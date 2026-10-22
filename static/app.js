// Roulib – front-end (mobile first, friendly). Big tiles, plain words, freshness always visible.
"use strict";

const C = { ok: "#157a3c", warn: "#9a5800", ko: "#b42318", unk: "#5f6670", works: "#c2410c", brand: "#3d3bd6", ink: "#1e1a16" };
const LIFT_FR = { available: "Fonctionne", notavailable: "En panne", unknown: "État inconnu" };
const ACCESS_FR = { true: "accessible", partial: "partiellement accessible", false: "non accessible", unknown: "sans information" };
const TYPE_FR = { metro: "Métro", rail: "Train / RER", tram: "Tram", cableway: "Câble", bus: "Bus" };
const MODE_FR = { Metro: "Métro", RapidTransit: "RER / Train", Tramway: "Tram", LocalTrain: "Train" };
// Acceslibre wheelchair verdict -> our status + plain words
const PLACE_ST = { true: "ok", partial: "warn", false: "ko", unknown: "unk" };
const PLACE_FR = {
  true: ["Accessible en fauteuil", "Entrée sans obstacle."],
  partial: ["Accessible avec un peu d'aide", "Rampe à demander ou petit obstacle."],
  false: ["Difficile en fauteuil", "Obstacle à l'entrée."],
  unknown: ["Pas encore renseigné", "Personne n'a encore décrit l'entrée."],
};
const WC_FR = { true: ["ok", "Toilettes adaptées"], false: ["ko", "Toilettes non adaptées"], none: ["unk", "Pas de toilettes"], unknown: ["unk", "Toilettes : non renseigné"] };
const STALE_H = 48; // IDFM info older than this lowers confidence

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const norm = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  json(k) { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch { return null; } },
};
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
const plural = (n, one, many) => `${n} ${n > 1 ? many : one}`;

function toast(msg, ms = 3800) {
  const t = $("#toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), ms);
}

// ---------------------------------------------------------------------------
// Bottom sheet: three heights on phones, side panel elsewhere (CSS)
// ---------------------------------------------------------------------------
const Sheet = (() => {
  const el = $("#sheet"), grip = $("#grip"), body = $("#sheet-body");
  const LABEL = { peek: "réduit", half: "moitié", full: "plein écran" };
  let snap = "half";
  const heights = () => {
    const vh = window.visualViewport ? window.visualViewport.height : window.innerHeight;
    return { peek: Math.min(210, Math.round(vh * 0.3)), half: Math.round(vh * 0.6), full: vh - 76 };
  };
  const apply = (h) => document.documentElement.style.setProperty("--sheet-h", `${Math.round(h)}px`);
  function set(name) {
    snap = name;
    grip.setAttribute("aria-valuetext", LABEL[name]);
    document.body.classList.toggle("sheet-full", name === "full" && isPhone());
    apply(isPhone() ? heights()[name] : 0);
  }
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
    set(Object.entries(hs).sort((a, b) => Math.abs(a[1] - h) - Math.abs(b[1] - h))[0][0]);
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
  window.visualViewport?.addEventListener("resize", () => set(snap));
  set("half");
  return {
    set, get: () => snap,
    padding: () => (isPhone() ? { bottom: heights()[snap === "full" ? "half" : snap] + 20, top: 76, left: 24, right: 24 }
      : { left: el.getBoundingClientRect().right + 20, top: 76, right: 76, bottom: 40 }),
    scrollTop: () => { body.scrollTop = 0; },
  };
})();

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------
const S = { stations: new Map(), quais: [], worksCenters: [], meta: {}, myPos: null, places: [] };

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
    case "ok": return [n > 1 ? `Les ${n} ascenseurs fonctionnent` : "L'ascenseur fonctionne", "Vous pouvez passer en fauteuil."];
    case "ko": return [n > 1 ? `Aucun des ${n} ascenseurs ne marche` : "L'ascenseur est en panne", "Mieux vaut éviter cette station pour l'instant."];
    case "warn": return [ko ? `${ko} ascenseur${ko > 1 ? "s" : ""} sur ${n} en panne` : `On ne sait pas pour ${unk} ascenseur${unk > 1 ? "s" : ""} sur ${n}`,
      "Vérifiez que celui dont vous avez besoin marche."];
    default: return ["On ne sait pas", "IDFM n'a pas d'information récente."];
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
    st.ko = st.lifts.filter((l) => l.status === "notavailable").length;
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

// Acceslibre places around a point (the API wants a bbox of at most 16 tiles of 0.01°).
const placeCache = new Map();
async function placesAround(coord, dLon = 0.008, dLat = 0.0055) {
  const bbox = [coord[0] - dLon, coord[1] - dLat, coord[0] + dLon, coord[1] + dLat].map((v) => v.toFixed(4)).join(",");
  if (!placeCache.has(bbox)) placeCache.set(bbox, getJSON(`/api/places?bbox=${bbox}`).catch((e) => { placeCache.delete(bbox); throw e; }));
  const d = await placeCache.get(bbox);
  S.meta.places = d.meta;
  return d.features;
}

// ---------------------------------------------------------------------------
// Map
// ---------------------------------------------------------------------------
const map = new maplibregl.Map({
  container: "map", style: "https://tiles.openfreemap.org/styles/liberty",
  center: [2.3488, 48.8566], zoom: 12.4, attributionControl: { compact: true }, dragRotate: false, pitchWithRotate: false,
});
map.touchZoomRotate.disableRotation();

const MARK_PATHS = { ok: "m5 12.5 4.5 4.5L19 7.5", ko: "M6 6l12 12M18 6 6 18", warn: "M12 5v9M12 19h.01", unk: "M9 9a3 3 0 1 1 4 2.8c-.7.3-1 .9-1 1.6V14M12 19h.01",
  food: "M7 3v18M4 3v5a3 3 0 0 0 6 0V3M18 21V3c-2.5 1.5-4 4.5-4 8h4" };
function markImage(color, glyph, { size = 44, square = false } = {}) {
  const r = Math.max(2, window.devicePixelRatio || 1), px = size * r, c = document.createElement("canvas");
  c.width = c.height = px;
  const g = c.getContext("2d"), pad = 2.5 * r;
  g.beginPath();
  if (square) g.roundRect(pad, pad, px - 2 * pad, px - 2 * pad, 11 * r); else g.arc(px / 2, px / 2, px / 2 - pad, 0, Math.PI * 2);
  g.fillStyle = color; g.fill(); g.lineWidth = 3 * r; g.strokeStyle = "#fff"; g.stroke();
  const s = (px * 0.56) / 24; g.translate(px / 2 - 12 * s, px / 2 - 12 * s); g.scale(s, s);
  g.strokeStyle = "#fff"; g.lineWidth = glyph === "food" ? 2.4 : 3.2; g.lineCap = "round"; g.lineJoin = "round"; g.stroke(new Path2D(MARK_PATHS[glyph]));
  return { image: g.getImageData(0, 0, px, px), pixelRatio: r };
}
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

// The base map's own shop icons and road shields compete with ours: hide them.
const BASE_CLUTTER = /^(poi_|highway-shield|road_shield)/;

map.on("load", () => {
  for (const l of map.getStyle().layers) {
    if (BASE_CLUTTER.test(l.id)) { map.setLayoutProperty(l.id, "visibility", "none"); continue; }
    // Place names in French (the base style prefers English for districts).
    if (l.type === "symbol" && l.layout && l.layout["text-field"]) map.setLayoutProperty(l.id, "text-field", ["coalesce", ["get", "name:fr"], ["get", "name"]]);
    // Calm, warm base: white streets on cream, so our markers are what stands out.
    if (l.type === "line" && /^(road|bridge|tunnel)_/.test(l.id) && !/rail|pattern/.test(l.id)) {
      const casing = /casing/.test(l.id);
      map.setPaintProperty(l.id, "line-color", casing ? (/motorway|trunk|primary|secondary|link/.test(l.id) ? "#e2d6c2" : "#e9e1d3") : (/motorway/.test(l.id) ? "#fde9c8" : "#ffffff"));
    }
  }
  map.setPaintProperty("background", "background-color", "#f6f0e6");
  // Quieter ground so our markers carry the screen: flat pale buildings, softer residential areas.
  for (const l of map.getStyle().layers) {
    if (l.type === "fill-extrusion") map.setLayoutProperty(l.id, "visibility", "none");
    else if (l.type === "fill" && /^building/.test(l.id)) { map.setPaintProperty(l.id, "fill-color", "#ebe4d8"); map.setPaintProperty(l.id, "fill-opacity", 0.6); }
    else if (l.id === "landuse_residential") map.setPaintProperty(l.id, "fill-opacity", 0.25);
  }
  for (const k of ["ok", "warn", "ko", "unk"]) {
    const m = markImage(C[k], k); map.addImage(`st-${k}`, m.image, { pixelRatio: m.pixelRatio });
    const f = markImage(C[k], "food", { size: 36, square: true }); map.addImage(`pl-${k}`, f.image, { pixelRatio: f.pixelRatio });
  }
  const h = hatchImage(); map.addImage("hatch", h.image, { pixelRatio: h.pixelRatio });
  ["works", "quais", "bus", "places", "reports", "trip", "stations", "pin", "me"].forEach((id) => map.addSource(id, { type: "geojson", data: empty() }));

  // Works only from street level: city-wide they are noise.
  map.addLayer({ id: "works-fill", type: "fill", source: "works", minzoom: 14.5, paint: { "fill-pattern": "hatch" } });
  map.addLayer({ id: "works-line", type: "line", source: "works", minzoom: 14.5, paint: { "line-color": C.works, "line-width": 1.5 } });
  const accColor = ["match", ["get", "accessibility"], "true", C.ok, "partial", C.warn, "false", C.ko, C.unk];
  map.addLayer({ id: "quais", type: "circle", source: "quais", layout: { visibility: "none" },
    paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 11, 3, 16, 8], "circle-color": accColor, "circle-stroke-color": "#fff", "circle-stroke-width": 1.5 } });
  map.addLayer({ id: "bus", type: "circle", source: "bus", minzoom: 14.5, layout: { visibility: "none" },
    paint: { "circle-radius": 6, "circle-color": accColor, "circle-stroke-color": "#fff", "circle-stroke-width": 2 } });
  map.addLayer({ id: "places", type: "symbol", source: "places", minzoom: 15, layout: {
    visibility: "none", "icon-image": ["concat", "pl-", ["get", "st"]], "icon-allow-overlap": false, "icon-padding": 3,
    "symbol-sort-key": ["match", ["get", "st"], "ok", 3, "warn", 2, "ko", 1, 0],
    "icon-size": ["interpolate", ["linear"], ["zoom"], 14, 0.45, 17, 0.8],
  } });
  { const r = markImage(C.warn, "warn", { size: 38, square: true }); map.addImage("rp-warn", r.image, { pixelRatio: r.pixelRatio });
    const k = markImage(C.ko, "warn", { size: 38, square: true }); map.addImage("rp-ko", k.image, { pixelRatio: k.pixelRatio });
    const u = markImage(C.unk, "warn", { size: 38, square: true }); map.addImage("rp-unk", u.image, { pixelRatio: u.pixelRatio }); }
  map.addLayer({ id: "reports", type: "symbol", source: "reports", minzoom: 13, layout: {
    "icon-image": ["concat", "rp-", ["get", "st"]], "icon-allow-overlap": true, "icon-size": ["interpolate", ["linear"], ["zoom"], 13, 0.55, 17, 0.9] } });
  map.addLayer({ id: "trip", type: "line", source: "trip", layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": ["coalesce", ["get", "c"], C.brand], "line-width": 7, "line-opacity": 0.9 } });
  // Zoomed out, a station is a small dot (problems slightly larger, drawn on top); its icon appears from street level.
  map.addLayer({ id: "stations-dot", type: "circle", source: "stations", maxzoom: 13.5, layout: { "circle-sort-key": ["get", "sort"] },
    paint: {
      "circle-color": ["match", ["get", "status"], "ok", C.ok, "warn", C.warn, "ko", C.ko, C.unk],
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, ["match", ["get", "status"], "ko", 3.5, "warn", 3, 2.5], 12, ["match", ["get", "status"], "ko", 6.5, "warn", 5.5, 4.5], 13.5, ["match", ["get", "status"], "ko", 8.5, "warn", 7.5, 6.5]],
      "circle-stroke-color": "#fff", "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 9, 1, 13, 2],
    } });
  map.addLayer({ id: "stations", type: "symbol", source: "stations", minzoom: 13.5,
    layout: {
      "icon-image": ["concat", "st-", ["get", "status"]], "icon-allow-overlap": false, "icon-padding": 2, "symbol-sort-key": ["get", "sort"],
      "icon-size": ["interpolate", ["linear"], ["zoom"], 13.5, 0.6, 16, 0.9],
      "text-field": ["step", ["zoom"], "", 13.5, ["get", "name"]], "text-font": ["Noto Sans Bold"],
      "text-size": 14, "text-offset": [0, 1.8], "text-anchor": "top", "text-optional": true,
    },
    paint: { "text-color": C.ink, "text-halo-color": "#fff", "text-halo-width": 2 } });
  map.addLayer({ id: "pin", type: "circle", source: "pin",
    paint: { "circle-radius": 10, "circle-color": C.brand, "circle-stroke-color": "#fff", "circle-stroke-width": 4 } });
  map.addLayer({ id: "me-halo", type: "circle", source: "me", paint: { "circle-radius": 22, "circle-color": "#1a73e8", "circle-opacity": 0.15 } });
  map.addLayer({ id: "me", type: "symbol", source: "me", layout: {
    "text-field": "Vous êtes ici", "text-font": ["Noto Sans Bold"], "text-size": 14, "text-offset": [0, 1.6], "text-anchor": "top", "text-allow-overlap": true,
  }, paint: { "text-color": "#1a4fb5", "text-halo-color": "#fff", "text-halo-width": 2 } });
  map.addLayer({ id: "me-dot", type: "circle", source: "me", paint: { "circle-radius": 9, "circle-color": "#1a73e8", "circle-stroke-color": "#fff", "circle-stroke-width": 3 } });

  map.on("click", "stations", (e) => openStation(e.features[0].properties.id));
  map.on("click", "stations-dot", (e) => openStation(e.features[0].properties.id));
  map.on("click", "places", (e) => { const id = e.features[0].properties.id; const p = S.places.find((x) => x.properties.id === id); if (p) openAcceslibre(p); });
  map.on("click", "works-fill", (e) => openWorks(e.features[0].properties, e.lngLat));
  map.on("click", "reports", (e) => { const f = reportsData[e.features[0].properties.i]; if (f) openReport(f); });
  map.on("click", "quais", (e) => quickPopup(e, "Quai"));
  map.on("click", "bus", (e) => quickPopup(e, "Arrêt de bus"));
  for (const id of ["stations", "stations-dot", "places", "reports", "works-fill", "quais", "bus"]) {
    map.on("mouseenter", id, () => (map.getCanvas().style.cursor = "pointer"));
    map.on("mouseleave", id, () => (map.getCanvas().style.cursor = ""));
  }
  map.on("moveend", () => { loadBus(); loadPlacesLayer(); loadReports(); });
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
      `<b>${esc(ACCESS_FR[p.accessibility] || p.accessibility)}</b><div style="color:#5a524a;font-size:.85em;margin-top:4px">IDFM, référentiel des arrêts</div>`)
    .addTo(map);
}

function setPin(coord) { map.getSource("pin")?.setData(coord ? { type: "Feature", geometry: { type: "Point", coordinates: coord } } : empty()); }
const flyTo = (coord, zoom = 15.5) => map.flyTo({ center: coord, zoom, padding: Sheet.padding(), essential: true });
function fitTo(coords) {
  const b = new maplibregl.LngLatBounds(coords[0], coords[0]);
  coords.forEach((c) => b.extend(c));
  map.fitBounds(b, { padding: Sheet.padding(), maxZoom: 15.5 });
}
function showPlacesOnMap(feats) {
  S.places = feats;
  map.getSource("places")?.setData({ type: "FeatureCollection", features: feats.map((f) => ({ ...f, properties: { id: f.properties.id, st: PLACE_ST[f.properties.wheelchair] } })) });
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
    $("#today").innerHTML = `<p class="err">Je n'arrive pas à charger l'état des ascenseurs. Réessayez dans un instant.</p>`;
  }
}

async function loadStatic() {
  const jobs = {
    quais: async () => { const d = await getJSON("/api/stations"); S.quais = d.features; S.meta.quais = d.meta; map.getSource("quais").setData(d); },
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

async function loadPlacesLayer() {
  if (!layerOn.places || map.getZoom() < 14) return;
  const c = map.getCenter();
  try { showPlacesOnMap((await placesAround([c.lng, c.lat])).filter((f) => f.properties.category === "food")); } catch (e) { console.warn("places", e); }
}

async function loadAlerts() {
  try {
    const d = await getJSON("/api/alerts");
    const ul = $("#alerts");
    if (!d.alerts.length) {
      ul.innerHTML = `<li class="empty-li">Rien n'a bougé depuis ${d.poller.last_poll ? hhmm(d.poller.last_poll) : "tout à l'heure"}. Je revérifie toutes les 15 minutes.</li>`;
      return;
    }
    ul.innerHTML = d.alerts.slice(0, 6).map((a) => {
      const st = a.to === "available" ? "ok" : a.to === "notavailable" ? "ko" : "unk";
      const what = st === "ok" ? "Ascenseur réparé" : st === "ko" ? "Ascenseur tombé en panne" : "On ne sait plus";
      return `<li><button class="item" data-open="${esc(a.zdcid)}">${mark(st)}<span class="t"><b>${esc(a.station)}</b>` +
        `<small>${what}, ${rel(a.detected_at)}</small></span>${icon("chev-r", "chev")}</button></li>`;
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
  $("#tile-pannes").textContent = `${c.notavailable} ascenseurs en panne`;
  $("#today").innerHTML =
    `<p class="headline">Aujourd'hui, <em>${c.notavailable}</em> ascenseurs sont en panne dans les gares d'Île-de-France.</p>` +
    `<div class="bar" aria-hidden="true"><span style="width:${pct(c.available)};background:${C.ok}"></span>` +
    `<span style="width:${pct(c.notavailable)};background:${C.ko}"></span><span style="width:${pct(c.unknown)};background:${C.unk}"></span></div>` +
    `<ul class="legend"><li><span class="sw ok"></span><b>${c.available}</b> marchent</li><li><span class="sw ko"></span><b>${c.notavailable}</b> en panne</li>` +
    `<li><span class="sw unk"></span><b>${c.unknown}</b> on ne sait pas</li></ul>` +
    `<p class="fresh">${icon("clock")}${m.stale ? "Source IDFM injoignable, dernière version connue. " : ""}Info IDFM ${rel(latest)}, vérifiée à ${hhmm(m.fetched_at)}</p>`;
}

function renderSources() {
  const items = Object.values(S.meta).filter((m) => m && m.source).map((m) =>
    `<li><a href="${esc(m.source.url)}" target="_blank" rel="noopener">${esc(m.source.name)}</a>, ${esc(m.source.license)}.${m.fetched_at ? ` Récupéré à ${hhmm(m.fetched_at)}.` : ""}</li>`);
  $("#sources-list").innerHTML = items.join("") + `<li>Recherche de lieux : IGN Géoplateforme.</li><li>Fond de carte © OpenStreetMap, OpenFreeMap.</li>`;
}

// Favourites (Maison, Travail) kept on this phone only.
const FAVS = [{ key: "home", label: "Maison", ic: "home" }, { key: "work", label: "Travail", ic: "work" }];
let pendingFav = null;
function renderFavs() {
  $("#favs").innerHTML = FAVS.map((f) => {
    const v = store.json(`fav-${f.key}`);
    return `<div class="fav"><button class="fav-go" data-fav="${f.key}"><span class="fav-ic">${icon(f.ic)}</span><span class="t"><b>${f.label}</b>` +
      `<small>${v ? esc(v.label) : "Ajouter"}</small></span></button>` +
      (v ? `<button class="fav-edit" data-fav-edit="${f.key}" aria-label="Changer l'adresse ${f.label}">Changer</button>` : "") + `</div>`;
  }).join("");
  document.querySelectorAll("[data-fav]").forEach((b) => b.addEventListener("click", () => {
    const v = store.json(`fav-${b.dataset.fav}`);
    if (v) openTrip(null, { ...v, kind: "fav" }); else askFav(b.dataset.fav);
  }));
  document.querySelectorAll("[data-fav-edit]").forEach((b) => b.addEventListener("click", () => askFav(b.dataset.favEdit)));
}
function askFav(key) {
  pendingFav = key;
  const s = $("#search");
  s.placeholder = key === "home" ? "Tapez votre adresse (Maison)" : "Tapez l'adresse de votre travail";
  s.value = ""; s.focus();
  toast(key === "home" ? "Tapez votre adresse, puis choisissez-la dans la liste." : "Tapez l'adresse de votre travail, puis choisissez-la.");
}
function saveFav(it) {
  store.set(`fav-${pendingFav}`, JSON.stringify({ label: it.label, lon: it.lon, lat: it.lat }));
  toast(`${pendingFav === "home" ? "Maison" : "Travail"} enregistré. Touchez-le pour y aller.`);
  pendingFav = null;
  $("#search").placeholder = "Une station, un lieu, une adresse";
  $("#search").value = "";
  renderFavs();

// ---------------------------------------------------------------------------
// First launch: choose a mobility profile (roadmap screen 1)
// ---------------------------------------------------------------------------
let chosen = Profile.get()?.key || null;
function renderOnboard() {
  $("#ptiles").innerHTML = PMR_PROFILES.map((p) =>
    `<button class="ptile" role="radio" aria-checked="${p.key === chosen}" data-p="${p.key}"><span class="tile-ic">${icon(p.ic)}</span><b>${esc(p.label)}</b></button>`).join("");
  document.querySelectorAll("[data-p]").forEach((b) => b.addEventListener("click", () => { chosen = b.dataset.p; renderOnboard(); $("#o-go").disabled = false; }));
  $("#o-go").disabled = !chosen;
  $("#o-name").value = Profile.name();
}
$("#o-go").addEventListener("click", () => {
  if (!chosen) return;
  Profile.save(chosen, $("#o-name").value);
  renderMe();
  show("home", "half");
  toast(`C'est noté : je vérifierai vos trajets pour un ${Profile.get().short}.`);
});
function renderMe() {
  const p = Profile.get();
  $("#me-ic").innerHTML = icon(p ? p.ic : "p-manuel");
  $("#me-name").textContent = p ? p.label.toLowerCase() : "votre profil";
  $("#h-home").innerHTML = Profile.name() ? `Où allez-vous, ${esc(Profile.name())}&nbsp;?` : "Bonjour&nbsp;! Où allez-vous&nbsp;?";
}
$("#me-chip").addEventListener("click", () => { renderOnboard(); show("onboard", "full"); });
renderMe();
if (!Profile.get() && !REPLAY) { renderOnboard(); show("onboard", "full"); }
if (REPLAY) openTrip(null, null);
}

function stationItem(st, d) {
  return `<li><button class="item" data-open="${esc(st.id)}">${mark(st.status)}<span class="t"><b>${esc(st.name)}</b>` +
    `<small>${esc(verdictText(st)[0])}</small></span><span class="end">${d != null ? fmtDist(d) : ""}${icon("chev-r", "chev")}</span></button></li>`;
}
const stationList = (rows) => `<ul class="list">${rows.map((x) => stationItem(x.st, x.d)).join("")}</ul>`;
function bindOpen(root) { root.querySelectorAll("[data-open]").forEach((b) => b.addEventListener("click", () => openStation(b.dataset.open))); }

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------
function show(view, snap) {
  for (const v of document.querySelectorAll(".view")) v.hidden = v.id !== `v-${view}`;
  // Restaurant pins stay visible while a restaurant list or detail is open, even with the chip off.
  const foodView = (view === "list" && /^Manger/.test($("#l-title").textContent)) || (view === "detail" && $("#detail")?.dataset.kind === "place");
  const wantPlaces = layerOn.places || foodView;
  if (map.getLayer("places")) map.setLayoutProperty("places", "visibility", wantPlaces ? "visible" : "none");
  Sheet.scrollTop();
  if (snap) Sheet.set(snap);
  const h = $(`#v-${view} .title`);
  if (h && view !== "home") { h.setAttribute("tabindex", "-1"); h.focus({ preventScroll: true }); }
}
function goHome() {
  show("home", "half"); setPin(null); map.getSource("trip")?.setData(empty());
  if (!layerOn.places) showPlacesOnMap([]);
  history.replaceState(null, "", location.pathname);
}
document.querySelectorAll("[data-back]").forEach((b) => b.addEventListener("click", goHome));

document.querySelectorAll("[data-go]").forEach((t) => t.addEventListener("click", () => {
  ({ trip: () => openTrip(null, null), food: openFood, near: openNearby, pannes: openPannes })[t.dataset.go]();
}));

async function here() {
  let pos = await locate();
  if (!pos) { const c = map.getCenter(); pos = [c.lng, c.lat]; toast("Je ne trouve pas votre position. Je cherche autour du centre de la carte."); }
  return pos;
}

function listView(title, sub) {
  $("#l-title").textContent = title;
  $("#l-sub").textContent = sub || "";
  $("#l-filters").innerHTML = "";
  $("#l-body").innerHTML = `<p class="muted">Je cherche…</p>`;
  show("list", "half");
}

async function openNearby() {
  listView("Autour de moi", "Les stations avec ascenseur les plus proches.");
  const pos = await here();
  if (!S.myPos) setPin(pos);
  flyTo(pos, 14.5);
  const near = nearestStations(pos, 8, 3000);
  $("#l-body").innerHTML = near.length ? stationList(near) : `<p class="muted">Aucune station avec ascenseur à moins de 3 km.</p>`;
  bindOpen($("#l-body"));
}

async function openPannes() {
  listView("Ascenseurs en panne", "Les stations où au moins un ascenseur ne marche pas, de la plus proche à la plus loin.");
  const pos = S.myPos || [map.getCenter().lng, map.getCenter().lat];
  const rows = [...S.stations.values()].filter((st) => st.ko > 0).map((st) => ({ st, d: distM(pos, st.coord) })).sort((a, b) => a.d - b.d).slice(0, 30);
  $("#l-body").innerHTML = rows.length ? stationList(rows) : `<p class="muted">Aucune panne signalée en ce moment. Bonne nouvelle !</p>`;
  bindOpen($("#l-body"));
}

// --- Restos ----------------------------------------------------------------
const foodFilters = { ok: true, help: true, wc: false };
let foodPos = null, foodAll = [];

async function openFood() {
  listView("Manger près d'ici", "Restaurants, cafés et bars décrits sur Acceslibre.");
  renderFoodFilters();
  foodPos = await here();
  if (!S.myPos) setPin(foodPos);
  flyTo(foodPos, 15.5);
  try {
    foodAll = (await placesAround(foodPos)).filter((f) => f.properties.category === "food")
      .map((f) => ({ f, d: distM(foodPos, f.geometry.coordinates) })).sort((a, b) => a.d - b.d);
    renderFood();
  } catch (e) {
    $("#l-body").innerHTML = `<p class="err">Je n'arrive pas à charger les restaurants. Réessayez dans un instant.</p>`;
  }
}
function renderFoodFilters() {
  const F = [["ok", "ok", "Sans marche"], ["help", "hand", "Avec un peu d'aide"], ["wc", "wc", "Toilettes adaptées"]];
  $("#l-filters").innerHTML = F.map(([k, ic, label]) => `<button class="fchip" data-f="${k}" aria-pressed="${foodFilters[k]}">${icon(ic)}${label}</button>`).join("");
  document.querySelectorAll("[data-f]").forEach((b) => b.addEventListener("click", () => {
    foodFilters[b.dataset.f] = !foodFilters[b.dataset.f]; b.setAttribute("aria-pressed", String(foodFilters[b.dataset.f])); renderFood();
  }));
}
function renderFood() {
  const keep = foodAll.filter(({ f }) => {
    const p = f.properties;
    const okLevel = (foodFilters.ok && p.wheelchair === "true") || (foodFilters.help && p.wheelchair === "partial") || (!foodFilters.ok && !foodFilters.help);
    return okLevel && (!foodFilters.wc || p.toilets === "true");
  });
  showPlacesOnMap(keep.map((x) => x.f));
  const total = foodAll.length;
  $("#l-sub").textContent = `${plural(keep.length, "adresse", "adresses")} sur ${total} autour de vous.`;
  $("#l-body").innerHTML = keep.length
    ? `<ul class="list">${keep.slice(0, 40).map(({ f, d }, i) => {
        const p = f.properties, st = PLACE_ST[p.wheelchair];
        return `<li><button class="item" data-place="${i}">${mark(st, "food")}<span class="t"><b>${esc(p.name || "Sans nom")}</b>` +
          `<small>${esc(PLACE_FR[p.wheelchair][0])}${p.toilets === "true" ? " · toilettes adaptées" : ""}</small>` +
          `<small>${esc(p.activity || "")}</small></span><span class="end">${fmtDist(d)}${icon("chev-r", "chev")}</span></button></li>`;
      }).join("")}</ul>`
    : `<p class="muted">Aucune adresse avec ces filtres. Essayez d'en enlever un.</p>`;
  document.querySelectorAll("[data-place]").forEach((b) => b.addEventListener("click", () => openAcceslibre(keep[+b.dataset.place].f)));
}

function acceslibreBlock(p) {
  const st = PLACE_ST[p.wheelchair], [title, sub] = PLACE_FR[p.wheelchair], wc = WC_FR[p.toilets] || WC_FR.unknown;
  const reasonIcon = (r) => /marche/i.test(r) ? "steps" : /porte/i.test(r) ? "door" : /rampe|aide/i.test(r) ? "hand" : "ok";
  return `<div class="verdict ${st}">${mark(st, "lg")}<span><strong>${esc(title)}</strong>${esc(sub)}</span></div>` +
    `<ul class="facts">` + (p.reasons || []).map((r) => `<li>${icon(reasonIcon(r))}<span>${esc(r)}</span></li>`).join("") +
    `<li>${icon("wc", wc[0])}<span>${esc(wc[1])}</span></li>` +
    (p.parking ? `<li>${icon("parking", "ok")}<span>Place de parking handicapé</span></li>` : "") + `</ul>`;
}

function openAcceslibre(f) {
  const p = f.properties, coord = f.geometry.coordinates;
  $("#detail").dataset.kind = "place";
  setPin(coord);
  show("detail", "half");
  flyTo(coord, 17);
  const near = nearestStations(coord, 3, 1500);
  $("#detail").innerHTML =
    photoSlot() +
    `<h2 id="d-title" class="title">${esc(p.name || "Sans nom")}</h2><p class="sub">${esc(p.activity || "")}${p.address ? ` · ${esc(p.address)}` : ""}</p>` +
    acceslibreBlock(p) +
    `<div class="btn-row"><button class="btn primary" id="go-to">Y aller</button><a class="btn" href="${esc(p.url)}" target="_blank" rel="noopener">${icon("ext")}Plus d'infos</a></div>` +
    `<h3 class="h2">Stations avec ascenseur à côté</h3>` +
    (near.length ? stationList(near) : `<p class="muted">Aucune station avec ascenseur à moins de 1,5 km.</p>`) +
    nearSlot() +
    `<p class="src">Accessibilité : Acceslibre (beta.gouv.fr), décrite par les lieux et les visiteurs. Licence Ouverte.</p>`;
  bindOpen($("#detail"));
  $("#go-to").addEventListener("click", () => openTrip(null, { label: p.name, lon: coord[0], lat: coord[1] }));
  fillPhoto(coord, p.id);
}

// ---------------------------------------------------------------------------
// Photos: the place's own website, else a free-licence photo taken nearby. Never invented.
// ---------------------------------------------------------------------------
// Top slot: only a photo of the place itself. Bottom slot: a photo taken nearby, kept small and below the verdict.
const photoSlot = () => `<figure class="photo" id="photo" hidden><figcaption></figcaption></figure>`;
const nearSlot = () => `<section id="photo-near" hidden><h3 class="h2">Aux alentours</h3><figure class="photo small"><figcaption></figcaption></figure></section>`;
async function fillPhoto(coord, placeId) {
  const top = $("#photo"), near = $("#photo-near");
  const q = new URLSearchParams({ lat: coord[1].toFixed(5), lon: coord[0].toFixed(5) });
  if (placeId) q.set("id", placeId);
  try {
    const { photo } = await getJSON(`/api/photo?${q}`);
    const box = photo && (photo.kind === "site" ? top : near);
    if (!box || !box.isConnected) return;
    // The <img> only exists once a real photo is known: no empty image box in the page.
    const img = document.createElement("img");
    img.decoding = "async";
    (box.tagName === "FIGURE" ? box : box.querySelector("figure")).prepend(img);
    img.alt = photo.kind === "site" ? "Photo du lieu" : "Photo prise à proximité";
    img.onload = () => { box.hidden = false; };
    img.onerror = () => box.remove();
    img.src = photo.src;
    box.querySelector("figcaption").innerHTML = `${esc(photo.caption)} · <a href="${esc(photo.link)}" target="_blank" rel="noopener">${esc(photo.credit)}</a>`;
  } catch { /* no photo is fine */ }
}

// ---------------------------------------------------------------------------
// Detail views
// ---------------------------------------------------------------------------
function openStation(id) {
  $("#detail").dataset.kind = "station";
  const st = S.stations.get(String(id));
  if (!st) { toast("Je n'ai pas d'information d'ascenseur pour cette station."); return; }
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
    (st.staleLifts ? `<p class="note">${icon("clock")}<span><b>À confirmer.</b> Pour ${who}, la dernière info IDFM date ${rel(oldest).replace(/^le /, "du ").replace("il y a", "d'il y a")}. Ça a pu changer depuis.</span></p>` : "") +
    `<div class="btn-row"><button class="btn primary" id="go-to">Y aller</button><button class="btn" id="go-from">Partir d'ici</button></div>` +
    ((quais.length || works.length) ? `<ul class="facts">` +
      (quais.length ? `<li>${icon("train")}<span><b>Quais :</b> ${qText}</span></li>` : "") +
      (works.length ? `<li>${icon("cone", "warn")}<span><b>${plural(works.length, "chantier", "chantiers")}</b> sur le trottoir à moins de 200 m</span></li>` : "") +
      `</ul>` : "") +
    `<h3 class="h2">Les ascenseurs (${lifts.length})</h3><div class="card">` +
    lifts.map((l) => {
      const s = l.status === "available" ? "ok" : l.status === "notavailable" ? "ko" : "unk";
      const old = ageH(l.source_update) > STALE_H;
      return `<div class="lift">${mark(s)}<div class="lift-body"><div class="st">${esc(LIFT_FR[l.status] || l.status)}</div>` +
        `<div class="where">${esc(l.situation || "Emplacement non précisé")}</div>${l.direction ? `<small>${esc(l.direction)}</small>` : ""}` +
        `<small class="${old ? "old" : ""}">Info IDFM ${rel(l.source_update)} (${esc(dayTime(l.source_update))})</small>` +
        `<small class="rel" data-rel="${esc(l.liftid)}"></small>` +
        (l.status !== "notavailable" ? `<button class="linkish report-lift" data-lift="${esc(l.liftid)}">Signaler une panne</button>` : "") +
        `</div></div>`;
    }).join("") + `</div>` +
    nearSlot() +
    `<p class="src">Source : IDFM, état des ascenseurs (Licence Mobilité), zone ${esc(st.id)}. Vérifié à ${hhmm(S.meta.lifts.fetched_at)}.</p>`;
  const spot = { label: st.name, lon: st.coord[0], lat: st.coord[1] };
  $("#go-to").addEventListener("click", () => openTrip(null, spot));
  $("#go-from").addEventListener("click", () => openTrip(spot, null));
  fillPhoto(st.coord);
  fillReliability(st);
  document.querySelectorAll(".report-lift").forEach((b) => b.addEventListener("click", () => reportLift(st, st.lifts.find((l) => l.liftid === b.dataset.lift))));
}

// Lift reliability from the Dispotrains archive (roadmap screen 6). Honest about the window.
async function fillReliability(st) {
  try {
    const d = await getJSON(`/api/stations/${encodeURIComponent(st.id)}/reliability`);
    for (const [liftid, r] of Object.entries(d.lifts || {})) {
      const el = document.querySelector(`[data-rel="${CSS.escape(liftid)}"]`);
      if (!el) continue;
      const down = 1 - r.availability;
      el.textContent = down < 0.02
        ? `Très fiable : presque jamais en panne (${Math.round(r.window_days)} derniers jours)`
        : `En panne environ 1 jour sur ${Math.max(2, Math.round(1 / down))} (${Math.round(r.window_days)} derniers jours, ${plural(r.outages, "panne", "pannes")})`;
      el.classList.toggle("bad", down >= 0.1);
    }
  } catch { /* the history is a bonus */ }
}

// ---------------------------------------------------------------------------
// Community reports (chantier B owns the API and the photo screen; A shows them)
// ---------------------------------------------------------------------------
const REPORT_FR = {
  escalier: "Escalier", marche: "Marche", travaux: "Travaux", trottoir_encombre: "Trottoir encombré",
  trottoir_etroit: "Trottoir étroit", bordure_haute: "Bordure haute", pente: "Pente forte",
  ascenseur_panne: "Ascenseur en panne", escalator_panne: "Escalator en panne", rampe: "Rampe", autre: "Obstacle",
};
const GRAV_ST = { bloquant: "ko", genant: "warn", info: "unk" };
const userId = () => store.get("pmr_user_id");

function reportLift(st, lift) {
  openReportFlow({ cat: "ascenseur_panne", place: { label: st.name, sub: lift.situation || "Ascenseur de la station", lon: st.coord[0], lat: st.coord[1] },
    target: { type: "lift", id: lift.liftid } });
}

// ---------------------------------------------------------------------------
// Report flow (roadmap screen 5): what, where, optional voice / photo / text, then send.
// The API (POST /api/reports, /api/reports/analyze) belongs to chantier B; without it we say so.
// ---------------------------------------------------------------------------
const R_CATS = [
  { key: "ascenseur_panne", label: "Ascenseur en panne", ic: "lift", gravite: "bloquant", temporaire: true },
  { key: "trottoir_encombre", label: "Obstacle sur le passage", ic: "cone", gravite: "genant", temporaire: true },
  { key: "marche", label: "Marche ou rampe impossible", ic: "steps", gravite: "bloquant", temporaire: false },
  { key: "autre", label: "Autre problème", ic: "unk", gravite: "info", temporaire: true },
];
const rep = { cat: null, place: null, target: null, text: "", photo: null, ai: null };

function openReportFlow({ cat = null, place = null, target = null }) {
  Object.assign(rep, { cat, target, text: "", photo: null, ai: null });
  if (!place) {
    const pos = S.myPos || [map.getCenter().lng, map.getCenter().lat];
    const near = nearestStations(pos, 1, 250)[0];
    place = near ? { label: near.st.name, sub: "Station la plus proche de vous", lon: near.st.coord[0], lat: near.st.coord[1] }
      : { label: "Ici", sub: S.myPos ? "Votre position" : "Le centre de la carte", lon: pos[0], lat: pos[1] };
    if (near && !target) rep.target = { type: "station", id: near.st.id };
  }
  rep.place = place;
  $("#r-place").textContent = place.label;
  $("#r-place-sub").textContent = place.sub;
  $("#r-text").value = ""; $("#r-text").hidden = true; $("#r-thumb").hidden = true; $("#r-photo").value = "";
  renderReportCats();
  show("report", "full");
  setPin([place.lon, place.lat]);
}

function renderReportCats() {
  $("#r-cats").innerHTML = R_CATS.map((c) => `<button class="r-cat" role="radio" aria-checked="${rep.cat === c.key}" data-cat="${c.key}">${icon(c.ic)}<span>${c.label}</span></button>`).join("");
  document.querySelectorAll("[data-cat]").forEach((b) => b.addEventListener("click", () => { rep.cat = b.dataset.cat; renderReportCats(); }));
  renderReportSummary();
}

function renderReportSummary() {
  const c = R_CATS.find((x) => x.key === rep.cat);
  $("#r-send").disabled = !c;
  if (!c) { $("#r-summary").innerHTML = ""; return; }
  const ai = rep.ai;
  const grav = { bloquant: "Bloquant en fauteuil", genant: "Gênant", info: "Pour information" }[ai?.gravite || c.gravite];
  $("#r-summary").innerHTML =
    `<p class="r-sum-head">${icon(ai ? "spark" : "ok")}${ai ? "Ce que Roulib a compris de votre photo" : "Vous allez signaler"}</p>` +
    `<p><b>${esc(ai ? (REPORT_FR[ai.categorie] || c.label) : c.label)}</b> à ${esc(rep.place.label)}. ${esc(grav)}${(ai?.temporaire ?? c.temporaire) ? ", sans doute temporaire" : ""}.</p>` +
    (ai?.description ? `<p class="muted">${esc(ai.description)}</p>` : "") +
    (ai ? `<p class="muted">Vérifiez avant d'envoyer : c'est une proposition, pas une certitude.</p>` : "");
}

$("#r-text-btn").addEventListener("click", () => { $("#r-text").hidden = false; $("#r-text").focus(); });
$("#r-text").addEventListener("input", (e) => { rep.text = e.target.value; });
(() => {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const btn = $("#r-voice");
  if (!SR) { btn.hidden = true; return; }
  const rec = new SR(); rec.lang = "fr-FR";
  rec.onresult = (e) => { const t = e.results[0][0].transcript; $("#r-text").hidden = false; $("#r-text").value = (rep.text ? rep.text + " " : "") + t; rep.text = $("#r-text").value; };
  rec.onerror = () => toast("Je n'ai pas bien entendu. Réessayez.");
  rec.onend = () => btn.classList.remove("listening");
  btn.addEventListener("click", () => { btn.classList.add("listening"); toast("Je vous écoute. Décrivez le problème."); try { rec.start(); } catch {} });
})();

// Photo: resized to 1024 px JPEG (Vercel refuses bodies over 4.5 MB), then analysed if B's route exists.
$("#r-photo").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const bmp = await createImageBitmap(file).catch(() => null);
  if (!bmp) return toast("Je n'arrive pas à lire cette photo.");
  const k = Math.min(1, 1024 / Math.max(bmp.width, bmp.height));
  const cv = document.createElement("canvas"); cv.width = Math.round(bmp.width * k); cv.height = Math.round(bmp.height * k);
  cv.getContext("2d").drawImage(bmp, 0, 0, cv.width, cv.height);
  rep.photo = cv.toDataURL("image/jpeg", 0.7);
  $("#r-thumb").src = rep.photo; $("#r-thumb").hidden = false;
  $("#r-summary").insertAdjacentHTML("afterbegin", `<p class="muted" id="r-analyzing">${icon("spark")}J'analyse la photo…</p>`);
  try {
    const r = await fetch("/api/reports/analyze", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image_base64: rep.photo.split(",")[1], lat: rep.place.lat, lon: rep.place.lon }) });
    if (!r.ok) throw new Error(r.status);
    rep.ai = await r.json();
    if (rep.ai?.categorie) rep.cat = R_CATS.some((c) => c.key === rep.ai.categorie) ? rep.ai.categorie : (rep.ai.categorie === "escalier" ? "marche" : rep.cat || "autre");
    renderReportCats();
  } catch {
    $("#r-analyzing")?.remove();
    toast("Photo ajoutée. L'analyse automatique n'est pas encore disponible.");
  }
});

$("#r-send").addEventListener("click", async () => {
  const c = R_CATS.find((x) => x.key === rep.cat);
  if (!c) return;
  const btn = $("#r-send"); btn.disabled = true; btn.textContent = "Envoi…";
  try {
    const r = await fetch("/api/reports", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
      categorie: rep.ai?.categorie || c.key, temporaire: rep.ai?.temporaire ?? c.temporaire, gravite: rep.ai?.gravite || c.gravite,
      description: rep.text || rep.ai?.description || `${c.label} à ${rep.place.label}`, confiance: rep.ai?.confiance ?? 1,
      user_id: userId(), lat: rep.place.lat, lon: rep.place.lon, target_type: rep.target?.type || "place", target_id: rep.target?.id || null,
      photo_thumb: rep.photo || null,
    }) });
    if (!r.ok) throw new Error(r.status);
    toast("Merci ! C'est sur la carte. Les autres utilisateurs pourront confirmer.");
    goHome(); loadReports();
  } catch {
    toast("Les signalements ne sont pas encore branchés : celui-ci n'a pas été envoyé. Réessayez plus tard.", 5000);
  } finally { btn.disabled = false; btn.textContent = "Envoyer le signalement"; }
});

let reportsData = [];
async function loadReports() {
  if (map.getZoom() < 13) return;
  const b = map.getBounds();
  const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map((v) => v.toFixed(5)).join(",");
  try {
    const d = await getJSON(`/api/reports?bbox=${bbox}`);
    reportsData = d.features || [];
    map.getSource("reports")?.setData({ type: "FeatureCollection", features: reportsData.map((f, i) => ({ ...f, properties: { i, st: GRAV_ST[f.properties.gravite] || "warn" } })) });
  } catch { /* no reports API yet */ }
}

function openReport(f) {
  const p = f.properties, coord = f.geometry.coordinates, st = GRAV_ST[p.gravite] || "warn";
  setPin(coord);
  show("detail", "half");
  flyTo(coord, 17);
  $("#detail").innerHTML =
    (p.photo_thumb ? `<figure class="photo" id="photo"><img alt="Photo du signalement" src="${esc(p.photo_thumb)}"><figcaption>Photo prise par un utilisateur</figcaption></figure>` : "") +
    `<h2 id="d-title" class="title">${esc(REPORT_FR[p.categorie] || "Obstacle signalé")}</h2>` +
    `<p class="sub">Signalé par la communauté ${p.created_at ? rel(p.created_at) : ""}${p.is_demo ? " · signalement de démonstration" : ""}</p>` +
    `<div class="verdict ${st}">${mark(st, "lg")}<span><strong>${p.gravite === "bloquant" ? "Bloquant en fauteuil" : p.gravite === "genant" ? "Gênant" : "Pour information"}</strong>${esc(p.description || "")}</span></div>` +
    `<p class="trip-meta">${confPill(p.confidence || 2)} <span class="muted">${plural(p.confirmations || 1, "personne l'a vu", "personnes l'ont vu")}</span></p>` +
    `<button class="btn primary block" id="still-there">${icon("ok")}C'est toujours là</button>` +
    `<p class="src">Signalement communautaire, non vérifié par une source officielle. Il perd en confiance s'il n'est pas confirmé.</p>`;
  $("#still-there").addEventListener("click", async (e) => {
    e.currentTarget.disabled = true;
    try {
      const r = await fetch(`/api/reports/${encodeURIComponent(p.id)}/confirm`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ user_id: userId() }) });
      if (!r.ok) throw new Error(r.status);
      const d = await r.json().catch(() => ({}));
      toast(`Merci ! ${d.confirmations ? plural(d.confirmations, "personne l'a confirmé", "personnes l'ont confirmé") : "Confirmation enregistrée"}.`);
      loadReports();
    } catch { e.currentTarget.disabled = false; toast("Je n'ai pas pu enregistrer. Réessayez dans un instant."); }
  });
}

async function openPlace(item) {
  const coord = [item.lon, item.lat];
  setPin(coord);
  show("detail", "half");
  flyTo(coord, 16);
  const near = nearestStations(coord, 3, 1500);
  const works = worksNear(coord, 150);
  $("#detail").innerHTML = photoSlot() +
    `<h2 id="d-title" class="title">${esc(item.label)}</h2><p class="sub">${esc(item.sub || "")}</p>` +
    `<div id="place-access"><p class="muted">Je regarde si le lieu est accessible…</p></div>` +
    (works.length ? `<p class="note">${icon("cone")}<span><b>${plural(works.length, "chantier", "chantiers")} sur le trottoir</b> à moins de 150 m. ${esc(works[0].p.summary || "Travaux")}, jusqu'au ${esc(works[0].p.end)}.</span></p>` : "") +
    `<div class="btn-row"><button class="btn primary" id="go-to">Y aller</button><button class="btn" id="go-from">Partir d'ici</button></div>` +
    `<h3 class="h2">Stations avec ascenseur à côté</h3>` +
    (near.length ? stationList(near) : `<p class="muted">Aucune station avec ascenseur à moins de 1,5 km.</p>`) +
    nearSlot() +
    `<p class="src">Lieu : IGN Géoplateforme. Ascenseurs : IDFM. Chantiers : Ville de Paris.</p>`;
  bindOpen($("#detail"));
  $("#go-to").addEventListener("click", () => openTrip(null, item));
  $("#go-from").addEventListener("click", () => openTrip(item, null));
  // Same place in Acceslibre? Match by name within 120 m.
  try {
    const key = norm(item.label);
    const cands = (await placesAround(coord, 0.003, 0.002))
      .map((f) => ({ f, d: distM(coord, f.geometry.coordinates), k: norm(f.properties.name) }))
      .filter((x) => x.d < 120 && x.k && (x.k.includes(key) || key.includes(x.k))).sort((a, b) => a.d - b.d);
    const box = $("#place-access");
    if (!box) return;
    fillPhoto(coord, cands.length ? cands[0].f.properties.id : null);
    box.innerHTML = cands.length
      ? acceslibreBlock(cands[0].f.properties) + `<p class="src"><a href="${esc(cands[0].f.properties.url)}" target="_blank" rel="noopener">Voir la fiche Acceslibre</a></p>`
      : `<div class="verdict unk">${mark("unk", "lg")}<span><strong>Pas encore décrit</strong>Ce lieu n'a pas de fiche d'accessibilité sur Acceslibre.</span></div>`;
  } catch {
    const box = $("#place-access"); if (box) box.innerHTML = "";
  }
}

function openWorks(p, lngLat) {
  setPin([lngLat.lng, lngLat.lat]);
  show("detail", "half");
  $("#detail").innerHTML =
    `<h2 id="d-title" class="title">Travaux sur le trottoir</h2><p class="sub">${esc(p.postcode || "Paris")}</p>` +
    `<div class="verdict warn">${mark("warn", "lg")}<span><strong>${esc(p.summary || "Travaux")}</strong>Du ${esc(p.start)} au ${esc(p.end)}.</span></div>` +
    `<ul class="facts"><li>${icon("cone")}<span><b>Où :</b> ${esc((p.where || "").replace(/EMPRISE_/g, "").toLowerCase().replace(/_/g, " "))}</span></li>` +
    `<li>${icon("place")}<span><b>Qui :</b> ${esc(p.owner || "non précisé")}</span></li></ul>` +
    `<p class="muted">Le passage peut être plus étroit ou dévié. Prévoyez de traverser un peu avant.</p>` +
    `<p class="src">Source : Ville de Paris, chantiers à Paris (ODbL), emprise ${esc(p.id)}.</p>`;
}

// ---------------------------------------------------------------------------
// Trip
// ---------------------------------------------------------------------------
const trip = { from: null, to: null };
const myPosItem = () => (S.myPos ? { label: "Ma position", lon: S.myPos[0], lat: S.myPos[1], kind: "me" } : null);

$("#trip-summary").addEventListener("click", () => { $("#v-trip").classList.remove("has-result"); $("#trip-to").focus(); });
function openTrip(from, to) {
  $("#v-trip").classList.remove("has-result");
  trip.from = from || trip.from || myPosItem();
  trip.to = to || trip.to;
  $("#trip-from").value = trip.from ? trip.from.label : "";
  $("#trip-to").value = trip.to ? trip.to.label : "";
  $("#trip-result").innerHTML = "";
  show("trip", "full");
  if (!trip.from) locate().then(() => { if (!trip.from && S.myPos) { trip.from = myPosItem(); $("#trip-from").value = trip.from.label; if (trip.to) runTrip(); } });
  if (REPLAY || (trip.from && trip.to)) runTrip(); else if (trip.from) $("#trip-to").focus();
  else $("#trip-result").innerHTML = demoButton(), bindDemo();
}

const REPLAY = new URLSearchParams(location.search).get("replay") === "demo";
const VERDICT = {
  passe: { st: "ok", title: () => "Ce trajet passe", sub: (p) => `Rien ne bloque pour un ${p}.` },
  risque: { st: "warn", title: () => "Possible, avec des risques", sub: () => "Regardez les étapes en orange avant de partir." },
  bloque: { st: "ko", title: (it) => `Bloqué${it.blocked_at ? ` à ${it.blocked_at}` : ""}`, sub: () => "Ne partez pas sur ce trajet. Voyez le plan B." },
};
// Confidence levels (roadmap 4.3): colour + icon + words, never colour alone.
const CONF = {
  5: ["ok", "shield", "Officiel, en direct"], 4: ["ok", "people", "Confirmé par la communauté"],
  3: ["unk", "shield", "Officiel, information fixe"], 2: ["warn", "people", "Un seul signalement"], 1: ["unk", "unk", "Inconnu"],
};
const checkState = (c) => c.status === "ok" ? "ok" : c.status === "en_panne" || c.effect === "bloquant" ? "ko" : c.status === "inconnu" ? "unk" : "warn";
// In replay mode a level-5 source is official but recorded, not live: say so.
const confPill = (n, recorded) => {
  let [st, ic, label] = CONF[n] || CONF[1];
  if (recorded && n === 5) label = "Officiel, enregistré";
  return `<span class="pill ${st}">${icon(ic)}${label}</span>`;
};
const whenMap = (fn) => (map.isStyleLoaded() && map.getSource("trip") ? fn() : map.once("idle", fn));
const yyyymmddToTime = (s) => (s && s.length >= 13 ? `${s.slice(9, 11)}h${s.slice(11, 13)}` : "");

// Public line colours of the Île-de-France network (signage convention), for line chips.
const LINE_COLORS = {
  "Métro": { 1: "#FFCD00", 2: "#003CA6", 3: "#837902", "3B": "#6EC4E8", 4: "#CF009E", 5: "#FF7E2E", 6: "#6ECA97", 7: "#FA9ABA", "7B": "#6ECA97",
    8: "#E19BDF", 9: "#B6BD00", 10: "#C9910D", 11: "#704B1C", 12: "#007852", 13: "#6EC4E8", 14: "#62259D" },
  "RER": { A: "#E2231A", B: "#5291CE", C: "#FFCD00", D: "#00814F", E: "#C04191" },
};
function lineColor(mode, line) {
  const m = /rer/i.test(mode || "") ? "RER" : /m[ée]tro/i.test(mode || "") ? "Métro" : null;
  const c = m && LINE_COLORS[m][String(line || "").toUpperCase().replace("BIS", "B")];
  return c || (/(bus)/i.test(mode || "") ? "#1e1a16" : /tram/i.test(mode || "") ? "#00643c" : "#3d3bd6");
}
function inkOn(hex) {
  const n = parseInt(hex.slice(1), 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255;
  return (0.299 * r + 0.587 * g + 0.114 * b) > 160 ? "#1e1a16" : "#ffffff";
}
const modeShort = (mode) => (/rer/i.test(mode || "") ? "RER" : /m[ée]tro/i.test(mode || "") ? "M" : /tram/i.test(mode || "") ? "T" : /bus/i.test(mode || "") ? "Bus" : "");
// One Citymapper-style chip per step: wheelchair + minutes for walks, coloured line badge for transit.
function stepChip(s) {
  const st = { bloque: "ko", risque: "warn" }[s.verdict];
  const flag = st ? `<span class="chip-flag ${st}" aria-hidden="true">${icon(st)}</span>` : "";
  if (s.type === "transit") {
    const bg = lineColor(s.mode, s.line);
    return `<span class="lchip" style="background:${bg};color:${inkOn(bg)}" aria-label="${esc(s.mode)} ${esc(s.line)}${st ? ", attention" : ""}">${esc(modeShort(s.mode))}&nbsp;${esc(s.line || "")}${flag}</span>`;
  }
  return `<span class="wchip" aria-label="${s.duration_min || ""} minutes en fauteuil${st ? ", attention" : ""}">${icon(Profile.get()?.ic || "p-manuel")}${s.duration_min ? `${s.duration_min}′` : ""}${flag}</span>`;
}
const chipsRow = (it) => it.steps.filter((s) => s.type !== "walk" || (s.duration_min || 0) >= 1)
  .map(stepChip).join(`<span class="chev-sep" aria-hidden="true">›</span>`);
const RANK = { passe: 0, risque: 1, bloque: 2 };
let lastTrip = null;

async function runTrip(opts = {}) {
  const out = $("#trip-result");
  const demo = opts.demo || REPLAY;
  if (!demo && (!trip.from || !trip.to)) { out.innerHTML = `<p class="err">Choisissez le départ et l'arrivée dans la liste qui s'affiche.</p>`; return; }
  document.activeElement?.blur();
  out.innerHTML = `<p class="muted">Je vérifie chaque étape pour votre ${esc(Profile.get()?.short || "profil")}…</p>`;
  const q = new URLSearchParams({ profile: Profile.key() });
  if (demo) { q.set("replay", "demo"); q.set("from", "demo"); q.set("to", "demo"); }
  else { q.set("from", `${trip.from.lon},${trip.from.lat}`); q.set("to", `${trip.to.lon},${trip.to.lat}`); }
  try {
    const d = await getJSON(`/api/journey?${q}`);
    if (demo) { trip.from = d.from; trip.to = d.to; $("#trip-from").value = d.from.label; $("#trip-to").value = d.to.label; }
    lastTrip = d;
    renderResults(d);
  } catch (e) {
    if (e.status === 503) renderTripFallback();
    else out.innerHTML = `<p class="err">Je n'ai pas trouvé de trajet. ${esc(e.message)}</p>` + demoButton();
    bindDemo();
  }
}
const demoButton = () => `<button class="btn block" id="trip-demo">${icon("route")}Voir un trajet d'exemple (enregistré)</button>`;
const bindDemo = () => $("#trip-demo")?.addEventListener("click", () => runTrip({ demo: true }));

function renderTripFallback() {
  const a = [trip.from.lon, trip.from.lat], b = [trip.to.lon, trip.to.lat];
  const block = (label, coord) => {
    const near = nearestStations(coord, 3, 1500);
    return `<h3 class="h2">${label}</h3>` + (near.length ? stationList(near) : `<p class="muted">Aucune station avec ascenseur à moins de 1,5 km.</p>`);
  };
  $("#trip-result").innerHTML =
    `<div class="verdict unk">${mark("unk", "lg")}<span><strong>Le calcul du trajet n'est pas encore branché</strong>En attendant, voici les stations avec ascenseur au départ et à l'arrivée.</span></div>` +
    demoButton() + block("Au départ", a) + block("À l'arrivée", b);
  bindOpen($("#trip-result"));
  Sheet.set("half");
  fitTo([a, b]);
}

function stepTitle(s) {
  if (s.type === "transit") return `${esc(s.mode || "Transport")} ${esc(s.line || "")}`.trim();
  if (s.type === "transfer") return "Correspondance";
  return { manuel: "En fauteuil", electrique: "En fauteuil", poussette: "Avec la poussette" }[Profile.key()] || "À pied";
}
function checkLine(c, recorded) {
  const st = checkState(c);
  const rel = c.reliability != null
    ? `<small>Historique : en panne environ 1 jour sur ${Math.max(2, Math.round(1 / Math.max(0.01, 1 - c.reliability)))} (${Math.round(c.reliability_window_days || 0)} derniers jours, ${esc(c.reliability_source || "")})</small>` : "";
  return `<li class="check">${mark(st)}<div><b>${esc(c.label || c.kind)}</b><div>${esc(c.message || "")}</div>${rel}` +
    `<div class="meta">${confPill(c.confidence, recorded)}${c.fetched_at ? `<span class="muted">${esc(c.source || "")} · vérifié à ${hhmm(c.fetched_at)}</span>` : `<span class="muted">${esc(c.source || "")}</span>`}</div></div></li>`;
}

// Ranked options, like Citymapper's result list, but ordered by what works for this profile.
function renderResults(d) {
  const its = [...d.itineraries].sort((x, y) => (RANK[x.verdict] - RANK[y.verdict]) || (x.duration_min - y.duration_min));
  const rec = d.replay === "demo";
  const prof = Profile.get()?.short || "profil";
  $("#v-trip").classList.add("has-result");
  $("#trip-summary").innerHTML = `<span class="t">${esc(d.from?.label || trip.from?.label || "")} → ${esc(d.to?.label || trip.to?.label || "")}</span><span class="linkish">Modifier</span>`;
  if (!its.length) { $("#trip-result").innerHTML = `<p>Je n'ai pas trouvé de trajet.</p>` + demoButton(); bindDemo(); return; }
  const best = its[0];
  $("#trip-result").innerHTML =
    `<p class="results-head">${best.verdict === "bloque" ? `Aucun trajet ne passe pour un ${esc(prof)} en ce moment.` : `${plural(its.filter((x) => x.verdict !== "bloque").length, "trajet possible", "trajets possibles")} pour un ${esc(prof)}`}</p>` +
    (rec ? `<p class="rec-line">${icon("clock")}Exemple enregistré, pas en direct</p>` : "") +
    `<ul class="routes">` + its.map((it, i) => {
      const V = VERDICT[it.verdict] || VERDICT.risque;
      const why = it.verdict === "bloque" ? V.title(it)
        : it.verdict === "risque" ? `À surveiller : ${[...new Set(it.steps.flatMap((s) => (s.checks || []).filter((c) => checkState(c) === "warn").map((c) => c.label.toLowerCase())))].slice(0, 2).join(", ") || "voir les étapes"}`
        : "Rien ne bloque sur ce trajet";
      return `<li><button class="route ${V.st}" data-it="${esc(it.id)}">` +
        `<span class="route-top">${i === 0 && it.verdict !== "bloque" ? `<span class="tag">Le mieux pour vous</span>` : ""}<span class="chips">${chipsRow(it)}</span>` +
        `<span class="mins"><b>${it.duration_min}</b><small>min</small></span></span>` +
        `<span class="route-why">${mark(V.st)}<span>${esc(why)}${it.departure ? `<small>Départ ${yyyymmddToTime(it.departure)} · arrivée ${yyyymmddToTime(it.arrival)}</small>` : ""}</span></span>` +
        `</button></li>`;
    }).join("") + `</ul>` +
    (d.baseline?.length ? `<button class="btn block" id="compare-btn">${icon("swap")}Ce qu'une appli classique vous aurait dit</button>` : "") +
    `<p class="src">Trajets Navitia (option fauteuil), vérifiés étape par étape par Roulib pour le profil « ${esc(prof)} ». Ascenseurs vérifiés à ${hhmm(d.lifts_fetched_at)}.</p>`;
  document.querySelectorAll("[data-it]").forEach((b) => b.addEventListener("click", () => renderItinerary(d, b.dataset.it)));
  $("#compare-btn")?.addEventListener("click", () => openCompare(d));
  whenMap(() => drawItinerary(best));
  Sheet.set("half");
  Sheet.scrollTop();
}

function renderItinerary(d, id) {
  const it = d.itineraries.find((x) => x.id === id) || d.itineraries[0];
  if (!it) { $("#trip-result").innerHTML = `<p>Je n'ai pas trouvé de trajet.</p>` + demoButton(); bindDemo(); return; }
  const prof = Profile.get()?.short || "profil";
  const V = VERDICT[it.verdict] || VERDICT.risque;
  const isPlanB = d.itineraries[0] && it.id !== d.itineraries[0].id;
  const planB = it.plan_b_id && d.itineraries.find((x) => x.id === it.plan_b_id);
  const rec = d.replay === "demo";
  $("#v-trip").classList.add("has-result");
  $("#trip-summary").innerHTML = `<span class="t">${esc(d.from?.label || trip.from?.label || "")} → ${esc(d.to?.label || trip.to?.label || "")}</span><span class="linkish">Modifier</span>`;
  $("#trip-result").innerHTML =
    `<button class="back" id="all-routes">${icon("chev-l")}Tous les trajets</button>` +
    (isPlanB ? `<p class="badge-b">Plan B</p>` : "") +
    `<div class="verdict big ${V.st}">${mark(V.st, "lg")}<span><strong>${esc(V.title(it))}</strong>${esc(V.sub(prof))}</span></div>` +
    `<p class="trip-meta">${it.duration_min} min${it.departure ? ` · départ ${yyyymmddToTime(it.departure)}, arrivée ${yyyymmddToTime(it.arrival)}` : ""} ${confPill(it.confidence, rec)}</p>` +
    (rec ? `<p class="rec-line">${icon("clock")}Exemple enregistré, pas en direct</p>` : "") +
    (planB ? `<button class="btn primary block" id="planb">${icon("swap")}Voir le plan B (${planB.duration_min} min)</button>` : "") +
    (isPlanB ? `<button class="btn block" id="plana">Revenir au premier trajet</button>` : "") +
    `<ol class="timeline">` + it.steps.map((s) => {
      const st = { passe: "ok", risque: "warn", bloque: "ko" }[s.verdict] || "unk";
      const rail = s.type === "transit" ? lineColor(s.mode, s.line) : null;
      const badge = s.type === "transit"
        ? `<span class="lchip" style="background:${rail};color:${inkOn(rail)}">${esc(modeShort(s.mode))}&nbsp;${esc(s.line || "")}</span>`
        : `<span class="wchip">${icon(Profile.get()?.ic || "p-manuel")}</span>`;
      return `<li class="tl ${s.type} ${st}" style="--rail:${rail || "#b9b0a2"}">` +
        `<div class="tl-stop"><span class="tl-dot"></span><b>${esc(s.from)}</b></div>` +
        `<div class="tl-body">${badge}<div><b>${stepTitle(s)}</b><small>${s.duration_min ? `${s.duration_min} min` : ""}${s.type === "transit" ? ` · jusqu'à ${esc(s.to)}` : ""}</small></div><span class="tl-state">${mark(st)}</span></div>` +
        (s.checks?.length ? `<ul class="checks">${s.checks.map((c) => checkLine(c, rec)).join("")}</ul>` : `<p class="muted small">Rien de particulier signalé.</p>`) + `</li>`;
    }).join("") + `<li class="tl end"><div class="tl-stop"><span class="tl-dot"></span><b>${esc(it.steps[it.steps.length - 1]?.to || "")}</b></div></li></ol>` +
    `<p class="src">Vérification Roulib pour le profil « ${esc(prof)} ». Ascenseurs vérifiés à ${hhmm(d.lifts_fetched_at)}.</p>`;
  $("#planb")?.addEventListener("click", () => { renderItinerary(d, it.plan_b_id); Sheet.scrollTop(); });
  $("#plana")?.addEventListener("click", () => { renderItinerary(d, d.itineraries[0].id); Sheet.scrollTop(); });
  $("#all-routes").addEventListener("click", () => renderResults(d));
  whenMap(() => drawItinerary(it));
  Sheet.set("half");
  Sheet.scrollTop();
}

function drawItinerary(it) {
  const color = { passe: C.ok, risque: C.warn, bloque: C.ko };
  map.getSource("trip")?.setData({ type: "FeatureCollection", features: it.steps.filter((s) => s.geojson).map((s) => ({
    type: "Feature", geometry: s.geojson, properties: { c: color[s.verdict] || C.brand } })) });
  const pts = it.steps.flatMap((s) => (s.geojson?.coordinates || []));
  if (pts.length) fitTo(pts.filter((_, i) => i % Math.ceil(pts.length / 40) === 0).concat([pts[pts.length - 1]]));
}

// Same Navitia route on both sides: what it says vs what our checks find.
function openCompare(d) {
  const base = d.baseline[0];
  const ours = d.itineraries[0];
  const planB = ours.plan_b_id && d.itineraries.find((x) => x.id === ours.plan_b_id);
  const blockers = ours.steps.flatMap((s) => (s.checks || []).filter((c) => checkState(c) !== "ok"));
  $("#compare").innerHTML =
    `<div class="cmp">` +
    `<div class="cmp-col"><h3>Appli classique</h3><div class="verdict ok">${mark("ok")}<span><strong>« Accessible »</strong>${base.duration_min} min</span></div>` +
    `<ul class="cmp-list">${base.steps.map((s) => `<li>${s.type === "public_transport" ? `${esc(s.mode)} ${esc(s.line)}` : "À pied"}<small>${esc(s.from)} → ${esc(s.to)}</small></li>`).join("")}</ul></div>` +
    `<div class="cmp-col ours"><h3>Roulib</h3><div class="verdict ${VERDICT[ours.verdict].st}">${mark(VERDICT[ours.verdict].st)}<span><strong>${esc(VERDICT[ours.verdict].title(ours))}</strong>${ours.duration_min} min</span></div>` +
    `<ul class="cmp-list">${blockers.map((c) => `<li class="hit">${mark(checkState(c))}<span>${esc(c.label)}<small>${esc(c.message || "")}</small></span></li>`).join("") || "<li>Rien à signaler</li>"}</ul></div>` +
    `</div>` + (planB ? `<button class="btn primary block" id="cmp-planb">${icon("swap")}Roulib propose un plan B (${planB.duration_min} min)</button>` : "") +
    `<p class="src">À gauche : la réponse de Navitia seule (option fauteuil). À droite : le même trajet vérifié étape par étape avec les données ${d.replay === "demo" ? "enregistrées le 22/10 au matin" : "en direct"}.</p>`;
  $("#cmp-planb")?.addEventListener("click", () => { show("trip", "half"); renderItinerary(d, planB.id); });
  show("compare", "full");
}
document.querySelector("[data-back-trip]")?.addEventListener("click", () => { show("trip", "half"); if (lastTrip) renderResults(lastTrip); });

$("#trip-go").addEventListener("click", () => runTrip());

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

function autocomplete(input, list, onPick, { withMe = false, onFocus, stations = true } = {}) {
  let items = [], sel = -1, timer = null, seq = 0;
  const render = () => {
    if (!items.length) { list.hidden = true; input.setAttribute("aria-expanded", "false"); input.removeAttribute("aria-activedescendant"); return; }
    list.innerHTML = items.map((it, i) => {
      const lead = it.kind === "station" ? mark(it.status) : it.kind === "acces" ? mark(it.status, "food")
        : `<span class="mark neutral sq" aria-hidden="true">${icon(it.kind === "me" ? "locate" : it.kind === "place" ? "place" : it.kind === "fav" ? "home" : "address")}</span>`;
      return `<li role="option" id="${list.id}-${i}" aria-selected="${i === sel}" data-i="${i}">${lead}<span class="t"><b>${esc(it.label)}</b><small>${esc(it.sub || "")}</small></span></li>`;
    }).join("");
    list.hidden = false; input.setAttribute("aria-expanded", "true");
    if (sel >= 0) input.setAttribute("aria-activedescendant", `${list.id}-${sel}`);
    list.querySelectorAll("li").forEach((li) => li.addEventListener("click", () => pick(+li.dataset.i)));
  };
  const pick = (i) => { const it = items[i]; if (!it) return; items = []; render(); input.value = it.label; input.blur(); onPick(it); };
  const favItems = () => FAVS.map((f) => { const v = store.json(`fav-${f.key}`); return v && { ...v, kind: "fav", sub: f.label }; }).filter(Boolean);
  const run = async () => {
    const q = input.value.trim(), my = ++seq;
    const head = [];
    if (withMe && myPosItem() && (!q || norm("ma position").startsWith(norm(q)))) head.push({ ...myPosItem(), sub: "Partir d'où vous êtes" });
    if (withMe && !q) head.push(...favItems());
    if (q.length < 2) { items = head; sel = -1; render(); return; }
    const local = stations ? localStations(q) : [];
    items = [...head, ...local]; sel = -1; render();
    const ref = S.myPos || [map.getCenter().lng, map.getCenter().lat];
    const [ign, acc] = await Promise.all([
      getJSON(`/api/suggest?q=${encodeURIComponent(q)}`).catch(() => ({ results: [] })),
      q.length >= 3 ? getJSON(`/api/places/search?q=${encodeURIComponent(q)}&lon=${ref[0]}&lat=${ref[1]}`).catch(() => ({ features: [] })) : { features: [] },
    ]);
    if (my !== seq) return;
    const places = acc.features.map((f) => ({ kind: "acces", f, label: f.properties.name, status: PLACE_ST[f.properties.wheelchair],
      sub: `${PLACE_FR[f.properties.wheelchair][0]} · ${f.properties.address || f.properties.activity || ""}`, lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] }));
    items = [...head, ...local, ...places.slice(0, 3), ...ign.results.slice(0, 4)]; render();
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

const pickMain = (it) => {
  if (pendingFav) return saveFav(it);
  return it.kind === "station" ? openStation(it.id) : it.kind === "acces" ? openAcceslibre(it.f) : openPlace(it);
};
const mainSearch = autocomplete($("#search"), $("#suggest"), pickMain, { onFocus: () => isPhone() && Sheet.set("full") });
autocomplete($("#trip-from"), $("#suggest-from"), (it) => { trip.from = it; if (trip.to) runTrip(); else $("#trip-to").focus(); }, { withMe: true });
autocomplete($("#trip-to"), $("#suggest-to"), (it) => { trip.to = it; if (trip.from) runTrip(); }, { withMe: true });

// ---------------------------------------------------------------------------
// Geolocation
// ---------------------------------------------------------------------------
function locate() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition((p) => {
      S.myPos = [p.coords.longitude, p.coords.latitude];
      map.getSource("me")?.setData({ type: "Feature", geometry: { type: "Point", coordinates: S.myPos } });
      resolve(S.myPos);
    },
      () => resolve(null), { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 });
  });
}
$("#locate").addEventListener("click", async () => {
  const pos = await locate();
  if (!pos) return toast("Je ne trouve pas votre position. Autorisez la localisation dans les réglages du téléphone.");
  flyTo(pos, 15.5);
});
$("#zoom-in").addEventListener("click", () => map.zoomIn());
$("#snap").addEventListener("click", () => openReportFlow({}));
$("#zoom-out").addEventListener("click", () => map.zoomOut());

// ---------------------------------------------------------------------------
// Chips, text size, voice, deep links
// ---------------------------------------------------------------------------
const layerOn = { lifts: true, works: true, quais: false, bus: false, places: false };
const LAYER_IDS = { lifts: ["stations", "stations-dot"], works: ["works-fill", "works-line"], quais: ["quais"], bus: ["bus"], places: ["places"] };
function setLayer(k, on) {
  layerOn[k] = on;
  const chip = $(`.chip[data-layer="${k}"]`);
  chip?.classList.toggle("on", on); chip?.setAttribute("aria-pressed", String(on));
  for (const id of LAYER_IDS[k]) map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
}
document.querySelectorAll(".chip").forEach((chip) => chip.addEventListener("click", () => {
  const k = chip.dataset.layer; setLayer(k, !layerOn[k]);
  const minZ = { places: 15, works: 14.5 }[k];
  if (minZ && layerOn[k] && map.getZoom() < minZ) {
    toast(k === "places" ? "Je rapproche la carte pour montrer les restos." : "Je rapproche la carte pour montrer les travaux.");
    map.easeTo({ zoom: minZ + 0.5, padding: Sheet.padding() });
  } else if (k === "places") loadPlacesLayer();
}));

const textBtn = $("#textsize");
function setBig(on) {
  document.documentElement.classList.toggle("big", on);
  textBtn.setAttribute("aria-pressed", String(on));
}
setBig(store.get("big") === "1");
textBtn.addEventListener("click", () => { const on = !document.documentElement.classList.contains("big"); setBig(on); store.set("big", on ? "1" : "0"); toast(on ? "Texte agrandi." : "Texte normal."); });

(() => {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const btn = $("#mic");
  if (!SR) { btn.hidden = true; return; }
  const rec = new SR(); rec.lang = "fr-FR"; rec.interimResults = false;
  rec.onresult = (e) => {
    const text = e.results[0][0].transcript.replace(/^(je veux aller|aller|emmène-moi|je vais) (à|au|aux|a)\s+/i, "");
    $("#search").value = text; $("#search").focus(); mainSearch.run();
  };
  rec.onerror = () => toast("Je n'ai pas bien entendu. Réessayez en parlant près du téléphone.");
  rec.onend = () => { btn.classList.remove("listening"); btn.setAttribute("aria-label", "Dire où vous allez"); };
  btn.addEventListener("click", () => { btn.classList.add("listening"); btn.setAttribute("aria-label", "Je vous écoute"); toast("Je vous écoute. Dites par exemple : Gare de Lyon."); try { rec.start(); } catch {} });
})();

function applyHash() {
  const m = location.hash.match(/station=([^&]+)/);
  if (m) openStation(decodeURIComponent(m[1]));
}
window.addEventListener("hashchange", applyHash);
renderFavs();

// ---------------------------------------------------------------------------
// First launch: choose a mobility profile (roadmap screen 1)
// ---------------------------------------------------------------------------
let chosen = Profile.get()?.key || null;
function renderOnboard() {
  $("#ptiles").innerHTML = PMR_PROFILES.map((p) =>
    `<button class="ptile" role="radio" aria-checked="${p.key === chosen}" data-p="${p.key}"><span class="tile-ic">${icon(p.ic)}</span><b>${esc(p.label)}</b></button>`).join("");
  document.querySelectorAll("[data-p]").forEach((b) => b.addEventListener("click", () => { chosen = b.dataset.p; renderOnboard(); $("#o-go").disabled = false; }));
  $("#o-go").disabled = !chosen;
  $("#o-name").value = Profile.name();
}
$("#o-go").addEventListener("click", () => {
  if (!chosen) return;
  Profile.save(chosen, $("#o-name").value);
  renderMe();
  show("home", "half");
  toast(`C'est noté : je vérifierai vos trajets pour un ${Profile.get().short}.`);
});
function renderMe() {
  const p = Profile.get();
  $("#me-ic").innerHTML = icon(p ? p.ic : "p-manuel");
  $("#me-name").textContent = p ? p.label.toLowerCase() : "votre profil";
  $("#h-home").innerHTML = Profile.name() ? `Où allez-vous, ${esc(Profile.name())}&nbsp;?` : "Bonjour&nbsp;! Où allez-vous&nbsp;?";
}
$("#me-chip").addEventListener("click", () => { renderOnboard(); show("onboard", "full"); });
renderMe();
if (!Profile.get() && !REPLAY) { renderOnboard(); show("onboard", "full"); }
if (REPLAY) openTrip(null, null);
