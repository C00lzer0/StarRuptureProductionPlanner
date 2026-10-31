use axum::{
    Json, Router,
    extract::{Path, State},
    http::StatusCode,
    routing::{get, put},
};
use serde::{Deserialize, Serialize};
use sqlx::{
    FromRow, SqlitePool,
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions},
};
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
}

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
async fn items_create(State(s): State<AppState>, Json(n): Json<Item>) -> ApiResult<Item> {
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
    State(s): State<AppState>,
    Path(id): Path<i64>,
) -> Result<StatusCode, ApiError> {
    delete_from(&s.pool, "items", id).await
}

async fn buildings_list(State(s): State<AppState>) -> ApiResult<Vec<Building>> {
    sqlx::query_as::<_, Building>(
        "SELECT id, name, icon, power, temperature, build_area, build_area2, category, unlocked FROM buildings ORDER BY name",
    )
    .fetch_all(&s.pool)
    .await
    .map(Json)
    .map_err(err)
}
async fn buildings_create(
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
async fn buildings_update(
    State(s): State<AppState>,
    Path(id): Path<i64>,
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
    }
    tx.commit().await.map_err(err)?;
    Ok(Json(Building { id, ..b }))
}
fn validate_building(b: &Building) -> Result<(), ApiError> {
    if !b.power.is_finite() || b.power < 0.0 || b.temperature.is_some_and(|t| !t.is_finite()) {
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
    State(s): State<AppState>,
    Path(id): Path<i64>,
) -> Result<StatusCode, ApiError> {
    delete_from(&s.pool, "buildings", id).await
}

// ---------- blueprints ----------

async fn blueprints_list(State(s): State<AppState>) -> ApiResult<Vec<Blueprint>> {
    let rows = sqlx::query_as::<_, BlueprintRow>(
        "SELECT id, name, icon, building_id, output_item_id, output_amount, unlocked FROM blueprints ORDER BY name",
    )
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
    State(s): State<AppState>,
    Json(b): Json<Blueprint>,
) -> ApiResult<Blueprint> {
    save_blueprint(&s.pool, None, b).await
}
async fn blueprints_update(
    State(s): State<AppState>,
    Path(id): Path<i64>,
    Json(b): Json<Blueprint>,
) -> ApiResult<Blueprint> {
    save_blueprint(&s.pool, Some(id), b).await
}
async fn blueprints_delete(
    State(s): State<AppState>,
    Path(id): Path<i64>,
) -> Result<StatusCode, ApiError> {
    delete_from(&s.pool, "blueprints", id).await
}

// ---------- plans ----------

async fn plans_list(State(s): State<AppState>) -> ApiResult<Vec<Plan>> {
    sqlx::query_as::<_, Plan>("SELECT id, name, data FROM plans ORDER BY updated_at DESC")
        .fetch_all(&s.pool)
        .await
        .map(Json)
        .map_err(err)
}
async fn plans_create(State(s): State<AppState>, Json(p): Json<Plan>) -> ApiResult<Plan> {
    let r = sqlx::query("INSERT INTO plans (name, data) VALUES (?, ?)")
        .bind(&p.name)
        .bind(&p.data)
        .execute(&s.pool)
        .await
        .map_err(err)?;
    Ok(Json(Plan {
        id: r.last_insert_rowid(),
        ..p
    }))
}
async fn plans_update(
    State(s): State<AppState>,
    Path(id): Path<i64>,
    Json(p): Json<Plan>,
) -> ApiResult<Plan> {
    sqlx::query("UPDATE plans SET name = ?, data = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .bind(&p.name)
        .bind(&p.data)
        .bind(id)
        .execute(&s.pool)
        .await
        .map_err(err)?;
    Ok(Json(Plan { id, ..p }))
}
async fn plans_delete(
    State(s): State<AppState>,
    Path(id): Path<i64>,
) -> Result<StatusCode, ApiError> {
    delete_from(&s.pool, "plans", id).await
}

async fn images_list() -> Json<Vec<String>> {
    const EXT: [&str; 7] = ["png", "jpg", "jpeg", "gif", "webp", "svg", "avif"];
    let mut files = Vec::new();
    if let Ok(mut dir) = tokio::fs::read_dir(IMAGE_DIR).await {
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
    Json(files)
}

// ---------- settings ----------

#[derive(Serialize, Deserialize)]
struct Setting {
    value: String,
}

const LANGUAGES: [&str; 4] = ["en", "de", "es", "fr"];

async fn language_get(State(s): State<AppState>) -> ApiResult<Setting> {
    let v: Option<String> = sqlx::query_scalar("SELECT value FROM settings WHERE key = 'language'")
        .fetch_optional(&s.pool)
        .await
        .map_err(err)?;
    Ok(Json(Setting {
        value: v
            .filter(|v| LANGUAGES.contains(&v.as_str()))
            .unwrap_or_else(|| "en".into()),
    }))
}

async fn language_put(State(s): State<AppState>, Json(v): Json<Setting>) -> ApiResult<Setting> {
    if !LANGUAGES.contains(&v.value.as_str()) {
        return Err((StatusCode::BAD_REQUEST, "Unsupported language".into()));
    }
    sqlx::query("INSERT INTO settings (key, value) VALUES ('language', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
        .bind(&v.value)
        .execute(&s.pool)
        .await
        .map_err(err)?;
    Ok(Json(v))
}

// ---------- setup ----------

const IMAGE_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/images");

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
    "CREATE TABLE IF NOT EXISTS plans (
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

    let api = Router::new()
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
        .route("/settings/language", get(language_get).put(language_put))
        .route("/images", get(images_list))
        .route("/plans", get(plans_list).post(plans_create))
        .route("/plans/{id}", put(plans_update).delete(plans_delete))
        .with_state(AppState { pool: pool.clone() });

    let app = Router::new()
        .nest("/api", api)
        .nest_service("/images", ServeDir::new(IMAGE_DIR))
        .fallback_service(ServeDir::new(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/static"
        )));

    let addr = std::env::var("BIND").unwrap_or_else(|_| "127.0.0.1:3000".into());
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
