"use strict";
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const t = (k, o) => i18next.t(k, o);
const fmt = (n) => (Math.round(n * 100) / 100).toLocaleString(LANGUAGES.find((l) => l.code === i18next.language)?.numbers ?? "en-US");
// Energie: positiv = Erzeugung (grün, mit "+"), negativ = Verbrauch (rot)
const powerHtml = (p) => {
  const v = Math.round((p ?? 0) * 100) / 100;
  return `<span class="${v > 0 ? "power-pos" : v < 0 ? "power-neg" : ""}">${v > 0 ? "+" : ""}${fmt(v)}</span>`;
};
const isUrl = (s) => /^(https?:|data:image\/|\/)/.test(s || "");
const BUILDING_CATEGORIES = ["extraction", "manufacturing", "processing", "transport", "defense", "power"];

const db = { items: [], buildings: [], blueprints: [], plans: [], manualPlans: [] };
const tableHeaderObservers = new WeakMap();
// Anmeldestatus (aus /api/me); ohne Login-Konfiguration ist der lokale Benutzer ein Admin
const auth = { enabled: false, user: null };
const isAdmin = () => !!auth.user?.is_admin;
const view = { items: { filter: "", tier: "", sort: "tier-name" }, blueprints: { search: "", status: "", tierFrom: "", tierTo: "" }, flow: { unlockedOnly: true, search: "" } };
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
  let imageFiles;
  [db.items, db.buildings, db.blueprints, db.plans, imageFiles, db.manualPlans] = await Promise.all([
    api("GET", "/items"), api("GET", "/buildings"), api("GET", "/blueprints"), own("/plans"), api("GET", "/images"), own("/manual-plans"),
  ]);
  for (const kind of ["items", "buildings"]) {
    imageIndex[kind] = new Map((imageFiles[kind] ?? []).map((f) => [f.replace(/\.[^.]+$/, "").toLowerCase(), f]));
  }
  renderAll();
}

const itemById = (id) => db.items.find((i) => i.id === id);
const itemsByName = () => [...db.items].sort((a, b) => a.name.localeCompare(b.name));
const buildingById = (id) => db.buildings.find((b) => b.id === id);
const bpsFor = (itemId) => db.blueprints.filter((b) => b.output_item_id === itemId && b.unlocked);
const allBpsFor = (itemId) => db.blueprints.filter((b) => b.output_item_id === itemId);

const imageIndex = { items: new Map(), buildings: new Map() };

// Priorität: explizites Icon (Emoji/URL) > Bilddatei mit dem Namen aus /images/<kind> (items | buildings) > leer
function resolveIcon(icon, name, kind = "items") {
  if (icon) return icon;
  const file = imageIndex[kind]?.get(String(name ?? "").trim().toLowerCase());
  return file ? `/images/${kind}/${encodeURIComponent(file)}` : "";
}
const blueprintIcon = (b) => resolveIcon(b.icon, b.name) || resolveIcon(itemById(b.output_item_id)?.icon, itemById(b.output_item_id)?.name);

function iconHtml(icon, name, kind) {
  icon = resolveIcon(icon, name, kind);
  return isUrl(icon) ? `<img class="icon" src="${esc(icon)}" alt="">` : `<span class="icon">${esc(icon || "▫️")}</span>`;
}
function iconSvg(icon, name, x, y, size = 24, kind) {
  icon = resolveIcon(icon, name, kind);
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

const NW = 220, NH = 74, GX = 100, GY = 24, PAD = 20, PGRID = 40;
const pv = { x: 0, y: 0, k: 1, key: null, fitted: false, moved: false, drag: null, geo: null, hover: null };

function pEdgeGeom(e) {
  const a = pv.geo.pos.get(e.from), b = pv.geo.pos.get(e.to);
  const x1 = a.x + NW, y1 = a.y + NH / 2, x2 = b.x, y2 = b.y + NH / 2, mx = (x1 + x2) / 2;
  return { x1, y1, x2, y2, mx, d: `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2 - 2},${y2}`, ly: (y1 + y2) / 2 - 4 };
}

function pApplyView() {
  const svg = $("#p-svg");
  $("#p-view")?.setAttribute("transform", `translate(${pv.x} ${pv.y}) scale(${pv.k})`);
  for (const id of ["p-grid", "p-grid5"]) {
    const p = svg.querySelector("#" + id);
    if (!p) continue;
    p.setAttribute("patternTransform", `translate(${pv.x} ${pv.y}) scale(${pv.k})`);
    p.firstElementChild.setAttribute("stroke-width", (id === "p-grid" ? 1 : 1.5) / pv.k);
  }
}

// Passt den ganzen Graphen in die sichtbare Fläche; ist der Tab gerade verborgen, wird später nachgeholt
function pFit() {
  const r = $("#p-svg").getBoundingClientRect();
  if (!pv.geo || !r.width || !r.height) { pv.fitted = false; return; }
  const k = Math.min(1, (r.width - 2 * PAD) / pv.geo.W, (r.height - 2 * PAD) / pv.geo.H);
  pv.k = Math.max(0.2, k);
  pv.x = (r.width - pv.geo.W * pv.k) / 2;
  pv.y = Math.max(PAD, (r.height - pv.geo.H * pv.k) / 2);
  pv.fitted = true;
  pApplyView();
}

function renderGraph(calc) {
  const svg = $("#p-svg");
  pv.hover = null;
  if (!calc.nodes.size) { pv.geo = null; svg.innerHTML = `<text x="16" y="28" class="muted">${t("planner.chooseTarget")}</text>`; return; }
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
  pv.geo = { pos, edges: calc.edges, W, H };
  const hasIn = new Set(calc.edges.map((e) => e.to)), hasOut = new Set(calc.edges.map((e) => e.from));
  const arrow = (id, color) => `<marker id="${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="${color}"/></marker>`;
  let s = `<defs>${arrow("arr", "#5b6678")}${arrow("arr-in", "#4aa3df")}${arrow("arr-out", "#6fcf8f")}
    <pattern id="p-grid" width="${PGRID}" height="${PGRID}" patternUnits="userSpaceOnUse"><path d="M${PGRID} 0H0V${PGRID}" fill="none" stroke="#313946"/></pattern>
    <pattern id="p-grid5" width="${PGRID * 5}" height="${PGRID * 5}" patternUnits="userSpaceOnUse"><path d="M${PGRID * 5} 0H0V${PGRID * 5}" fill="none" stroke="#4a5568"/></pattern></defs>
    <rect width="100%" height="100%" fill="url(#p-grid)"/><rect width="100%" height="100%" fill="url(#p-grid5)"/><g id="p-view"><g>`;
  for (const e of calc.edges) {
    const g = pEdgeGeom(e);
    s += `<path class="edge" marker-end="url(#arr)" d="${g.d}"/>`;
    s += `<text class="edge-label" x="${g.mx}" y="${g.ly}" text-anchor="middle">${t("graph.perMin", { amount: fmt(e.amount) })}</text>`;
  }
  s += "</g><g>";
  for (const n of calc.nodes.values()) {
    const p = pos.get(n.id);
    const b = n.bp && buildingById(n.bp.building_id);
    const options = bpsFor(n.id).length;
    const hasAlternative = options > 1 || (!n.bp && options > 0);
    const cls = "node" + (n.bp ? "" : " raw") + (n.id === plan.target ? " target" : "") + (hasAlternative ? " alt" : "");
    const line2 = n.bp ? `${Math.ceil(n.machines - 1e-9)}× ${esc(b?.name ?? t("graph.noBuilding"))} (${fmt(n.machines)})` : t("graph.resource");
    s += `<g class="${cls}" data-item="${n.id}" transform="translate(${p.x},${p.y})"><title>${esc(t("graph.clickHint"))}</title>
      <rect width="${NW}" height="${NH}" rx="8"/>
      ${iconSvg(n.item?.icon, n.item?.name, 10, 10, 28)}
      <text x="46" y="28" style="font-weight:600;font-size:13px">${esc(n.item?.name)}</text>
      <text x="46" y="46" class="muted">${t("graph.perMinSpaced", { amount: fmt(n.demand) })}</text>
      <text x="10" y="64" class="muted">${line2}</text>
      ${n.bp ? `<text x="${NW - 10}" y="28" text-anchor="end" class="muted">${esc(n.bp.name)}</text>` : ""}${hasAlternative ? `<text class="alt-badge" x="${NW - 10}" y="64" text-anchor="end">⇄</text>` : ""}
      ${hasIn.has(n.id) ? `<circle class="pport in" cx="0" cy="${NH / 2}" r="5"/>` : ""}${hasOut.has(n.id) ? `<circle class="pport out" cx="${NW}" cy="${NH / 2}" r="5"/>` : ""}</g>`;
  }
  svg.innerHTML = s + `</g><g id="p-hl"></g></g>`;
  if (!pv.fitted || pv.key !== plan.target) { pv.key = plan.target; pFit(); } else pApplyView();
}

// Hebt beim Überfahren einer Node deren Ein- (blau) und Ausgänge (grün) hervor und zeichnet sie über alle anderen Nodes
function pHighlight(id) {
  if (pv.hover === id) return;
  pv.hover = id;
  const svg = $("#p-svg"), hl = $("#p-hl");
  if (!hl || !pv.geo) return;
  svg.querySelectorAll(".linked-in, .linked-out").forEach((el) => el.classList.remove("linked-in", "linked-out"));
  svg.classList.toggle("hl", id != null);
  hl.innerHTML = "";
  if (id == null) return;
  let s = "";
  for (const e of pv.geo.edges) {
    const isIn = e.to === id;
    if (!isIn && e.from !== id) continue;
    const cls = isIn ? "in" : "out";
    svg.querySelector(`.node[data-item="${isIn ? e.from : e.to}"]`)?.classList.add(isIn ? "linked-in" : "linked-out");
    const g = pEdgeGeom(e);
    s += `<path class="edge-hl ${cls}" marker-end="url(#arr-${cls})" d="${g.d}"/>
      <circle class="port-hl ${cls}" cx="${g.x1}" cy="${g.y1}" r="6"/><circle class="port-hl ${cls}" cx="${g.x2}" cy="${g.y2}" r="6"/>
      <text class="edge-label hl" x="${g.mx}" y="${g.ly}" text-anchor="middle">${t("graph.perMin", { amount: fmt(e.amount) })}</text>`;
  }
  hl.innerHTML = s;
}

function pInit() {
  const svg = $("#p-svg");
  svg.addEventListener("mousedown", (e) => {
    if (e.button !== 0 && e.button !== 1) return;
    pv.drag = { sx: e.clientX, sy: e.clientY, vx: pv.x, vy: pv.y };
    pv.moved = false;
    if (e.button === 1) e.preventDefault();
  });
  window.addEventListener("mousemove", (e) => {
    const d = pv.drag;
    if (!d) return;
    if (!pv.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 4) return;
    pv.moved = true;
    svg.classList.add("panning");
    pv.x = d.vx + e.clientX - d.sx;
    pv.y = d.vy + e.clientY - d.sy;
    pApplyView();
  });
  window.addEventListener("mouseup", () => { pv.drag = null; svg.classList.remove("panning"); });
  svg.addEventListener("click", (e) => {
    if (pv.moved) { pv.moved = false; return; }
    const node = e.target.closest(".node");
    if (node) chooseBlueprint(Number(node.dataset.item));
  });
  svg.addEventListener("mouseover", (e) => {
    const node = e.target.closest(".node");
    pHighlight(node ? Number(node.dataset.item) : null);
  });
  svg.addEventListener("mouseleave", () => pHighlight(null));
  svg.addEventListener("wheel", (e) => {
    e.preventDefault();
    const r = svg.getBoundingClientRect();
    const px = e.clientX - r.left, py = e.clientY - r.top;
    const k = Math.min(4, Math.max(0.2, pv.k * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
    pv.x = px - ((px - pv.x) / pv.k) * k;
    pv.y = py - ((py - pv.y) / pv.k) * k;
    pv.k = k;
    pApplyView();
  }, { passive: false });
  $("#p-center").onclick = pFit;
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
    `<tr><td>${e.b ? iconHtml(e.b.icon, e.b.name, "buildings") + " " + esc(e.b.name) : "<i>" + t("summary.noBuilding") + "</i>"}</td><td class="num">${e.count}</td><td class="num">${fmt(e.exact)}</td><td class="num">${powerHtml(e.count * (e.b?.power ?? 0))}</td><td class="num">${e.b?.temperature == null ? "–" : fmt(e.b.temperature)}</td><td>${esc(e.outputs.join(", "))}</td></tr>`).join("");
  const rRows = res.sort((a, b) => b.demand - a.demand).map((n) =>
    `<tr><td>${iconHtml(n.item?.icon, n.item?.name)} ${esc(n.item?.name)}</td><td class="num">${fmt(n.demand)}</td></tr>`).join("");
  host.innerHTML = `<div class="cols">
    <div><h2>${t("summary.buildings")}</h2><table><tr><th>${t("summary.building")}</th><th class="num">${t("summary.count")}</th><th class="num">${t("summary.utilization")}</th><th class="num">${t("summary.power")}</th><th class="num">${t("summary.temp")}</th><th>${t("summary.produces")}</th></tr>${bRows || `<tr><td colspan="6">–</td></tr>`}
      ${bRows ? `<tr><th>${t("summary.total")}</th><th></th><th></th><th class="num">${powerHtml(totalPower)}</th><th></th><th></th></tr>` : ""}</table></div>
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

function stickTableHeader(host) {
  const toolbar = $(".toolbar.sticky", host);
  const table = $("table.sticky-head", host);
  if (!toolbar || !table) return;

  tableHeaderObservers.get(host)?.disconnect();
  const updateOffset = () => table.style.setProperty("--sticky-toolbar-height", `${toolbar.offsetHeight}px`);
  const observer = new ResizeObserver(updateOffset);
  observer.observe(toolbar);
  tableHeaderObservers.set(host, observer);
  updateOffset();
}

function renderNamed(kind) {
  const host = $("#tab-" + kind);
  const isB = kind === "buildings";
  const what = t(isB ? "kind.building" : "kind.item");
  const v = view.items;
  const sel = (val, cur) => (val === cur ? "selected" : "");
  const controls = isB ? "" : `<label>${t("item.filter")} <input id="item-filter" value="${esc(v.filter)}"></label><label>${t("item.tier")} <select id="item-tier"><option value="">${t("item.allTiers")}</option>${[...new Set(db.items.map((i) => i.tier))].sort((a, b) => a - b).map((tier) => `<option ${sel(String(tier), v.tier)}>${tier}</option>`).join("")}</select></label><label>${t("item.sort")} <select id="item-sort"><option value="tier-name" ${sel("tier-name", v.sort)}>${t("item.sortTierName")}</option><option value="name" ${sel("name", v.sort)}>${t("item.sortName")}</option><option value="tier" ${sel("tier", v.sort)}>${t("item.sortTier")}</option></select></label>`;
  host.innerHTML = `<div class="toolbar sticky">${isAdmin() ? `<button id="add-${kind}" class="active">${t("common.add", { what })}</button>` : ""}${controls}${kind === "items" && !db.items.length && isAdmin() ? `<button id="seed">${t("named.seed")}</button>` : ""}</div>
    <table class="sticky-head"><thead><tr><th>${t("common.icon")}</th><th>${t("common.name")}</th>${isB ? `<th>${t("named.category")}</th><th>${t("bp.status")}</th><th class="num">${t("named.powerShort")}</th><th class="num">${t("named.tempShort")}</th><th class="num">${t("named.areaShort")}</th>` : `<th class="num">${t("item.tier")}</th>`}<th></th></tr></thead><tbody id="${kind}-rows"></tbody></table>`;
  stickTableHeader(host);
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
    $("#"+kind+"-rows").innerHTML = list.map((n) => `<tr${isB ? ` class="${n.unlocked ? "bp-unlocked" : "bp-locked"}"` : ""}><td>${iconHtml(n.icon, n.name, kind)}</td><td>${esc(n.name)}</td>${isB ? `<td>${n.category ? esc(t("category." + n.category)) : "–"}</td><td class="status">${n.unlocked ? t("bp.unlocked") : t("bp.locked")}</td><td class="num">${powerHtml(n.power)}</td><td class="num">${n.temperature == null ? "–" : fmt(n.temperature)}</td><td class="num">${[n.build_area, n.build_area2].filter(Boolean).map(esc).join(" / ") || "–"}</td>` : `<td class="num">${n.tier}</td>`}    <td>${isB && auth.user ? `<button data-toggle="${n.id}">${t(n.unlocked ? "bp.lock" : "bp.unlock")}</button> ` : ""}${isAdmin() ? `<button data-edit="${n.id}">${t("common.edit")}</button> <button class="danger" data-del="${n.id}">${t("common.delete")}</button>` : ""}</td></tr>`).join("");
    $("#"+kind+"-rows").querySelectorAll("[data-toggle]").forEach((b) => (b.onclick = async () => {
      const n = db.buildings.find((x) => x.id === Number(b.dataset.toggle));
      const body = { unlocked: !n.unlocked };
      if (body.unlocked) {
        const locked = db.blueprints.filter((bp) => bp.building_id === n.id && !bp.unlocked).length;
        if (locked && confirm(t("named.unlockBlueprints", { name: n.name, count: locked }))) body.with_blueprints = true;
      }
      await api("PUT", `/unlocks/buildings/${n.id}`, body);
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
     <label class="field"><span>${t("named.power")}</span><input type="number" name="power" step="any" value="${n?.power ?? 0}"></label>
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
      let query = "";
      if (isB && n && !n.unlocked && body.unlocked) {
        const locked = db.blueprints.filter((bp) => bp.building_id === n.id && !bp.unlocked).length;
        if (locked && confirm(t("named.unlockBlueprints", { name: n.name, count: locked }))) query = "?with_blueprints=true";
      }
      if (n) await api("PUT", `/${kind}/${n.id}${query}`, body); else await api("POST", `/${kind}`, body);
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
  for (const [k, icon, power, temperature] of [["smelter", "🔥", -4, 1200], ["constructor", "🏗️", -4, null]])
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
    <label>${t("bp.status")} <select id="bp-status"><option value="" ${sel("")}>${t("bp.allStatus")}</option><option value="unlocked" ${sel("unlocked")}>${t("bp.unlocked")}</option><option value="locked" ${sel("locked")}>${t("bp.locked")}</option></select></label>
    ${auth.user ? `<span class="sep"></span><label>${t("bp.tierRange")} <input id="bp-tier-from" type="number" min="0" step="1" class="tier-in" placeholder="${t("bp.tierFrom")}" value="${esc(v.tierFrom)}"> – <input id="bp-tier-to" type="number" min="0" step="1" class="tier-in" placeholder="${t("bp.tierTo")}" value="${esc(v.tierTo)}"></label>
    <button id="bp-tier-unlock" type="button">${t("bp.unlockTier")}</button><button id="bp-tier-lock" type="button">${t("bp.lockTier")}</button>` : ""}</div>
    <table class="sticky-head"><thead><tr><th>${t("common.icon")}</th><th>${t("common.name")}</th><th>${t("bp.status")}</th><th class="num">${t("item.tier")}</th><th>${t("bp.building")}</th><th>${t("bp.inputsShort")}</th><th>${t("bp.outputShort")}</th><th></th></tr></thead><tbody id="bp-rows"></tbody></table>`;
  stickTableHeader(host);

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
      return `<tr class="${b.unlocked ? "bp-unlocked" : "bp-locked"}"><td>${iconHtml(blueprintIcon(b))}</td><td>${esc(b.name)}</td><td class="status">${b.unlocked ? t("bp.unlocked") : t("bp.locked")}</td><td class="num">${tierOf(b)}</td><td>${bld ? iconHtml(bld.icon, bld.name, "buildings") + " " + esc(bld.name) + (bld.unlocked ? "" : " 🔒") : "–"}</td>
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
  if (auth.user) {
    const bulk = async (unlocked) => {
      v.tierFrom = $("#bp-tier-from").value.trim();
      v.tierTo = $("#bp-tier-to").value.trim();
      if (v.tierFrom === "" && v.tierTo === "") return toast(t("bp.tierMissing"));
      const from = Number(v.tierFrom === "" ? v.tierTo : v.tierFrom), to = Number(v.tierTo === "" ? v.tierFrom : v.tierTo);
      if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || from > to) return toast(t("bp.tierInvalid"));
      const count = db.blueprints.filter((b) => { const tier = itemById(b.output_item_id)?.tier ?? 0; return tier >= from && tier <= to; }).length;
      if (!count) return toast(t("bp.tierNone"));
      const range = from === to ? String(from) : `${from}–${to}`;
      if (!confirm(t(unlocked ? "bp.unlockTierConfirm" : "bp.lockTierConfirm", { count, range }))) return;
      const res = await api("PUT", "/unlocks/blueprints", { unlocked, tier_min: from, tier_max: to });
      await loadAll();
      toast(t("bp.tierDone", { changed: res.changed, skipped: res.skipped }), true);
    };
    $("#bp-tier-unlock").onclick = () => bulk(true);
    $("#bp-tier-lock").onclick = () => bulk(false);
  }
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

// ---------- material flow matrix ----------

// Zeilen = produzierte Items (Output), Spalten = benötigte Items (Input). Beide Achsen sind nach Produktionsstufe sortiert,
// sodass jede Zelle unterhalb der Diagonale liegt und eine Spalte von oben nach unten dem Weg des Items durch die Kette folgt.
function renderFlow() {
  const host = $("#tab-flow");
  const v = view.flow;
  host.innerHTML = `<div class="toolbar sticky">
    <label><input id="fl-unlocked" type="checkbox" ${v.unlockedOnly ? "checked" : ""}> ${t("flow.unlockedOnly")}</label>
    <label>${t("flow.search")} <input id="fl-search" type="search" value="${esc(v.search)}"></label>
    <span class="info">${t("flow.info")}</span></div><div id="fl-body"></div>`;

  const draw = () => {
    v.unlockedOnly = $("#fl-unlocked").checked;
    v.search = $("#fl-search").value;
    const q = v.search.trim().toLocaleLowerCase();
    const bps = db.blueprints.filter((b) => !v.unlockedOnly || b.unlocked);

    const cell = new Map(); // "out>in" -> Set(amount)
    const outs = new Set(), ins = new Set();
    for (const b of bps) {
      for (const inp of b.inputs) {
        outs.add(b.output_item_id);
        ins.add(inp.item_id);
        const k = b.output_item_id + ">" + inp.item_id;
        if (!cell.has(k)) cell.set(k, new Set());
        cell.get(k).add(inp.amount);
      }
    }

    const inputsOf = new Map();
    for (const b of bps) inputsOf.set(b.output_item_id, [...(inputsOf.get(b.output_item_id) ?? []), ...b.inputs.map((i) => i.item_id)]);
    const level = new Map();
    const levelOf = (id, stack = new Set()) => {
      if (level.has(id)) return level.get(id);
      if (stack.has(id)) return 0;
      stack.add(id);
      const l = Math.max(-1, ...(inputsOf.get(id) ?? []).map((i) => levelOf(i, stack))) + 1;
      stack.delete(id);
      level.set(id, l);
      return l;
    };
    const order = (a, b) => levelOf(a) - levelOf(b) || (itemById(a)?.tier ?? 0) - (itemById(b)?.tier ?? 0) || String(itemById(a)?.name).localeCompare(itemById(b)?.name);
    const rows = [...outs].filter((id) => itemById(id)).sort(order);
    const cols = [...ins].filter((id) => itemById(id)).sort(order);
    const matches = (id) => !q || itemById(id).name.toLocaleLowerCase().includes(q);
    const shownRows = rows.filter(matches), shownCols = cols.filter(matches);

    // Ein Input belegt das Transportnetz von seiner ersten bis zur letzten Verwendung (Zeilenindex in `rows`)
    const span = new Map();
    for (const c of shownCols) {
      const used = rows.map((r, i) => (cell.has(r + ">" + c) ? i : -1)).filter((i) => i >= 0);
      if (used.length) span.set(c, [used[0], used[used.length - 1]]);
    }

    if (!shownRows.length || !shownCols.length) {
      $("#fl-body").innerHTML = `<p class="muted">${t("flow.empty")}</p>`;
      return;
    }
    const head = shownCols.map((c, ci) => {
      const it = itemById(c);
      const uses = shownRows.filter((r) => cell.has(r + ">" + c)).length;
      return `<th class="fl-col" data-c="${ci}" title="${esc(t("flow.usedBy", { count: uses }))}"><div>${iconHtml(it.icon, it.name)}<span>${esc(it.name)}</span></div></th>`;
    }).join("");
    const body = shownRows.map((r) => {
      const it = itemById(r);
      const ri = rows.indexOf(r);
      const tds = shownCols.map((c, ci) => {
        const amounts = cell.get(r + ">" + c);
        const [first, last] = span.get(c) ?? [-1, -1];
        if (amounts) {
          const edge = ri === first ? " first" : ri === last ? " last" : "";
          const title = `${itemById(c).name} → ${it.name}`;
          return `<td class="fl-use${edge}" data-c="${ci}" title="${esc(title)}">${[...amounts].map(fmt).join(" / ")}</td>`;
        }
        return `<td class="${ri > first && ri < last ? "fl-gap" : ""}" data-c="${ci}"></td>`;
      }).join("");
      return `<tr data-r="${ri}"><th class="fl-row">${iconHtml(it.icon, it.name)} ${esc(it.name)}<span class="muted"> · ${t("item.tier")} ${it.tier ?? 0}</span></th>${tds}</tr>`;
    }).join("");
    const host$ = $("#fl-body");
    host$.innerHTML = `<div class="flow-wrap"><table class="flow"><thead><tr><th class="fl-corner">${t("flow.corner")}</th>${head}</tr></thead><tbody>${body}</tbody></table></div>`;

    const table = host$.querySelector("table");
    const mark = (r, c, on) => {
      table.querySelectorAll(`tbody tr[data-r="${r}"]`).forEach((e) => e.classList.toggle("hl", on));
      table.querySelectorAll(`[data-c="${c}"]`).forEach((e) => e.classList.toggle("hl", on));
    };
    let cur = null;
    table.onmouseover = (e) => {
      const td = e.target.closest("td,th.fl-col,th.fl-row");
      if (!td || !table.contains(td)) return;
      const next = [td.parentElement.dataset.r ?? "", td.dataset.c ?? ""];
      if (cur) mark(cur[0], cur[1], false);
      cur = next;
      mark(cur[0], cur[1], true);
    };
    table.onmouseleave = () => { if (cur) mark(cur[0], cur[1], false); cur = null; };
  };
  $("#fl-unlocked").onchange = draw;
  $("#fl-search").oninput = draw;
  draw();
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
  renderFlow();
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
  if (!pv.fitted) pFit();
}));
document.querySelectorAll(".seg button").forEach((b) => (b.onclick = () => {
  document.querySelectorAll(".seg button").forEach((x) => x.classList.toggle("active", x === b));
  $("#view-graph").hidden = b.dataset.view !== "graph";
  $("#view-summary").hidden = b.dataset.view !== "summary";
  if (!pv.fitted) pFit();
}));
pInit();
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
