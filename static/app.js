"use strict";
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const t = (k, o) => i18next.t(k, o);
const fmt = (n) => (Math.round(n * 100) / 100).toLocaleString(LANGUAGES.find((l) => l.code === i18next.language)?.numbers ?? "en-US");
const isUrl = (s) => /^(https?:|data:image\/|\/)/.test(s || "");
const BUILDING_CATEGORIES = ["extraction", "manufacturing", "processing", "transport", "defense", "power"];

const db = { items: [], buildings: [], blueprints: [], plans: [], manualPlans: [] };
// Anmeldestatus (aus /api/me); ohne Login-Konfiguration ist der lokale Benutzer ein Admin
const auth = { enabled: false, user: null };
const isAdmin = () => !!auth.user?.is_admin;
const view = { items: { filter: "", tier: "", sort: "tier-name" }, blueprints: { search: "", status: "" } };
const plan = { id: null, name: "", target: null, rate: 60, choices: {} };

async function api(method, path, body) {
  const res = await fetch("/api" + path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const msg = res.status === 409 ? t("err.conflict") : res.status === 400 ? t("err.invalid") : res.status === 401 ? t("err.loginRequired") : res.status === 403 ? t("err.forbidden") : await res.text();
    toast(msg || res.statusText);
    throw new Error(msg);
  }
  return res.status === 204 ? null : res.json();
}

let toastTimer;
function toast(msg, ok = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = ok ? "ok" : "";
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3500);
}

async function loadAll() {
  const own = (path) => (auth.user ? api("GET", path) : []);
  [db.items, db.buildings, db.blueprints, db.plans, imageFiles, db.manualPlans] = await Promise.all([
    api("GET", "/items"), api("GET", "/buildings"), api("GET", "/blueprints"), own("/plans"), api("GET", "/images"), own("/manual-plans"),
  ]);
  imageIndex = new Map(imageFiles.map((f) => [f.replace(/\.[^.]+$/, "").toLowerCase(), f]));
  renderAll();
}

const itemById = (id) => db.items.find((i) => i.id === id);
const itemsByName = () => [...db.items].sort((a, b) => a.name.localeCompare(b.name));
const buildingById = (id) => db.buildings.find((b) => b.id === id);
const bpsFor = (itemId) => db.blueprints.filter((b) => b.output_item_id === itemId && b.unlocked);
const allBpsFor = (itemId) => db.blueprints.filter((b) => b.output_item_id === itemId);

let imageFiles = [], imageIndex = new Map();

// Priorität: explizites Icon (Emoji/URL) > Bilddatei mit dem Namen aus /images > leer
function resolveIcon(icon, name) {
  if (icon) return icon;
  const file = imageIndex.get(String(name ?? "").trim().toLowerCase());
  return file ? "/images/" + encodeURIComponent(file) : "";
}
const blueprintIcon = (b) => resolveIcon(b.icon, b.name) || resolveIcon(itemById(b.output_item_id)?.icon, itemById(b.output_item_id)?.name);

function iconHtml(icon, name) {
  icon = resolveIcon(icon, name);
  return isUrl(icon) ? `<img class="icon" src="${esc(icon)}" alt="">` : `<span class="icon">${esc(icon || "▫️")}</span>`;
}
function iconSvg(icon, name, x, y, size = 24) {
  icon = resolveIcon(icon, name);
  return isUrl(icon)
    ? `<image href="${esc(icon)}" x="${x}" y="${y}" width="${size}" height="${size}"/>`
    : `<text x="${x}" y="${y + size - 4}" style="font-size:${size - 4}px">${esc(icon || "▫️")}</text>`;
}

// ---------- calculation ----------

function chosenBlueprint(itemId, stack) {
  if (stack.has(itemId)) return null;
  const c = plan.choices[itemId];
  if (c === 0) return null;
  const list = bpsFor(itemId);
  return list.find((b) => b.id === c) || list[0] || null;
}

function calculate() {
  const result = { nodes: new Map(), edges: [], order: [], warnings: [] };
  if (!plan.target || !itemById(plan.target)) return result;

  const post = [];
  const visited = new Set();
  const bpOf = new Map();
  const visit = (id, stack) => {
    if (stack.has(id)) { result.warnings.push(t("graph.cycle", { name: itemById(id)?.name })); return; }
    if (visited.has(id)) return;
    visited.add(id);
    const bp = chosenBlueprint(id, stack);
    bpOf.set(id, bp);
    stack.add(id);
    for (const inp of bp?.inputs ?? []) {
      visit(inp.item_id, stack);
    }
    stack.delete(id);
    post.push(id);
  };
  visit(plan.target, new Set());
  const order = post.reverse();

  const demand = new Map([[plan.target, plan.rate]]);
  const depth = new Map([[plan.target, 0]]);
  const edgeMap = new Map();
  for (const id of order) {
    const bp = bpOf.get(id);
    const d = demand.get(id) ?? 0;
    const node = { id, item: itemById(id), bp, demand: d, machines: 0, depth: depth.get(id) ?? 0 };
    if (bp) {
      node.machines = d / bp.output_amount;
      for (const inp of bp.inputs) {
        // inputs that would close a cycle are ignored here; they never appear in `order` ahead of the parent
        if (!order.includes(inp.item_id) || order.indexOf(inp.item_id) <= order.indexOf(id)) continue;
        const amt = inp.amount * node.machines;
        demand.set(inp.item_id, (demand.get(inp.item_id) ?? 0) + amt);
        depth.set(inp.item_id, Math.max(depth.get(inp.item_id) ?? 0, node.depth + 1));
        const key = inp.item_id + ">" + id;
        edgeMap.set(key, { from: inp.item_id, to: id, amount: amt });
      }
    }
    result.nodes.set(id, node);
  }
  for (const n of result.nodes.values()) n.depth = depth.get(n.id) ?? 0;
  result.edges = [...edgeMap.values()];
  result.order = order;
  result.warnings = [...new Set(result.warnings)];
  return result;
}

// ---------- planner rendering ----------

const NW = 220, NH = 74, GX = 100, GY = 24, PAD = 20;

function renderGraph(calc) {
  const host = $("#view-graph");
  if (!calc.nodes.size) { host.innerHTML = `<p style="padding:16px" class="muted">${t("planner.chooseTarget")}</p>`; return; }
  const cols = new Map();
  for (const n of calc.nodes.values()) {
    if (!cols.has(n.depth)) cols.set(n.depth, []);
    cols.get(n.depth).push(n);
  }
  const maxDepth = Math.max(...cols.keys());
  const maxRows = Math.max(...[...cols.values()].map((c) => c.length));
  const W = PAD * 2 + (maxDepth + 1) * NW + maxDepth * GX;
  const H = PAD * 2 + maxRows * NH + (maxRows - 1) * GY;
  const pos = new Map();
  for (const [d, list] of cols) {
    const colH = list.length * NH + (list.length - 1) * GY;
    list.forEach((n, i) => pos.set(n.id, { x: PAD + (maxDepth - d) * (NW + GX), y: PAD + (H - PAD * 2 - colH) / 2 + i * (NH + GY) }));
  }
  let svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg"><defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#5b6678"/></marker></defs>`;
  for (const e of calc.edges) {
    const a = pos.get(e.from), b = pos.get(e.to);
    const x1 = a.x + NW, y1 = a.y + NH / 2, x2 = b.x, y2 = b.y + NH / 2, mx = (x1 + x2) / 2;
    svg += `<path class="edge" marker-end="url(#arr)" d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2 - 2},${y2}"/>`;
    svg += `<text class="edge-label" x="${mx}" y="${(y1 + y2) / 2 - 4}" text-anchor="middle">${t("graph.perMin", { amount: fmt(e.amount) })}</text>`;
  }
  for (const n of calc.nodes.values()) {
    const p = pos.get(n.id);
    const b = n.bp && buildingById(n.bp.building_id);
    const options = bpsFor(n.id).length;
    const hasAlternative = options > 1 || (!n.bp && options > 0);
    const cls = "node" + (n.bp ? "" : " raw") + (n.id === plan.target ? " target" : "") + (hasAlternative ? " alt" : "");
    const line2 = n.bp ? `${Math.ceil(n.machines - 1e-9)}× ${    esc(b?.name ?? t("graph.noBuilding"))} (${fmt(n.machines)})` : t("graph.resource");
        svg += `<g class="${cls}" data-item="${n.id}" transform="translate(${p.x},${p.y})"><title>${esc(t("graph.clickHint"))}</title>
      <rect width="${NW}" height="${NH}" rx="8"/>
      ${iconSvg(n.item?.icon, n.item?.name, 10, 10, 28)}
      <text x="46" y="28" style="font-weight:600;font-size:13px">${esc(n.item?.name)}</text>
      <text x="46" y="46" class="muted">${t("graph.perMinSpaced", { amount: fmt(n.demand) })}</text>
            <text x="10" y="64" class="muted">${line2}</text>
      ${n.bp ? `<text x="${NW - 10}" y="28" text-anchor="end" class="muted">${esc(n.bp.name)}</text>` : ""}${hasAlternative ? `<text class="alt-badge" x="${NW - 10}" y="64" text-anchor="end">⇄</text>` : ""}</g>`;
  }
  host.innerHTML = svg + "</svg>";
  host.querySelectorAll(".node").forEach((g) => (g.onclick = () => chooseBlueprint(Number(g.dataset.item))));
}

function renderSummary(calc) {
  const host = $("#view-summary");
  const bld = new Map(), res = [];
  for (const n of calc.nodes.values()) {
    if (n.bp) {
      const key = n.bp.building_id ?? 0;
      const e = bld.get(key) ?? { b: buildingById(key), count: 0, exact: 0, outputs: [] };
      e.count += Math.ceil(n.machines - 1e-9);
      e.exact += n.machines;
      e.outputs.push(`${n.item?.name} (${Math.ceil(n.machines - 1e-9)}×)`);
      bld.set(key, e);
    }
    // Resources: items that are not produced from other items (no blueprint, or an extraction blueprint without inputs)
    if (!n.bp || !n.bp.inputs.length) res.push(n);
  }
  const sorted = [...bld.values()].sort((a, b) => b.count - a.count);
  const totalPower = sorted.reduce((s, e) => s + e.count * (e.b?.power ?? 0), 0);
  const bRows = sorted.map((e) =>
    `<tr><td>${e.b ? iconHtml(e.b.icon, e.b.name) + " " + esc(e.b.name) : "<i>" + t("summary.noBuilding") + "</i>"}</td><td class="num">${e.count}</td><td class="num">${fmt(e.exact)}</td><td class="num">${fmt(e.count * (e.b?.power ?? 0))}</td><td class="num">${e.b?.temperature == null ? "–" : fmt(e.b.temperature)}</td><td>${esc(e.outputs.join(", "))}</td></tr>`).join("");
  const rRows = res.sort((a, b) => b.demand - a.demand).map((n) =>
    `<tr><td>${iconHtml(n.item?.icon, n.item?.name)} ${esc(n.item?.name)}</td><td class="num">${fmt(n.demand)}</td></tr>`).join("");
  host.innerHTML = `<div class="cols">
    <div><h2>${t("summary.buildings")}</h2><table><tr><th>${t("summary.building")}</th><th class="num">${t("summary.count")}</th><th class="num">${t("summary.utilization")}</th><th class="num">${t("summary.power")}</th><th class="num">${t("summary.temp")}</th><th>${t("summary.produces")}</th></tr>${bRows || `<tr><td colspan="6">–</td></tr>`}
      ${bRows ? `<tr><th>${t("summary.total")}</th><th></th><th></th><th class="num">${fmt(totalPower)}</th><th></th><th></th></tr>` : ""}</table></div>
    <div><h2>${t("summary.resources")}</h2><table><tr><th>${t("summary.resource")}</th><th class="num">${t("summary.perMinute")}</th></tr>${rRows || `<tr><td colspan="2">–</td></tr>`}</table></div></div>`;
}

function renderPlanner() {
  const opts = (list, sel) => list.map((i) => `<option value="${i.id}" ${i.id === sel ? "selected" : ""}>${esc(i.icon && !isUrl(i.icon) ? i.icon + " " : "")}${esc(i.name)}</option>`).join("");
  const producible = db.items.filter((i) => bpsFor(i.id).length);
  if (!plan.target || !itemById(plan.target)) plan.target = (producible[0] ?? db.items[0])?.id ?? null;
  $("#p-target").innerHTML = opts(itemsByName(), plan.target);
  if (document.activeElement !== $("#p-rate")) $("#p-rate").value = plan.rate;
  const defaultRate = chosenBlueprint(plan.target, new Set())?.output_amount;
  const reset = $("#p-rate-reset");
  reset.disabled = defaultRate == null;
  reset.title = defaultRate == null ? t("planner.rateResetNone") : t("planner.rateReset", { amount: fmt(defaultRate) });
  $("#p-name").value = plan.name;
  $("#p-saved").innerHTML = `<option value="">–</option>` + db.plans.map((p) => `<option value="${p.id}" ${p.id === plan.id ? "selected" : ""}>${esc(p.name)}</option>`).join("");
  const calc = calculate();
  $("#p-warn").textContent = calc.warnings.join(" · ");
  renderGraph(calc);
  renderSummary(calc);
}

function chooseBlueprint(itemId) {
  const list = bpsFor(itemId);
  const cur = chosenBlueprint(itemId, new Set())?.id ?? 0;
  if (!list.length) return toast(t("bp.none", { name: itemById(itemId)?.name }));
  const radios = [...allBpsFor(itemId).map((b) => ({ v: b.id, disabled: !b.unlocked, label: `${b.name} (${t("graph.perMin", { amount: fmt(b.output_amount) })}${buildingById(b.building_id) ? ", " + buildingById(b.building_id).name : ""})${b.unlocked ? "" : " – " + t("bp.locked")}` })), { v: 0, label: t("bp.asResource") }]
    .map((r) => `<label class="choice"><input type="radio" name="bp" value="${r.v}" ${r.disabled ? "disabled" : ""} ${r.v === cur ? "checked" : ""}> ${esc(r.label)}</label>`).join("");
  openDialog(t("bp.chooseTitle", { name: itemById(itemId)?.name }), radios, (f) => {
    plan.choices[itemId] = Number(new FormData(f).get("bp"));
    renderPlanner();
  });
}

// ---------- dialog helper ----------

function openDialog(title, body, onOk) {
  const dlg = $("#dlg"), form = $("#dlg-form");
  form.innerHTML = `<h2 style="margin-top:0">${esc(title)}</h2>${body}<div class="actions"><button type="button" value="cancel" id="dlg-cancel">${t("common.cancel")}</button><button class="active" type="submit">${t("common.ok")}</button></div>`;
  $("#dlg-cancel").onclick = () => dlg.close();
  form.onsubmit = async (e) => {
    e.preventDefault();
    try { if ((await onOk(form)) !== false) dlg.close(); } catch { /* error already shown */ }
  };
  dlg.showModal();
}

// ---------- CRUD: items & buildings ----------

function renderNamed(kind) {
  const host = $("#tab-" + kind);
  const isB = kind === "buildings";
  const what = t(isB ? "kind.building" : "kind.item");
  const v = view.items;
  const sel = (val, cur) => (val === cur ? "selected" : "");
  const controls = isB ? "" : `<label>${t("item.filter")} <input id="item-filter" value="${esc(v.filter)}"></label><label>${t("item.tier")} <select id="item-tier"><option value="">${t("item.allTiers")}</option>${[...new Set(db.items.map((i) => i.tier))].sort((a, b) => a - b).map((tier) => `<option ${sel(String(tier), v.tier)}>${tier}</option>`).join("")}</select></label><label>${t("item.sort")} <select id="item-sort"><option value="tier-name" ${sel("tier-name", v.sort)}>${t("item.sortTierName")}</option><option value="name" ${sel("name", v.sort)}>${t("item.sortName")}</option><option value="tier" ${sel("tier", v.sort)}>${t("item.sortTier")}</option></select></label>`;
  host.innerHTML = `<div class="toolbar sticky">${isAdmin() ? `<button id="add-${kind}" class="active">${t("common.add", { what })}</button>` : ""}${controls}${kind === "items" && !db.items.length && isAdmin() ? `<button id="seed">${t("named.seed")}</button>` : ""}</div>
    <table><thead><tr><th>${t("common.icon")}</th><th>${t("common.name")}</th>${isB ? `<th>${t("named.category")}</th><th>${t("bp.status")}</th><th class="num">${t("named.powerShort")}</th><th class="num">${t("named.tempShort")}</th><th class="num">${t("named.areaShort")}</th>` : `<th class="num">${t("item.tier")}</th>`}<th></th></tr></thead><tbody id="${kind}-rows"></tbody></table>`;
  const renderRows = () => {
    let list = [...db[kind]];
    if (!isB) {
      v.filter = $("#item-filter").value;
      v.tier = $("#item-tier").value;
      v.sort = $("#item-sort").value;
      const filter = v.filter.trim().toLocaleLowerCase(), tier = v.tier, sort = v.sort;
      list = list.filter((n) => (!filter || n.name.toLocaleLowerCase().includes(filter)) && (!tier || String(n.tier) === tier));
      list.sort((a, b) => sort === "name" ? a.name.localeCompare(b.name) : sort === "tier" ? a.tier - b.tier : a.tier - b.tier || a.name.localeCompare(b.name));
    }
    $("#"+kind+"-rows").innerHTML = list.map((n) => `<tr${isB ? ` class="${n.unlocked ? "bp-unlocked" : "bp-locked"}"` : ""}><td>${iconHtml(n.icon, n.name)}</td><td>${esc(n.name)}</td>${isB ? `<td>${n.category ? esc(t("category." + n.category)) : "–"}</td><td class="status">${n.unlocked ? t("bp.unlocked") : t("bp.locked")}</td><td class="num">${fmt(n.power)}</td><td class="num">${n.temperature == null ? "–" : fmt(n.temperature)}</td><td class="num">${[n.build_area, n.build_area2].filter(Boolean).map(esc).join(" / ") || "–"}</td>` : `<td class="num">${n.tier}</td>`}    <td>${isB && auth.user ? `<button data-toggle="${n.id}">${t(n.unlocked ? "bp.lock" : "bp.unlock")}</button> ` : ""}${isAdmin() ? `<button data-edit="${n.id}">${t("common.edit")}</button> <button class="danger" data-del="${n.id}">${t("common.delete")}</button>` : ""}</td></tr>`).join("");
    $("#"+kind+"-rows").querySelectorAll("[data-toggle]").forEach((b) => (b.onclick = async () => {
      const n = db.buildings.find((x) => x.id === Number(b.dataset.toggle));
          await api("PUT", `/unlocks/buildings/${n.id}`, { unlocked: !n.unlocked });
      await loadAll();
    }));
    $("#"+kind+"-rows").querySelectorAll("[data-edit]").forEach((b) => (b.onclick = () => edit(db[kind].find((n) => n.id === Number(b.dataset.edit)))));
    $("#"+kind+"-rows").querySelectorAll("[data-del]").forEach((b) => (b.onclick = async () => { const n = db[kind].find((x) => x.id === Number(b.dataset.del)); if (!confirm(t("common.deleteConfirm", { name: n.name }))) return; await api("DELETE", `/${kind}/${n.id}`); await loadAll(); }));
  };
  const edit = (n) => openDialog(t(n ? "named.editTitle" : "named.addTitle", { what }),
    `<label class="field"><span>${t("common.name")}</span><input name="name" required value="${esc(n?.name)}"></label>
     <label class="field"><span>${t("named.icon")}</span><input name="icon" value="${esc(n?.icon)}"></label>` +
    (!isB ? `<label class="field"><span>${t("item.tier")}</span><input type="number" name="tier" min="0" step="1" value="${n?.tier ?? 0}"></label>` : "") +
    (isB ? `<label class="field"><span>${t("named.category")}</span><select name="category"><option value="">–</option>${BUILDING_CATEGORIES.map((c) => `<option value="${c}" ${n?.category === c ? "selected" : ""}>${t("category." + c)}</option>`).join("")}</select></label>
     <label class="field"><span>${t("bp.status")}</span><select name="unlocked"><option value="true" ${n?.unlocked !== false ? "selected" : ""}>${t("bp.unlocked")}</option><option value="false" ${n?.unlocked === false ? "selected" : ""}>${t("bp.locked")}</option></select></label>
     <label class="field"><span>${t("named.power")}</span><input type="number" name="power" min="0" step="any" value="${n?.power ?? 0}"></label>
     <label class="field"><span>${t("named.temperature")}</span><input type="number" name="temperature" step="any" value="${n?.temperature ?? ""}"></label>
     <label class="field"><span>${t("named.buildArea")}</span>     <input name="build_area" pattern="\s*[1-9][0-9]*\s*\*\s*[1-9][0-9]*\s*" placeholder="4*4" value="${esc(n?.build_area)}"></label>
          <label class="field"><span>${t("named.buildArea2")}</span><input name="build_area2" pattern="\s*[1-9][0-9]*\s*\*\s*[1-9][0-9]*\s*" placeholder="4*4" value="${esc(n?.build_area2)}"></label>` : ""),
    async (f) => {
      const d = Object.fromEntries(new FormData(f));
      const body = { name: d.name.trim(), icon: d.icon.trim() };
      if (!isB) body.tier = Number(d.tier);
      if (isB) {
        body.category = d.category || null;
        body.unlocked = d.unlocked === "true";
        body.power = d.power === "" ? 0 : Number(d.power);
        body.temperature = d.temperature === "" ? null : Number(d.temperature);
        body.build_area = d.build_area.replace(/\s+/g, "") || null;
        body.build_area2 = d.build_area2.replace(/\s+/g, "") || null;
      }
      if (n) await api("PUT", `/${kind}/${n.id}`, body); else await api("POST", `/${kind}`, body);
      await loadAll();
    });
  if (isAdmin()) $("#add-" + kind).onclick = () => edit(null);
  if (!isB) { $("#item-filter").oninput = renderRows; $("#item-tier").onchange = renderRows; $("#item-sort").onchange = renderRows; }
  renderRows();
  const seed = $("#seed");
  if (seed) seed.onclick = seedData;
}

async function seedData() {
  const names = t("seed.items", { returnObjects: true }), bnames = t("seed.buildings", { returnObjects: true });
  const it = {};
  for (const [k, icon] of [["ore", "⛏️"], ["ingot", "🧱"], ["plate", "📄"], ["rod", "📏"], ["screw", "🔩"]])
    it[k] = (await api("POST", "/items", { name: names[k], icon })).id;
  const b = {};
  for (const [k, icon, power, temperature] of [["smelter", "🔥", 4, 1200], ["constructor", "🏗️", 4, null]])
    b[k] = (await api("POST", "/buildings", { name: bnames[k], icon, power, temperature })).id;
  const bp = (name, building_id, out, amt, inputs) => api("POST", "/blueprints", { name, icon: "", building_id, output_item_id: out, output_amount: amt, inputs: inputs.map(([item_id, amount]) => ({ item_id, amount })) });
  await bp(names.ingot, b.smelter, it.ingot, 30, [[it.ore, 30]]);
  await bp(names.plate, b.constructor, it.plate, 20, [[it.ingot, 30]]);
  await bp(names.rod, b.constructor, it.rod, 15, [[it.ingot, 15]]);
  await bp(names.screw, b.constructor, it.screw, 40, [[it.rod, 10]]);
  await loadAll();
}

// ---------- CRUD: blueprints ----------

function renderBlueprints() {
  const host = $("#tab-blueprints");
  const v = view.blueprints;
  const sel = (val) => (val === v.status ? "selected" : "");
  host.innerHTML = `<div class="toolbar sticky">${isAdmin() ? `<button id="add-bp" class="active">${t("common.add", { what: t("kind.blueprint") })}</button>` : ""}
    <label>${t("bp.search")} <input id="bp-search" type="search" placeholder="${esc(t("bp.searchHint"))}" value="${esc(v.search)}"></label>
    <label>${t("bp.status")} <select id="bp-status"><option value="" ${sel("")}>${t("bp.allStatus")}</option><option value="unlocked" ${sel("unlocked")}>${t("bp.unlocked")}</option><option value="locked" ${sel("locked")}>${t("bp.locked")}</option></select></label></div>
    <table><thead><tr><th>${t("common.icon")}</th><th>${t("common.name")}</th><th>${t("bp.status")}</th><th class="num">${t("item.tier")}</th><th>${t("bp.building")}</th><th>${t("bp.inputsShort")}</th><th>${t("bp.outputShort")}</th><th></th></tr></thead><tbody id="bp-rows"></tbody></table>`;

  const renderRows = () => {
    v.search = $("#bp-search").value;
    v.status = $("#bp-status").value;
    const q = v.search.trim().toLocaleLowerCase();
    const tierOf = (b) => itemById(b.output_item_id)?.tier ?? 0;
    const text = (b) => [b.name, itemById(b.output_item_id)?.name, buildingById(b.building_id)?.name, ...b.inputs.map((i) => itemById(i.item_id)?.name)].join("\n").toLocaleLowerCase();
    const list = db.blueprints
      .filter((b) => (!q || text(b).includes(q)) && (!v.status || (v.status === "unlocked") === b.unlocked))
      .sort((a, b) => tierOf(a) - tierOf(b) || a.name.localeCompare(b.name));
    $("#bp-rows").innerHTML = list.map((b) => {
      const ins = b.inputs.map((i) => `${fmt(i.amount)}× ${esc(itemById(i.item_id)?.name)}`).join(", ") || "–";
      const bld = buildingById(b.building_id);
      return `<tr class="${b.unlocked ? "bp-unlocked" : "bp-locked"}"><td>${iconHtml(blueprintIcon(b))}</td><td>${esc(b.name)}</td><td class="status">${b.unlocked ? t("bp.unlocked") : t("bp.locked")}</td><td class="num">${tierOf(b)}</td><td>${bld ? iconHtml(bld.icon, bld.name) + " " + esc(bld.name) + (bld.unlocked ? "" : " 🔒") : "–"}</td>
        <td>${ins}</td><td>${fmt(b.output_amount)}× ${esc(itemById(b.output_item_id)?.name)}</td>
        <td>${auth.user ? `<button data-toggle="${b.id}">${t(b.unlocked ? "bp.lock" : "bp.unlock")}</button> ` : ""}${isAdmin() ? `<button data-edit="${b.id}">${t("common.edit")}</button> <button class="danger" data-del="${b.id}">${t("common.delete")}</button>` : ""}</td></tr>`;
    }).join("") || `<tr><td colspan="8" class="muted">${t("bp.noResults")}</td></tr>`;
    const rows = $("#bp-rows");
    rows.querySelectorAll("[data-toggle]").forEach((x) => (x.onclick = async () => {
      const b = db.blueprints.find((w) => w.id === Number(x.dataset.toggle));
      if (!b.unlocked && buildingById(b.building_id)?.unlocked === false) return toast(t("bp.buildingLocked"));
      await api("PUT", `/unlocks/blueprints/${b.id}`, { unlocked: !b.unlocked });
      await loadAll();
    }));
    rows.querySelectorAll("[data-edit]").forEach((x) => (x.onclick = () => editBlueprint(db.blueprints.find((b) => b.id === Number(x.dataset.edit)))));
    rows.querySelectorAll("[data-del]").forEach((x) => (x.onclick = async () => {
      const b = db.blueprints.find((w) => w.id === Number(x.dataset.del));
      if (!confirm(t("common.deleteConfirm", { name: b.name }))) return;
      await api("DELETE", `/blueprints/${b.id}`);
      await loadAll();
    }));
  };
  if (isAdmin()) $("#add-bp").onclick = () => editBlueprint(null);
  $("#bp-search").oninput = renderRows;
  $("#bp-status").onchange = renderRows;
  renderRows();
}

function editBlueprint(bp) {
  if (!db.items.length) return toast(t("bp.itemsFirst"));
  const itemOpts = (sel) => itemsByName().map((i) => `<option value="${i.id}" ${i.id === sel ? "selected" : ""}>${esc(i.name)}</option>`).join("");
  const inputRow = (i) => `<div class="row"><select name="in-item">${itemOpts(i?.item_id)}</select><input type="number" name="in-amt" min="0.0001" step="any" required value="${i ? i.amount : 1}"><button type="button" class="danger rm">✕</button></div>`;
  const bOpts = `<option value="">${t("bp.noBuilding")}</option>` + db.buildings.map((b) => `<option value="${b.id}" ${b.id === bp?.building_id ? "selected" : ""}>${esc(b.name)}${b.unlocked ? "" : " 🔒"}</option>`).join("");
  openDialog(t(bp ? "named.editTitle" : "named.addTitle", { what: t("kind.blueprint") }),
    `<label class="field"><span>${t("common.name")}</span><input name="name" required value="${esc(bp?.name)}"></label>
     <label class="field"><span>${t("bp.icon")}</span><input name="icon" value="${esc(bp?.icon)}"></label>
     <label class="field"><span>${t("bp.status")}</span><select name="unlocked"><option value="true" ${bp?.unlocked !== false ? "selected" : ""}>${t("bp.unlocked")}</option><option value="false" ${bp?.unlocked === false ? "selected" : ""}>${t("bp.locked")}</option></select></label>
     <label class="field"><span>${t("bp.building")}</span><select name="building">${bOpts}</select></label>
     <div class="field"><span>${t("bp.output")}</span><div class="row"><select name="out-item">${itemOpts(bp?.output_item_id)}</select><input type="number" name="out-amt" min="0.0001" step="any" required value="${bp ? bp.output_amount : 1}"></div></div>
     <div class="field"><span>${t("bp.inputs")}</span><div id="inputs">${(bp?.inputs ?? []).map(inputRow).join("")}</div><div><button type="button" id="add-in">${t("bp.addInput")}</button></div></div>`,
    async (f) => {
      const items = [...f.querySelectorAll('[name="in-item"]')].map((s) => Number(s.value));
      const amts = [...f.querySelectorAll('[name="in-amt"]')].map((s) => Number(s.value));
      const d = Object.fromEntries(new FormData(f));
      const body = {
        name: d.name.trim(), icon: d.icon.trim(),
        building_id: d.building ? Number(d.building) : null,
        output_item_id: Number(d["out-item"]), output_amount: Number(d["out-amt"]),
        unlocked: d.unlocked === "true",
        inputs: items.map((item_id, i) => ({ item_id, amount: amts[i] })),
      };
      if (body.unlocked && buildingById(body.building_id)?.unlocked === false) { toast(t("bp.buildingLocked")); return false; }
      if (bp) await api("PUT", `/blueprints/${bp.id}`, body); else await api("POST", "/blueprints", body);
      await loadAll();
    });
  const wrap = $("#inputs");
  const bind = () => wrap.querySelectorAll(".rm").forEach((b) => (b.onclick = () => b.parentElement.remove()));
  bind();
  $("#add-in").onclick = () => { wrap.insertAdjacentHTML("beforeend", inputRow(null)); bind(); };
}

// ---------- plan save / load ----------

const planData = () => JSON.stringify({ target: plan.target, rate: plan.rate, choices: plan.choices });

async function savePlan(asNew) {
  const name = $("#p-name").value.trim();
  if (!name) return toast(t("planner.nameRequired"));
  plan.name = name;
  const body = { name, data: planData() };
  const saved = plan.id && !asNew ? await api("PUT", `/plans/${plan.id}`, body) : await api("POST", "/plans", body);
  plan.id = saved.id;
  db.plans = await api("GET", "/plans");
  renderPlanner();
  toast(t("planner.saved"), true);
}

function loadPlan() {
  const p = db.plans.find((x) => x.id === Number($("#p-saved").value));
  if (!p) return;
  const d = JSON.parse(p.data);
  Object.assign(plan, { id: p.id, name: p.name, target: d.target, rate: d.rate, choices: d.choices ?? {} });
  renderPlanner();
}

// ---------- wiring ----------

function applyStaticTexts() {
  document.documentElement.lang = i18next.language;
  document.querySelectorAll("[data-i18n]").forEach((e) => (e.textContent = t(e.dataset.i18n)));
  document.querySelectorAll("[data-i18n-title]").forEach((e) => (e.title = t(e.dataset.i18nTitle)));
  document.querySelectorAll("[data-i18n-placeholder]").forEach((e) => (e.placeholder = t(e.dataset.i18nPlaceholder)));
  const counts = { planner: null, blueprints: db.blueprints.length, buildings: db.buildings.length, items: db.items.length };
  document.querySelectorAll("#tabs button").forEach((b) => {
    const n = counts[b.dataset.tab];
    b.textContent = t("tab." + b.dataset.tab) + (n == null ? "" : ` (${n})`);
  });
}

function renderAll() {
  applyStaticTexts();
  renderPlanner();
  renderBlueprints();
  renderNamed("buildings");
  renderNamed("items");
  renderManual();
  applyAuthUi();
}

// Header (Login/Logout) und Bedienelemente, die einen Benutzer erfordern
function applyAuthUi() {
  const host = $("#auth");
  if (!auth.enabled) host.innerHTML = "";
  else if (auth.user) host.innerHTML = `<span class="user">@${esc(auth.user.login)}</span> <button id="logout" type="button">${t("auth.logout")}</button>`;
  else host.innerHTML = `<a id="login" class="btn" href="/auth/login">${t("auth.login")}</a>`;
  const logout = $("#logout");
  if (logout) logout.onclick = async () => {
    try { await api("POST", "/logout"); } catch { return; }
    mpSwitchUser("");
    location.reload();
  };
  const anon = !auth.user;
  for (const id of ["p-saved", "p-load", "p-name", "p-save", "p-saveas", "p-del", "m-saved", "m-load", "m-name", "m-save", "m-saveas", "m-delplan"]) {
    const el = $("#" + id);
    el.title = anon ? t("auth.loginHint") : "";
    if (anon) el.disabled = true;
    else if (id !== "m-delplan") el.disabled = false;
  }
}

document.querySelectorAll("#tabs button").forEach((b) => (b.onclick = () => {
  document.querySelectorAll("#tabs button").forEach((x) => x.classList.toggle("active", x === b));
  document.querySelectorAll("main > section").forEach((s) => (s.hidden = s.id !== "tab-" + b.dataset.tab));
}));
document.querySelectorAll(".seg button").forEach((b) => (b.onclick = () => {
  document.querySelectorAll(".seg button").forEach((x) => x.classList.toggle("active", x === b));
  $("#view-graph").hidden = b.dataset.view !== "graph";
  $("#view-summary").hidden = b.dataset.view !== "summary";
}));
$("#p-target").onchange = (e) => { plan.target = Number(e.target.value); renderPlanner(); };
$("#p-rate-reset").onclick = () => {
  const amount = chosenBlueprint(plan.target, new Set())?.output_amount;
  if (amount > 0) { plan.rate = amount; renderPlanner(); }
};
$("#p-rate").oninput = (e) => { const v = Number(e.target.value); if (v > 0) { plan.rate = v; renderPlanner(); } };
$("#p-load").onclick = loadPlan;
$("#p-save").onclick = () => savePlan(false);
$("#p-saveas").onclick = () => savePlan(true);
$("#p-del").onclick = async () => {
  if (!plan.id || !confirm(t("planner.deleteConfirm"))) return;
  await api("DELETE", `/plans/${plan.id}`);
  plan.id = null;
  db.plans = await api("GET", "/plans");
  renderPlanner();
};

const LANG_KEY = "language";
const langSelect = $("#lang");
langSelect.innerHTML = LANGUAGES.map((l) => `<option value="${l.code}">${l.flag} ${l.label}</option>`).join("");
langSelect.onchange = async () => {
  await i18next.changeLanguage(langSelect.value);
  try { localStorage.setItem(LANG_KEY, langSelect.value); } catch { /* storage unavailable */ }
  renderAll();
};

async function init() {
  let lang = "en";
  try {
    const stored = localStorage.getItem(LANG_KEY);
    if (LANGUAGES.some((l) => l.code === stored)) lang = stored;
  } catch { /* fall back to English */ }
  await i18next.init({ lng: lang, fallbackLng: "en", supportedLngs: LANGUAGES.map((l) => l.code), resources: RESOURCES });
  langSelect.value = lang;
  applyStaticTexts();
  try {
    const me = await fetch("/api/me").then((r) => r.json());
    auth.enabled = me.auth_enabled;
    auth.user = me.user;
  } catch { /* treat as signed out */ }
  mpSwitchUser(auth.user?.login ?? "");
  await loadAll();
}

init().catch(() => {});
