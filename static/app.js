// PMR Maps – front-end (mobile first). One search, plain-language answers, freshness always visible.
"use strict";

const C = { ok: "#157a3c", warn: "#9a5800", ko: "#b42318", unk: "#5f6670", works: "#c2410c", brand: "#2338a0", ink: "#16191d" };
const LIFT_FR = { available: "En service", notavailable: "En panne", unknown: "État inconnu" };
const ACCESS_FR = { true: "accessible", partial: "partiellement accessible", false: "non accessible", unknown: "sans information" };
const TYPE_FR = { metro: "Métro", rail: "Train / RER", tram: "Tram", cableway: "Câble", bus: "Bus" };
const MODE_FR = { Metro: "Métro", RapidTransit: "RER / Train", Tramway: "Tram", LocalTrain: "Train" };
const STALE_H = 48; // IDFM info older than this lowers confidence

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const norm = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} } };
const icon = (name, cls = "") => `<svg class="i ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const mark = (st, cls = "") => `<span class="mark ${st} ${cls}" aria-hidden="true">${icon(st)}</span>`;
const isPhone = () => window.matchMedia("(max-width: 1023px) and (not ((orientation: landscape) and (max-height: 540px)))").matches;

async function getJSON(url) {
  const r = await fetch(url);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(body.detail || `Erreur ${r.status}`); e.status = r.status; throw e; }
  return body;
}

function rel(iso) {
  if (!iso) return "date inconnue";
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  const min = Math.round((Date.now() - d) / 60000);
  if (min < 1) return "à l'instant";
  if (min < 60) return `il y a ${min} min`;
  if (min < 24 * 60) return `il y a ${Math.round(min / 60)} h`;
  return `le ${d.toLocaleDateString("fr-FR", { day: "numeric", month: "long" })}`;
}
const ageH = (iso) => { const d = new Date(iso); return isNaN(d) ? Infinity : (Date.now() - d) / 3600000; };
const hhmm = (iso) => { const d = new Date(iso); return isNaN(d) ? "?" : d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }); };
const dayTime = (iso) => { const d = new Date(iso); return isNaN(d) ? iso : d.toLocaleString("fr-FR", { weekday: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); };

function distM(a, b) {
  const k = Math.PI / 180, x = (b[0] - a[0]) * k * Math.cos((a[1] + b[1]) * k / 2), y = (b[1] - a[1]) * k;
  return 6371000 * Math.hypot(x, y);
}
const fmtDist = (m) => (m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1).replace(".", ",")} km`);

function toast(msg, ms = 3500) {
  const t = $("#toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), ms);
}

// ---------------------------------------------------------------------------
// Bottom sheet: three snap points on phones, side panel elsewhere (CSS)
// ---------------------------------------------------------------------------
const Sheet = (() => {
  const el = $("#sheet"), grip = $("#grip"), body = $("#sheet-body");
  const LABEL = { peek: "réduit", half: "moitié", full: "plein écran" };
  let snap = "peek";
  const heights = () => {
    const vh = window.innerHeight;
    return { peek: Math.min(236, Math.round(vh * 0.36)), half: Math.round(vh * 0.56), full: vh - 76 };
  };
  const apply = (h) => document.documentElement.style.setProperty("--sheet-h", `${Math.round(h)}px`);
  function set(name) {
    snap = name;
    el.dataset.snap = name;
    grip.setAttribute("aria-valuetext", LABEL[name]);
    document.body.classList.toggle("sheet-full", name === "full" && isPhone());
    apply(isPhone() ? heights()[name] : 0);
  }
  // Drag on the grip; tap or keyboard cycles.
  let startY = 0, startH = 0, moved = false;
  grip.addEventListener("pointerdown", (e) => {
    if (!isPhone()) return;
    startY = e.clientY; startH = el.getBoundingClientRect().height; moved = false;
    el.classList.add("dragging"); grip.setPointerCapture(e.pointerId);
  });
  grip.addEventListener("pointermove", (e) => {
    if (!el.classList.contains("dragging")) return;
    const dy = startY - e.clientY;
    if (Math.abs(dy) > 4) moved = true;
    const hs = heights();
    apply(Math.max(hs.peek * 0.7, Math.min(hs.full, startH + dy)));
  });
  const end = () => {
    if (!el.classList.contains("dragging")) return;
    el.classList.remove("dragging");
    if (!moved) return set(snap === "peek" ? "half" : snap === "half" ? "full" : "peek");
    const h = el.getBoundingClientRect().height, hs = heights();
    const nearest = Object.entries(hs).sort((a, b) => Math.abs(a[1] - h) - Math.abs(b[1] - h))[0][0];
    set(nearest);
  };
  grip.addEventListener("pointerup", end);
  grip.addEventListener("pointercancel", end);
  grip.addEventListener("keydown", (e) => {
    const order = ["peek", "half", "full"], i = order.indexOf(snap);
    if (e.key === "ArrowUp") { set(order[Math.min(2, i + 1)]); e.preventDefault(); }
    if (e.key === "ArrowDown") { set(order[Math.max(0, i - 1)]); e.preventDefault(); }
    if (e.key === "Enter" || e.key === " ") { set(order[(i + 1) % 3]); e.preventDefault(); }
  });
  window.addEventListener("resize", () => set(snap));
  set("peek");
  return {
    set, get: () => snap,
    // Room the map keeps clear: bottom on phones (sheet), left elsewhere (panel).
    padding: () => (isPhone() ? { bottom: heights()[snap === "full" ? "half" : snap] + 20, top: 70, left: 20, right: 20 }
      : { left: el.getBoundingClientRect().right + 20, top: 70, right: 70, bottom: 40 }),
    scrollTop: () => { body.scrollTop = 0; },
  };
})();

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------
const S = { stations: new Map(), quais: [], train: [], worksCenters: [], meta: {}, myPos: null };

function stationStatus(lifts) {
  const n = lifts.length, ko = lifts.filter((l) => l.status === "notavailable").length;
  const ok = lifts.filter((l) => l.status === "available").length;
  if (!n) return "unk";
  if (ok === n) return "ok";
  if (ko && !ok) return "ko";
  if (ko || ok) return "warn";
  return "unk";
}

function verdictText(st) {
  const n = st.lifts.length, ko = st.lifts.filter((l) => l.status === "notavailable").length;
  const unk = st.lifts.filter((l) => l.status === "unknown").length;
  switch (st.status) {
    case "ok": return [n > 1 ? `Les ${n} ascenseurs fonctionnent` : "L'ascenseur fonctionne", "Accès en fauteuil possible par ascenseur."];
    case "ko": return [n > 1 ? `Aucun des ${n} ascenseurs ne fonctionne` : "L'ascenseur est en panne", "Évitez cette station pour l'instant."];
    case "warn": return [ko ? `${ko} ascenseur${ko > 1 ? "s" : ""} sur ${n} en panne` : `État inconnu pour ${unk} ascenseur${unk > 1 ? "s" : ""} sur ${n}`,
      "Vérifiez que celui dont vous avez besoin fonctionne."];
    default: return ["État des ascenseurs inconnu", "IDFM n'a pas d'information à jour."];
  }
}

function buildStations(fc) {
  S.stations.clear();
  for (const f of fc.features) {
    const p = f.properties;
    let st = S.stations.get(p.zdcid);
    if (!st) { st = { id: p.zdcid, name: p.station, mode: p.mode, coord: f.geometry.coordinates, lifts: [] }; S.stations.set(p.zdcid, st); }
    st.lifts.push(p);
  }
  for (const st of S.stations.values()) {
    st.status = stationStatus(st.lifts);
    st.latest = st.lifts.map((l) => l.source_update).filter(Boolean).sort().pop();
    st.staleLifts = st.lifts.filter((l) => ageH(l.source_update) > STALE_H).length;
    st.key = norm(st.name);
  }
}

function stationsGeoJSON() {
  const order = { ko: 3, warn: 2, unk: 1, ok: 0 };
  return { type: "FeatureCollection", features: [...S.stations.values()].map((st) => ({
    type: "Feature", geometry: { type: "Point", coordinates: st.coord },
    properties: { id: st.id, name: st.name, status: st.status, sort: order[st.status] },
  })) };
}

const nearestStations = (coord, max = 5, radius = 2000) => [...S.stations.values()]
  .map((st) => ({ st, d: distM(coord, st.coord) })).filter((x) => x.d <= radius).sort((a, b) => a.d - b.d).slice(0, max);
const worksNear = (coord, radius = 150) => S.worksCenters.filter((w) => distM(coord, w.c) <= radius);

// ---------------------------------------------------------------------------
// Map
// ---------------------------------------------------------------------------
const map = new maplibregl.Map({
  container: "map", style: "https://tiles.openfreemap.org/styles/positron",
  center: [2.3488, 48.8566], zoom: 12.3, attributionControl: { compact: true }, dragRotate: false, pitchWithRotate: false,
});
map.touchZoomRotate.disableRotation();

// Status markers: the same strokes as the SVG icon set, drawn on canvas.
const MARK_PATHS = { ok: "m5 12.5 4.5 4.5L19 7.5", ko: "M6 6l12 12M18 6 6 18", warn: "M12 5v9M12 19h.01", unk: "M9 9a3 3 0 1 1 4 2.8c-.7.3-1 .9-1 1.6V14M12 19h.01" };
function markImage(status, size = 44) {
  const r = Math.max(2, window.devicePixelRatio || 1), px = size * r, c = document.createElement("canvas");
  c.width = c.height = px;
  const g = c.getContext("2d");
  g.beginPath(); g.arc(px / 2, px / 2, px / 2 - 2.5 * r, 0, Math.PI * 2);
  g.fillStyle = C[status]; g.fill(); g.lineWidth = 3 * r; g.strokeStyle = "#fff"; g.stroke();
  const s = (px * 0.56) / 24; g.translate(px / 2 - 12 * s, px / 2 - 12 * s); g.scale(s, s);
  g.strokeStyle = "#fff"; g.lineWidth = 3.2; g.lineCap = "round"; g.lineJoin = "round"; g.stroke(new Path2D(MARK_PATHS[status]));
  return { image: g.getImageData(0, 0, px, px), pixelRatio: r };
}
// Works: diagonal hatch, like a site barrier.
function hatchImage() {
  const r = Math.max(2, window.devicePixelRatio || 1), px = 12 * r, c = document.createElement("canvas");
  c.width = c.height = px;
  const g = c.getContext("2d");
  g.fillStyle = "rgba(194,65,12,.16)"; g.fillRect(0, 0, px, px);
  g.strokeStyle = "rgba(194,65,12,.85)"; g.lineWidth = 2.2 * r;
  for (const o of [-px, 0, px]) { g.beginPath(); g.moveTo(o, px); g.lineTo(o + px, 0); g.stroke(); }
  return { image: g.getImageData(0, 0, px, px), pixelRatio: r };
}

const empty = () => ({ type: "FeatureCollection", features: [] });

map.on("load", () => {
  for (const k of ["ok", "warn", "ko", "unk"]) { const m = markImage(k); map.addImage(`st-${k}`, m.image, { pixelRatio: m.pixelRatio }); }
  const h = hatchImage(); map.addImage("hatch", h.image, { pixelRatio: h.pixelRatio });
  ["works", "quais", "bus", "trip", "stations", "pin"].forEach((id) => map.addSource(id, { type: "geojson", data: empty() }));

  map.addLayer({ id: "works-fill", type: "fill", source: "works", paint: { "fill-pattern": "hatch" } });
  map.addLayer({ id: "works-line", type: "line", source: "works", paint: { "line-color": C.works, "line-width": 1.5 } });
  const accColor = ["match", ["get", "accessibility"], "true", C.ok, "partial", C.warn, "false", C.ko, C.unk];
  map.addLayer({ id: "quais", type: "circle", source: "quais", layout: { visibility: "none" },
    paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 11, 3, 16, 8], "circle-color": accColor, "circle-stroke-color": "#fff", "circle-stroke-width": 1.5 } });
  map.addLayer({ id: "bus", type: "circle", source: "bus", minzoom: 14.5, layout: { visibility: "none" },
    paint: { "circle-radius": 6, "circle-color": accColor, "circle-stroke-color": "#fff", "circle-stroke-width": 2 } });
  map.addLayer({ id: "trip", type: "line", source: "trip", layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": C.brand, "line-width": 6, "line-opacity": 0.9 } });
  map.addLayer({ id: "stations", type: "symbol", source: "stations",
    layout: {
      "icon-image": ["concat", "st-", ["get", "status"]], "icon-allow-overlap": true, "symbol-sort-key": ["get", "sort"],
      "icon-size": ["interpolate", ["linear"], ["zoom"], 9, 0.4, 12, 0.6, 15, 0.9],
      "text-field": ["step", ["zoom"], "", 14, ["get", "name"]], "text-font": ["Noto Sans Regular"],
      "text-size": 13, "text-offset": [0, 1.7], "text-anchor": "top", "text-optional": true,
    },
    paint: { "text-color": C.ink, "text-halo-color": "#fff", "text-halo-width": 1.6 } });
  map.addLayer({ id: "pin", type: "circle", source: "pin",
    paint: { "circle-radius": 10, "circle-color": C.brand, "circle-stroke-color": "#fff", "circle-stroke-width": 4 } });

  map.on("click", "stations", (e) => openStation(e.features[0].properties.id));
  map.on("click", "works-fill", (e) => openWorks(e.features[0].properties, e.lngLat));
  map.on("click", "quais", (e) => quickPopup(e, "Quai"));
  map.on("click", "bus", (e) => quickPopup(e, "Arrêt de bus"));
  for (const id of ["stations", "works-fill", "quais", "bus"]) {
    map.on("mouseenter", id, () => (map.getCanvas().style.cursor = "pointer"));
    map.on("mouseleave", id, () => (map.getCanvas().style.cursor = ""));
  }
  map.on("moveend", loadBus);
  // Moving the map on a phone lowers a full sheet to give the map room.
  map.on("dragstart", () => { if (isPhone() && Sheet.get() === "full") Sheet.set("half"); });

  loadLifts().then(applyHash);
  loadStatic();
  loadAlerts();
  setInterval(loadLifts, 5 * 60 * 1000);
  setInterval(loadAlerts, 60 * 1000);
});

function quickPopup(e, kind) {
  const p = e.features[0].properties;
  new maplibregl.Popup({ maxWidth: "260px" }).setLngLat(e.lngLat)
    .setHTML(`<b>${esc(p.name)}</b><br>${esc(kind)}${p.type ? " · " + esc(TYPE_FR[p.type] || p.type) : ""}<br>` +
      `<b>${esc(ACCESS_FR[p.accessibility] || p.accessibility)}</b><div style="color:#4a5058;font-size:.85em;margin-top:4px">IDFM, référentiel des arrêts</div>`)
    .addTo(map);
}

function setPin(coord) { map.getSource("pin")?.setData(coord ? { type: "Feature", geometry: { type: "Point", coordinates: coord } } : empty()); }
const flyTo = (coord, zoom = 15.5) => map.flyTo({ center: coord, zoom, padding: Sheet.padding(), essential: true });
function fitTo(coords) {
  const b = new maplibregl.LngLatBounds(coords[0], coords[0]);
  coords.forEach((c) => b.extend(c));
  map.fitBounds(b, { padding: Sheet.padding(), maxZoom: 15 });
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------
async function loadLifts() {
  try {
    const d = await getJSON("/api/lifts");
    buildStations(d);
    S.meta.lifts = d.meta;
    map.getSource("stations")?.setData(stationsGeoJSON());
    renderToday();
    renderSources();
  } catch (e) {
    $("#today").innerHTML = `<p class="err">Impossible de charger l'état des ascenseurs. ${esc(e.message)}</p>`;
  }
}

async function loadStatic() {
  const jobs = {
    quais: async () => { const d = await getJSON("/api/stations"); S.quais = d.features; S.meta.quais = d.meta; map.getSource("quais").setData(d); },
    train: async () => { const d = await getJSON("/api/train-stations"); S.train = d.features; S.meta.train = d.meta; },
    works: async () => {
      const d = await getJSON("/api/works"); S.meta.works = d.meta; map.getSource("works").setData(d);
      S.worksCenters = d.features.map((f) => {
        const ring = f.geometry.type === "Polygon" ? f.geometry.coordinates[0] : f.geometry.coordinates[0][0];
        const xs = ring.map((p) => p[0]), ys = ring.map((p) => p[1]);
        return { c: [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2], p: f.properties };
      });
    },
  };
  await Promise.all(Object.entries(jobs).map(([k, fn]) => fn().catch((e) => console.warn(k, e))));
  renderSources();
}

async function loadBus() {
  if (!layerOn.bus || map.getZoom() < 14.5) return;
  const b = map.getBounds();
  const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map((v) => v.toFixed(5)).join(",");
  try { map.getSource("bus").setData(await getJSON(`/api/bus-stops?bbox=${bbox}`)); } catch (e) { console.warn("bus", e); }
}

async function loadAlerts() {
  try {
    const d = await getJSON("/api/alerts");
    const ul = $("#alerts");
    if (!d.alerts.length) {
      ul.innerHTML = `<li class="empty">Rien n'a changé depuis ${d.poller.last_poll ? hhmm(d.poller.last_poll) : "le démarrage"}. Nouvelle vérification toutes les 15 minutes.</li>`;
      return;
    }
    ul.innerHTML = d.alerts.slice(0, 8).map((a) => {
      const st = a.to === "available" ? "ok" : a.to === "notavailable" ? "ko" : "unk";
      const what = st === "ok" ? "Ascenseur réparé" : st === "ko" ? "Ascenseur en panne" : "État devenu inconnu";
      return `<li><button class="item" data-open="${esc(a.zdcid)}">${mark(st)}<span class="t"><b>${esc(a.station)}</b>` +
        `<small>${what} · ${rel(a.detected_at)}</small></span>${icon("chev-r", "chev")}</button></li>`;
    }).join("");
    bindOpen(ul);
  } catch (e) { console.warn("alerts", e); }
}

// ---------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------
function renderToday() {
  const m = S.meta.lifts, c = m.counts, total = (c.available || 0) + (c.notavailable || 0) + (c.unknown || 0);
  const latest = [...S.stations.values()].map((s) => s.latest).filter(Boolean).sort().pop();
  const pct = (n) => `${(100 * n / total).toFixed(2)}%`;
  $("#today").innerHTML =
    `<p class="headline"><em>${c.notavailable}</em> ascenseurs en panne en ce moment</p>` +
    `<div class="bar" aria-hidden="true"><span style="width:${pct(c.available)};background:${C.ok}"></span>` +
    `<span style="width:${pct(c.notavailable)};background:${C.ko}"></span><span style="width:${pct(c.unknown)};background:${C.unk}"></span></div>` +
    `<ul class="legend"><li><span class="sw ok"></span><b>${c.available}</b> en service</li><li><span class="sw ko"></span><b>${c.notavailable}</b> en panne</li>` +
    `<li><span class="sw unk"></span><b>${c.unknown}</b> inconnus</li></ul>` +
    `<p class="fresh">${icon("clock")}${m.stale ? "Source IDFM injoignable, dernière version connue. " : ""}Info IDFM ${rel(latest)}, vérifiée à ${hhmm(m.fetched_at)}</p>`;
}

function renderSources() {
  const items = Object.values(S.meta).filter((m) => m && m.source).map((m) =>
    `<li><a href="${esc(m.source.url)}" target="_blank" rel="noopener">${esc(m.source.name)}</a>, ${esc(m.source.license)}. ${m.count} éléments, récupérés à ${hhmm(m.fetched_at)}.</li>`);
  $("#sources-list").innerHTML = items.join("") + `<li>Recherche de lieux : IGN Géoplateforme.</li><li>Fond de carte © OpenStreetMap, OpenFreeMap.</li>`;
}

function stationItem(st, d) {
  return `<li><button class="item" data-open="${esc(st.id)}">${mark(st.status)}<span class="t"><b>${esc(st.name)}</b>` +
    `<small>${esc(verdictText(st)[0])}</small></span>${d != null ? `<span class="dist">${fmtDist(d)}</span>` : icon("chev-r", "chev")}</button></li>`;
}
const stationList = (rows) => `<ul class="list">${rows.map((x) => stationItem(x.st, x.d)).join("")}</ul>`;
function bindOpen(root) { root.querySelectorAll("[data-open]").forEach((b) => b.addEventListener("click", () => openStation(b.dataset.open))); }

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------
function show(view, snap) {
  for (const v of document.querySelectorAll(".view")) v.hidden = v.id !== `v-${view}`;
  Sheet.scrollTop();
  if (snap) Sheet.set(snap);
  const h = $(`#v-${view} .title`);
  if (h && view !== "home") { h.setAttribute("tabindex", "-1"); h.focus({ preventScroll: true }); }
}
document.querySelectorAll("[data-back]").forEach((b) => b.addEventListener("click", () => {
  show("home", "peek"); setPin(null); map.getSource("trip")?.setData(empty()); history.replaceState(null, "", location.pathname);
}));

function openStation(id) {
  const st = S.stations.get(String(id));
  if (!st) { toast("Cette station n'apparaît pas dans les données ascenseurs."); return; }
  history.replaceState(null, "", `#station=${encodeURIComponent(st.id)}`);
  setPin(null);
  show("detail", "half");
  flyTo(st.coord, 16);
  const [title, sub] = verdictText(st);
  const quais = S.quais.filter((q) => distM(st.coord, q.geometry.coordinates) < 350 && norm(q.properties.name) === st.key);
  const qCount = {};
  quais.forEach((q) => { const a = q.properties.accessibility || "unknown"; qCount[a] = (qCount[a] || 0) + 1; });
  const Q_FR = { true: ["accessible", "accessibles"], partial: ["partiellement accessible", "partiellement accessibles"], false: ["non accessible", "non accessibles"], unknown: ["sans information", "sans information"] };
  const qText = ["true", "partial", "false", "unknown"].filter((k) => qCount[k]).map((k) => `${qCount[k]} ${Q_FR[k][qCount[k] > 1 ? 1 : 0]}`).join(", ");
  const works = worksNear(st.coord, 200);
  const lifts = [...st.lifts].sort((a, b) => (b.status === "notavailable") - (a.status === "notavailable"));
  const oldest = st.lifts.map((l) => l.source_update).filter(Boolean).sort()[0];
  const who = st.staleLifts === st.lifts.length ? (st.lifts.length > 1 ? "tous les ascenseurs" : "cet ascenseur") : `${st.staleLifts} ascenseur${st.staleLifts > 1 ? "s" : ""} sur ${st.lifts.length}`;

  $("#detail").innerHTML =
    `<h2 id="d-title" class="title">${esc(st.name)}</h2><p class="sub">${esc(MODE_FR[st.mode] || st.mode || "Station")}</p>` +
    `<div class="verdict ${st.status}">${mark(st.status, "lg")}<span><strong>${esc(title)}</strong>${esc(sub)}</span></div>` +
    (st.staleLifts ? `<p class="note">${icon("clock")}<span><b>À confirmer.</b> Pour ${who}, la dernière info IDFM date ${rel(oldest).replace(/^le /, "du ").replace("il y a", "d'il y a")}. L'état réel a pu changer.</span></p>` : "") +
    `<div class="btn-row"><button class="btn primary" id="go-to">Y aller</button><button class="btn" id="go-from">Partir d'ici</button></div>` +
    ((quais.length || works.length) ? `<ul class="facts">` +
      (quais.length ? `<li>${icon("train")}<span><b>Quais :</b> ${qText}</span></li>` : "") +
      (works.length ? `<li>${icon("cone")}<span><b>${works.length} chantier${works.length > 1 ? "s" : ""}</b> sur le trottoir à moins de 200 m</span></li>` : "") +
      `</ul>` : "") +
    `<h3 class="h2">Ascenseurs (${lifts.length})</h3>` +
    lifts.map((l) => {
      const s = l.status === "available" ? "ok" : l.status === "notavailable" ? "ko" : "unk";
      const old = ageH(l.source_update) > STALE_H;
      return `<div class="lift">${mark(s)}<div><div class="st">${esc(LIFT_FR[l.status] || l.status)}${l.reason === "liftFailure" ? ", panne" : ""}</div>` +
        `<div class="where">${esc(l.situation || "Emplacement non précisé")}</div>${l.direction ? `<small>${esc(l.direction)}</small>` : ""}` +
        `<small class="${old ? "old" : ""}">Info IDFM ${rel(l.source_update)} (${esc(dayTime(l.source_update))})</small></div></div>`;
    }).join("") +
    `<p class="src">Source : IDFM, état des ascenseurs (Licence Mobilité), zone ${esc(st.id)}. Vérifié à ${hhmm(S.meta.lifts.fetched_at)}.</p>`;
  const here = { label: st.name, lon: st.coord[0], lat: st.coord[1] };
  $("#go-to").addEventListener("click", () => openTrip(null, here));
  $("#go-from").addEventListener("click", () => openTrip(here, null));
}

function openPlace(item) {
  const coord = [item.lon, item.lat];
  setPin(coord);
  show("detail", "half");
  flyTo(coord, 15.5);
  const near = nearestStations(coord, 4, 1500);
  const works = worksNear(coord, 150);
  $("#detail").innerHTML =
    `<h2 id="d-title" class="title">${esc(item.label)}</h2><p class="sub">${esc(item.sub || "")}</p>` +
    (works.length ? `<div class="verdict warn">${mark("warn", "lg")}<span><strong>${works.length} chantier${works.length > 1 ? "s" : ""} sur le trottoir à moins de 150 m</strong>` +
      `${esc(works[0].p.summary || "Travaux")}, jusqu'au ${esc(works[0].p.end)}.</span></div>` : "") +
    `<div class="btn-row"><button class="btn primary" id="go-to">Y aller</button><button class="btn" id="go-from">Partir d'ici</button></div>` +
    `<h3 class="h2">Stations avec ascenseur à proximité</h3>` +
    (near.length ? stationList(near) : `<p class="muted">Aucune station avec ascenseur à moins de 1,5 km.</p>`) +
    `<p class="muted">L'accessibilité du lieu lui-même (entrée, marches, toilettes) arrive bientôt, avec Acceslibre.</p>` +
    `<p class="src">Lieu : IGN Géoplateforme. Ascenseurs : IDFM. Chantiers : Ville de Paris.</p>`;
  bindOpen($("#detail"));
  $("#go-to").addEventListener("click", () => openTrip(null, item));
  $("#go-from").addEventListener("click", () => openTrip(item, null));
}

function openWorks(p, lngLat) {
  setPin([lngLat.lng, lngLat.lat]);
  show("detail", "half");
  $("#detail").innerHTML =
    `<h2 id="d-title" class="title">Chantier sur le trottoir</h2><p class="sub">${esc(p.postcode || "Paris")}</p>` +
    `<div class="verdict warn">${mark("warn", "lg")}<span><strong>${esc(p.summary || "Travaux")}</strong>Du ${esc(p.start)} au ${esc(p.end)}.</span></div>` +
    `<ul class="facts"><li>${icon("cone")}<span><b>Emprise :</b> ${esc((p.where || "").replace(/EMPRISE_/g, "").toLowerCase().replace(/_/g, " "))}</span></li>` +
    `<li>${icon("place")}<span><b>Maître d'ouvrage :</b> ${esc(p.owner || "non précisé")}</span></li></ul>` +
    `<p class="muted">Le passage peut être réduit ou dévié. Prévoyez de traverser plus tôt.</p>` +
    `<p class="src">Source : Ville de Paris, chantiers à Paris (ODbL), emprise ${esc(p.id)}.</p>`;
}

// ---------------------------------------------------------------------------
// Trip
// ---------------------------------------------------------------------------
const trip = { from: null, to: null };
const myPosItem = () => (S.myPos ? { label: "Ma position", lon: S.myPos[0], lat: S.myPos[1], kind: "me" } : null);

function openTrip(from, to) {
  trip.from = from || trip.from || myPosItem();
  trip.to = to || trip.to;
  $("#trip-from").value = trip.from ? trip.from.label : "";
  $("#trip-to").value = trip.to ? trip.to.label : "";
  $("#trip-result").innerHTML = "";
  show("trip", "full");
  if (!trip.from) $("#trip-from").focus(); else if (!trip.to) $("#trip-to").focus(); else runTrip();
}

async function runTrip() {
  const out = $("#trip-result");
  if (!trip.from || !trip.to) { out.innerHTML = `<p class="err">Choisissez un départ et une arrivée dans la liste.</p>`; return; }
  document.activeElement?.blur();
  out.innerHTML = `<p class="muted">Recherche d'un itinéraire accessible…</p>`;
  const q = (p) => `${p.lon},${p.lat}`;
  try { renderJourneys(await getJSON(`/api/journey?from=${q(trip.from)}&to=${q(trip.to)}`)); }
  catch (e) { if (e.status === 503) renderTripFallback(); else out.innerHTML = `<p class="err">${esc(e.message)}</p>`; }
}

function renderTripFallback() {
  const a = [trip.from.lon, trip.from.lat], b = [trip.to.lon, trip.to.lat];
  const block = (label, coord) => {
    const near = nearestStations(coord, 3, 1500);
    return `<h3 class="h2">${label}</h3>` + (near.length ? stationList(near) : `<p class="muted">Aucune station avec ascenseur à moins de 1,5 km.</p>`);
  };
  $("#trip-result").innerHTML =
    `<div class="verdict unk">${mark("unk", "lg")}<span><strong>Le calcul d'itinéraire arrive bientôt</strong>En attendant, voici l'état des stations proches du départ et de l'arrivée.</span></div>` +
    block("Près du départ", a) + block("Près de l'arrivée", b);
  bindOpen($("#trip-result"));
  Sheet.set("half");
  fitTo([a, b]);
}

function renderJourneys(d) {
  if (!d.journeys.length) { $("#trip-result").innerHTML = `<p>Aucun itinéraire accessible trouvé.</p>`; return; }
  $("#trip-result").innerHTML = d.journeys.map((j, i) => {
    const bad = j.lifts_not_available, status = bad.length ? "warn" : "ok";
    const steps = j.sections.filter((s) => s.type === "public_transport" || (s.type === "street_network" && s.duration_s > 30)).map((s) =>
      s.type === "public_transport" ? `<li><b>${esc(s.mode)} ${esc(s.line)}</b>, de ${esc(s.from)} à ${esc(s.to)}</li>`
        : `<li>En fauteuil, ${Math.max(1, Math.round(s.duration_s / 60))} min</li>`).join("");
    return `<div class="journey ${i === 0 ? "sel" : ""}" data-i="${i}" tabindex="0" role="button">` +
      `<div class="verdict ${status}">${mark(status, "lg")}<span><strong>${Math.round(j.duration_s / 60)} min</strong>` +
      `${bad.length ? `${bad.length} ascenseur${bad.length > 1 ? "s" : ""} hors service : ${esc([...new Set(bad.map((l) => l.station))].join(", "))}` : "Aucun ascenseur en panne sur le trajet"}</span></div>` +
      `<ol>${steps}</ol></div>`;
  }).join("") + `<p class="src">Itinéraire : ${esc(d.source)}. Ascenseurs vérifiés à ${hhmm(d.lifts_fetched_at)}.</p>`;
  const showJ = (i) => {
    document.querySelectorAll(".journey").forEach((el) => el.classList.toggle("sel", +el.dataset.i === i));
    map.getSource("trip").setData({ type: "FeatureCollection", features: d.journeys[i].sections.filter((s) => s.geojson).map((s) => ({ type: "Feature", geometry: s.geojson, properties: {} })) });
  };
  document.querySelectorAll(".journey").forEach((el) => {
    el.addEventListener("click", () => showJ(+el.dataset.i));
    el.addEventListener("keydown", (e) => e.key === "Enter" && showJ(+el.dataset.i));
  });
  showJ(0);
  Sheet.set("half");
  fitTo([[d.from.lon, d.from.lat], [d.to.lon, d.to.lat]]);
}
$("#trip-go").addEventListener("click", runTrip);

// ---------------------------------------------------------------------------
// Search: stations from our data + places / addresses from IGN
// ---------------------------------------------------------------------------
function localStations(q, max = 4) {
  const words = norm(q).split(" ").filter(Boolean);
  if (!words.length) return [];
  return [...S.stations.values()].filter((st) => words.every((w) => st.key.includes(w)))
    .sort((a, b) => (b.key.startsWith(words[0]) - a.key.startsWith(words[0])) || a.name.length - b.name.length)
    .slice(0, max)
    .map((st) => ({ kind: "station", id: st.id, label: st.name, sub: verdictText(st)[0], status: st.status, lon: st.coord[0], lat: st.coord[1] }));
}

function autocomplete(input, list, onPick, { withMe = false, onFocus } = {}) {
  let items = [], sel = -1, timer = null, seq = 0;
  const render = () => {
    if (!items.length) { list.hidden = true; input.setAttribute("aria-expanded", "false"); input.removeAttribute("aria-activedescendant"); return; }
    list.innerHTML = items.map((it, i) => {
      const lead = it.kind === "station" ? mark(it.status)
        : `<span class="mark neutral" aria-hidden="true">${icon(it.kind === "me" ? "locate" : it.kind === "place" ? "place" : "address")}</span>`;
      return `<li role="option" id="${list.id}-${i}" aria-selected="${i === sel}" data-i="${i}">${lead}<span class="t"><b>${esc(it.label)}</b><small>${esc(it.sub || "")}</small></span></li>`;
    }).join("");
    list.hidden = false; input.setAttribute("aria-expanded", "true");
    if (sel >= 0) input.setAttribute("aria-activedescendant", `${list.id}-${sel}`);
    list.querySelectorAll("li").forEach((li) => li.addEventListener("click", () => pick(+li.dataset.i)));
  };
  const pick = (i) => { const it = items[i]; if (!it) return; items = []; render(); input.value = it.label; input.blur(); onPick(it); };
  const run = async () => {
    const q = input.value.trim(), my = ++seq;
    const head = withMe && myPosItem() && (!q || norm("ma position").startsWith(norm(q))) ? [{ ...myPosItem(), sub: "Partir de votre position" }] : [];
    if (q.length < 2) { items = head; sel = -1; render(); return; }
    items = [...head, ...localStations(q)]; sel = -1; render();
    try {
      const d = await getJSON(`/api/suggest?q=${encodeURIComponent(q)}`);
      if (my !== seq) return;
      items = [...head, ...localStations(q), ...d.results.slice(0, 5)]; render();
    } catch {}
  };
  input.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(run, 180); });
  input.addEventListener("focus", () => { onFocus?.(); run(); });
  input.addEventListener("blur", () => setTimeout(() => { items = []; render(); }, 200));
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { sel = Math.min(items.length - 1, sel + 1); render(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { sel = Math.max(0, sel - 1); render(); e.preventDefault(); }
    else if (e.key === "Enter") { pick(sel >= 0 ? sel : 0); e.preventDefault(); }
    else if (e.key === "Escape") { items = []; render(); }
  });
  return { run };
}

const pickMain = (it) => (it.kind === "station" ? openStation(it.id) : openPlace(it));
const mainSearch = autocomplete($("#search"), $("#suggest"), pickMain, { onFocus: () => isPhone() && Sheet.set("full") });
autocomplete($("#trip-from"), $("#suggest-from"), (it) => { trip.from = it; if (trip.to) runTrip(); else $("#trip-to").focus(); }, { withMe: true });
autocomplete($("#trip-to"), $("#suggest-to"), (it) => { trip.to = it; if (trip.from) runTrip(); });

// ---------------------------------------------------------------------------
// Geolocation & nearby
// ---------------------------------------------------------------------------
function locate() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition((p) => { S.myPos = [p.coords.longitude, p.coords.latitude]; resolve(S.myPos); },
      () => resolve(null), { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 });
  });
}

$("#nearby").addEventListener("click", async () => {
  const label = $("#nearby span"); label.textContent = "Localisation…";
  let pos = await locate();
  if (!pos) { const c = map.getCenter(); pos = [c.lng, c.lat]; toast("Position indisponible. Recherche autour du centre de la carte."); }
  label.textContent = "Stations autour de moi";
  const near = nearestStations(pos, 6, 3000);
  $("#nearby-list").innerHTML = near.length ? stationList(near) : `<p class="muted">Aucune station avec ascenseur à moins de 3 km.</p>`;
  bindOpen($("#nearby-list"));
  Sheet.set("half");
  setPin(pos); flyTo(pos, 14.5);
});

$("#locate").addEventListener("click", async () => {
  const pos = await locate();
  if (!pos) return toast("Impossible d'obtenir votre position. Vérifiez l'autorisation de localisation.");
  setPin(pos); flyTo(pos, 15);
});

// ---------------------------------------------------------------------------
// Chips, text size, voice, deep links
// ---------------------------------------------------------------------------
const layerOn = { lifts: true, works: true, quais: false, bus: false };
const LAYER_IDS = { lifts: ["stations"], works: ["works-fill", "works-line"], quais: ["quais"], bus: ["bus"] };
document.querySelectorAll(".chip").forEach((chip) => chip.addEventListener("click", () => {
  const k = chip.dataset.layer; layerOn[k] = !layerOn[k];
  chip.classList.toggle("on", layerOn[k]); chip.setAttribute("aria-pressed", String(layerOn[k]));
  for (const id of LAYER_IDS[k]) map.setLayoutProperty(id, "visibility", layerOn[k] ? "visible" : "none");
  if (k === "bus" && layerOn.bus) {
    if (map.getZoom() < 14.5) { toast("Les arrêts de bus s'affichent en zoomant."); map.easeTo({ zoom: 15, padding: Sheet.padding() }); } else loadBus();
  }
}));

const textBtn = $("#textsize");
function setBig(on) {
  document.documentElement.classList.toggle("big", on);
  textBtn.setAttribute("aria-pressed", String(on));
  textBtn.setAttribute("aria-label", on ? "Texte normal" : "Agrandir le texte");
}
setBig(store.get("big") === "1");
textBtn.addEventListener("click", () => { const on = !document.documentElement.classList.contains("big"); setBig(on); store.set("big", on ? "1" : "0"); });

(() => {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const btn = $("#mic");
  if (!SR) { btn.hidden = true; return; }
  const rec = new SR(); rec.lang = "fr-FR"; rec.interimResults = false;
  rec.onresult = (e) => {
    const text = e.results[0][0].transcript.replace(/^(je veux aller|aller|emmène-moi|je vais) (à|au|aux|a)\s+/i, "");
    $("#search").value = text; $("#search").focus(); mainSearch.run();
  };
  rec.onerror = () => toast("Je n'ai pas entendu. Réessayez.");
  rec.onend = () => { btn.classList.remove("listening"); btn.setAttribute("aria-label", "Dicter la destination"); };
  btn.addEventListener("click", () => { btn.classList.add("listening"); btn.setAttribute("aria-label", "Écoute en cours"); try { rec.start(); } catch {} });
})();

function applyHash() {
  const m = location.hash.match(/station=([^&]+)/);
  if (m) openStation(decodeURIComponent(m[1]));
}
window.addEventListener("hashchange", applyHash);
