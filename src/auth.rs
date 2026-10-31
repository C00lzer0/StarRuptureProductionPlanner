// Anmeldung per GitHub OAuth, Sessions und Zugriffsrechte.
//
// Ohne GITHUB_CLIENT_ID läuft die App im lokalen Einzelnutzer-Modus: Es gibt einen
// impliziten Benutzer "local" mit Adminrechten (nur an Loopback-Adressen erlaubt).
use crate::{ApiError, AppState, err};
use axum::{
    Json,
    extract::{FromRequestParts, Query, State},
    http::{HeaderMap, StatusCode, header, request::Parts},
    response::{IntoResponse, Redirect, Response},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::HashSet, fmt::Display, time::Duration};

const SESSION_COOKIE: &str = "session";
const STATE_COOKIE: &str = "oauth_state";
const SESSION_SECONDS: i64 = 30 * 24 * 3600;
const STATE_SECONDS: i64 = 600;
const NOW_SQL: &str = "CAST(strftime('%s', 'now') AS INTEGER)";

pub struct OAuth {
    client_id: String,
    client_secret: String,
    // Öffentliche Basis-URL ohne abschließenden Slash, z. B. https://planner.example.com
    pub base_url: String,
}

pub struct AuthConfig {
    pub oauth: Option<OAuth>,
    admins: HashSet<String>,
    local_user: User,
    http: reqwest::Client,
}

#[derive(Clone, Serialize)]
pub struct User {
    pub id: i64,
    pub login: String,
    pub is_admin: bool,
}

impl AuthConfig {
    pub async fn from_env(pool: &sqlx::SqlitePool) -> Self {
        let var = |k: &str| std::env::var(k).ok().filter(|v| !v.trim().is_empty());
        let oauth = var("GITHUB_CLIENT_ID").map(|client_id| OAuth {
            client_id,
            client_secret: var("GITHUB_CLIENT_SECRET")
                .expect("GITHUB_CLIENT_SECRET fehlt (wird mit GITHUB_CLIENT_ID benötigt)"),
            base_url: var("PUBLIC_URL")
                .expect("PUBLIC_URL fehlt (z. B. https://planner.example.com)")
                .trim_end_matches('/')
                .to_string(),
        });
        let admins = var("ADMIN_GITHUB_LOGINS")
            .unwrap_or_default()
            .split(',')
            .map(|l| l.trim().to_lowercase())
            .filter(|l| !l.is_empty())
            .collect();
        // Der lokale Benutzer wird immer angelegt; er übernimmt Daten aus der Zeit vor der Benutzertrennung
        let id: i64 = sqlx::query_scalar(
            "INSERT INTO users (github_id, login) VALUES (0, 'local') ON CONFLICT (github_id) DO UPDATE SET login = 'local' RETURNING id",
        )
        .fetch_one(pool)
        .await
        .expect("Lokaler Benutzer");
        if oauth.is_none() {
            adopt_legacy_plans(pool, id).await.expect("Migration Pläne");
        }
        Self {
            oauth,
            admins,
            local_user: User {
                id,
                login: "local".into(),
                is_admin: true,
            },
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(10))
                .build()
                .expect("HTTP-Client"),
        }
    }

    fn is_admin(&self, login: &str) -> bool {
        self.admins.contains(&login.to_lowercase())
    }
}

// Pläne aus der Einzelnutzer-Zeit (ohne Besitzer) dem angegebenen Benutzer zuordnen
async fn adopt_legacy_plans(pool: &sqlx::SqlitePool, user_id: i64) -> Result<(), sqlx::Error> {
    for table in ["plans", "manual_plans"] {
        sqlx::query(&format!(
            "UPDATE {table} SET user_id = ? WHERE user_id IS NULL"
        ))
        .bind(user_id)
        .execute(pool)
        .await?;
    }
    Ok(())
}

fn random_token() -> String {
    let mut b = [0u8; 32];
    getrandom::fill(&mut b).expect("Zufallsquelle nicht verfügbar");
    b.iter().map(|x| format!("{x:02x}")).collect()
}

// In der DB landet nur der Hash, ein Datenbankleck gibt also keine gültigen Sessions preis
fn hash(token: &str) -> String {
    Sha256::digest(token.as_bytes())
        .iter()
        .map(|x| format!("{x:02x}"))
        .collect()
}

fn cookie(h: &HeaderMap, name: &str) -> Option<String> {
    h.get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .find_map(|p| {
            let (k, v) = p.trim().split_once('=')?;
            (k == name).then(|| v.to_string())
        })
}

fn set_cookie(s: &AppState, name: &str, value: &str, max_age: i64) -> String {
    let secure = s
        .auth
        .oauth
        .as_ref()
        .is_some_and(|o| o.base_url.starts_with("https://"));
    format!(
        "{name}={value}; Path=/; HttpOnly; SameSite=Lax; Max-Age={max_age}{}",
        if secure { "; Secure" } else { "" }
    )
}

fn gateway(e: impl Display) -> ApiError {
    eprintln!("GitHub-Login fehlgeschlagen: {e}");
    (StatusCode::BAD_GATEWAY, "GitHub login failed".into())
}

async fn current_user(headers: &HeaderMap, s: &AppState) -> Result<Option<User>, ApiError> {
    if s.auth.oauth.is_none() {
        return Ok(Some(s.auth.local_user.clone()));
    }
    let Some(token) = cookie(headers, SESSION_COOKIE) else {
        return Ok(None);
    };
    let row: Option<(i64, String)> = sqlx::query_as(&format!(
        "SELECT u.id, u.login FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > {NOW_SQL}"
    ))
    .bind(hash(&token))
    .fetch_optional(&s.pool)
    .await
    .map_err(err)?;
    Ok(row.map(|(id, login)| User {
        is_admin: s.auth.is_admin(&login),
        id,
        login,
    }))
}

// Benutzer, falls angemeldet (öffentliche Lesezugriffe)
pub struct MaybeUser(pub Option<User>);
// Angemeldeter Benutzer, sonst 401
pub struct AuthUser(pub User);
// Angemeldeter Admin, sonst 401/403
pub struct Admin;

impl FromRequestParts<AppState> for MaybeUser {
    type Rejection = ApiError;
    async fn from_request_parts(p: &mut Parts, s: &AppState) -> Result<Self, ApiError> {
        Ok(Self(current_user(&p.headers, s).await?))
    }
}

impl FromRequestParts<AppState> for AuthUser {
    type Rejection = ApiError;
    async fn from_request_parts(p: &mut Parts, s: &AppState) -> Result<Self, ApiError> {
        current_user(&p.headers, s)
            .await?
            .map(Self)
            .ok_or((StatusCode::UNAUTHORIZED, "Login required".into()))
    }
}

impl FromRequestParts<AppState> for Admin {
    type Rejection = ApiError;
    async fn from_request_parts(p: &mut Parts, s: &AppState) -> Result<Self, ApiError> {
        let user = AuthUser::from_request_parts(p, s).await?.0;
        if user.is_admin {
            Ok(Self)
        } else {
            Err((StatusCode::FORBIDDEN, "Admin rights required".into()))
        }
    }
}

#[derive(Serialize)]
pub struct Me {
    auth_enabled: bool,
    user: Option<User>,
}

pub async fn me(State(s): State<AppState>, MaybeUser(user): MaybeUser) -> Json<Me> {
    Json(Me {
        auth_enabled: s.auth.oauth.is_some(),
        user,
    })
}

pub async fn login(State(s): State<AppState>) -> Result<Response, ApiError> {
    let Some(o) = &s.auth.oauth else {
        return Err((StatusCode::NOT_FOUND, "Login is not configured".into()));
    };
    let state = random_token();
    let url = reqwest::Url::parse_with_params(
        "https://github.com/login/oauth/authorize",
        [
            ("client_id", o.client_id.as_str()),
            ("redirect_uri", &format!("{}/auth/callback", o.base_url)),
            ("state", &state),
        ],
    )
    .map_err(gateway)?;
    Ok((
        [(
            header::SET_COOKIE,
            set_cookie(&s, STATE_COOKIE, &state, STATE_SECONDS),
        )],
        Redirect::to(url.as_str()),
    )
        .into_response())
}

#[derive(Deserialize)]
pub struct CallbackQuery {
    code: Option<String>,
    state: Option<String>,
}

pub async fn callback(
    State(s): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<CallbackQuery>,
) -> Result<Response, ApiError> {
    let Some(o) = &s.auth.oauth else {
        return Err((StatusCode::NOT_FOUND, "Login is not configured".into()));
    };
    // Schutz vor Login-CSRF: der state muss zum Cookie des auslösenden Browsers passen
    let expected = cookie(&headers, STATE_COOKIE);
    let (Some(code), Some(state), Some(expected)) = (q.code, q.state, expected) else {
        return Err((StatusCode::BAD_REQUEST, "Invalid login request".into()));
    };
    if state != expected {
        return Err((StatusCode::BAD_REQUEST, "Invalid login request".into()));
    }

    let token: serde_json::Value = s
        .auth
        .http
        .post("https://github.com/login/oauth/access_token")
        .header(header::ACCEPT, "application/json")
        .json(&serde_json::json!({
            "client_id": o.client_id,
            "client_secret": o.client_secret,
            "code": code,
            "redirect_uri": format!("{}/auth/callback", o.base_url),
        }))
        .send()
        .await
        .map_err(gateway)?
        .json()
        .await
        .map_err(gateway)?;
    let access = token["access_token"]
        .as_str()
        .ok_or_else(|| gateway("kein access_token"))?;
    let gh: serde_json::Value = s
        .auth
        .http
        .get("https://api.github.com/user")
        .bearer_auth(access)
        .header(header::USER_AGENT, "ProductionPlanner")
        .header(header::ACCEPT, "application/vnd.github+json")
        .send()
        .await
        .map_err(gateway)?
        .error_for_status()
        .map_err(gateway)?
        .json()
        .await
        .map_err(gateway)?;
    let (Some(github_id), Some(login)) = (gh["id"].as_i64(), gh["login"].as_str()) else {
        return Err(gateway("unerwartete Antwort von /user"));
    };

    let user_id: i64 = sqlx::query_scalar(
        "INSERT INTO users (github_id, login) VALUES (?, ?) ON CONFLICT (github_id) DO UPDATE SET login = excluded.login RETURNING id",
    )
    .bind(github_id)
    .bind(login)
    .fetch_one(&s.pool)
    .await
    .map_err(err)?;
    if s.auth.is_admin(login) {
        adopt_legacy_plans(&s.pool, user_id).await.map_err(err)?;
    }

    sqlx::query(&format!("DELETE FROM sessions WHERE expires_at <= {NOW_SQL}"))
        .execute(&s.pool)
        .await
        .map_err(err)?;
    let session = random_token();
    sqlx::query(&format!(
        "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, {NOW_SQL} + ?)"
    ))
    .bind(hash(&session))
    .bind(user_id)
    .bind(SESSION_SECONDS)
    .execute(&s.pool)
    .await
    .map_err(err)?;

    Ok((
        [
            (
                header::SET_COOKIE,
                set_cookie(&s, SESSION_COOKIE, &session, SESSION_SECONDS),
            ),
            (header::SET_COOKIE, set_cookie(&s, STATE_COOKIE, "", 0)),
        ],
        Redirect::to("/"),
    )
        .into_response())
}

pub async fn logout(State(s): State<AppState>, headers: HeaderMap) -> Result<Response, ApiError> {
    if let Some(token) = cookie(&headers, SESSION_COOKIE) {
        sqlx::query("DELETE FROM sessions WHERE token_hash = ?")
            .bind(hash(&token))
            .execute(&s.pool)
            .await
            .map_err(err)?;
    }
    Ok((
        StatusCode::NO_CONTENT,
        [(header::SET_COOKIE, set_cookie(&s, SESSION_COOKIE, "", 0))],
    )
        .into_response())
}
