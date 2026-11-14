"use strict";
// Statischer Modus (GitHub Pages): Ersetzt das Rust-Backend durch eine SQLite-Datenbank im Browser (sql.js).
// Die Basisdaten stammen aus seed.sql, Pläne und Freischaltungen werden in localStorage gespeichert.
// Die Routen und SQL-Abfragen entsprechen src/main.rs; Stammdaten sind hier schreibgeschützt.
const Offline = (() => {
  const STORAGE_KEY = "pp.userdata.v1";
  const USER_ID = 1;
  const USER = { id: USER_ID, login: "local", is_admin: false };
  const MAX_PLANS = 200;
  const MAX_PLAN_BYTES = 1_000_000;
  const PLAN_TABLES = { plans: "plans", "manual-plans": "manual_plans" };

  const SCHEMA = `
    CREATE TABLE items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      icon TEXT NOT NULL DEFAULT '',
      tier INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE buildings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      icon TEXT NOT NULL DEFAULT '',
      power REAL NOT NULL DEFAULT 0,
      temperature REAL NULL,
      build_area TEXT NULL,
      build_area2 TEXT NULL,
      category TEXT NULL,
      unlocked INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE blueprints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      icon TEXT NOT NULL DEFAULT '',
      building_id INTEGER NULL REFERENCES buildings(id) ON DELETE SET NULL,
      output_item_id INTEGER NOT NULL REFERENCES items(id),
      output_amount REAL NOT NULL,
      unlocked INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE blueprint_inputs (
      blueprint_id INTEGER NOT NULL REFERENCES blueprints(id) ON DELETE CASCADE,
      item_id INTEGER NOT NULL REFERENCES items(id),
      amount REAL NOT NULL,
      PRIMARY KEY (blueprint_id, item_id)
    );
    CREATE TABLE user_building_unlocks (
      user_id INTEGER NOT NULL,
      building_id INTEGER NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
      unlocked INTEGER NOT NULL,
      PRIMARY KEY (user_id, building_id)
    );
    CREATE TABLE user_blueprint_unlocks (
      user_id INTEGER NOT NULL,
      blueprint_id INTEGER NOT NULL REFERENCES blueprints(id) ON DELETE CASCADE,
      unlocked INTEGER NOT NULL,
      PRIMARY KEY (user_id, blueprint_id)
    );
    CREATE TABLE plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NULL,
      name TEXT NOT NULL,
      data TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE manual_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NULL,
      name TEXT NOT NULL,
      data TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );`;

  let db;
  let imageFiles = { items: [], buildings: [] };

  class HttpError extends Error {
    constructor(status, message) {
      super(message);
      this.status = status;
    }
  }

  const all = (sql, params = []) => {
    const st = db.prepare(sql);
    try {
      st.bind(params);
      const rows = [];
      while (st.step()) rows.push(st.getAsObject());
      return rows;
    } finally {
      st.free();
    }
  };
  const run = (sql, params = []) => {
    db.run(sql, params);
    return db.getRowsModified();
  };
  const scalar = (sql, params = []) => Object.values(all(sql, params)[0] ?? {})[0];
  const lastId = () => scalar("SELECT last_insert_rowid()");
  const flag = (v) => (v ? 1 : 0);

  function tx(fn) {
    db.run("BEGIN");
    try {
      const r = fn();
      db.run("COMMIT");
      return r;
    } catch (e) {
      db.run("ROLLBACK");
      throw e;
    }
  }

  async function loadScript(src) {
    await new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error("Failed to load " + src));
      document.head.appendChild(s);
    });
  }

  // ---------- persistence ----------

  function persist() {
    const data = {
      plans: all("SELECT id, name, data, updated_at FROM plans"),
      manual_plans: all("SELECT id, name, data, updated_at FROM manual_plans"),
      building_unlocks: all("SELECT building_id AS id, unlocked FROM user_building_unlocks WHERE user_id = ?", [USER_ID]),
      blueprint_unlocks: all("SELECT blueprint_id AS id, unlocked FROM user_blueprint_unlocks WHERE user_id = ?", [USER_ID]),
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch {
      throw new HttpError(507, "Browser storage is full or unavailable; changes will be lost on reload");
    }
  }

  function restore() {
    let data;
    try {
      data = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    } catch {
      data = null;
    }
    if (!data) return;
    tx(() => {
      for (const [key, table] of [["plans", "plans"], ["manual_plans", "manual_plans"]]) {
        for (const p of data[key] ?? []) {
          run(`INSERT INTO ${table} (id, user_id, name, data, updated_at) VALUES (?, ?, ?, ?, ?)`, [p.id, USER_ID, p.name, p.data, p.updated_at]);
        }
      }
      // Einträge zu Gebäuden/Blueprints, die in seed.sql nicht mehr existieren, werden ignoriert
      for (const u of data.building_unlocks ?? []) {
        run("INSERT INTO user_building_unlocks (user_id, building_id, unlocked) SELECT ?, id, ? FROM buildings WHERE id = ?", [USER_ID, flag(u.unlocked), u.id]);
      }
      for (const u of data.blueprint_unlocks ?? []) {
        run("INSERT INTO user_blueprint_unlocks (user_id, blueprint_id, unlocked) SELECT ?, id, ? FROM blueprints WHERE id = ?", [USER_ID, flag(u.unlocked), u.id]);
      }
    });
  }

  // ---------- init ----------

  async function init() {
    const base = new URL(".", document.baseURI).href;
    const [seed, images] = await Promise.all([
      fetch(base + "seed.sql").then((r) => {
        if (!r.ok) throw new Error("seed.sql: " + r.status);
        return r.text();
      }),
      fetch(base + "images/index.json").then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
      loadScript("vendor/sql-wasm.js"),
    ]);
    imageFiles = { items: images.items ?? [], buildings: images.buildings ?? [] };
    const SQL = await initSqlJs({ locateFile: (f) => "vendor/" + f });
    db = new SQL.Database();
    db.run("PRAGMA foreign_keys = ON");
    db.run(SCHEMA);
    tx(() => db.run(seed));
    restore();
  }

  // ---------- handlers ----------

  const buildingsList = () =>
    all(
      `SELECT b.id, b.name, b.icon, b.power, b.temperature, b.build_area, b.build_area2, b.category,
              COALESCE(u.unlocked, b.unlocked) AS unlocked
       FROM buildings b
       LEFT JOIN user_building_unlocks u ON u.building_id = b.id AND u.user_id = ?
       ORDER BY b.name`,
      [USER_ID],
    ).map((b) => ({ ...b, unlocked: !!b.unlocked }));

  function blueprintsList() {
    const rows = all(
      `SELECT bp.id, bp.name, bp.icon, bp.building_id, bp.output_item_id, bp.output_amount,
              (COALESCE(ubp.unlocked, bp.unlocked) AND COALESCE(ub.unlocked, b.unlocked, 1)) AS unlocked
       FROM blueprints bp
       LEFT JOIN buildings b ON b.id = bp.building_id
       LEFT JOIN user_blueprint_unlocks ubp ON ubp.blueprint_id = bp.id AND ubp.user_id = ?1
       LEFT JOIN user_building_unlocks ub ON ub.building_id = bp.building_id AND ub.user_id = ?1
       ORDER BY bp.name`,
      [USER_ID],
    );
    const inputs = new Map();
    for (const i of all("SELECT blueprint_id, item_id, amount FROM blueprint_inputs")) {
      if (!inputs.has(i.blueprint_id)) inputs.set(i.blueprint_id, []);
      inputs.get(i.blueprint_id).push(i);
    }
    return rows.map((r) => ({ ...r, unlocked: !!r.unlocked, inputs: inputs.get(r.id) ?? [] }));
  }

  function buildingUnlock(id, v) {
    tx(() => {
      if (scalar("SELECT id FROM buildings WHERE id = ?", [id]) === undefined) throw new HttpError(404, "Building not found");
      run(
        `INSERT INTO user_building_unlocks (user_id, building_id, unlocked) VALUES (?, ?, ?)
         ON CONFLICT (user_id, building_id) DO UPDATE SET unlocked = excluded.unlocked`,
        [USER_ID, id, flag(v.unlocked)],
      );
      // A locked building cannot be used, so its blueprints are locked as well
      if (!v.unlocked || v.with_blueprints) {
        run(
          `INSERT INTO user_blueprint_unlocks (user_id, blueprint_id, unlocked)
           SELECT ?1, id, ?2 FROM blueprints WHERE building_id = ?3
           ON CONFLICT (user_id, blueprint_id) DO UPDATE SET unlocked = excluded.unlocked`,
          [USER_ID, flag(v.unlocked), id],
        );
      }
    });
    persist();
    return null;
  }

  // Locks or unlocks all blueprints whose output item has a tier within [tier_min, tier_max]
  function blueprintsUnlockTiers(v) {
    if (!(v.tier_min <= v.tier_max)) throw new HttpError(400, "Invalid tier range");
    const result = tx(() => {
      // Blueprints of a locked building cannot be unlocked
      const changed = run(
        `INSERT INTO user_blueprint_unlocks (user_id, blueprint_id, unlocked)
         SELECT ?1, bp.id, ?2 FROM blueprints bp
         JOIN items i ON i.id = bp.output_item_id
         LEFT JOIN buildings b ON b.id = bp.building_id
         LEFT JOIN user_building_unlocks ub ON ub.building_id = bp.building_id AND ub.user_id = ?1
         WHERE i.tier BETWEEN ?3 AND ?4 AND (?2 = 0 OR COALESCE(ub.unlocked, b.unlocked, 1) = 1)
         ON CONFLICT (user_id, blueprint_id) DO UPDATE SET unlocked = excluded.unlocked`,
        [USER_ID, flag(v.unlocked), v.tier_min, v.tier_max],
      );
      const total = scalar(
        "SELECT COUNT(*) FROM blueprints bp JOIN items i ON i.id = bp.output_item_id WHERE i.tier BETWEEN ? AND ?",
        [v.tier_min, v.tier_max],
      );
      return { changed, skipped: Math.max(0, total - changed) };
    });
    persist();
    return result;
  }

  function blueprintUnlock(id, v) {
    tx(() => {
      const rows = all(
        `SELECT COALESCE(ub.unlocked, b.unlocked) AS unlocked FROM blueprints bp
         LEFT JOIN buildings b ON b.id = bp.building_id
         LEFT JOIN user_building_unlocks ub ON ub.building_id = bp.building_id AND ub.user_id = ?
         WHERE bp.id = ?`,
        [USER_ID, id],
      );
      if (!rows.length) throw new HttpError(404, "Blueprint not found");
      if (v.unlocked && rows[0].unlocked === 0) throw new HttpError(400, "Blueprint cannot be unlocked while its building is locked");
      run(
        `INSERT INTO user_blueprint_unlocks (user_id, blueprint_id, unlocked) VALUES (?, ?, ?)
         ON CONFLICT (user_id, blueprint_id) DO UPDATE SET unlocked = excluded.unlocked`,
        [USER_ID, id, flag(v.unlocked)],
      );
    });
    persist();
    return null;
  }

  function validatePlan(p) {
    const name = typeof p?.name === "string" ? p.name : "";
    if (!name.trim() || [...name].length > 200 || typeof p.data !== "string") throw new HttpError(400, "Invalid plan name");
    if (new Blob([p.data]).size > MAX_PLAN_BYTES) throw new HttpError(413, "Plan is too large");
  }

  function planRoute(table, method, id, body) {
    if (method === "GET") return all(`SELECT id, name, data FROM ${table} WHERE user_id = ? ORDER BY updated_at DESC, id DESC`, [USER_ID]);
    if (method === "POST") {
      validatePlan(body);
      if (scalar(`SELECT COUNT(*) FROM ${table} WHERE user_id = ?`, [USER_ID]) >= MAX_PLANS) throw new HttpError(422, "Plan limit reached");
      run(`INSERT INTO ${table} (user_id, name, data) VALUES (?, ?, ?)`, [USER_ID, body.name, body.data]);
      const out = { id: lastId(), name: body.name, data: body.data };
      persist();
      return out;
    }
    if (method === "PUT") {
      validatePlan(body);
      const changed = run(`UPDATE ${table} SET name = ?, data = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?`, [body.name, body.data, id, USER_ID]);
      if (!changed) throw new HttpError(404, "Plan not found");
      persist();
      return { id, name: body.name, data: body.data };
    }
    if (method === "DELETE") {
      if (!run(`DELETE FROM ${table} WHERE id = ? AND user_id = ?`, [id, USER_ID])) throw new HttpError(404, "Plan not found");
      persist();
      return null;
    }
    throw new HttpError(405, "Method not allowed");
  }

  function route(method, path, body) {
    const [, head, rawId, ...rest] = path.split("?")[0].split("/");
    const id = rawId === undefined ? undefined : Number(rawId);
    if (rest.length || (rawId !== undefined && !Number.isInteger(id))) throw new HttpError(404, "Not found");
    const key = rawId === undefined ? head : head + "/:id";
    const match = (m, k) => method === m && key === k;

    if (match("GET", "me")) return { auth_enabled: false, user: USER };
    if (match("POST", "logout")) return null;
    if (match("GET", "items")) return all("SELECT id, name, icon, tier FROM items ORDER BY tier, name");
    if (match("GET", "buildings")) return buildingsList();
    if (match("GET", "blueprints")) return blueprintsList();
    if (match("GET", "images")) return imageFiles;
    if (head === "plans" || head === "manual-plans") return planRoute(PLAN_TABLES[head], method, id, body);
    if (["items", "buildings", "blueprints"].includes(head) && method !== "GET") throw new HttpError(403, "Master data is read-only in the static version");
    throw new HttpError(404, "Not found");
  }

  function unlockRoute(method, path, body) {
    const [, , kind, rawId, ...rest] = path.split("?")[0].split("/");
    const id = Number(rawId);
    if (method !== "PUT" || rest.length) throw new HttpError(404, "Not found");
    if (kind === "blueprints" && rawId === undefined) return blueprintsUnlockTiers(body ?? {});
    if (!Number.isInteger(id)) throw new HttpError(404, "Not found");
    if (kind === "buildings") return buildingUnlock(id, body ?? {});
    if (kind === "blueprints") return blueprintUnlock(id, body ?? {});
    throw new HttpError(404, "Not found");
  }

  // Liefert wie fetch() ein Response-Objekt, damit api() in app.js beide Modi gleich behandelt
  async function fetchApi(method, path, body) {
    try {
      const out = path.startsWith("/unlocks/") ? unlockRoute(method, path, body) : route(method, path, body);
      return out === null || out === undefined
        ? new Response(null, { status: 204 })
        : new Response(JSON.stringify(out), { status: 200, headers: { "Content-Type": "application/json" } });
    } catch (e) {
      if (e instanceof HttpError) return new Response(e.message, { status: e.status });
      const conflict = /UNIQUE|FOREIGN KEY/.test(String(e?.message));
      return new Response(conflict ? "Conflict: entry is in use or already exists" : String(e?.message ?? e), { status: conflict ? 409 : 500 });
    }
  }

  return { init, fetchApi };
})();
