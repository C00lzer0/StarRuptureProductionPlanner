mod auth;

use auth::{Admin, AuthConfig, AuthUser, MaybeUser};
use axum::{
    Json, Router,
    extract::{Path, Query, Request, State},
    http::{Method, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post, put},
};
use serde::{Deserialize, Serialize};
use sqlx::{
    FromRow, SqlitePool,
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions},
};
use std::sync::Arc;
use tower_http::services::ServeDir;

type ApiError = (StatusCode, String);
type ApiResult<T> = Result<Json<T>, ApiError>;

fn err(e: sqlx::Error) -> ApiError {
    let status = match &e {
        sqlx::Error::Database(d) if d.is_foreign_key_violation() || d.is_unique_violation() => {
            StatusCode::CONFLICT
        }
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    };
    let msg = match status {
        StatusCode::CONFLICT => "Conflict: entry is in use or already exists".to_string(),
        _ => e.to_string(),
    };
    (status, msg)
}

#[derive(Serialize, Deserialize, FromRow)]
struct Item {
    #[serde(default)]
    id: i64,
    name: String,
    #[serde(default)]
    icon: String,
    #[serde(default)]
    tier: i64,
}

#[derive(Serialize, Deserialize, FromRow)]
struct Building {
    #[serde(default)]
    id: i64,
    name: String,
    #[serde(default)]
    icon: String,
    #[serde(default)]
    power: f64,
    #[serde(default)]
    temperature: Option<f64>,
    // A building can occupy up to two different build areas
    #[serde(default)]
    build_area: Option<String>,
    #[serde(default)]
    build_area2: Option<String>,
    #[serde(default)]
    category: Option<String>,
    #[serde(default = "default_unlocked")]
    unlocked: bool,
}

#[derive(Serialize, Deserialize, FromRow)]
struct BlueprintRow {
    id: i64,
    name: String,
    icon: String,
    building_id: Option<i64>,
    output_item_id: i64,
    output_amount: f64,
    unlocked: bool,
}

#[derive(Serialize, Deserialize, FromRow, Clone)]
struct Input {
    #[serde(default)]
    blueprint_id: i64,
    item_id: i64,
    amount: f64,
}

#[derive(Serialize, Deserialize)]
struct Blueprint {
    #[serde(default)]
    id: i64,
    name: String,
    #[serde(default)]
    icon: String,
    building_id: Option<i64>,
    output_item_id: i64,
    output_amount: f64,
    #[serde(default = "default_unlocked")]
    unlocked: bool,
    inputs: Vec<Input>,
}

fn default_unlocked() -> bool {
    true
}

#[derive(Serialize, Deserialize, FromRow)]
struct Plan {
    #[serde(default)]
    id: i64,
    name: String,
    data: String,
}

#[derive(Clone)]
struct AppState {
    pool: SqlitePool,
    auth: Arc<AuthConfig>,
}

// Items, Gebäude und Blueprints sind gemeinsame Stammdaten und nur für Admins änderbar
async fn delete_from(pool: &SqlitePool, table: &str, id: i64) -> Result<StatusCode, ApiError> {
    sqlx::query(&format!("DELETE FROM {table} WHERE id = ?"))
        .bind(id)
        .execute(pool)
        .await
        .map_err(err)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn items_list(State(s): State<AppState>) -> ApiResult<Vec<Item>> {
    sqlx::query_as::<_, Item>("SELECT id, name, icon, tier FROM items ORDER BY tier, name")
        .fetch_all(&s.pool)
        .await
        .map(Json)
        .map_err(err)
}
async fn items_create(
    _: Admin,
    State(s): State<AppState>,
    Json(n): Json<Item>,
) -> ApiResult<Item> {
    validate_tier(n.tier)?;
    let r = sqlx::query("INSERT INTO items (name, icon, tier) VALUES (?, ?, ?)")
        .bind(&n.name)
        .bind(&n.icon)
        .bind(n.tier)
        .execute(&s.pool)
        .await
        .map_err(err)?;
    Ok(Json(Item {
        id: r.last_insert_rowid(),
        ..n
    }))
}
async fn items_update(
    _: Admin,
    State(s): State<AppState>,
    Path(id): Path<i64>,
    Json(n): Json<Item>,
) -> ApiResult<Item> {
    validate_tier(n.tier)?;
    sqlx::query("UPDATE items SET name = ?, icon = ?, tier = ? WHERE id = ?")
        .bind(&n.name)
        .bind(&n.icon)
        .bind(n.tier)
        .bind(id)
        .execute(&s.pool)
        .await
        .map_err(err)?;
    Ok(Json(Item { id, ..n }))
}
async fn items_delete(
    _: Admin,
    State(s): State<AppState>,
    Path(id): Path<i64>,
) -> Result<StatusCode, ApiError> {
    delete_from(&s.pool, "items", id).await
}

async fn buildings_list(
    MaybeUser(user): MaybeUser,
    State(s): State<AppState>,
) -> ApiResult<Vec<Building>> {
    // Der Freischalt-Status ist pro Benutzer überschreibbar (Standardwert aus den Stammdaten)
    sqlx::query_as::<_, Building>(
        "SELECT b.id, b.name, b.icon, b.power, b.temperature, b.build_area, b.build_area2, b.category,
                COALESCE(u.unlocked, b.unlocked) AS unlocked
         FROM buildings b
         LEFT JOIN user_building_unlocks u ON u.building_id = b.id AND u.user_id = ?
         ORDER BY b.name",
    )
    .bind(user.map_or(0, |u| u.id))
    .fetch_all(&s.pool)
    .await
    .map(Json)
    .map_err(err)
}
async fn buildings_create(
    _: Admin,
    State(s): State<AppState>,
    Json(b): Json<Building>,
) -> ApiResult<Building> {
    validate_building(&b)?;
    let r = sqlx::query(
        "INSERT INTO buildings (name, icon, power, temperature, build_area, build_area2, category, unlocked) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&b.name)
    .bind(&b.icon)
    .bind(b.power)
    .bind(b.temperature)
    .bind(&b.build_area)
    .bind(&b.build_area2)
    .bind(&b.category)
    .bind(b.unlocked)
    .execute(&s.pool)
    .await
    .map_err(err)?;
    Ok(Json(Building {
        id: r.last_insert_rowid(),
        ..b
    }))
}
#[derive(Deserialize)]
struct UnlockOptions {
    #[serde(default)]
    with_blueprints: bool,
}

async fn buildings_update(
    _: Admin,
    State(s): State<AppState>,
    Path(id): Path<i64>,
    Query(opts): Query<UnlockOptions>,
    Json(b): Json<Building>,
) -> ApiResult<Building> {
    validate_building(&b)?;
    let mut tx = s.pool.begin().await.map_err(err)?;
    sqlx::query(
        "UPDATE buildings SET name = ?, icon = ?, power = ?, temperature = ?, build_area = ?, build_area2 = ?, category = ?, unlocked = ? WHERE id = ?",
    )
    .bind(&b.name)
    .bind(&b.icon)
    .bind(b.power)
    .bind(b.temperature)
    .bind(&b.build_area)
    .bind(&b.build_area2)
    .bind(&b.category)
    .bind(b.unlocked)
    .bind(id)
    .execute(&mut *tx)
    .await
    .map_err(err)?;
    // A locked building cannot be used, so its blueprints are locked as well
    if !b.unlocked {
        sqlx::query("UPDATE blueprints SET unlocked = 0 WHERE building_id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(err)?;
    } else if opts.with_blueprints {
        sqlx::query("UPDATE blueprints SET unlocked = 1 WHERE building_id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(err)?;
    }
    tx.commit().await.map_err(err)?;
    Ok(Json(Building { id, ..b }))
}
fn validate_building(b: &Building) -> Result<(), ApiError> {
    if !b.power.is_finite() || b.temperature.is_some_and(|t| !t.is_finite()) {
        return Err((
            StatusCode::BAD_REQUEST,
            "Invalid power or temperature".into(),
        ));
    }
    if [&b.build_area, &b.build_area2]
        .into_iter()
        .flatten()
        .any(|a| !is_valid_area(a))
    {
        return Err((
            StatusCode::BAD_REQUEST,
            "Build area must have the format X*Y".into(),
        ));
    }
    if b
        .category
        .as_deref()
        .is_some_and(|c| !BUILDING_CATEGORIES.contains(&c))
    {
        return Err((StatusCode::BAD_REQUEST, "Unknown building category".into()));
    }
    Ok(())
}
const BUILDING_CATEGORIES: [&str; 6] = [
    "extraction",
    "manufacturing",
    "processing",
    "transport",
    "defense",
    "power",
];
// Build area format: "X*Y" with two positive integers, e.g. "4*4"
fn is_valid_area(a: &str) -> bool {
    a.split_once('*').is_some_and(|(x, y)| {
        [x, y]
            .iter()
            .all(|p| !p.is_empty() && p.bytes().all(|c| c.is_ascii_digit()) && p.parse::<u32>().is_ok_and(|n| n > 0))
    })
}
fn validate_tier(tier: i64) -> Result<(), ApiError> {
    if tier < 0 {
        return Err((StatusCode::BAD_REQUEST, "Tier must not be negative".into()));
    }
    Ok(())
}
async fn buildings_delete(
    _: Admin,
    State(s): State<AppState>,
    Path(id): Path<i64>,
) -> Result<StatusCode, ApiError> {
    delete_from(&s.pool, "buildings", id).await
}

// ---------- blueprints ----------

async fn blueprints_list(
    MaybeUser(user): MaybeUser,
    State(s): State<AppState>,
) -> ApiResult<Vec<Blueprint>> {
    // Effektiv freigeschaltet: Blueprint-Status (ggf. pro Benutzer) und Status des Gebäudes
    let rows = sqlx::query_as::<_, BlueprintRow>(
        "SELECT bp.id, bp.name, bp.icon, bp.building_id, bp.output_item_id, bp.output_amount,
                (COALESCE(ubp.unlocked, bp.unlocked) AND COALESCE(ub.unlocked, b.unlocked, 1)) AS unlocked
         FROM blueprints bp
         LEFT JOIN buildings b ON b.id = bp.building_id
         LEFT JOIN user_blueprint_unlocks ubp ON ubp.blueprint_id = bp.id AND ubp.user_id = ?1
         LEFT JOIN user_building_unlocks ub ON ub.building_id = bp.building_id AND ub.user_id = ?1
         ORDER BY bp.name",
    )
    .bind(user.map_or(0, |u| u.id))
    .fetch_all(&s.pool)
    .await
    .map_err(err)?;
    let inputs =
        sqlx::query_as::<_, Input>("SELECT blueprint_id, item_id, amount FROM blueprint_inputs")
            .fetch_all(&s.pool)
            .await
            .map_err(err)?;
    Ok(Json(
        rows.into_iter()
            .map(|r| Blueprint {
                inputs: inputs
                    .iter()
                    .filter(|i| i.blueprint_id == r.id)
                    .cloned()
                    .collect(),
                id: r.id,
                name: r.name,
                icon: r.icon,
                building_id: r.building_id,
                output_item_id: r.output_item_id,
                output_amount: r.output_amount,
                unlocked: r.unlocked,
            })
            .collect(),
    ))
}

async fn save_blueprint(
    pool: &SqlitePool,
    id: Option<i64>,
    mut b: Blueprint,
) -> ApiResult<Blueprint> {
    if b.output_amount <= 0.0 || b.inputs.iter().any(|i| i.amount <= 0.0) {
        return Err((
            StatusCode::BAD_REQUEST,
            "Amounts must be greater than 0".into(),
        ));
    }
    let mut tx = pool.begin().await.map_err(err)?;
    if let (true, Some(building_id)) = (b.unlocked, b.building_id) {
        let building_unlocked: Option<bool> =
            sqlx::query_scalar("SELECT unlocked FROM buildings WHERE id = ?")
                .bind(building_id)
                .fetch_optional(&mut *tx)
                .await
                .map_err(err)?;
        if building_unlocked == Some(false) {
            return Err((
                StatusCode::BAD_REQUEST,
                "Blueprint cannot be unlocked while its building is locked".into(),
            ));
        }
    }
    let id = match id {
        Some(id) => {
            sqlx::query(
                "UPDATE blueprints SET name=?, icon=?, building_id=?, output_item_id=?, output_amount=?, unlocked=? WHERE id=?",
            )
            .bind(&b.name)
            .bind(&b.icon)
            .bind(b.building_id)
            .bind(b.output_item_id)
            .bind(b.output_amount)
            .bind(b.unlocked)
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(err)?;
            sqlx::query("DELETE FROM blueprint_inputs WHERE blueprint_id = ?")
                .bind(id)
                .execute(&mut *tx)
                .await
                .map_err(err)?;
            id
        }
        None => sqlx::query(
            "INSERT INTO blueprints (name, icon, building_id, output_item_id, output_amount, unlocked) VALUES (?,?,?,?,?,?)",
        )
        .bind(&b.name)
        .bind(&b.icon)
        .bind(b.building_id)
        .bind(b.output_item_id)
        .bind(b.output_amount)
        .bind(b.unlocked)
        .execute(&mut *tx)
        .await
        .map_err(err)?
        .last_insert_rowid(),
    };
    for i in &b.inputs {
        sqlx::query(
            "INSERT INTO blueprint_inputs (blueprint_id, item_id, amount) VALUES (?,?,?)
             ON CONFLICT (blueprint_id, item_id) DO UPDATE SET amount = amount + excluded.amount",
        )
        .bind(id)
        .bind(i.item_id)
        .bind(i.amount)
        .execute(&mut *tx)
        .await
        .map_err(err)?;
    }
    tx.commit().await.map_err(err)?;
    b.id = id;
    Ok(Json(b))
}

async fn blueprints_create(
    _: Admin,
    State(s): State<AppState>,
    Json(b): Json<Blueprint>,
) -> ApiResult<Blueprint> {
    save_blueprint(&s.pool, None, b).await
}
async fn blueprints_update(
    _: Admin,
    State(s): State<AppState>,
    Path(id): Path<i64>,
    Json(b): Json<Blueprint>,
) -> ApiResult<Blueprint> {
    save_blueprint(&s.pool, Some(id), b).await
}
async fn blueprints_delete(
    _: Admin,
    State(s): State<AppState>,
    Path(id): Path<i64>,
) -> Result<StatusCode, ApiError> {
    delete_from(&s.pool, "blueprints", id).await
}

// ---------- unlock state (per user) ----------

#[derive(Deserialize)]
struct Unlock {
    unlocked: bool,
    #[serde(default)]
    with_blueprints: bool,
}

#[derive(Deserialize)]
struct TierUnlock {
    unlocked: bool,
    tier_min: i64,
    tier_max: i64,
}

#[derive(Serialize)]
struct TierUnlockResult {
    changed: u64,
    skipped: u64,
}

async fn building_unlock(
    AuthUser(user): AuthUser,
    State(s): State<AppState>,
    Path(id): Path<i64>,
    Json(v): Json<Unlock>,
) -> Result<StatusCode, ApiError> {
    let mut tx = s.pool.begin().await.map_err(err)?;
    let exists: Option<i64> = sqlx::query_scalar("SELECT id FROM buildings WHERE id = ?")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(err)?;
    if exists.is_none() {
        return Err((StatusCode::NOT_FOUND, "Building not found".into()));
    }
    sqlx::query(
        "INSERT INTO user_building_unlocks (user_id, building_id, unlocked) VALUES (?, ?, ?)
         ON CONFLICT (user_id, building_id) DO UPDATE SET unlocked = excluded.unlocked",
    )
    .bind(user.id)
    .bind(id)
    .bind(v.unlocked)
    .execute(&mut *tx)
    .await
    .map_err(err)?;
    // A locked building cannot be used, so its blueprints are locked as well
    if !v.unlocked {
        sqlx::query(
            "INSERT INTO user_blueprint_unlocks (user_id, blueprint_id, unlocked)
             SELECT ?, id, 0 FROM blueprints WHERE building_id = ?
             ON CONFLICT (user_id, blueprint_id) DO UPDATE SET unlocked = 0",
        )
        .bind(user.id)
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(err)?;
    } else if v.with_blueprints {
        sqlx::query(
            "INSERT INTO user_blueprint_unlocks (user_id, blueprint_id, unlocked)
             SELECT ?, id, 1 FROM blueprints WHERE building_id = ?
             ON CONFLICT (user_id, blueprint_id) DO UPDATE SET unlocked = 1",
        )
        .bind(user.id)
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(err)?;
    }
    tx.commit().await.map_err(err)?;
    Ok(StatusCode::NO_CONTENT)
}

// Locks or unlocks all blueprints whose output item has a tier within [tier_min, tier_max]
async fn blueprints_unlock_tiers(
    AuthUser(user): AuthUser,
    State(s): State<AppState>,
    Json(v): Json<TierUnlock>,
) -> ApiResult<TierUnlockResult> {
    if v.tier_min > v.tier_max {
        return Err((StatusCode::BAD_REQUEST, "Invalid tier range".into()));
    }
    let mut tx = s.pool.begin().await.map_err(err)?;
    // Blueprints of a locked building cannot be unlocked
    let changed = sqlx::query(
        "INSERT INTO user_blueprint_unlocks (user_id, blueprint_id, unlocked)
         SELECT ?1, bp.id, ?2 FROM blueprints bp
         JOIN items i ON i.id = bp.output_item_id
         LEFT JOIN buildings b ON b.id = bp.building_id
         LEFT JOIN user_building_unlocks ub ON ub.building_id = bp.building_id AND ub.user_id = ?1
         WHERE i.tier BETWEEN ?3 AND ?4 AND (?2 = 0 OR COALESCE(ub.unlocked, b.unlocked, 1) = 1)
         ON CONFLICT (user_id, blueprint_id) DO UPDATE SET unlocked = excluded.unlocked",
    )
    .bind(user.id)
    .bind(v.unlocked)
    .bind(v.tier_min)
    .bind(v.tier_max)
    .execute(&mut *tx)
    .await
    .map_err(err)?
    .rows_affected();
    let total: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM blueprints bp JOIN items i ON i.id = bp.output_item_id WHERE i.tier BETWEEN ? AND ?",
    )
    .bind(v.tier_min)
    .bind(v.tier_max)
    .fetch_one(&mut *tx)
    .await
    .map_err(err)?;
    tx.commit().await.map_err(err)?;
    Ok(Json(TierUnlockResult {
        changed,
        skipped: (total as u64).saturating_sub(changed),
    }))
}

async fn blueprint_unlock(
    AuthUser(user): AuthUser,
    State(s): State<AppState>,
    Path(id): Path<i64>,
    Json(v): Json<Unlock>,
) -> Result<StatusCode, ApiError> {
    let mut tx = s.pool.begin().await.map_err(err)?;
    let row: Option<(Option<bool>,)> = sqlx::query_as(
        "SELECT COALESCE(ub.unlocked, b.unlocked) FROM blueprints bp
         LEFT JOIN buildings b ON b.id = bp.building_id
         LEFT JOIN user_building_unlocks ub ON ub.building_id = bp.building_id AND ub.user_id = ?
         WHERE bp.id = ?",
    )
    .bind(user.id)
    .bind(id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(err)?;
    let Some((building_unlocked,)) = row else {
        return Err((StatusCode::NOT_FOUND, "Blueprint not found".into()));
    };
    if v.unlocked && building_unlocked == Some(false) {
        return Err((
            StatusCode::BAD_REQUEST,
            "Blueprint cannot be unlocked while its building is locked".into(),
        ));
    }
    sqlx::query(
        "INSERT INTO user_blueprint_unlocks (user_id, blueprint_id, unlocked) VALUES (?, ?, ?)
         ON CONFLICT (user_id, blueprint_id) DO UPDATE SET unlocked = excluded.unlocked",
    )
    .bind(user.id)
    .bind(id)
    .bind(v.unlocked)
    .execute(&mut *tx)
    .await
    .map_err(err)?;
    tx.commit().await.map_err(err)?;
    Ok(StatusCode::NO_CONTENT)
}

// ---------- plans (per user) ----------

const MAX_PLANS_PER_USER: i64 = 200;
const MAX_PLAN_BYTES: usize = 1_000_000;

fn validate_plan(p: &Plan) -> Result<(), ApiError> {
    if p.name.trim().is_empty() || p.name.chars().count() > 200 {
        return Err((StatusCode::BAD_REQUEST, "Invalid plan name".into()));
    }
    if p.data.len() > MAX_PLAN_BYTES {
        return Err((StatusCode::PAYLOAD_TOO_LARGE, "Plan is too large".into()));
    }
    Ok(())
}

// table stammt ausschließlich aus Konstanten dieses Moduls, nie aus Benutzereingaben
async fn plans_list_of(pool: &SqlitePool, table: &str, user_id: i64) -> ApiResult<Vec<Plan>> {
    sqlx::query_as::<_, Plan>(&format!(
        "SELECT id, name, data FROM {table} WHERE user_id = ? ORDER BY updated_at DESC"
    ))
    .bind(user_id)
    .fetch_all(pool)
    .await
    .map(Json)
    .map_err(err)
}

async fn plans_create_in(
    pool: &SqlitePool,
    table: &str,
    user_id: i64,
    p: Plan,
) -> ApiResult<Plan> {
    validate_plan(&p)?;
    let count: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {table} WHERE user_id = ?"))
        .bind(user_id)
        .fetch_one(pool)
        .await
        .map_err(err)?;
    if count >= MAX_PLANS_PER_USER {
        return Err((
            StatusCode::UNPROCESSABLE_ENTITY,
            "Plan limit reached".into(),
        ));
    }
    let r = sqlx::query(&format!(
        "INSERT INTO {table} (user_id, name, data) VALUES (?, ?, ?)"
    ))
    .bind(user_id)
    .bind(&p.name)
    .bind(&p.data)
    .execute(pool)
    .await
    .map_err(err)?;
    Ok(Json(Plan {
        id: r.last_insert_rowid(),
        ..p
    }))
}

async fn plans_update_in(
    pool: &SqlitePool,
    table: &str,
    user_id: i64,
    id: i64,
    p: Plan,
) -> ApiResult<Plan> {
    validate_plan(&p)?;
    let r = sqlx::query(&format!(
        "UPDATE {table} SET name = ?, data = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?"
    ))
    .bind(&p.name)
    .bind(&p.data)
    .bind(id)
    .bind(user_id)
    .execute(pool)
    .await
    .map_err(err)?;
    // Fremde und nicht vorhandene Pläne sind nicht unterscheidbar
    if r.rows_affected() == 0 {
        return Err((StatusCode::NOT_FOUND, "Plan not found".into()));
    }
    Ok(Json(Plan { id, ..p }))
}

async fn plans_delete_in(
    pool: &SqlitePool,
    table: &str,
    user_id: i64,
    id: i64,
) -> Result<StatusCode, ApiError> {
    let r = sqlx::query(&format!(
        "DELETE FROM {table} WHERE id = ? AND user_id = ?"
    ))
    .bind(id)
    .bind(user_id)
    .execute(pool)
    .await
    .map_err(err)?;
    if r.rows_affected() == 0 {
        return Err((StatusCode::NOT_FOUND, "Plan not found".into()));
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn plans_list(AuthUser(u): AuthUser, State(s): State<AppState>) -> ApiResult<Vec<Plan>> {
    plans_list_of(&s.pool, "plans", u.id).await
}
async fn plans_create(
    AuthUser(u): AuthUser,
    State(s): State<AppState>,
    Json(p): Json<Plan>,
) -> ApiResult<Plan> {
    plans_create_in(&s.pool, "plans", u.id, p).await
}
async fn plans_update(
    AuthUser(u): AuthUser,
    State(s): State<AppState>,
    Path(id): Path<i64>,
    Json(p): Json<Plan>,
) -> ApiResult<Plan> {
    plans_update_in(&s.pool, "plans", u.id, id, p).await
}
async fn plans_delete(
    AuthUser(u): AuthUser,
    State(s): State<AppState>,
    Path(id): Path<i64>,
) -> Result<StatusCode, ApiError> {
    plans_delete_in(&s.pool, "plans", u.id, id).await
}

async fn manual_plans_list(
    AuthUser(u): AuthUser,
    State(s): State<AppState>,
) -> ApiResult<Vec<Plan>> {
    plans_list_of(&s.pool, "manual_plans", u.id).await
}
async fn manual_plans_create(
    AuthUser(u): AuthUser,
    State(s): State<AppState>,
    Json(p): Json<Plan>,
) -> ApiResult<Plan> {
    plans_create_in(&s.pool, "manual_plans", u.id, p).await
}
async fn manual_plans_update(
    AuthUser(u): AuthUser,
    State(s): State<AppState>,
    Path(id): Path<i64>,
    Json(p): Json<Plan>,
) -> ApiResult<Plan> {
    plans_update_in(&s.pool, "manual_plans", u.id, id, p).await
}
async fn manual_plans_delete(
    AuthUser(u): AuthUser,
    State(s): State<AppState>,
    Path(id): Path<i64>,
) -> Result<StatusCode, ApiError> {
    plans_delete_in(&s.pool, "manual_plans", u.id, id).await
}


async fn images_list() -> Json<std::collections::HashMap<&'static str, Vec<String>>> {
    let (items, buildings) = tokio::join!(list_image_files("items"), list_image_files("buildings"));
    Json([("items", items), ("buildings", buildings)].into())
}

async fn list_image_files(sub: &str) -> Vec<String> {
    const EXT: [&str; 7] = ["png", "jpg", "jpeg", "gif", "webp", "svg", "avif"];
    let mut files = Vec::new();
    if let Ok(mut dir) = tokio::fs::read_dir(format!("{IMAGE_DIR}/{sub}")).await {
        while let Ok(Some(e)) = dir.next_entry().await {
            let path = e.path();
            let ok = path
                .extension()
                .and_then(|x| x.to_str())
                .is_some_and(|x| EXT.contains(&x.to_ascii_lowercase().as_str()));
            if ok && let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                files.push(name.to_string());
            }
        }
    }
    files.sort();
    files
}

// ---------- security ----------

// Schreibende Anfragen müssen vom eigenen Origin kommen (zusätzlich zu SameSite=Lax)
async fn same_origin(State(s): State<AppState>, req: Request, next: Next) -> Response {
    if !matches!(*req.method(), Method::GET | Method::HEAD | Method::OPTIONS)
        && let Some(origin) = req.headers().get(header::ORIGIN)
    {
        let expected = match &s.auth.oauth {
            Some(o) => o.base_url.split_once("://").map(|(_, h)| h.to_string()),
            None => req
                .headers()
                .get(header::HOST)
                .and_then(|h| h.to_str().ok())
                .map(str::to_string),
        };
        let actual = origin
            .to_str()
            .ok()
            .and_then(|o| o.split_once("://"))
            .map(|(_, h)| h);
        if expected.as_deref() != actual {
            return (StatusCode::FORBIDDEN, "Cross-origin request rejected").into_response();
        }
    }
    next.run(req).await
}

// ---------- setup ----------

const IMAGE_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/images");

// Basisdaten (Items, Gebäude, Blueprints) für neu erstellte Datenbanken
const SEED_SQL: &str = include_str!("../seed.sql");

const SCHEMA: &[&str] = &[
    "CREATE TABLE IF NOT EXISTS items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        icon TEXT NOT NULL DEFAULT ''
        ,tier INTEGER NOT NULL DEFAULT 0
    )",
    "CREATE TABLE IF NOT EXISTS buildings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        icon TEXT NOT NULL DEFAULT '',
        power REAL NOT NULL DEFAULT 0,
        temperature REAL NULL,
        build_area TEXT NULL,
        build_area2 TEXT NULL,
        category TEXT NULL,
        unlocked INTEGER NOT NULL DEFAULT 1
    )",
    "CREATE TABLE IF NOT EXISTS blueprints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        icon TEXT NOT NULL DEFAULT '',
        building_id INTEGER NULL REFERENCES buildings(id) ON DELETE SET NULL,
        output_item_id INTEGER NOT NULL REFERENCES items(id),
        output_amount REAL NOT NULL,
        unlocked INTEGER NOT NULL DEFAULT 1
    )",
    "CREATE TABLE IF NOT EXISTS blueprint_inputs (
        blueprint_id INTEGER NOT NULL REFERENCES blueprints(id) ON DELETE CASCADE,
        item_id INTEGER NOT NULL REFERENCES items(id),
        amount REAL NOT NULL,
        PRIMARY KEY (blueprint_id, item_id)
    )",
    "CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    )",
    "CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        github_id INTEGER NOT NULL UNIQUE,
        login TEXT NOT NULL
    )",
    "CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL
    )",
    "CREATE TABLE IF NOT EXISTS user_building_unlocks (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        building_id INTEGER NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
        unlocked INTEGER NOT NULL,
        PRIMARY KEY (user_id, building_id)
    )",
    "CREATE TABLE IF NOT EXISTS user_blueprint_unlocks (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        blueprint_id INTEGER NOT NULL REFERENCES blueprints(id) ON DELETE CASCADE,
        unlocked INTEGER NOT NULL,
        PRIMARY KEY (user_id, blueprint_id)
    )",
    "CREATE TABLE IF NOT EXISTS plans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        data TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )",
    "CREATE TABLE IF NOT EXISTS manual_plans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        data TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )",
];

#[tokio::main]
async fn main() {
    // Datei relativ zum Projektordner; per DATABASE_PATH überschreibbar
    let path = std::env::var("DATABASE_PATH")
        .unwrap_or_else(|_| concat!(env!("CARGO_MANIFEST_DIR"), "/productionplanner.db").into());
    let is_new_db = !std::path::Path::new(&path).exists();
    let opts = SqliteConnectOptions::new()
        .filename(&path)
        .create_if_missing(true)
        .foreign_keys(true)
        .journal_mode(SqliteJournalMode::Wal)
        .busy_timeout(std::time::Duration::from_secs(5));
    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect_with(opts)
        .await
        .expect("SQLite-Datenbank konnte nicht geöffnet werden");
    for stmt in SCHEMA {
        sqlx::query(stmt)
            .execute(&pool)
            .await
            .expect("Schema-Erstellung");
    }
    // Migration für Datenbanken aus älteren Versionen
    let cols: Vec<String> = sqlx::query_scalar("SELECT name FROM pragma_table_info('buildings')")
        .fetch_all(&pool)
        .await
        .expect("Schema-Prüfung");
    if !cols.iter().any(|c| c == "power") {
        sqlx::query("ALTER TABLE buildings ADD COLUMN power REAL NOT NULL DEFAULT 0")
            .execute(&pool)
            .await
            .expect("Migration power");
    }
    if !cols.iter().any(|c| c == "temperature") {
        sqlx::query("ALTER TABLE buildings ADD COLUMN temperature REAL NULL")
            .execute(&pool)
            .await
            .expect("Migration temperature");
    }
    for col in ["build_area", "build_area2", "category"] {
        if !cols.iter().any(|c| c == col) {
            sqlx::query(&format!("ALTER TABLE buildings ADD COLUMN {col} TEXT NULL"))
                .execute(&pool)
                .await
                .expect("Migration build area");
        }
    }
    if !cols.iter().any(|c| c == "unlocked") {
        sqlx::query("ALTER TABLE buildings ADD COLUMN unlocked INTEGER NOT NULL DEFAULT 1")
            .execute(&pool)
            .await
            .expect("Migration building unlocked");
    }
    let item_cols: Vec<String> = sqlx::query_scalar("SELECT name FROM pragma_table_info('items')")
        .fetch_all(&pool)
        .await
        .expect("Item-Schema-Prüfung");
    if !item_cols.iter().any(|c| c == "tier") {
        sqlx::query("ALTER TABLE items ADD COLUMN tier INTEGER NOT NULL DEFAULT 0")
            .execute(&pool)
            .await
            .expect("Migration tier");
    }
    let blueprint_cols: Vec<String> =
        sqlx::query_scalar("SELECT name FROM pragma_table_info('blueprints')")
            .fetch_all(&pool)
            .await
            .expect("Blueprint-Schema-Prüfung");
    if !blueprint_cols.iter().any(|c| c == "unlocked") {
        sqlx::query("ALTER TABLE blueprints ADD COLUMN unlocked INTEGER NOT NULL DEFAULT 1")
            .execute(&pool)
            .await
            .expect("Migration unlocked");
    }

    // Pläne gehören einem Benutzer; ältere Datenbanken erhalten die Spalte nachträglich
    for table in ["plans", "manual_plans"] {
        let plan_cols: Vec<String> =
            sqlx::query_scalar(&format!("SELECT name FROM pragma_table_info('{table}')"))
                .fetch_all(&pool)
                .await
                .expect("Plan-Schema-Prüfung");
        if !plan_cols.iter().any(|c| c == "user_id") {
            sqlx::query(&format!(
                "ALTER TABLE {table} ADD COLUMN user_id INTEGER NULL REFERENCES users(id) ON DELETE CASCADE"
            ))
            .execute(&pool)
            .await
            .expect("Migration user_id");
        }
        sqlx::query(&format!(
            "CREATE INDEX IF NOT EXISTS idx_{table}_user ON {table}(user_id)"
        ))
        .execute(&pool)
        .await
        .expect("Index user_id");
    }

    // Neu erstellte Datenbank mit den Basisdaten befüllen
    if is_new_db {
        let mut tx = pool.begin().await.expect("Seed-Transaktion");
        sqlx::raw_sql(SEED_SQL)
            .execute(&mut *tx)
            .await
            .expect("Basisdaten konnten nicht importiert werden (Datenbankdatei löschen und neu starten)");
        tx.commit().await.expect("Seed-Commit");
        println!("Neue Datenbank mit Basisdaten aus seed.sql befüllt");
    }

    // Version 1: Energie ist vorzeichenbehaftet (negativ = Verbrauch, positiv = Erzeugung).
    // Ältere Datenbanken speicherten den Verbrauch als positiven Wert.
    let version: i64 = sqlx::query_scalar("PRAGMA user_version")
        .fetch_one(&pool)
        .await
        .expect("Versionsprüfung");
    if version < 1 {
        let mut tx = pool.begin().await.expect("Migrations-Transaktion");
        if !is_new_db {
            sqlx::query("UPDATE buildings SET power = -power")
                .execute(&mut *tx)
                .await
                .expect("Migration Energie vorzeichenbehaftet");
        }
        sqlx::query("PRAGMA user_version = 1")
            .execute(&mut *tx)
            .await
            .expect("Version setzen");
        tx.commit().await.expect("Migrations-Commit");
    }

    let addr = std::env::var("BIND").unwrap_or_else(|_| "127.0.0.1:3000".into());
    let auth = AuthConfig::from_env(&pool).await;
    // Ohne Login hat jeder Zugreifer Adminrechte – daher nur lokal erlauben
    let loopback = addr
        .rsplit_once(':')
        .is_some_and(|(h, _)| matches!(h, "127.0.0.1" | "localhost" | "[::1]"));
    if auth.oauth.is_none() && !loopback {
        panic!(
            "BIND={addr} ist nicht lokal. Für den öffentlichen Betrieb GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET und PUBLIC_URL setzen (siehe README)."
        );
    }
    let state = AppState {
        pool: pool.clone(),
        auth: Arc::new(auth),
    };

    let api = Router::new()
        .route("/me", get(auth::me))
        .route("/logout", post(auth::logout))
        .route("/items", get(items_list).post(items_create))
        .route("/items/{id}", put(items_update).delete(items_delete))
        .route("/buildings", get(buildings_list).post(buildings_create))
        .route(
            "/buildings/{id}",
            put(buildings_update).delete(buildings_delete),
        )
        .route("/blueprints", get(blueprints_list).post(blueprints_create))
        .route(
            "/blueprints/{id}",
            put(blueprints_update).delete(blueprints_delete),
        )
        .route("/unlocks/buildings/{id}", put(building_unlock))
        .route("/unlocks/blueprints", put(blueprints_unlock_tiers))
        .route("/unlocks/blueprints/{id}", put(blueprint_unlock))
        .route("/images", get(images_list))
        .route("/plans", get(plans_list).post(plans_create))
        .route("/plans/{id}", put(plans_update).delete(plans_delete))
        .route(
            "/manual-plans",
            get(manual_plans_list).post(manual_plans_create),
        )
        .route(
            "/manual-plans/{id}",
            put(manual_plans_update).delete(manual_plans_delete),
        );

    let app = Router::new()
        .route("/auth/login", get(auth::login))
        .route("/auth/callback", get(auth::callback))
        .nest("/api", api)
        .nest_service("/images", ServeDir::new(IMAGE_DIR))
        .fallback_service(ServeDir::new(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/static"
        )))
        .layer(middleware::from_fn_with_state(state.clone(), same_origin))
        .with_state(state);

    println!("Production Planner auf http://{addr} (Datenbank: {path})");
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .expect("Port belegt");
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
            println!("Beende Production Planner ...");
        })
        .await
        .unwrap();
    pool.close().await;
}
