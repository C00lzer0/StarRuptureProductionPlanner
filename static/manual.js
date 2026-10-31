"use strict";
// Manueller Planer: Gebäude auf einem Raster platzieren und verbinden.
// 1 Rasterzelle = 1 Baueinheit des Gebäudes (z.B. 6*8 = 6x8 Zellen); CELL = Pixel pro Zelle bei Zoom 1.
// Eingänge liegen lokal immer an der oberen, der Ausgang an der unteren X-Achse des Gebäudes; Rotation dreht beides mit.
const CELL = 40, STORE_KEY = "manualPlan.v1";
const mp = { nodes: [], links: [], view: { x: 40, y: 40, k: 1 }, nextId: 1, sel: null, place: null, drag: null, mouse: { x: 0, y: 0 }, planId: null, planName: "", owner: "" };

const parseArea = (s) => { const m = /^\s*(\d+)\s*\*\s*(\d+)\s*$/.exec(s || ""); return m ? [Number(m[1]), Number(m[2])] : null; };
const sizesOf = (b) => [parseArea(b?.build_area), parseArea(b?.build_area2)].filter(Boolean);
const mpBps = (bid) => db.blueprints.filter((b) => b.building_id === bid);
const mpDims = (n) => (n.rot % 2 ? [n.h, n.w] : [n.w, n.h]);
const mpNode = (id) => mp.nodes.find((n) => n.id === id);
const mpDefaultBp = (bid) => (mpBps(bid).find((b) => b.unlocked) ?? mpBps(bid)[0])?.id ?? null;

function mpSave() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify({ nodes: mp.nodes, links: mp.links, view: mp.view, nextId: mp.nextId, planId: mp.planId, planName: mp.planName, owner: mp.owner })); } catch { /* storage unavailable */ }
}
function mpLoad() {
  try {
    const d = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
    if (d) Object.assign(mp, { nodes: d.nodes ?? [], links: d.links ?? [], view: d.view ?? mp.view, nextId: d.nextId ?? 1, planId: d.planId ?? null, planName: d.planName ?? "", owner: d.owner ?? "" });
  } catch { /* ignore broken data */ }
}

// Der Entwurf im Browser gehört dem angemeldeten Benutzer: bei anderem Benutzer (oder nach dem Abmelden)
// wird er verworfen. Ein Entwurf ohne Besitzer (abgemeldet gezeichnet) wird vom Anmeldenden übernommen.
function mpSwitchUser(login) {
  if (mp.owner && mp.owner !== login) Object.assign(mp, { nodes: [], links: [], nextId: 1, planId: null, planName: "", sel: null, place: null, drag: null });
  mp.owner = login;
  mpSave();
}

// Gespeichert wird nur das Layout; die Ansicht (Zoom/Position) gehört nicht zum Plan
const mpPlanData = () => JSON.stringify({ nodes: mp.nodes, links: mp.links, nextId: mp.nextId });

async function mpSavePlan(asNew) {
  const name = $("#m-name").value.trim();
  if (!name) return toast(t("planner.nameRequired"));
  mp.planName = name;
  const body = { name, data: mpPlanData() };
  const saved = mp.planId && !asNew ? await api("PUT", `/manual-plans/${mp.planId}`, body) : await api("POST", "/manual-plans", body);
  mp.planId = saved.id;
  db.manualPlans = await api("GET", "/manual-plans");
  mpSave();
  renderManual();
  toast(t("planner.saved"), true);
}

function mpLoadPlan() {
  const p = db.manualPlans.find((x) => x.id === Number($("#m-saved").value));
  if (!p) return;
  let d;
  try { d = JSON.parse(p.data); } catch { return toast(t("err.invalid")); }
  Object.assign(mp, { nodes: d.nodes ?? [], links: d.links ?? [], nextId: d.nextId ?? 1, planId: p.id, planName: p.name, sel: null, place: null, drag: null });
  mpSave();
  renderManual();
}

async function mpDeletePlan() {
  if (!mp.planId || !confirm(t("planner.deleteConfirm"))) return;
  await api("DELETE", `/manual-plans/${mp.planId}`);
  mp.planId = null;
  db.manualPlans = await api("GET", "/manual-plans");
  mpSave();
  renderManual();
}

function mpNewPlan() {
  if (mp.nodes.length && !confirm(t("manual.newConfirm"))) return;
  Object.assign(mp, { nodes: [], links: [], nextId: 1, planId: null, planName: "", sel: null, place: null, drag: null });
  mpSave();
  renderManual();
}

const rotPoint = (rot, x, y, w, h) => [[x, y], [h - y, x], [w - x, h - y], [y, w - x]][rot];
const rotVec = (rot, x, y) => [[x, y], [-y, x], [-x, -y], [y, -x]][rot];

function mpPorts(n) {
  const bp = db.blueprints.find((b) => b.id === n.bp);
  if (!bp) return [];
  const [dw, dh] = mpDims(n);
  const mk = (kind, idx, item, amount, lx, ly, vx, vy) => {
    const [px, py] = rotPoint(n.rot, lx, ly, n.w, n.h);
    const [nx, ny] = rotVec(n.rot, vx, vy);
    return { node: n.id, kind, idx, item, amount, x: n.x + px, y: n.y + py, nx, ny, dw, dh };
  };
  const ins = bp.inputs ?? [];
  const ports = ins.map((inp, i) => {
    return mk("in", i, inp.item_id, inp.amount, ((i + 0.5) * n.w) / ins.length, 0, 0, 1);
  });
  ports.push(mk("out", 0, bp.output_item_id, bp.output_amount, n.w / 2, n.h, 0, -1));
  return ports;
}
const mpPort = (nodeId, kind, idx) => { const n = mpNode(nodeId); return n && mpPorts(n).find((p) => p.kind === kind && p.idx === idx); };

function mpOverlaps(n, ignoreId) {
  const [w, h] = mpDims(n);
  return mp.nodes.some((o) => {
    if (o.id === ignoreId) return false;
    const [ow, oh] = mpDims(o);
    return n.x < o.x + ow && o.x < n.x + w && n.y < o.y + oh && o.y < n.y + h;
  });
}

function mpToWorld(e) {
  const r = $("#m-svg").getBoundingClientRect();
  return { x: (e.clientX - r.left - mp.view.x) / mp.view.k / CELL, y: (e.clientY - r.top - mp.view.y) / mp.view.k / CELL };
}

function mpGhost() {
  if (!mp.place) return null;
  const b = buildingById(mp.place.bid);
  const [w, h] = sizesOf(b)[mp.place.size] ?? [1, 1];
  const n = { id: 0, bid: b.id, bp: mpDefaultBp(b.id), w, h, rot: mp.place.rot, x: 0, y: 0 };
  const [dw, dh] = mpDims(n);
  n.x = Math.round(mp.mouse.x - dw / 2);
  n.y = Math.round(mp.mouse.y - dh / 2);
  return n;
}

function mpPath(a, b) {
  const d = 60 / CELL * 1;
  const c1 = [a.x - a.nx * d, a.y - a.ny * d], c2 = [b.x - b.nx * d, b.y - b.ny * d];
  const P = (p) => `${p[0] * CELL},${p[1] * CELL}`;
  return `M${P([a.x, a.y])} C${P(c1)} ${P(c2)} ${P([b.x, b.y])}`;
}

function mpNodeSvg(n, ghost, bad) {
  const b = buildingById(n.bid);
  const [w, h] = mpDims(n);
  const px = w * CELL, py = h * CELL, x = n.x * CELL, y = n.y * CELL;
  const bp = db.blueprints.find((q) => q.id === n.bp);
  const sel = mp.sel?.type === "n" && mp.sel.id === n.id;
  const maxChars = Math.max(4, Math.floor(px / 6));
  const name = bp ? (bp.name.length > maxChars ? bp.name.slice(0, maxChars - 1) + "…" : bp.name) : "?";
  let s = `<g class="mnode${sel ? " sel" : ""}${ghost ? " ghost" : ""}${bad ? " bad" : ""}" data-node="${n.id}">
    <title>${esc(b?.name)} (${n.w}*${n.h})</title>
    <rect x="${x}" y="${y}" width="${px}" height="${py}" rx="4"/>
    ${iconSvg(b?.icon, b?.name, x + px / 2 - 14, y + py / 2 - 24, 28)}
    <text x="${x + px / 2}" y="${y + py / 2 + 20}" text-anchor="middle" class="mlabel">${esc(name)}</text>`;
  for (const p of mpPorts(n)) {
    const it = itemById(p.item);
    const cx = p.x * CELL, cy = p.y * CELL;
    const title = `${p.kind === "in" ? "⬅" : "➡"} ${it?.name ?? ""} (${fmt(p.amount)}/min)`;
    s += `<g class="mport ${p.kind}" data-port="${p.node}:${p.kind}:${p.idx}"><title>${esc(title)}</title>
      <circle cx="${cx}" cy="${cy}" r="8"/>
      ${iconSvg(it?.icon, it?.name, cx + p.nx * 16 - 8, cy + p.ny * 16 - 8, 16)}</g>`;
  }
  return s + "</g>";
}

function mpRender() {
  const host = $("#m-svg");
  if (!host) return;
  const v = mp.view;
  let s = `<defs>
    <pattern id="m-grid" width="${CELL}" height="${CELL}" patternUnits="userSpaceOnUse" patternTransform="translate(${v.x} ${v.y}) scale(${v.k})">
      <path d="M${CELL} 0H0V${CELL}" fill="none" stroke="#313946" stroke-width="${1 / v.k}"/></pattern>
    <pattern id="m-grid5" width="${CELL * 5}" height="${CELL * 5}" patternUnits="userSpaceOnUse" patternTransform="translate(${v.x} ${v.y}) scale(${v.k})">
      <path d="M${CELL * 5} 0H0V${CELL * 5}" fill="none" stroke="#4a5568" stroke-width="${1.5 / v.k}"/></pattern></defs>
    <rect width="100%" height="100%" fill="url(#m-grid)"/><rect width="100%" height="100%" fill="url(#m-grid5)"/>
    <g transform="translate(${v.x} ${v.y}) scale(${v.k})">`;
  for (const l of mp.links) {
    const a = mpPort(l.from, "out", 0), b = mpPort(l.to, "in", l.idx);
    if (!a || !b) continue;
    const sel = mp.sel?.type === "l" && mp.sel.id === l.id;
    s += `<path class="mlink-hit" data-link="${l.id}" d="${mpPath(a, b)}"/><path class="mlink${sel ? " sel" : ""}" d="${mpPath(a, b)}"/>`;
  }
  for (const n of mp.nodes) s += mpNodeSvg(n, false, false);
  const g = mpGhost();
  if (g) s += mpNodeSvg(g, true, mpOverlaps(g));
  if (mp.drag?.type === "connect") {
    const a = mp.drag.port;
    s += `<path class="mlink pending" d="${mpPath(a, { x: mp.mouse.x, y: mp.mouse.y, nx: -a.nx, ny: -a.ny })}"/>`;
  }
  host.innerHTML = s + "</g>";
  mpToolbar();
}

function mpToolbar() {
  const n = mp.sel?.type === "n" ? mpNode(mp.sel.id) : null;
  const sel = $("#m-bp");
  const cur = n ? mpBps(n.bid) : [];
  sel.innerHTML = cur.map((b) => `<option value="${b.id}">${esc(b.name)}</option>`).join("");
  sel.disabled = !n || !cur.length;
  if (n?.bp) sel.value = n.bp;
  const target = mp.place ? { bid: mp.place.bid, size: mp.place.size } : n ? { bid: n.bid, size: n.w === sizesOf(buildingById(n.bid))[1]?.[0] && n.h === sizesOf(buildingById(n.bid))[1]?.[1] ? 1 : 0 } : null;
  const sizes = target ? sizesOf(buildingById(target.bid)) : [];
  $("#m-size").textContent = sizes.length ? sizes.map((z, i) => (i === target.size ? `[${z[0]}*${z[1]}]` : `${z[0]}*${z[1]}`)).join(" / ") : "–";
  $("#m-size").disabled = sizes.length < 2;
  $("#m-del").disabled = !mp.sel;
  $("#m-rot-l").disabled = $("#m-rot-r").disabled = !(mp.place || n);
}

function mpFixLinks() {
  mp.links = mp.links.filter((l) => {
    const a = mpPort(l.from, "out", 0), b = mpPort(l.to, "in", l.idx);
    return a && b && a.item === b.item;
  });
}

function mpSelect(sel) { mp.sel = sel; mpRender(); }

function mpRotate(dir) {
  if (mp.place) mp.place.rot = (mp.place.rot + dir + 4) % 4;
  else if (mp.sel?.type === "n") {
    const n = mpNode(mp.sel.id);
    const old = n.rot;
    n.rot = (n.rot + dir + 4) % 4;
    if (mpOverlaps(n, n.id)) { n.rot = old; toast(t("manual.overlap")); }
    mpSave();
  }
  mpRender();
}

function mpCycleSize() {
  if (mp.place) {
    const n = sizesOf(buildingById(mp.place.bid)).length;
    mp.place.size = (mp.place.size + 1) % Math.max(n, 1);
  } else if (mp.sel?.type === "n") {
    const n = mpNode(mp.sel.id);
    const sizes = sizesOf(buildingById(n.bid));
    if (sizes.length < 2) return;
    const i = sizes.findIndex((z) => z[0] === n.w && z[1] === n.h);
    const [w, h] = sizes[(i + 1) % sizes.length];
    const old = [n.w, n.h];
    [n.w, n.h] = [w, h];
    if (mpOverlaps(n, n.id)) { [n.w, n.h] = old; toast(t("manual.overlap")); }
    else { mpFixLinks(); mpSave(); }
  }
  mpRender();
}

function mpDelete() {
  if (!mp.sel) return;
  if (mp.sel.type === "n") {
    mp.nodes = mp.nodes.filter((n) => n.id !== mp.sel.id);
    mp.links = mp.links.filter((l) => l.from !== mp.sel.id && l.to !== mp.sel.id);
  } else mp.links = mp.links.filter((l) => l.id !== mp.sel.id);
  mp.sel = null;
  mpSave();
  mpRender();
}

function mpTryConnect(a, b) {
  if (a.kind === b.kind || a.node === b.node) return;
  const [o, i] = a.kind === "out" ? [a, b] : [b, a];
  if (o.item !== i.item) { toast(t("manual.mismatch")); return; }
  mp.links = mp.links.filter((l) => !(l.to === i.node && l.idx === i.idx));
  mp.links.push({ id: mp.nextId++, from: o.node, to: i.node, idx: i.idx });
  mpSave();
}

function mpInit() {
  const svg = $("#m-svg");
  mpLoad();

  svg.addEventListener("mousedown", (e) => {
    mp.mouse = mpToWorld(e);
    svg.focus();
    if (e.button === 2) return;
    const portEl = e.target.closest("[data-port]");
    const nodeEl = e.target.closest("[data-node]");
    if (e.button === 1) { mp.drag = { type: "pan", sx: e.clientX, sy: e.clientY, vx: mp.view.x, vy: mp.view.y }; e.preventDefault(); return; }
    if (mp.place) {
      const g = mpGhost();
      if (mpOverlaps(g)) { toast(t("manual.overlap")); return; }
      const n = { ...g, id: mp.nextId++ };
      mp.nodes.push(n);
      mp.sel = { type: "n", id: n.id };
      mpSave();
      mpRender();
      return;
    }
    if (portEl) {
      const [nid, kind, idx] = portEl.dataset.port.split(":");
      const port = mpPort(Number(nid), kind, Number(idx));
      if (port) mp.drag = { type: "connect", port };
    } else if (nodeEl) {
      const n = mpNode(Number(nodeEl.dataset.node));
      mp.sel = { type: "n", id: n.id };
      mp.drag = { type: "move", id: n.id, ox: mp.mouse.x - n.x, oy: mp.mouse.y - n.y, from: [n.x, n.y] };
    } else if (e.target.dataset.link) {
      mp.sel = { type: "l", id: Number(e.target.dataset.link) };
    } else {
      mp.sel = null;
      mp.drag = { type: "pan", sx: e.clientX, sy: e.clientY, vx: mp.view.x, vy: mp.view.y };
    }
    mpRender();
  });

  window.addEventListener("mousemove", (e) => {
    if (!mp.drag && !mp.place) return;
    mp.mouse = mpToWorld(e);
    const d = mp.drag;
    if (d?.type === "pan") {
      mp.view.x = d.vx + e.clientX - d.sx;
      mp.view.y = d.vy + e.clientY - d.sy;
    } else if (d?.type === "move") {
      const n = mpNode(d.id);
      n.x = Math.round(mp.mouse.x - d.ox);
      n.y = Math.round(mp.mouse.y - d.oy);
      d.bad = mpOverlaps(n, n.id);
    }
    mpRender();
  });

  window.addEventListener("mouseup", (e) => {
    const d = mp.drag;
    if (!d) return;
    mp.drag = null;
    if (d.type === "move") {
      const n = mpNode(d.id);
      if (mpOverlaps(n, n.id)) { [n.x, n.y] = d.from; toast(t("manual.overlap")); }
    } else if (d.type === "connect") {
      const portEl = document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-port]");
      if (portEl) {
        const [nid, kind, idx] = portEl.dataset.port.split(":");
        const port = mpPort(Number(nid), kind, Number(idx));
        if (port) mpTryConnect(d.port, port);
      }
    }
    mpSave();
    mpRender();
  });

  svg.addEventListener("contextmenu", (e) => { e.preventDefault(); if (mp.place) { mp.place = null; $("#m-building").value = ""; mpRender(); } });

  svg.addEventListener("wheel", (e) => {
    e.preventDefault();
    const r = svg.getBoundingClientRect();
    const px = e.clientX - r.left, py = e.clientY - r.top;
    const v = mp.view;
    const k = Math.min(4, Math.max(0.2, v.k * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
    v.x = px - ((px - v.x) / v.k) * k;
    v.y = py - ((py - v.y) / v.k) * k;
    v.k = k;
    mpSave();
    mpRender();
  }, { passive: false });

  document.addEventListener("keydown", (e) => {
    if ($("#tab-manual").hidden || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    const key = e.key.toLowerCase();
    if (key === "x" && e.ctrlKey) { e.preventDefault(); mpCycleSize(); }
    else if (key === "r" && !e.ctrlKey && !e.metaKey) { e.preventDefault(); mpRotate(e.shiftKey ? -1 : 1); }
    else if (key === "delete" || key === "backspace") { e.preventDefault(); mpDelete(); }
    else if (key === "escape") { mp.place = null; mp.drag = null; $("#m-building").value = ""; mpRender(); }
  });

  $("#m-building").onchange = (e) => {
    mp.place = e.target.value ? { bid: Number(e.target.value), size: 0, rot: 0 } : null;
    mpRender();
  };
  $("#m-bp").onchange = (e) => {
    const n = mp.sel?.type === "n" && mpNode(mp.sel.id);
    if (n) { n.bp = Number(e.target.value); mpFixLinks(); mpSave(); }
    e.target.blur();
    mpRender();
  };
  $("#m-size").onclick = mpCycleSize;
  $("#m-rot-l").onclick = () => mpRotate(-1);
  $("#m-rot-r").onclick = () => mpRotate(1);
  $("#m-del").onclick = mpDelete;
  $("#m-load").onclick = mpLoadPlan;
  $("#m-save").onclick = () => mpSavePlan(false);
  $("#m-saveas").onclick = () => mpSavePlan(true);
  $("#m-delplan").onclick = mpDeletePlan;
  $("#m-new").onclick = mpNewPlan;
  $("#m-center").onclick = () => { mp.view = { x: 40, y: 40, k: 1 }; mpSave(); mpRender(); };
  $("#m-clear").onclick = () => {
    if (!confirm(t("manual.clearConfirm"))) return;
    Object.assign(mp, { nodes: [], links: [], sel: null, place: null });
    mpSave();
    mpRender();
  };
}

// Wird von renderAll() aufgerufen (Daten oder Sprache geändert)
function renderManual() {
  const sel = $("#m-building");
  const cur = sel.value;
  sel.innerHTML = `<option value="">${t("manual.chooseBuilding")}</option>` +
    db.buildings.filter((b) => sizesOf(b).length).sort((a, b) => a.name.localeCompare(b.name))
      .map((b) => `<option value="${b.id}">${esc(b.name)} (${sizesOf(b).map((z) => z.join("*")).join(" / ")})</option>`).join("");
  sel.value = cur;
  $("#m-saved").innerHTML = `<option value="">–</option>` + db.manualPlans.map((p) => `<option value="${p.id}" ${p.id === mp.planId ? "selected" : ""}>${esc(p.name)}</option>`).join("");
  if (document.activeElement !== $("#m-name")) $("#m-name").value = mp.planName;
  $("#m-delplan").disabled = !mp.planId;
  mpFixLinks();
  mpRender();
}

mpInit();
