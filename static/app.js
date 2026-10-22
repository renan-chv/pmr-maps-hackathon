// Roulib – front-end (mobile first, friendly). Big tiles, plain words, freshness always visible.
"use strict";

const C = { ok: "#157a3c", warn: "#9a5800", ko: "#b42318", unk: "#5f6670", works: "#c2410c", brand: "#3d3bd6", ink: "#1e1a16" };
const LIFT_FR = { available: "Working", notavailable: "Out of order", unknown: "Status unknown" };
const ACCESS_FR = { true: "accessible", partial: "partly accessible", false: "not accessible", unknown: "no information" };
const TYPE_FR = { metro: "Metro", rail: "Train / RER", tram: "Tram", cableway: "Cable car", bus: "Bus" };
const MODE_FR = { Metro: "Metro", RapidTransit: "RER / Train", Tramway: "Tram", LocalTrain: "Train" };
// Acceslibre wheelchair verdict -> our status + plain words
const PLACE_ST = { true: "ok", partial: "warn", false: "ko", unknown: "unk" };
const PLACE_FR = {
  true: ["Wheelchair accessible", "Step-free entrance."],
  partial: ["Accessible with a little help", "Ramp on request or a small obstacle."],
  false: ["Hard in a wheelchair", "Obstacle at the entrance."],
  unknown: ["Not described yet", "No one has described the entrance yet."],
};
const WC_FR = { true: ["ok", "Accessible toilets"], false: ["ko", "Toilets not accessible"], none: ["unk", "No toilets"], unknown: ["unk", "Toilets: not described"] };
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
  if (!r.ok) { const e = new Error(body.detail || `Error ${r.status}`); e.status = r.status; throw e; }
  return body;
}

function rel(iso) {
  if (!iso) return "unknown date";
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  const min = Math.round((Date.now() - d) / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  if (min < 24 * 60) return `${Math.round(min / 60)} h ago`;
  return `on ${d.toLocaleDateString("en-GB", { day: "numeric", month: "long" })}`;
}
const ageH = (iso) => { const d = new Date(iso); return isNaN(d) ? Infinity : (Date.now() - d) / 3600000; };
const hhmm = (iso) => { const d = new Date(iso); return isNaN(d) ? "?" : d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }); };
const dayTime = (iso) => { const d = new Date(iso); return isNaN(d) ? iso : d.toLocaleString("en-GB", { weekday: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); };

function distM(a, b) {
  const k = Math.PI / 180, x = (b[0] - a[0]) * k * Math.cos((a[1] + b[1]) * k / 2), y = (b[1] - a[1]) * k;
  return 6371000 * Math.hypot(x, y);
}
const fmtDist = (m) => (m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`);
const plural = (n, one, many) => `${n} ${n > 1 ? many : one}`;

function toast(msg, ms = 3800) {
  const t = $("#toast"); t.textContent = "";
  requestAnimationFrame(() => { t.textContent = msg; });
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.textContent = ""), ms);
}
// Short message for screen readers (results, errors), without re-reading the whole list.
function announce(msg) {
  const r = $("#sr-status"); if (!r) return;
  r.textContent = ""; requestAnimationFrame(() => { r.textContent = msg; });
}
// Move keyboard / screen reader focus to freshly rendered content.
function focusEl(el) { if (!el) return; el.setAttribute("tabindex", "-1"); el.focus({ preventScroll: true }); }
// Text equivalent of a state mark, for screen readers (the mark itself is an icon).
const SR_STATE = { ok: "OK", warn: "Watch out", ko: "Blocked", unk: "Unknown" };
const srState = (st) => `<span class="sr">${SR_STATE[st] || ""}</span>`;

// ---------------------------------------------------------------------------
// Bottom sheet: three heights on phones, side panel elsewhere (CSS)
// ---------------------------------------------------------------------------
const Sheet = (() => {
  const el = $("#sheet"), grip = $("#grip"), body = $("#sheet-body");
  const LABEL = { peek: "collapsed", half: "half", full: "full screen" };
  let snap = "half";
  const heights = () => {
    const vh = window.visualViewport ? window.visualViewport.height : window.innerHeight;
    return { peek: Math.min(210, Math.round(vh * 0.3)), half: Math.round(vh * 0.6), full: vh - 76 };
  };
  // The sheet keeps its full height and slides with transform (GPU), so the map never relayouts mid-animation.
  let cur = 0;
  const root = document.documentElement.style;
  const apply = (h) => { cur = Math.round(h); root.setProperty("--sheet-h", `${cur}px`); root.setProperty("--sheet-full", `${heights().full}px`); };
  function set(name) {
    snap = name;
    grip.setAttribute("aria-valuetext", LABEL[name]);
    document.body.classList.toggle("sheet-full", name === "full" && isPhone());
    apply(isPhone() ? heights()[name] : 0);
  }
  let startY = 0, startH = 0, moved = false;
  grip.addEventListener("pointerdown", (e) => {
    if (!isPhone()) return;
    startY = e.clientY; startH = cur; moved = false;
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
    const h = cur, hs = heights();
    set(Object.entries(hs).sort((a, b) => Math.abs(a[1] - h) - Math.abs(b[1] - h))[0][0]);
  };
  grip.addEventListener("pointerup", end);
  // Drag from anywhere in the sheet: swipe up to expand before scrolling, pull down from the top to lower it.
  let pull = null;
  body.addEventListener("touchstart", (e) => { if (isPhone()) pull = { y: e.touches[0].clientY, h: cur, on: false }; }, { passive: true });
  body.addEventListener("touchmove", (e) => {
    if (!pull) return;
    const dy = e.touches[0].clientY - pull.y;
    if (!pull.on) {
      const down = dy > 8 && body.scrollTop <= 0, up = dy < -8 && snap !== "full";
      if (down || up) { pull.on = true; pull.y = e.touches[0].clientY; el.classList.add("dragging"); }
      else if (Math.abs(dy) > 8) { pull = null; return; }
      else return;
    }
    e.preventDefault();
    const hs = heights();
    apply(Math.max(hs.peek * 0.7, Math.min(hs.full, pull.h - (e.touches[0].clientY - pull.y))));
  }, { passive: false });
  body.addEventListener("touchend", () => {
    if (pull?.on) {
      el.classList.remove("dragging");
      const hs = heights(), moved = cur - pull.h;
      // A short flick still changes level in its direction.
      const order = ["peek", "half", "full"], i = order.indexOf(snap);
      if (Math.abs(moved) > 40 && Math.abs(moved) < 140) set(order[Math.max(0, Math.min(2, i + (moved > 0 ? 1 : -1)))]);
      else set(Object.entries(hs).sort((x, y) => Math.abs(x[1] - cur) - Math.abs(y[1] - cur))[0][0]);
    }
    pull = null;
  });
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
    case "ok": return [n > 1 ? `All ${n} elevators are working` : "The elevator is working", "You can get through in a wheelchair."];
    case "ko": return [n > 1 ? `None of the ${n} elevators is working` : "The elevator is out of order", "Better avoid this station for now."];
    case "warn": return [ko ? `${ko} of ${n} elevators out of order` : `Status unknown for ${unk} of ${n} elevators`,
      "Check that the one you need is working."];
    default: return ["Unknown", "IDFM has no recent information."];
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
  // Snap to the server's 0.01° tiles: nearby positions share one URL, so the browser and the CDN reuse it.
  // Edges sit 0.0001° inside the tile grid so float rounding never adds a neighbour tile server-side.
  const T = 0.01, f = (v) => (Math.floor(v / T) * T + 0.0001).toFixed(4), c = (v) => (Math.ceil(v / T) * T - 0.0001).toFixed(4);
  const bbox = [f(coord[0] - dLon), f(coord[1] - dLat), c(coord[0] + dLon), c(coord[1] + dLat)].join(",");
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
  // iPhones render at 3x: capping at 2x divides the GPU work by ~2.25 with no visible loss on a map.
  pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
  fadeDuration: 0, renderWorldCopies: false, maxPitch: 0, antialias: false,
  maxTileCacheSize: 120, refreshExpiredTiles: false,
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
    if (l.type === "symbol" && /housenumber|poi|road_oneway|highway-name-minor|highway_name_other/.test(l.id)) map.setLayerZoomRange(l.id, 16, 24);
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
  ["works", "quais", "bus", "places", "reports", "trip", "trip-ends", "stations", "pin", "me"].forEach((id) => map.addSource(id, { type: "geojson", data: empty() }));

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
  // Trip start and end, like the form's pins: A = ring in brand colour, B = dark dot.
  map.addLayer({ id: "trip-ends", type: "circle", source: "trip-ends",
    paint: { "circle-radius": ["match", ["get", "end"], "a", 8, 9], "circle-color": ["match", ["get", "end"], "a", "#ffffff", C.ink || "#1e1a16"],
      "circle-stroke-color": ["match", ["get", "end"], "a", C.brand, "#ffffff"], "circle-stroke-width": ["match", ["get", "end"], "a", 5, 3] } });
  map.addLayer({ id: "pin", type: "circle", source: "pin",
    paint: { "circle-radius": 10, "circle-color": C.brand, "circle-stroke-color": "#fff", "circle-stroke-width": 4 } });
  map.addLayer({ id: "me-halo", type: "circle", source: "me", paint: { "circle-radius": 22, "circle-color": "#1a73e8", "circle-opacity": 0.15 } });
  map.addLayer({ id: "me", type: "symbol", source: "me", layout: {
    "text-field": "You are here", "text-font": ["Noto Sans Bold"], "text-size": 14, "text-offset": [0, 1.6], "text-anchor": "top", "text-allow-overlap": true,
  }, paint: { "text-color": "#1a4fb5", "text-halo-color": "#fff", "text-halo-width": 2 } });
  map.addLayer({ id: "me-dot", type: "circle", source: "me", paint: { "circle-radius": 9, "circle-color": "#1a73e8", "circle-stroke-color": "#fff", "circle-stroke-width": 3 } });

  map.on("click", "stations", (e) => openStation(e.features[0].properties.id));
  map.on("click", "stations-dot", (e) => openStation(e.features[0].properties.id));
  map.on("click", "places", (e) => { const id = e.features[0].properties.id; const p = S.places.find((x) => x.properties.id === id); if (p) openAcceslibre(p); });
  map.on("click", "works-fill", (e) => openWorks(e.features[0].properties, e.lngLat));
  map.on("click", "reports", (e) => { const f = reportsData[e.features[0].properties.i]; if (f) openReport(f); });
  map.on("click", "quais", (e) => quickPopup(e, "Platform"));
  map.on("click", "bus", (e) => quickPopup(e, "Bus stop"));
  for (const id of ["stations", "stations-dot", "places", "reports", "works-fill", "quais", "bus"]) {
    map.on("mouseenter", id, () => (map.getCanvas().style.cursor = "pointer"));
    map.on("mouseleave", id, () => (map.getCanvas().style.cursor = ""));
  }
  let moveT = null;
  map.on("moveend", () => { clearTimeout(moveT); moveT = setTimeout(() => { loadBus(); loadPlacesLayer(); loadReports(); }, 250); });
  map.on("dragstart", () => { if (isPhone() && Sheet.get() === "full") Sheet.set("half"); });
  const TAPPABLE = ["stations", "stations-dot", "places", "reports", "works-fill", "quais", "bus"];
  map.on("click", (e) => {
    if (!isPhone() || Sheet.get() === "peek") return;
    if (map.queryRenderedFeatures(e.point, { layers: TAPPABLE.filter((id) => map.getLayer(id)) }).length) return;
    Sheet.set(Sheet.get() === "full" ? "half" : "peek");
  });

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
      `<b>${esc(ACCESS_FR[p.accessibility] || p.accessibility)}</b><div style="color:#5a524a;font-size:.85em;margin-top:4px">IDFM, stop register</div>`)
    .addTo(map);
}

function setPin(coord) { map.getSource("pin")?.setData(coord ? { type: "Feature", geometry: { type: "Point", coordinates: coord } } : empty()); }
const reduceMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const flyTo = (coord, zoom = 15.5) => (reduceMotion() ? map.jumpTo({ center: coord, zoom, padding: Sheet.padding() })
  : map.flyTo({ center: coord, zoom, padding: Sheet.padding(), essential: true }));
function fitTo(coords) {
  const b = new maplibregl.LngLatBounds(coords[0], coords[0]);
  coords.forEach((c) => b.extend(c));
  const pad = Sheet.padding(), c = map.getCanvas(), h = c.clientHeight, w = c.clientWidth;
  pad.bottom = Math.min(pad.bottom, h - pad.top - 80); pad.right = Math.min(pad.right, w - pad.left - 80);
  map.setPadding({ top: 0, bottom: 0, left: 0, right: 0 });  // flyTo leaves its padding on the camera; fitBounds would add both
  map.fitBounds(b, { padding: pad, maxZoom: 15.5, animate: !reduceMotion() });
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
    $("#today").innerHTML = `<p class="err">I can't load the elevator status. Try again in a moment.</p>`;
  }
}

// Heavy layers load on demand, once: platforms when a station opens or the chip is on,
// roadworks when the map reaches street level or a sheet needs them.
const once = (fn) => { let p = null; return () => (p ||= fn().catch((e) => { p = null; console.warn(e); })); };
const ensureQuais = once(async () => {
  const d = await getJSON("/api/stations"); S.quais = d.features; S.meta.quais = d.meta;
  map.getSource("quais")?.setData(d); renderSources();
});
const ensureWorks = once(async () => {
  const d = await getJSON("/api/works"); S.meta.works = d.meta; map.getSource("works")?.setData(d);
  S.worksCenters = d.features.map((f) => {
    const ring = f.geometry.type === "Polygon" ? f.geometry.coordinates[0] : f.geometry.coordinates[0][0];
    let x1 = Infinity, x2 = -Infinity, y1 = Infinity, y2 = -Infinity;
    for (const [x, y] of ring) { if (x < x1) x1 = x; if (x > x2) x2 = x; if (y < y1) y1 = y; if (y > y2) y2 = y; }
    return { c: [(x1 + x2) / 2, (y1 + y2) / 2], p: f.properties };
  });
  renderSources();
});
function loadStatic() {
  const check = () => { if (map.getZoom() >= 14 && layerOn.works) ensureWorks(); };
  map.on("zoomend", check); check();
}

async function loadBus() {
  if (!layerOn.bus || map.getZoom() < 14.5) return;
  const b = map.getBounds();
  const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map((v) => v.toFixed(5)).join(",");
  try { map.getSource("bus").setData(await getJSON(`/api/bus-stops?bbox=${bbox}`)); } catch (e) { console.warn("bus", e); }
}

async function loadPlacesLayer() {
  if (!layerOn.places || map.getZoom() < 14) return;
  // Cover the visible map (the server accepts at most 4x4 tiles of 0.01°, so cap each half-span at 0.015°).
  const c = map.getCenter(), b = map.getBounds();
  const dLon = Math.min((b.getEast() - b.getWest()) / 2, 0.015), dLat = Math.min((b.getNorth() - b.getSouth()) / 2, 0.015);
  try { showPlacesOnMap((await placesAround([c.lng, c.lat], dLon, dLat)).filter((f) => f.properties.category === "food")); } catch (e) { console.warn("places", e); }
}

async function loadAlerts() {
  try {
    const d = await getJSON("/api/alerts");
    const ul = $("#alerts");
    if (!d.alerts.length) {
      ul.innerHTML = `<li class="empty-li">Nothing has changed since ${d.poller.last_poll ? hhmm(d.poller.last_poll) : "earlier"}. I check again every 15 minutes.</li>`;
      return;
    }
    ul.innerHTML = d.alerts.slice(0, 6).map((a) => {
      const st = a.to === "available" ? "ok" : a.to === "notavailable" ? "ko" : "unk";
      const what = st === "ok" ? "Elevator fixed" : st === "ko" ? "Elevator broke down" : "Status no longer known";
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
  $("#tile-pannes").textContent = c.notavailable ? `${plural(c.notavailable, "elevator", "elevators")} out of order` : "None reported right now";
  $("#today").innerHTML =
    `<p class="headline">Today, <em>${c.notavailable}</em> elevators are out of order in Île-de-France stations.</p>` +
    `<div class="bar" aria-hidden="true"><span style="width:${pct(c.available)};background:${C.ok}"></span>` +
    `<span style="width:${pct(c.notavailable)};background:${C.ko}"></span><span style="width:${pct(c.unknown)};background:${C.unk}"></span></div>` +
    `<ul class="legend"><li><span class="sw ok"></span><b>${c.available}</b> working</li><li><span class="sw ko"></span><b>${c.notavailable}</b> out of order</li>` +
    `<li><span class="sw unk"></span><b>${c.unknown}</b> unknown</li></ul>` +
    `<p class="fresh">${icon("clock")}${m.stale ? "IDFM unreachable, showing the last known version. " : ""}IDFM update ${rel(latest)}, checked at ${hhmm(m.fetched_at)}</p>`;
}

function renderSources() {
  const items = Object.values(S.meta).filter((m) => m && m.source).map((m) =>
    `<li><a href="${esc(m.source.url)}" target="_blank" rel="noopener">${esc(m.source.name)}</a>, ${esc(m.source.license)}.${m.fetched_at ? ` Fetched at ${hhmm(m.fetched_at)}.` : ""}</li>`);
  $("#sources-list").innerHTML = items.join("") + `<li>Place search: Photon (Komoot), data © OpenStreetMap contributors (ODbL); IGN Géoplateforme as backup.</li><li>Base map © OpenStreetMap, OpenFreeMap.</li>`;
}

// Favourites (Home, Work) kept on this phone only.
const FAVS = [{ key: "home", label: "Home", ic: "home" }, { key: "work", label: "Work", ic: "work" }];
let pendingFav = null;
const PENCIL = `<svg class="i" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16zM14 6l4 4"/></svg>`;
// Home row, maps-app style: Home, Work, then recent places, each one tap from a trip.
function renderFavs() {
  const ul = $("#favs");
  const favs = FAVS.map((f) => {
    const v = store.json(`fav-${f.key}`);
    return `<li class="hp${v ? " set" : ""}"><button class="hp-go" data-fav="${f.key}">${icon(f.ic)}<span class="t"><b>${f.label}</b>` +
      `<small>${v ? esc(v.label) : "Add address"}</small></span></button>` +
      (v ? `<button class="hp-edit" data-fav-edit="${f.key}" aria-label="Change the ${f.label} address">${PENCIL}</button>` : "") + `</li>`;
  });
  const rec = recents().map((r, i) => `<li class="hp"><button class="hp-go" data-recent="${i}">${icon("clock")}<span class="t">` +
    `<b><span class="sr">Recent: </span>${esc(r.label)}</b><small>${esc(r.sub || "Recent")}</small></span></button></li>`);
  const html = [...favs, ...rec].join("");
  if (ul.innerHTML === html) return;  // re-rendered on every return home: keep focus when nothing changed
  const hadFocus = ul.contains(document.activeElement);
  ul.innerHTML = html;
  ul.scrollLeft = 0;
  ul.querySelectorAll("[data-fav]").forEach((b) => b.addEventListener("click", () => {
    const v = store.json(`fav-${b.dataset.fav}`);
    if (v) tripTo({ ...v, kind: "fav" }); else askFav(b.dataset.fav);
  }));
  ul.querySelectorAll("[data-fav-edit]").forEach((b) => b.addEventListener("click", () => askFav(b.dataset.favEdit)));
  ul.querySelectorAll("[data-recent]").forEach((b) => b.addEventListener("click", () => {
    const r = recents()[+b.dataset.recent];
    if (r) { addRecent(r); tripTo({ ...r, kind: "recent" }); }
  }));
  if (hadFocus) ul.querySelector("button")?.focus({ preventScroll: true });
}
// A trip to `to` from where the user is (never the start of a previous trip), like Google Maps.
function tripTo(to) {
  if (!S.myPos) trip.from = null;
  $("#search").value = "";
  openTrip(myPosItem(), to);
}
function askFav(key) {
  pendingFav = key;
  const s = $("#search");
  s.placeholder = key === "home" ? "Type your home address" : "Type your work address";
  s.value = ""; s.focus();
  toast(key === "home" ? "Type your address, then pick it from the list." : "Type your work address, then pick it from the list.");
}
function saveFav(it) {
  store.set(`fav-${pendingFav}`, JSON.stringify({ label: it.label, lon: it.lon, lat: it.lat }));
  toast(`${pendingFav === "home" ? "Home" : "Work"} saved. Tap it to go there.`);
  pendingFav = null;
  $("#search").placeholder = "Where to?";
  $("#search").value = "";
  renderFavs();
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
  if (view !== "home" && !$("#v-home").hidden) show.opener = document.activeElement;
  for (const v of document.querySelectorAll(".view")) v.hidden = v.id !== `v-${view}`;
  // Restaurant pins stay visible while a restaurant list or detail is open, even with the chip off.
  const foodView = (view === "list" && /^Eat/.test($("#l-title").textContent)) || (view === "detail" && $("#detail")?.dataset.kind === "place");
  const wantPlaces = layerOn.places || foodView;
  if (map.getLayer("places")) map.setLayoutProperty("places", "visibility", wantPlaces ? "visible" : "none");
  Sheet.scrollTop();
  if (snap) Sheet.set(snap);
  // After the caller has injected its content (next frame), focus the view title.
  if (view !== "home") requestAnimationFrame(() => focusEl($(`#v-${view} .title`) || $(`#v-${view} h2, #v-${view} h3`)));
  if (view !== "home" && !history.state?.roulib) history.pushState({ roulib: true }, "", location.href);
}
function goHome() {
  show("home", "half"); setPin(null); map.getSource("trip")?.setData(empty()); map.getSource("trip-ends")?.setData(empty());
  if (!layerOn.places) showPlacesOnMap([]);
  history.replaceState(null, "", location.pathname);
  const back = show.opener && document.contains(show.opener) ? show.opener : $("#search");
  if (document.activeElement === document.body || !document.activeElement) back?.focus({ preventScroll: true });
}
window.addEventListener("popstate", () => {
  // A #station= link fires popstate before hashchange: open that station instead of going home (which clears the hash).
  if (/station=/.test(location.hash)) return applyHash();
  if ($("#all-routes") && !$("#v-trip").hidden && lastTrip) return renderResults(lastTrip);  // detail -> list
  if ($("#v-home").hidden) goHome();
});
document.querySelectorAll("[data-back]").forEach((b) => b.addEventListener("click", goHome));

document.querySelectorAll("[data-go]").forEach((t) => t.addEventListener("click", () => {
  ({ trip: () => openTrip(null, null), food: openFood, near: openNearby, pannes: openPannes })[t.dataset.go]();
}));
// Recent places change in the trip form: refresh the home row each time home comes back.
new MutationObserver(() => { if (!$("#v-home").hidden) renderFavs(); }).observe($("#v-home"), { attributes: true, attributeFilter: ["hidden"] });

async function here() {
  let pos = await locate();
  if (!pos) { const c = map.getCenter(); pos = [c.lng, c.lat]; toast("I can't find your location. Searching around the center of the map."); }
  return pos;
}

function listView(title, sub) {
  $("#l-title").textContent = title;
  $("#l-sub").textContent = sub || "";
  $("#l-filters").innerHTML = "";
  $("#l-body").innerHTML = `<p class="muted">Searching…</p>`;
  show("list", "half");
}

async function openNearby() {
  listView("Near me", "The closest stations with elevators.");
  const pos = await here();
  if (!S.myPos) setPin(pos);
  flyTo(pos, 14.5);
  const near = nearestStations(pos, 8, 3000);
  $("#l-body").innerHTML = near.length ? stationList(near) : `<p class="muted">No station with an elevator within 3 km.</p>`;
  bindOpen($("#l-body"));
}

async function openPannes() {
  listView("Elevators out of order", "Stations where at least one elevator is not working, closest first.");
  const pos = S.myPos || [map.getCenter().lng, map.getCenter().lat];
  const rows = [...S.stations.values()].filter((st) => st.ko > 0).map((st) => ({ st, d: distM(pos, st.coord) })).sort((a, b) => a.d - b.d).slice(0, 30);
  $("#l-body").innerHTML = rows.length ? stationList(rows) : `<p class="muted">No outages reported right now. Good news!</p>`;
  bindOpen($("#l-body"));
}

// --- Restaurants ----------------------------------------------------------------
const foodFilters = { ok: true, help: true, wc: false };
let foodPos = null, foodAll = [];

async function openFood() {
  listView("Eat nearby", "Restaurants, cafes and bars described on Acceslibre.");
  renderFoodFilters();
  foodPos = await here();
  if (!S.myPos) setPin(foodPos);
  flyTo(foodPos, 15.5);
  try {
    foodAll = (await placesAround(foodPos)).filter((f) => f.properties.category === "food")
      .map((f) => ({ f, d: distM(foodPos, f.geometry.coordinates) })).sort((a, b) => a.d - b.d);
    renderFood();
  } catch (e) {
    $("#l-body").innerHTML = `<p class="err">I can't load the restaurants. Try again in a moment.</p>`;
  }
}
function renderFoodFilters() {
  const F = [["ok", "ok", "Step-free"], ["help", "hand", "With a little help"], ["wc", "wc", "Accessible toilets"]];
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
  $("#l-sub").textContent = `${plural(keep.length, "place", "places")} out of ${total} around you.`;
  $("#l-body").innerHTML = keep.length
    ? `<ul class="list">${keep.slice(0, 40).map(({ f, d }, i) => {
        const p = f.properties, st = PLACE_ST[p.wheelchair];
        return `<li><button class="item" data-place="${i}">${mark(st, "food")}<span class="t"><b>${esc(p.name || "Unnamed")}</b>` +
          `<small>${esc(PLACE_FR[p.wheelchair][0])}${p.toilets === "true" ? " · accessible toilets" : ""}</small>` +
          `<small>${esc(p.activity || "")}</small></span><span class="end">${fmtDist(d)}${icon("chev-r", "chev")}</span></button></li>`;
      }).join("")}</ul>`
    : `<p class="muted">No place matches these filters. Try removing one.</p>`;
  document.querySelectorAll("[data-place]").forEach((b) => b.addEventListener("click", () => openAcceslibre(keep[+b.dataset.place].f)));
}

function acceslibreBlock(p) {
  const st = PLACE_ST[p.wheelchair], [title, sub] = PLACE_FR[p.wheelchair], wc = WC_FR[p.toilets] || WC_FR.unknown;
  const reasonIcon = (r) => /marche|\bsteps?\b(?!-)/i.test(r) ? "steps" : /porte|door/i.test(r) ? "door" : /rampe|aide|ramp|help|assist/i.test(r) ? "hand" : "ok";
  return `<div class="verdict ${st}">${mark(st, "lg")}<span><strong>${esc(title)}</strong>${esc(sub)}</span></div>` +
    `<ul class="facts">` + (p.reasons || []).map((r) => `<li>${icon(reasonIcon(r))}<span>${esc(r)}</span></li>`).join("") +
    `<li>${icon("wc", wc[0])}<span>${esc(wc[1])}</span></li>` +
    (p.parking ? `<li>${icon("parking", "ok")}<span>Disabled parking space</span></li>` : "") + `</ul>`;
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
    `<h2 id="d-title" class="title">${esc(p.name || "Unnamed")}</h2><p class="sub">${esc(p.activity || "")}${p.address ? ` · ${esc(p.address)}` : ""}</p>` +
    acceslibreBlock(p) +
    `<div class="btn-row"><button class="btn primary" id="go-to">Go there</button><a class="btn" href="${esc(p.url)}" target="_blank" rel="noopener">${icon("ext")}More info</a></div>` +
    `<h3 class="h2">Nearby stations with elevators</h3>` +
    (near.length ? stationList(near) : `<p class="muted">No station with an elevator within 1.5 km.</p>`) +
    nearSlot() +
    `<p class="src">Accessibility: Acceslibre (beta.gouv.fr), described by venues and visitors. Licence Ouverte (open licence).</p>`;
  bindOpen($("#detail"));
  $("#go-to").addEventListener("click", () => openTrip(null, { label: p.name, lon: coord[0], lat: coord[1] }));
  fillPhoto(coord, p.id);
}

// ---------------------------------------------------------------------------
// Photos: the place's own website, else a free-licence photo taken nearby. Never invented.
// ---------------------------------------------------------------------------
// Top slot: only a photo of the place itself. Bottom slot: a photo taken nearby, kept small and below the verdict.
const photoSlot = () => `<figure class="photo" id="photo" hidden><figcaption></figcaption></figure>`;
const nearSlot = () => `<section id="photo-near" hidden><h3 class="h2">Around here</h3><figure class="photo small"><figcaption></figcaption></figure></section>`;
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
    img.alt = photo.kind === "site" ? "Photo of the place" : "Photo taken nearby";
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
  if (!st) { toast("I have no elevator information for this station."); return; }
  history.replaceState(null, "", `#station=${encodeURIComponent(st.id)}`);
  setPin(null);
  show("detail", "half");
  flyTo(st.coord, 16);
  // Service lifts would drown the answer: the verdict, the summary and the groups only count passenger ones.
  const pub = st.lifts.filter((l) => !isServiceLift(l)), other = st.lifts.filter(isServiceLift);
  const base = pub.length ? pub : st.lifts;
  const [title, sub] = verdictText({ ...st, lifts: base, status: stationStatus(base) });
  const groups = liftGroups(pub);
  const stale = base.filter((l) => ageH(liftTime(l.source_update)) > STALE_H).length;
  const oldest = base.map((l) => liftTime(l.source_update)).filter(Boolean).sort((a, b) => a - b)[0];
  const who = stale === base.length ? (base.length > 1 ? "all elevators" : "this elevator") : `${stale} of ${base.length} elevators`;
  const summary = groups.length > 1 ? groups.map((g) => `<span class="ls-sum-i">${esc(g.label)}: ${esc(groupState(g.lifts).short)}</span>`)
    .join(`<span aria-hidden="true"> · </span>`) : esc(sub);

  $("#detail").innerHTML =
    `<h2 id="d-title" class="title">${esc(st.name)}</h2><p class="sub">${esc(MODE_FR[st.mode] || st.mode || "Station")}</p>` +
    `<div class="verdict ${stationStatus(base)}">${mark(stationStatus(base), "lg")}<span><strong>${esc(title)}</strong><span class="ls-sum">${summary}</span></span></div>` +
    (stale ? `<p class="note">${icon("clock")}<span><b>To be confirmed.</b> For ${who}, ${oldest ? `the latest IDFM update was ${rel(oldest.toISOString())}` : "the status time is unknown"}. It may have changed since.</span></p>` : "") +
    `<div class="btn-row"><button class="btn primary" id="go-to">Go there</button><button class="btn" id="go-from">Start here</button></div>` +
    `<ul class="facts" id="st-facts" hidden></ul>` +
    (pub.length ? `<h3 class="h2">${groups.length > 1 ? "Elevators by line" : "Elevators"} (${pub.length})</h3>` : "") +
    groups.map((g, i) => liftGroupHTML(g, i, groups.length === 1)).join("") +
    (other.length ? `<button class="linkish ls-more" id="ls-more" aria-expanded="false" aria-controls="ls-other">${icon("chev-r")}<span>Show ${plural(other.length, "other elevator", "other elevators")}</span></button>` +
      `<div class="card ls-other" id="ls-other" hidden><p class="ls-note">Staff, service or technical elevators. They are not on the passenger route.</p><ul class="ls-lifts">${other.map((l) => liftRowHTML(l)).join("")}</ul></div>` : "") +
    nearSlot() +
    `<p class="src">Source: IDFM, elevator status (Licence Mobilité), area ${esc(st.id)}. Checked at ${hhmm(S.meta.lifts.fetched_at)}.</p>`;
  const spot = { label: st.name, lon: st.coord[0], lat: st.coord[1] };
  $("#go-to").addEventListener("click", () => openTrip(null, spot));
  $("#go-from").addEventListener("click", () => openTrip(spot, null));
  fillPhoto(st.coord);
  fillReliability(st);
  fillStationFacts(st);
  bindLiftGroups(st, groups);
}

// ---------- Station sheet helpers: elevators grouped by line ----------
// IDFM lists staff and technical lifts next to passenger ones (checked on the live feed: "Bât. A Back-office",
// "asc service", "Galerie technique", "Acces Directeur", RER E smoke shafts "Puits", lounges, internal codes).
// They never have a public status worth acting on, so they go behind "Show N other elevators".
const SERVICE_LIFT = /back.?office|\bservice\b|technique|directeur|\bb[aâ]t(?:\.|iment)|\blocaux\b|\bpuits\b|\blounge\b|relogement|\bpersonnel\b|\bfoyer\b|^ascenseur\s*-\s*\d/i;
const isServiceLift = (l) => SERVICE_LIFT.test(l.situation || "") || (!!l.situation && !/\p{L}{3}/u.test(l.situation));
// Missing or epoch-like stamps (new Date(null) is 1 Jan 1970) mean "no time", never a date.
const liftTime = (iso) => { const d = iso ? new Date(iso) : null; return d && !isNaN(d) && d.getFullYear() >= 2000 ? d : null; };
const liftStatusSt = (l) => (l.status === "available" ? "ok" : l.status === "notavailable" ? "ko" : "unk");
// Lines named in the IDFM text, same idea as verify.line_tokens: "RER A", "Ligne M14", "ligne 14", "L14", "T3a", "ligne L".
const LINE_RE = /(?<![\p{L}\d])(?:RER\s?([A-E])|(?:ligne\s+M?|M|L)(\d{1,2}b?)|T(\d{1,2}[ab]?)|ligne\s+([A-EHJKLNPRUV]))(?![\p{L}\d])/giu;
function liftLines(l) {
  const out = new Set();
  for (const m of `${l.situation || ""} ${l.direction || ""}`.matchAll(LINE_RE)) {
    if (m[1] || (m[4] && /[A-E]/i.test(m[4]))) out.add(`RER ${(m[1] || m[4]).toUpperCase()}`);
    else if (m[2]) out.add(`M${m[2].toUpperCase()}`);
    else if (m[3]) out.add(`T${m[3].toLowerCase()}`);
    else if (m[4]) out.add(`Train ${m[4].toUpperCase()}`);
  }
  return [...out];
}
const LINE_ORDER = (k) => (k.startsWith("M") ? 0 : k.startsWith("RER") ? 1 : k.startsWith("T") && !k.startsWith("Train") ? 2 : k.startsWith("Train") ? 3 : 4);
function lineInfo(k) {
  if (k.startsWith("RER")) return { label: k, chip: k, mode: "RER", code: k.slice(4) };
  if (k.startsWith("Train")) return { label: k, chip: k, mode: "Train", code: k.slice(6) };
  if (k.startsWith("M")) return { label: `Line ${k.slice(1)}`, chip: `M ${k.slice(1)}`, mode: "Métro", code: k.slice(1) };
  return { label: `Tram ${k}`, chip: k, mode: "Tramway", code: k.slice(1) };
}
// One group per line named in the descriptions (a lift serving two lines shows in both: each line's answer must
// be complete). Lifts naming no line go to "Station access". No line anywhere: a single plain group.
function liftGroups(lifts) {
  const by = new Map(), rest = [];
  for (const l of lifts) {
    const ks = liftLines(l);
    if (!ks.length) rest.push(l);
    ks.forEach((k) => { if (!by.has(k)) by.set(k, []); by.get(k).push(l); });
  }
  const groups = [...by.entries()].sort(([a], [b]) => LINE_ORDER(a) - LINE_ORDER(b) || a.localeCompare(b, "en", { numeric: true }))
    .map(([k, ls]) => ({ key: k, ...lineInfo(k), lifts: ls }));
  if (rest.length) groups.push(groups.length ? { key: "access", label: "Station access", lifts: rest, note: "The data does not say which line these serve." }
    : { key: "all", label: lifts.length > 1 ? "Elevators" : "Elevator", lifts: rest });
  return groups;
}
// Synthetic state of a group: class, header words, short words for the summary line.
function groupState(lifts) {
  const n = lifts.length, ko = lifts.filter((l) => l.status === "notavailable").length, ok = lifts.filter((l) => l.status === "available").length, unk = n - ko - ok;
  if (ok === n) return { st: "ok", text: n > 1 ? `All ${n} working` : "Working", short: n > 1 ? "elevators working" : "elevator working" };
  if (ko === n) return { st: "ko", text: n > 1 ? `All ${n} out of order` : "Out of order", short: n > 1 ? `all ${n} out of order` : "out of order" };
  if (ko) return { st: "warn", text: `${ko} of ${n} out of order`, short: `${ko} out of order` };
  if (unk === n) return { st: "unk", text: "Status unknown", short: "status unknown" };
  return { st: "unk", text: `${unk} of ${n} status unknown`, short: `${unk} status unknown` };
}
// "Ligne M1 direction Château de Vincennes" -> direction; "Accès 1 Porte Marguerite de Navarre" -> exit.
// Only short segments: long sentences ("en direction de la sortie 1") would give nonsense.
function liftWay(l) {
  const segs = `${l.direction || ""}  /  ${l.situation || ""}`.split(/\s{2}\/\s{2}/).map((s) => s.trim()).filter((s) => s && s.length <= 70);
  let dir = null, exit = null;
  for (const s of segs) {
    const d = !dir && s.match(/^(?:.*\s)?direction\s+(?!de\b|du\b|des\b)(.+)$/i);
    if (d) dir = d[1].trim();
    if (!dir && /^toutes directions$/i.test(s)) dir = "all";
    const e = !exit && s.match(/^Acc[eè]s\s+(\d.*)$/i);
    if (e) exit = e[1].replace(/\s+/g, " ").trim();
  }
  return { dir, exit };
}
// Plain-text name of a lift for buttons: "Line 14 elevator, toward Saint-Denis - Pleyel, exit 1 Cour de Rome".
function liftName(l, g) {
  const { dir, exit } = liftWay(l);
  const bits = [dir ? (dir === "all" ? "all directions" : `toward ${dir}`) : "", exit ? `exit ${exit}` : ""].filter(Boolean);
  if (!bits.length) bits.push((l.situation || "location not specified").split(/[.,]/)[0].replace(/\s+/g, " ").slice(0, 70));
  return `${g && g.key !== "all" && g.key !== "access" ? `${g.label} elevator` : "Elevator"}, ${bits.join(", ")}`;
}
// withState false: the group header already says it (a group with a single elevator).
function liftRowHTML(l, showDir = true, withState = true) {
  const s = liftStatusSt(l), t = liftTime(l.source_update), { dir, exit } = liftWay(l);
  const way = [showDir && dir ? (dir === "all" ? "All directions" : `Toward <span lang="fr">${esc(dir)}</span>`) : "", exit ? `Exit <span lang="fr">${esc(exit)}</span>` : ""].filter(Boolean).join(" · ");
  const head = withState ? esc(LIFT_FR[l.status] || l.status) : "";
  return `<li class="lift${withState ? "" : " no-state"}">${withState ? mark(s) : ""}<div class="lift-body">${head || way ? `<div class="st">${head}${way ? `<span class="ls-way">${way}</span>` : ""}</div>` : ""}` +
    `<div class="where">${l.situation ? `<span lang="fr">${esc(l.situation)}</span>` : "Location not specified"}</div>` +
    (l.direction && !dir ? `<small lang="fr">${esc(l.direction)}</small>` : "") +
    (t ? `<small class="${ageH(t) > STALE_H ? "old" : ""}">IDFM update ${rel(t.toISOString())} (${esc(dayTime(t))})</small>` : `<small class="old">Status time unknown</small>`) +
    `<small class="rel" data-rel="${esc(l.liftid)}"></small></div></li>`;
}
function liftGroupHTML(g, i, only) {
  const gs = groupState(g.lifts), open = only || gs.st !== "ok";
  const order = { ko: 0, unk: 1, ok: 2 };
  const lifts = [...g.lifts].sort((a, b) => order[liftStatusSt(a)] - order[liftStatusSt(b)]);
  // Sub-headings by direction only when the data names at least two of them for this line.
  const dirs = [...new Set(lifts.map((l) => liftWay(l).dir).filter(Boolean))];
  const byDir = dirs.length > 1;
  const body = byDir
    ? [...dirs, null].map((d) => { const ls = lifts.filter((l) => (liftWay(l).dir || null) === d); return ls.length
      ? `<h5 class="ls-dir">${d ? (d === "all" ? "All directions" : `Toward <span lang="fr">${esc(d)}</span>`) : "Direction not specified"}</h5><ul class="ls-lifts">${ls.map((l) => liftRowHTML(l, false)).join("")}</ul>` : ""; }).join("")
    : `<ul class="ls-lifts">${lifts.map((l) => liftRowHTML(l, true, lifts.length > 1)).join("")}</ul>`;
  const can = lifts.filter((l) => l.status !== "notavailable");
  const report = !can.length ? "" : can.length === 1
    ? `<button class="linkish ls-report" data-g="${i}" data-lift="${esc(can[0].liftid)}" aria-label="Report an outage, ${esc(liftName(can[0], g))}">Report an outage</button>`
    : `<button class="linkish ls-report" data-g="${i}" aria-expanded="false" aria-controls="ls-pick-${i}">Report an outage${g.key === "all" || g.key === "access" ? "" : ` on ${esc(g.label)}`}</button>` +
      `<div class="ls-pick" id="ls-pick-${i}" hidden><p class="ls-note">Which elevator is out of order?</p>` +
      can.map((l) => `<button class="ls-pick-b" data-lift="${esc(l.liftid)}" aria-label="Report an outage, ${esc(liftName(l, g))}">${esc(liftName(l, g).replace(/^[^,]*,\s*(.)/, (_, c) => c.toUpperCase()))}</button>`).join("") + `</div>`;
  const chip = g.chip ? (() => { const bg = lineColor(g.mode, g.code); return `<span class="lchip" style="background:${bg};color:${inkOn(bg)}" aria-hidden="true">${esc(g.chip)}</span>`; })() : `<span class="ls-ic" aria-hidden="true">${icon("lift")}</span>`;
  return `<section class="ls-group ${gs.st}"><h4 class="ls-h"><button class="ls-toggle" aria-expanded="${open}" aria-controls="ls-g-${i}">` +
    `${chip}<span class="${g.chip === g.label ? "sr" : "ls-name"}">${esc(g.label)}</span><span class="sr">, </span> <span class="ls-state">${mark(gs.st, "sm")}${srState(gs.st)}<span class="sr">, </span><span>${esc(gs.text)}</span></span>${icon("chev-r", "ls-chev")}</button></h4>` +
    `<div class="ls-body" id="ls-g-${i}"${open ? "" : " hidden"}>${g.note ? `<p class="ls-note">${esc(g.note)}</p>` : ""}${body}${report}</div></section>`;
}
function bindLiftGroups(st, groups) {
  const flip = (btn, panel) => { const on = btn.getAttribute("aria-expanded") !== "true"; btn.setAttribute("aria-expanded", String(on)); panel.hidden = !on; return on; };
  const find = (id) => st.lifts.find((l) => l.liftid === id);
  document.querySelectorAll(".ls-toggle").forEach((b) => b.addEventListener("click", () => flip(b, document.getElementById(b.getAttribute("aria-controls")))));
  document.querySelectorAll(".ls-report").forEach((b) => b.addEventListener("click", () => {
    if (b.dataset.lift) return reportLift(st, find(b.dataset.lift));
    if (flip(b, document.getElementById(b.getAttribute("aria-controls")))) document.querySelector(`#ls-pick-${b.dataset.g} .ls-pick-b`)?.focus();
  }));
  document.querySelectorAll(".ls-pick-b").forEach((b) => b.addEventListener("click", () => reportLift(st, find(b.dataset.lift))));
  const more = $("#ls-more");
  more?.addEventListener("click", () => {
    const on = flip(more, $("#ls-other"));
    more.querySelector("span").textContent = on ? "Hide the other elevators" : `Show ${plural(st.lifts.filter(isServiceLift).length, "other elevator", "other elevators")}`;
  });
}

async function fillStationFacts(st) {
  await Promise.all([ensureQuais(), ensureWorks()]);
  const ul = $("#st-facts");
  if (!ul || $("#d-title")?.textContent !== st.name) return;  // the user moved on
  const quais = S.quais.filter((q) => distM(st.coord, q.geometry.coordinates) < 350 && norm(q.properties.name) === st.key);
  const qCount = {};
  quais.forEach((q) => { const k = q.properties.accessibility || "unknown"; qCount[k] = (qCount[k] || 0) + 1; });
  const Q_FR = { true: ["accessible", "accessible"], partial: ["partly accessible", "partly accessible"], false: ["not accessible", "not accessible"], unknown: ["no information", "no information"] };
  const qText = ["true", "partial", "false", "unknown"].filter((k) => qCount[k]).map((k) => `${qCount[k]} ${Q_FR[k][qCount[k] > 1 ? 1 : 0]}`).join(", ");
  const works = worksNear(st.coord, 200);
  ul.innerHTML = (quais.length ? `<li>${icon("train")}<span><b>Platforms:</b> ${qText}</span></li>` : "") +
    (works.length ? `<li>${icon("cone", "warn")}<span><b>${plural(works.length, "sidewalk works site", "sidewalk works sites")}</b> within 200 m</span></li>` : "");
  ul.hidden = !ul.innerHTML;
}

// Lift reliability from the Dispotrains archive (roadmap screen 6). Honest about the window.
// One sentence per lift, worded like the trip detail (verify.lift_check) so both screens say the same thing.
const UNRELIABLE_BELOW = 0.85;  // same threshold as app/verify.py
async function fillReliability(st) {
  try {
    const d = await getJSON(`/api/stations/${encodeURIComponent(st.id)}/reliability`);
    if ($("#d-title")?.textContent !== st.name) return;  // the user moved on
    for (const [liftid, r] of Object.entries(d.lifts || {})) {
      // a lift serving two lines shows in both groups
      document.querySelectorAll(`[data-rel="${CSS.escape(liftid)}"]`).forEach((el) => {
        el.textContent = `History: working ${Math.round(r.availability * 100)}% of the time from 6 am to 9 pm over the last ${+Number(r.window_days).toFixed(1)} days, ${r.outages ? plural(r.outages, "outage", "outages") : "no outage"}.`;
        el.classList.toggle("bad", r.availability < UNRELIABLE_BELOW);
      });
    }
  } catch { /* the history is a bonus */ }
}

// ---------------------------------------------------------------------------
// Community reports (workstream B owns the API and the photo screen; A shows them)
// ---------------------------------------------------------------------------
const REPORT_FR = {
  escalier: "Stairs", marche: "Step", travaux: "Roadworks", trottoir_encombre: "Blocked sidewalk",
  trottoir_etroit: "Narrow sidewalk", bordure_haute: "High curb", pente: "Steep slope",
  ascenseur_panne: "Elevator out of order", escalator_panne: "Escalator out of order", rampe: "Ramp", autre: "Obstacle",
};
const GRAV_ST = { bloquant: "ko", genant: "warn", info: "unk" };
const userId = () => store.get("pmr_user_id");

function reportLift(st, lift) {
  openReportFlow({ cat: "ascenseur_panne", place: { label: st.name, sub: lift.situation || "Station elevator", lon: st.coord[0], lat: st.coord[1] },
    target: { type: "lift", id: lift.liftid } });
}

// ---------------------------------------------------------------------------
// Report flow (roadmap screen 5): what, where, optional voice / photo / text, then send.
// The API (POST /api/reports, /api/reports/analyze) belongs to workstream B; without it we say so.
// ---------------------------------------------------------------------------
const R_CATS = [
  { key: "ascenseur_panne", label: "Elevator out of order", ic: "lift", gravite: "bloquant", temporaire: true },
  { key: "trottoir_encombre", label: "Obstacle in the way", ic: "cone", gravite: "genant", temporaire: true },
  { key: "marche", label: "Step or unusable ramp", ic: "steps", gravite: "bloquant", temporaire: false },
  { key: "autre", label: "Other problem", ic: "unk", gravite: "info", temporaire: true },
];
const rep = { cat: null, place: null, target: null, text: "", photo: null, thumb: null, ai: null };

async function openReportFlow({ cat = null, place = null, target = null }) {
  Object.assign(rep, { cat, target, text: "", photo: null, thumb: null, ai: null });
  if (!place) {
    if (!S.myPos) await locate();
    const pos = S.myPos || [map.getCenter().lng, map.getCenter().lat];
    const near = nearestStations(pos, 1, 250)[0];
    place = near ? { label: near.st.name, sub: S.myPos ? "The station closest to you" : "Near the center of the map", lon: near.st.coord[0], lat: near.st.coord[1] }
      : { label: "Here", sub: S.myPos ? "Your location" : "The center of the map", lon: pos[0], lat: pos[1] };
    if (near && !target) rep.target = { type: "station", id: near.st.id };
  }
  $("#r-place-pick").hidden = true;
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
  document.querySelectorAll("[data-cat]").forEach((b) => b.addEventListener("click", () => { rep.cat = b.dataset.cat; renderReportCats(); $(`[data-cat="${rep.cat}"]`)?.focus(); }));
  renderReportSummary();
}

function renderReportSummary() {
  const c = R_CATS.find((x) => x.key === rep.cat);
  $("#r-send").disabled = !c;
  if (!c) { $("#r-summary").innerHTML = ""; return; }
  const ai = rep.ai;
  const grav = { bloquant: "Blocking in a wheelchair", genant: "Inconvenient", info: "For information" }[ai?.gravite || c.gravite];
  $("#r-summary").innerHTML =
    `<p class="r-sum-head">${icon(ai ? "spark" : "ok")}${ai ? "What Roulib understood from your photo" : "You are about to report"}</p>` +
    `<p><b>${esc(ai ? (REPORT_FR[ai.categorie] || c.label) : c.label)}</b> at ${esc(rep.place.label)}. ${esc(grav)}${(ai?.temporaire ?? c.temporaire) ? ", probably temporary" : ""}.</p>` +
    (ai?.description ? `<p class="muted">${esc(ai.description)}</p>` : "") +
    (ai ? `<p class="muted">Check before sending: this is a suggestion, not a certainty.</p>` : "");
}

$("#r-text-btn").addEventListener("click", () => { $("#r-text").hidden = false; $("#r-text").focus(); });
$("#r-text").addEventListener("input", (e) => { rep.text = e.target.value; });
(() => {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const btn = $("#r-voice");
  if (!SR) { btn.hidden = true; return; }
  const rec = new SR(); rec.lang = navigator.language || "fr-FR";
  rec.onresult = (e) => { const t = e.results[0][0].transcript; $("#r-text").hidden = false; $("#r-text").value = (rep.text ? rep.text + " " : "") + t; rep.text = $("#r-text").value; };
  rec.onerror = () => toast("I didn't catch that. Try again.");
  rec.onend = () => btn.classList.remove("listening");
  btn.addEventListener("click", () => { btn.classList.add("listening"); toast("I'm listening. Describe the problem."); try { rec.start(); } catch {} });
})();

// Photo: resized to 1024 px JPEG (Vercel refuses bodies over 4.5 MB), then analysed if B's route exists.
$("#r-photo").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const bmp = await createImageBitmap(file).catch(() => null);
  if (!bmp) return toast("I can't read this photo.");
  const k = Math.min(1, 1024 / Math.max(bmp.width, bmp.height));
  const cv = document.createElement("canvas"); cv.width = Math.round(bmp.width * k); cv.height = Math.round(bmp.height * k);
  cv.getContext("2d").drawImage(bmp, 0, 0, cv.width, cv.height);
  rep.photo = cv.toDataURL("image/jpeg", 0.7);
  // Small copy for the map and the database (the server refuses thumbnails over 300 KB)
  const kt = Math.min(1, 320 / Math.max(bmp.width, bmp.height));
  const tv = document.createElement("canvas"); tv.width = Math.round(bmp.width * kt); tv.height = Math.round(bmp.height * kt);
  tv.getContext("2d").drawImage(bmp, 0, 0, tv.width, tv.height);
  rep.thumb = tv.toDataURL("image/jpeg", 0.7);
  $("#r-thumb").src = rep.photo; $("#r-thumb").hidden = false;
  $("#r-summary").insertAdjacentHTML("afterbegin", `<p class="muted" id="r-analyzing">${icon("spark")}Analyzing the photo…</p>`);
  try {
    const r = await fetch("/api/reports/analyze", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image_base64: rep.photo.split(",")[1], lat: rep.place.lat, lon: rep.place.lon }) });
    if (!r.ok) throw new Error(r.status);
    rep.ai = await r.json();
    if (rep.ai?.categorie) rep.cat = R_CATS.some((c) => c.key === rep.ai.categorie) ? rep.ai.categorie : (rep.ai.categorie === "escalier" ? "marche" : rep.cat || "autre");
    renderReportCats();
  } catch {
    $("#r-analyzing")?.remove();
    toast("Photo added. Automatic analysis isn't available yet.");
  }
});

$("#r-send").addEventListener("click", async () => {
  const c = R_CATS.find((x) => x.key === rep.cat);
  if (!c) return;
  const btn = $("#r-send"); btn.disabled = true; btn.textContent = "Sending…";
  try {
    const r = await fetch("/api/reports", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
      categorie: rep.ai?.categorie || c.key, temporaire: rep.ai?.temporaire ?? c.temporaire, gravite: rep.ai?.gravite || c.gravite,
      description: rep.text || rep.ai?.description || `${c.label} at ${rep.place.label}`, confiance: rep.ai?.confiance ?? 1,
      user_id: userId(), lat: rep.place.lat, lon: rep.place.lon, target_type: rep.target?.type || "place", target_id: rep.target?.id || null,
      photo_thumb: rep.thumb || null,
    }) });
    if (!r.ok) throw new Error(r.status);
    toast("Thank you! It's on the map. Other users can confirm it.");
    goHome(); loadReports();
  } catch {
    toast("Reports aren't connected yet: this one was not sent. Try again later.", 5000);
  } finally { btn.disabled = false; btn.textContent = "Send report"; }
});

let reportsData = [];
let reportsApi = true;
async function loadReports() {
  if (!reportsApi || map.getZoom() < 13) return;
  const b = map.getBounds();
  const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map((v) => v.toFixed(5)).join(",");
  try {
    const d = await getJSON(`/api/reports?bbox=${bbox}`).catch((e) => { if (e.status === 404 || e.status === 405) reportsApi = false; throw e; });
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
    (p.photo_thumb ? `<figure class="photo" id="photo"><img alt="Report photo" src="${esc(p.photo_thumb)}"><figcaption>Photo taken by a user</figcaption></figure>` : "") +
    `<h2 id="d-title" class="title">${esc(REPORT_FR[p.categorie] || "Reported obstacle")}</h2>` +
    `<p class="sub">Reported by the community ${p.created_at ? rel(p.created_at) : ""}${p.is_demo ? " · demo report" : ""}</p>` +
    `<div class="verdict ${st}">${mark(st, "lg")}<span><strong>${p.gravite === "bloquant" ? "Blocking in a wheelchair" : p.gravite === "genant" ? "Inconvenient" : "For information"}</strong>${esc(p.description || "")}</span></div>` +
    `<p class="trip-meta">${confPill(p.confidence || 2)} <span class="muted">${plural(p.confirmations || 1, "person saw it", "people saw it")}</span></p>` +
    `<button class="btn primary block" id="still-there">${icon("ok")}Still there</button>` +
    `<p class="src">Community report, not verified by an official source. It loses confidence if nobody confirms it.</p>`;
  $("#still-there").addEventListener("click", async (e) => {
    e.currentTarget.disabled = true;
    try {
      const r = await fetch(`/api/reports/${encodeURIComponent(p.id)}/confirm`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ user_id: userId() }) });
      if (!r.ok) throw new Error(r.status);
      const d = await r.json().catch(() => ({}));
      toast(`Thank you! ${d.confirmations ? plural(d.confirmations, "person has confirmed it", "people have confirmed it") : "Confirmation saved"}.`);
      loadReports();
    } catch { e.currentTarget.disabled = false; toast("I couldn't save that. Try again in a moment."); }
  });
}

async function openPlace(item) {
  const coord = [item.lon, item.lat];
  await ensureWorks();
  setPin(coord);
  show("detail", "half");
  flyTo(coord, 16);
  const near = nearestStations(coord, 3, 1500);
  const works = worksNear(coord, 150);
  $("#detail").innerHTML = photoSlot() +
    `<h2 id="d-title" class="title">${esc(item.label)}</h2><p class="sub">${esc(item.sub || "")}</p>` +
    `<div id="place-access"><p class="muted">Checking whether this place is accessible…</p></div>` +
    (works.length ? `<p class="note">${icon("cone")}<span><b>${plural(works.length, "sidewalk works site", "sidewalk works sites")}</b> within 150 m. ${esc(works[0].p.summary || "Roadworks")}, until ${esc(works[0].p.end)}.</span></p>` : "") +
    `<div class="btn-row"><button class="btn primary" id="go-to">Go there</button><button class="btn" id="go-from">Start here</button></div>` +
    `<h3 class="h2">Nearby stations with elevators</h3>` +
    (near.length ? stationList(near) : `<p class="muted">No station with an elevator within 1.5 km.</p>`) +
    nearSlot() +
    `<p class="src">Place: © OpenStreetMap contributors (Photon) or IGN. Elevators: IDFM. Roadworks: Ville de Paris.</p>`;
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
      ? acceslibreBlock(cands[0].f.properties) + `<p class="src"><a href="${esc(cands[0].f.properties.url)}" target="_blank" rel="noopener">See the Acceslibre page</a></p>`
      : `<div class="verdict unk">${mark("unk", "lg")}<span><strong>Not described yet</strong>This place has no accessibility page on Acceslibre.</span></div>`;
  } catch {
    const box = $("#place-access"); if (box) box.innerHTML = "";
  }
}

function openWorks(p, lngLat) {
  setPin([lngLat.lng, lngLat.lat]);
  show("detail", "half");
  $("#detail").innerHTML =
    `<h2 id="d-title" class="title">Sidewalk works</h2><p class="sub">${esc(p.postcode || "Paris")}</p>` +
    `<div class="verdict warn">${mark("warn", "lg")}<span><strong>${esc(p.summary || "Roadworks")}</strong>From ${esc(p.start)} to ${esc(p.end)}.</span></div>` +
    `<ul class="facts"><li>${icon("cone")}<span><b>Where:</b> ${esc((p.where || "").replace(/EMPRISE_([A-Z_]+)/g, (_, k) => ({ TROTTOIR: "sidewalk", CHAUSSEE: "roadway", STATIONNEMENT: "parking" }[k] || k.toLowerCase().replace(/_/g, " "))))}</span></li>` +
    `<li>${icon("place")}<span><b>Who:</b> ${esc(p.owner || "not specified")}</span></li></ul>` +
    `<p class="muted">The way may be narrower or diverted. Plan to cross a little earlier.</p>` +
    `<p class="src">Source: Ville de Paris, Paris roadworks (ODbL), site ${esc(p.id)}.</p>`;
}

// ---------------------------------------------------------------------------
// Trip
// ---------------------------------------------------------------------------
const trip = { from: null, to: null };
const myPosItem = () => (S.myPos ? { label: "My location", lon: S.myPos[0], lat: S.myPos[1], kind: "me" } : null);

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
  else $("#trip-from").focus();
}

const REPLAY = new URLSearchParams(location.search).get("replay") === "demo";
const VERDICT = {
  passe: { st: "ok", title: () => "This trip works", sub: (p) => (Profile.key() === "valide" ? "Nothing in the way." : `Nothing in the way for a ${p}.`) },
  risque: { st: "warn", title: () => "Possible, with risks", sub: () => "Check the steps marked “Watch out” before you go." },
  bloque: { st: "ko", title: (it) => blockedTitle(it), sub: () => "Don't take this trip." },
};
// "Blocked: Stepped street after Bastille", "Too far to go on foot", never a bare "Blocked at Long walk".
function blockedTitle(it) {
  const why = it.blocked_reason || "";
  if (why === "Long walk") return "Too far to go on foot";
  if (!why) return it.blocked_at ? `Blocked at ${it.blocked_at}` : "Blocked";
  return `Blocked: ${why}${it.blocked_near && !why.includes(it.blocked_near) ? ` near ${it.blocked_near}` : ""}`;
}
// "for a manual wheelchair", nothing for the able-bodied helper profile.
const forWho = () => (Profile.key() === "valide" ? "" : ` for a ${Profile.get()?.short || "your profile"}`);
// Confidence levels (roadmap 4.3): colour + icon + words, never colour alone.
const CONF = {
  5: ["ok", "shield", "Live info"], 4: ["ok", "people", "Confirmed by users"],
  3: ["unk", "shield", "Not live"], 2: ["warn", "people", "Reported once"], 1: ["unk", "unk", "Unknown"],
};
const checkState = (c) => c.status === "ok" ? "ok" : c.status === "en_panne" || c.effect === "bloquant" ? "ko" : c.status === "inconnu" ? "unk" : "warn";
// In replay mode a level-5 source is official but recorded, not live: say so.
const confPill = (n, recorded) => {
  let [st, ic, label] = CONF[n] || CONF[1];
  if (recorded && n === 5) label = "Recorded info";
  return `<span class="pill ${st}">${icon(ic)}${label}</span>`;
};
const whenMap = (fn) => (map.isStyleLoaded() && map.getSource("trip") ? fn() : map.once("idle", fn));
const yyyymmddToTime = (s) => (s && s.length >= 13 ? `${s.slice(9, 11)}:${s.slice(11, 13)}` : "");

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
// Text colour on a line colour: whichever of white / ink gives the higher WCAG contrast ratio.
function inkOn(hex) {
  const n = parseInt(hex.slice(1), 16);
  const lum = (v) => [v >> 16, (v >> 8) & 255, v & 255].map((c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; })
    .reduce((a, c, i) => a + c * [0.2126, 0.7152, 0.0722][i], 0);
  const L = lum(n), white = 1.05 / (L + 0.05), ink = (L + 0.05) / (lum(0x1e1a16) + 0.05);
  return ink >= white ? "#1e1a16" : "#ffffff";
}
const modeShort = (mode) => (/rer/i.test(mode || "") ? "RER" : /m[ée]tro/i.test(mode || "") ? "M" : /tram/i.test(mode || "") ? "T" : /bus/i.test(mode || "") ? "Bus"
  : /train|transilien|ter/i.test(mode || "") ? "Train" : "");
// One Citymapper-style chip per step: wheelchair + minutes for walks, coloured line badge for transit.
function stepChip(s) {
  const st = { bloque: "ko", risque: "warn" }[s.verdict];
  const flag = st ? `<span class="chip-flag ${st}" aria-hidden="true">${icon(st)}</span>` : "";
  if (s.type === "transit") {
    const bg = lineColor(s.mode, s.line);
    return `<span class="lchip" style="background:${bg};color:${inkOn(bg)}" aria-label="${esc(s.mode)} ${esc(s.line)}${st ? `, ${SR_STATE[st].toLowerCase()}` : ""}">${esc(modeShort(s.mode))}&nbsp;${esc(s.line || "")}${flag}</span>`;
  }
  return `<span class="wchip" aria-label="${s.duration_min || ""} minutes ${stepTitle(s).toLowerCase()}${st ? `, ${SR_STATE[st].toLowerCase()}` : ""}">${icon(Profile.get()?.ic || "p-manuel")}${s.duration_min ? `${s.duration_min}′` : ""}${flag}</span>`;
}
const chipsRow = (it) => it.steps.filter((s) => s.type !== "walk" || (s.duration_min || 0) >= 1)
  .map(stepChip).join(`<span class="chev-sep" aria-hidden="true">›</span>`);
const RANK = { passe: 0, risque: 1, bloque: 2 };
let lastTrip = null;

async function runTrip(opts = {}) {
  const out = $("#trip-result");
  const demo = opts.demo || REPLAY;
  // Typed but not picked (Google Maps style): take the first suggestion, never the previous trip's point.
  if (!demo) for (const k of ["from", "to"]) {
    const v = $(`#trip-${k}`).value.trim();
    if (trip[k]?.label === v) continue;
    trip[k] = v.length >= 2 ? await tripAC[k].first() : null;
    if (trip[k]) $(`#trip-${k}`).value = trip[k].label;
    else if (v) { out.innerHTML = `<p class="err">No place found for “${esc(v)}”. Try a station, an address or a landmark.</p>`; return; }
  }
  if (!demo && (!trip.from || !trip.to)) { out.innerHTML = `<p class="err">Enter ${trip.from ? "a destination" : "a starting point"}.</p>`; return; }
  document.activeElement?.blur();
  out.innerHTML = `<p class="muted">Checking every step for your ${esc(Profile.get()?.short || "profile")}…</p>`;
  const q = new URLSearchParams({ profile: Profile.key() });
  if (demo) { q.set("replay", "demo"); q.set("from", "demo"); q.set("to", "demo"); }
  else { q.set("from", `${trip.from.lon},${trip.from.lat}`); q.set("to", `${trip.to.lon},${trip.to.lat}`); }
  // The recorded demo has fixed times: only a live trip carries the chosen time.
  if (!demo && tripTime.mode !== "now") { q.set("when", tripTime.at); if (tripTime.mode === "arrive") q.set("arrive", "true"); }
  try {
    const d = await getJSON(`/api/journey?${q}`);
    if (demo) { trip.from = d.from; trip.to = d.to; $("#trip-from").value = d.from.label; $("#trip-to").value = d.to.label; }
    lastTrip = d;
    renderResults(d);
  } catch (e) {
    if (e.status === 503) renderTripFallback();
    else announce("I couldn't find a trip."), out.innerHTML = `<p class="err">I couldn't find a trip. ${/not reachable|no_(origin|destination)/.test(e.message || "") ? "No public transport reaches this place: try a nearby station or address." : esc(e.message)}</p>`;
    bindDemo();
  }
}

// Trip time, like Google Maps: "Leave now" by default, or "Depart at" / "Arrive by" a local Paris time.
const tripTime = { mode: "now", at: "" };
const WHEN_MAX_DAYS = 30;  // same limit as the server: timetables are not published further ahead
// datetime-local wants "YYYY-MM-DDTHH:MM" in local time, not toISOString's UTC.
const localISO = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
// "18:30" today, "Fri 23 Oct, 18:30" another day.
function whenText(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return "";
  const t = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString() ? t
    : `${d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}, ${t}`;
}
const whenPhrase = (mode, at) => (mode === "now" || !at ? "Leave now" : `${mode === "arrive" ? "Arrive by" : "Depart at"} ${whenText(at)}`);
const whenMode = () => document.querySelector('input[name="when-mode"]:checked')?.value || "now";

function openWhen() {
  document.querySelector(`input[name="when-mode"][value="${tripTime.mode}"]`).checked = true;
  // Next 5-minute slot by default, so "Depart at" is one tap away from a valid time.
  const next = new Date(Math.ceil(Date.now() / 300000) * 300000);
  $("#when-at").value = tripTime.at || localISO(next);
  $("#when-at").min = localISO(new Date());
  $("#when-at").max = localISO(new Date(Date.now() + WHEN_MAX_DAYS * 864e5));
  $("#when-err").textContent = "";
  syncWhenMode();
  $("#when-panel").hidden = false;
  $("#when-btn").setAttribute("aria-expanded", "true");
  document.querySelector('input[name="when-mode"]:checked').focus();
}
function closeWhen() {
  $("#when-panel").hidden = true;
  $("#when-btn").setAttribute("aria-expanded", "false");
  $("#when-btn").focus();
}
// The date field only matters for "Depart at" / "Arrive by".
function syncWhenMode() {
  const now = whenMode() === "now";
  $("#when-at").disabled = now;
  $(".when-at-l").classList.toggle("off", now);
}
function applyWhen() {
  const mode = whenMode(), at = $("#when-at").value;
  if (mode !== "now") {
    const t = new Date(at);
    const err = isNaN(t) ? "Pick a date and a time."
      : t < Date.now() - 10 * 60000 ? "This time has passed. Pick a later time, or Leave now."
      : t > Date.now() + WHEN_MAX_DAYS * 864e5 ? `Pick a time within the next ${WHEN_MAX_DAYS} days.` : "";
    if (err) { $("#when-err").textContent = err; $("#when-at").focus(); return; }
  }
  Object.assign(tripTime, { mode, at: mode === "now" ? "" : at });
  $("#when-label").textContent = whenPhrase(mode, at);
  closeWhen();
  if (trip.from && trip.to) runTrip();
}
$("#when-btn").addEventListener("click", () => ($("#when-panel").hidden ? openWhen() : closeWhen()));
$("#when-ok").addEventListener("click", applyWhen);
$("#when-cancel").addEventListener("click", closeWhen);
document.querySelectorAll('input[name="when-mode"]').forEach((r) => r.addEventListener("change", syncWhenMode));
$("#when-panel").addEventListener("keydown", (e) => {
  if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeWhen(); }
  else if (e.key === "Enter" && e.target.tagName === "INPUT") { e.preventDefault(); applyWhen(); }
});

const demoButton = () => `<button class="btn block" id="trip-demo">${icon("route")}See a sample trip (recorded)</button>`;
const bindDemo = () => $("#trip-demo")?.addEventListener("click", () => runTrip({ demo: true }));

function renderTripFallback() {
  const a = [trip.from.lon, trip.from.lat], b = [trip.to.lon, trip.to.lat];
  const block = (label, coord) => {
    const near = nearestStations(coord, 3, 1500);
    return `<h3 class="h2">${label}</h3>` + (near.length ? stationList(near) : `<p class="muted">No station with an elevator within 1.5 km.</p>`);
  };
  $("#trip-result").innerHTML =
    `<div class="verdict unk">${mark("unk", "lg")}<span><strong>Trip planning isn't connected yet</strong>Meanwhile, here are the stations with elevators at the start and at the destination.</span></div>` +
    demoButton() + block("At the start", a) + block("At the destination", b);
  bindOpen($("#trip-result"));
  Sheet.set("half");
  fitTo([a, b]);
}

function stepTitle(s) {
  // The coloured chip already says "M 14": the title gives the direction, like Google Maps.
  if (s.type === "transit") return s.direction ? `Towards ${esc(s.direction.replace(/\s*\(.*\)$/, ""))}` : `Ride to ${esc(s.to)}`;
  if (s.type === "transfer") return "Transfer";
  return { manuel: "By wheelchair", electrique: "By wheelchair", poussette: "With the stroller" }[Profile.key()] || "On foot";
}
function checkLine(c, recorded) {
  const st = checkState(c);
  const rel = "";  // reliability is part of c.message ("History: working 92% of the time…"), said once
  // A lift that is not plainly OK: one tap to that station's elevators (state, history, report).
  const zd = c.kind === "lift" && st !== "ok" && c.zdcid != null && [c.zdcid, String(c.zdcid), Number(c.zdcid)].find((k) => S.stations.has(k));
  const link = zd != null && zd !== undefined && zd !== false ? `<button class="linkish" data-open="${esc(zd)}">See the elevators at this station</button>` : "";
  return `<li class="check">${mark(st)}${srState(st)}<div><b>${esc(c.label || c.kind)}</b><div>${esc(c.message || "")}</div>${rel}${link}` +
    `<div class="meta">${confPill(c.confidence, recorded)}${c.fetched_at ? `<span class="muted">${esc(c.source || "")} · checked at ${hhmm(c.fetched_at)}</span>` : `<span class="muted">${esc(c.source || "")}</span>`}</div></div></li>`;
}

// Ranked options, like Citymapper's result list, but ordered by what works for this profile.
function renderResults(d) {
  // Same verdict: rank by time, counting 15 extra minutes per lift that often breaks down.
  const cost = (it) => it.duration_min + 15 * it.steps.flatMap((s) => s.checks || []).filter((c) => c.reliability != null && c.reliability < 0.8).length;
  const sorted = [...d.itineraries].sort((x, y) => (RANK[x.verdict] - RANK[y.verdict]) || (cost(x) - cost(y)));
  // Like Google Maps: an option more than twice as long as the fastest one that works (and 30 min more) is noise.
  const fastest = Math.min(...sorted.filter((x) => x.verdict !== "bloque").map((x) => x.duration_min));
  const its = sorted.filter((x, i) => i === 0 || !Number.isFinite(fastest) || x.duration_min <= Math.max(2 * fastest, fastest + 30));
  const rec = d.replay === "demo";
  const prof = Profile.get()?.short || "profile";
  $("#v-trip").classList.add("has-result");
  $("#trip-summary").innerHTML = `<span class="t">${esc(trip.from?.label || d.from?.label || "")} → ${esc(trip.to?.label || d.to?.label || "")}</span><span class="linkish">Edit</span>`;
  if (!its.length) { $("#trip-result").innerHTML = `<p class="err">I couldn't find a trip between these two places. Try a nearby station.</p>`; return; }
  const best = its[0];
  $("#trip-result").innerHTML =
    `<p class="results-head">${best.verdict === "bloque" ? `No trip works${esc(forWho())} ${d.when ? "at that time" : "right now"}.` : `${plural(its.filter((x) => x.verdict !== "bloque").length, "possible trip", "possible trips")}${esc(forWho())}`}</p>` +
    (rec ? `<p class="rec-line">${icon("clock")}Recorded example, not live</p>` : "") +
    // The chosen time, and plainly that lift statuses are today's, not a forecast.
    (d.when ? `<p class="when-line">${icon("clock")}<span><b>${esc(whenPhrase(d.arrive ? "arrive" : "depart", d.when))}</b>${d.time_note ? `<small>${esc(d.time_note)}</small>` : ""}</span></p>` : "") +
    `<ul class="routes">` + its.map((it, i) => {
      const V = VERDICT[it.verdict] || VERDICT.risque;
      const why = it.verdict === "bloque" ? V.title(it)
        : it.verdict === "risque" ? `Watch out: ${[...new Set(it.steps.flatMap((s) => (s.checks || []).filter((c) => checkState(c) === "warn").map((c) => c.label)))].slice(0, 2).join(", ") || "see the steps"}`
        : "Nothing blocks this trip";
      return `<li><button class="route ${V.st}" data-it="${esc(it.id)}">` +
        `<span class="route-top">${i === 0 && it.verdict !== "bloque" ? `<span class="tag">Best for you</span>` : ""}<span class="chips">${chipsRow(it)}</span>` +
        `<span class="mins"><b>${it.duration_min}</b><small>min</small></span></span>` +
        `<span class="route-why">${mark(V.st)}<span>${esc(why)}${it.departure ? `<small>Leave ${yyyymmddToTime(it.departure)} · arrive ${yyyymmddToTime(it.arrival)}</small>` : ""}</span></span>` +
        `</button></li>`;
    }).join("") + `</ul>` +
    (d.baseline?.length ? `<button class="btn block" id="compare-btn">${icon("swap")}Compare with a regular app</button>` : "") +
    `<p class="src">Routes from Île-de-France Mobilités, checked step by step by Roulib${esc(forWho())}. Elevator status from ${hhmm(d.lifts_fetched_at)}.</p>` +
    (Profile.key() === "malvoyant" ? `<p class="note"><span>Checked for you: audio announcements at stops and on board (IDFM), SNCF staff assistance and platform warning strips, audible traffic signals on walks in Paris. Not checked: tactile guidance paths inside stations, and traffic signals outside Paris.</span></p>` : "");
  document.querySelectorAll("[data-it]").forEach((b) => b.addEventListener("click", () => renderItinerary(d, b.dataset.it)));
  $("#compare-btn")?.addEventListener("click", () => openCompare(d));
  whenMap(() => drawItinerary(best));
  Sheet.set("half");
  Sheet.scrollTop();
  focusEl($("#trip-result .results-head"));
  announce(`${$("#trip-result .results-head").textContent}. Best: ${best.duration_min} minutes, ${best.verdict === "bloque" ? blockedTitle(best) : VERDICT[best.verdict].title(best)}.`);
}

function renderItinerary(d, id, fromId = null) {
  const it = d.itineraries.find((x) => x.id === id) || d.itineraries[0];
  if (!it) { $("#trip-result").innerHTML = `<p class="err">I couldn't find a trip.</p>`; return; }
  const prof = Profile.get()?.short || "profile";
  const V = VERDICT[it.verdict] || VERDICT.risque;
  const isPlanB = Boolean(fromId);
  // Plan B for any trip that does not fully work: the server's pick, else the best better-ranked option.
  const planB = (it.plan_b_id && d.itineraries.find((x) => x.id === it.plan_b_id)) || (it.verdict === "passe" ? null
    : [...d.itineraries].filter((x) => RANK[x.verdict] < RANK[it.verdict]).sort((x, y) => (RANK[x.verdict] - RANK[y.verdict]) || (x.duration_min - y.duration_min))[0]);
  const sub = it.verdict === "bloque" ? (planB ? "Don't take this trip. A Plan B is below." : "Don't take this trip. No other trip avoids it right now.") : V.sub(prof);
  const rec = d.replay === "demo";
  $("#v-trip").classList.add("has-result");
  $("#trip-summary").innerHTML = `<span class="t">${esc(trip.from?.label || d.from?.label || "")} → ${esc(trip.to?.label || d.to?.label || "")}</span><span class="linkish">Edit</span>`;
  $("#trip-result").innerHTML =
    `<button class="back" id="all-routes">${icon("chev-l")}All trips</button>` +
    (isPlanB ? `<p class="badge-b">Plan B</p>` : "") +
    `<div class="verdict big ${V.st}">${mark(V.st, "lg")}<span><strong>${esc(V.title(it))}</strong>${esc(sub)}</span></div>` +
    `<p class="trip-meta">${it.duration_min} min${it.departure ? ` · leave ${yyyymmddToTime(it.departure)}, arrive ${yyyymmddToTime(it.arrival)}` : ""} ${confPill(it.confidence, rec)}</p>` +
    (rec ? `<p class="rec-line">${icon("clock")}Recorded example, not live</p>` : "") +
    (planB ? `<button class="btn primary block" id="planb">${icon("swap")}See Plan B (${planB.duration_min} min)</button>` : "") +
    (isPlanB ? `<button class="btn block" id="plana">Back to the previous trip</button>` : "") +
    `<ol class="timeline">` + it.steps.map((s) => {
      const st = { passe: "ok", risque: "warn", bloque: "ko" }[s.verdict] || "unk";
      const rail = s.type === "transit" ? lineColor(s.mode, s.line) : null;
      const badge = s.type === "transit"
        ? `<span class="lchip" style="background:${rail};color:${inkOn(rail)}">${esc(modeShort(s.mode))}&nbsp;${esc(s.line || "")}</span>`
        : `<span class="wchip">${icon(Profile.get()?.ic || "p-manuel")}</span>`;
      return `<li class="tl ${s.type} ${st}" style="--rail:${rail || "#b9b0a2"}">` +
        `<div class="tl-stop"><span class="tl-dot"></span><b>${esc(s.from)}</b></div>` +
        `<div class="tl-body">${badge}<div><b>${stepTitle(s)}</b><small>${s.duration_min ? `${s.duration_min} min` : ""}${s.type === "transit" ? ` · to ${esc(s.to)}` : ""}</small></div><span class="tl-state">${mark(st)}${srState(st)}</span></div>` +
        (s.checks?.length ? `<ul class="checks">${s.checks.map((c) => checkLine(c, rec)).join("")}</ul>` : `<p class="muted small">Nothing in particular reported.</p>`) + `</li>`;
    }).join("") + `<li class="tl end"><div class="tl-stop"><span class="tl-dot"></span><b>${esc(it.steps[it.steps.length - 1]?.to || "")}</b></div></li></ol>` +
    `<p class="src">Roulib check for the “${esc(prof)}” profile. Elevators checked at ${hhmm(d.lifts_fetched_at)}.</p>`;
  $("#planb")?.addEventListener("click", () => { renderItinerary(d, planB.id, it.id); Sheet.scrollTop(); });
  $("#plana")?.addEventListener("click", () => { renderItinerary(d, fromId); Sheet.scrollTop(); });
  // Phone Back from a trip detail returns to the list of trips, like Google Maps.
  if (history.state?.roulib !== "detail") history.pushState({ roulib: "detail" }, "", location.href);
  $("#all-routes").addEventListener("click", () => (history.state?.roulib === "detail" ? history.back() : renderResults(d)));
  bindOpen($("#trip-result"));
  whenMap(() => drawItinerary(it));
  Sheet.set("half");
  Sheet.scrollTop();
  focusEl($("#trip-result .verdict"));
}

function drawItinerary(it) {
  const color = { passe: C.ok, risque: C.warn, bloque: C.ko };
  map.getSource("trip")?.setData({ type: "FeatureCollection", features: it.steps.filter((s) => s.geojson).map((s) => ({
    type: "Feature", geometry: s.geojson, properties: { c: color[s.verdict] || C.brand } })) });
  const pts = it.steps.flatMap((s) => (s.geojson?.coordinates || []));
  const pt = (c, end) => ({ type: "Feature", geometry: { type: "Point", coordinates: c }, properties: { end } });
  map.getSource("trip-ends")?.setData({ type: "FeatureCollection", features: pts.length ? [pt(pts[0], "a"), pt(pts[pts.length - 1], "b")] : [] });
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
    `<div class="cmp-col"><h3>Regular app</h3><div class="verdict ok">${mark("ok")}<span><strong>“Accessible”</strong>${base.duration_min} min</span></div>` +
    `<ul class="cmp-list">${base.steps.map((s) => `<li>${s.type === "public_transport" ? `${esc(s.mode)} ${esc(s.line)}` : "On foot"}<small>${esc(s.from)} → ${esc(s.to)}</small></li>`).join("")}</ul></div>` +
    `<div class="cmp-col ours"><h3>Roulib</h3><div class="verdict ${VERDICT[ours.verdict].st}">${mark(VERDICT[ours.verdict].st)}<span><strong>${esc(VERDICT[ours.verdict].title(ours))}</strong>${ours.duration_min} min</span></div>` +
    `<ul class="cmp-list">${blockers.map((c) => `<li class="hit">${mark(checkState(c))}<span>${esc(c.label)}<small>${esc(c.message || "")}</small></span></li>`).join("") || "<li>Nothing to report</li>"}</ul></div>` +
    `</div>` + (planB ? `<button class="btn primary block" id="cmp-planb">${icon("swap")}Roulib suggests a Plan B (${planB.duration_min} min)</button>` : "") +
    `<p class="src">Left: Navitia's answer alone (wheelchair option). Right: the same trip checked step by step with ${d.replay === "demo" ? "data recorded on the morning of Oct 22" : "live data"}.</p>`;
  $("#cmp-planb")?.addEventListener("click", () => { show("trip", "half"); renderItinerary(d, planB.id, ours.id); });
  show("compare", "full");
}
document.querySelector("[data-back-trip]")?.addEventListener("click", () => { show("trip", "half"); if (lastTrip) renderResults(lastTrip); });

$("#trip-go").addEventListener("click", () => runTrip());

// ---------------------------------------------------------------------------
// Search: stations from our data + places / addresses (Photon, IGN as fallback)
// ---------------------------------------------------------------------------
// Stops without elevators (Bastille, Opéra…): not in S.stations but valid trip ends.
function otherStations(q, max = 2) {
  if (!S.quais?.length) return [];
  const n = norm(q), seen = new Set([...S.stations.values()].map((st) => norm(st.name)));
  return S.quais.filter((f) => norm(f.properties.name || "").startsWith(n))
    .filter((f) => { const k = norm(f.properties.name); return !seen.has(k) && seen.add(k); }).slice(0, max)
    .map((f) => ({ kind: "place", label: f.properties.name, lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1],
      sub: `${STOP_TYPE[f.properties.type] || "Station"} · ${{ true: "step-free", partial: "partly step-free", false: "not step-free" }[f.properties.accessibility] || "access unknown"}` }));
}
const STOP_TYPE = { metro: "Metro station", rail: "Train station", tram: "Tram stop", cableway: "Cable car" };
// Last places picked in the trip form, newest first (this phone only).
const recents = () => (store.json("recents") || []).slice(0, 5);
function addRecent(it) {
  if (it.lon == null || it.kind === "me") return;
  const r = { label: it.label, sub: it.sub || "", lon: it.lon, lat: it.lat };
  store.set("recents", JSON.stringify([r, ...recents().filter((x) => x.label !== r.label)].slice(0, 5)));
}
// Addresses and places (shops, hospitals, restaurants…), ranked around `ref` [lon, lat].
const suggestAPI = (q, ref) => getJSON(`/api/suggest?q=${encodeURIComponent(q)}&lon=${ref[0]}&lat=${ref[1]}`).catch(() => ({ results: [] }));
function localStations(q, max = 4) {
  const words = norm(q).split(" ").filter(Boolean);
  if (!words.length) return [];
  return [...S.stations.values()].filter((st) => words.every((w) => st.key.includes(w)))
    .sort((a, b) => (b.key.startsWith(words[0]) - a.key.startsWith(words[0])) || a.name.length - b.name.length)
    .slice(0, max)
    .map((st) => ({ kind: "station", id: st.id, label: st.name, sub: verdictText(st)[0], status: st.status, lon: st.coord[0], lat: st.coord[1] }));
}

function autocomplete(input, list, onPick, { withMe = false, onFocus, onEnter, stations = true } = {}) {
  let items = [], sel = -1, timer = null, seq = 0;
  const render = () => {
    if (!items.length) { list.hidden = true; input.setAttribute("aria-expanded", "false"); input.removeAttribute("aria-activedescendant"); return; }
    list.innerHTML = items.map((it, i) => {
      const lead = it.kind === "station" ? mark(it.status) : it.kind === "acces" ? mark(it.status, "food")
        : `<span class="mark neutral sq" aria-hidden="true">${icon(it.kind === "me" ? "locate" : it.kind === "place" ? "place" : it.kind === "fav" ? "home" : it.kind === "recent" ? "clock" : "address")}</span>`;
      return `<li role="option" id="${list.id}-${i}" aria-selected="${i === sel}" data-i="${i}">${lead}<span class="t"><b>${esc(it.label)}</b><small>${esc(it.sub || "")}</small></span></li>`;
    }).join("");
    list.hidden = false; input.setAttribute("aria-expanded", "true");
    if (sel >= 0) input.setAttribute("aria-activedescendant", `${list.id}-${sel}`);
    list.querySelectorAll("li").forEach((li) => li.addEventListener("click", () => pick(+li.dataset.i)));
  };
  const pick = (i) => { const it = items[i]; if (!it || it.kind === "none") return; ++seq; items = []; render(); input.value = it.label; input.blur(); if (withMe) addRecent(it); onPick(it); };
  const favItems = () => [...FAVS.map((f) => { const v = store.json(`fav-${f.key}`); return v && { ...v, kind: "fav", sub: f.label }; }).filter(Boolean),
    ...recents().map((r) => ({ ...r, kind: "recent", sub: r.sub || "Recent" }))];
  const run = async () => {
    const q = input.value.trim(), my = ++seq;
    const head = [];
    if (withMe && myPosItem() && (!q || norm("my location").startsWith(norm(q)))) head.push({ ...myPosItem(), sub: "Start from where you are" });
    if (withMe && !q) head.push(...favItems());
    if (q.length < 2) { items = head; sel = -1; render(); return; }
    if (stations && !S.quais?.length) await ensureQuais();  // once, so Bastille or Opéra show up from the first keystroke
    if (my !== seq) return;
    const local = stations ? [...localStations(q), ...otherStations(q)].slice(0, 4) : [];
    items = [...head, ...local]; sel = -1; render();
    const ref = S.myPos || [map.getCenter().lng, map.getCenter().lat];
    // Addresses and places first (fast), restaurants from Acceslibre added when they arrive (can take seconds).
    let ign = { results: [] }, places = [];
    const show = () => { if (my === seq) { items = [...head, ...local, ...ign.results.slice(0, 5), ...places.slice(0, 3)]; render(); } };
    const accP = q.length >= 3 ? getJSON(`/api/places/search?q=${encodeURIComponent(q)}&lon=${ref[0]}&lat=${ref[1]}`).catch(() => ({ features: [] })) : null;
    ign = await suggestAPI(q, ref);
    const localNames = new Set(local.map((it) => norm(it.label)));
    ign.results = ign.results.filter((it) => !(/^Station/.test(it.sub || "") && localNames.has(norm(it.label))));
    show();
    if (!accP) return;
    const acc = await accP;
    places = acc.features.map((f) => ({ kind: "acces", f, label: f.properties.name, status: PLACE_ST[f.properties.wheelchair],
      sub: `${PLACE_FR[f.properties.wheelchair][0]} · ${f.properties.address || f.properties.activity || ""}`, lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] }));
    show();
    if (my === seq && !local.length && !ign.results.length && !places.length) { items = [{ kind: "none", label: `No place found for “${q}”`, sub: "Try a station, an address or a landmark" }]; render(); }
  };
  input.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(run, 180); });
  input.addEventListener("focus", () => { onFocus?.(); run(); });
  input.addEventListener("blur", () => setTimeout(() => { items = []; render(); }, 200));
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { sel = Math.min(items.length - 1, sel + 1); render(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { sel = Math.max(0, sel - 1); render(); e.preventDefault(); }
    else if (e.key === "Enter") { if (items.length) pick(sel >= 0 ? sel : 0); else { ++seq; onEnter?.(); } e.preventDefault(); }
    else if (e.key === "Escape") { items = []; render(); }
  });
  // First suggestion for the current text, for a search validated without picking.
  // Stations and addresses only: the places search is too slow to wait for here.
  const first = async () => {
    const q = input.value.trim(); ++seq; items = []; render();
    if (withMe && myPosItem() && norm("my location").startsWith(norm(q))) return myPosItem();
    const local = stations ? localStations(q) : [];
    if (local.length && norm(local[0].label).startsWith(norm(q))) return local[0];
    // Stations without elevators (Bastille…) are not in S.stations but are valid trip ends.
    await ensureQuais();
    const quai = (S.quais || []).find((f) => norm(f.properties.name || "") === norm(q));
    if (quai) return { kind: "place", label: quai.properties.name, lon: quai.geometry.coordinates[0], lat: quai.geometry.coordinates[1] };
    const ign = await suggestAPI(q, S.myPos || [map.getCenter().lng, map.getCenter().lat]);
    const all = [...local, ...ign.results].filter((x) => x.lon != null);
    return all.find((x) => norm(x.label).startsWith(norm(q))) || all[0] || null;
  };
  return { run, first };
}

// Home search = "Where to?": a picked place goes straight to a trip from here (the map still opens station and place sheets).
const pickMain = (it) => {
  if (pendingFav) return saveFav(it);
  if (it.lon == null) return;
  addRecent(it);
  $("#search").value = "";
  // Google Maps: a search result opens its card first (a station shows its elevators), "Go there" plans the trip.
  return it.kind === "station" ? openStation(it.id) : it.kind === "acces" ? openAcceslibre(it.f) : openPlace(it);
};
const mainSearch = autocomplete($("#search"), $("#suggest"), pickMain, {
  onFocus: () => isPhone() && Sheet.set("full"),
  // Enter before the suggestions arrive: take the best match, as the trip form does.
  onEnter: async () => {
    if ($("#search").value.trim().length < 2) return;
    const it = await mainSearch.first();
    if (it) pickMain(it); else toast("No place found. Try a station, an address or a landmark.");
  },
});
$("#trip-swap").addEventListener("click", () => {
  [trip.from, trip.to] = [trip.to, trip.from];
  [$("#trip-from").value, $("#trip-to").value] = [$("#trip-to").value, $("#trip-from").value];
  if (trip.from && trip.to) runTrip();
});
const tripAC = {
  from: autocomplete($("#trip-from"), $("#suggest-from"), (it) => { trip.from = it; if (trip.to) $("#trip-go").focus(); else $("#trip-to").focus(); }, { withMe: true, onEnter: () => runTrip() }),
  to: autocomplete($("#trip-to"), $("#suggest-to"), (it) => { trip.to = it; if (trip.from) runTrip(); }, { withMe: true, onEnter: () => runTrip() }),
};

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
  if (!pos) return toast("I can't find your location. Allow location access in your phone settings.");
  flyTo(pos, 15.5);
});
$("#zoom-in").addEventListener("click", () => map.zoomIn());
$("#zoom-out").addEventListener("click", () => map.zoomOut());
$("#snap").addEventListener("click", () => openReportFlow({}));

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
  if (k === "quais" && layerOn.quais) ensureQuais();
  if (k === "works" && layerOn.works && map.getZoom() >= 14) ensureWorks();
  const minZ = { places: 15, works: 14.5 }[k];
  if (minZ && layerOn[k] && map.getZoom() < minZ) {
    toast(k === "places" ? "Zooming in to show restaurants." : "Zooming in to show roadworks.");
    map.easeTo({ zoom: minZ + 0.5, padding: Sheet.padding() });
  } else if (k === "places") loadPlacesLayer();
}));

// Larger text (low vision): the app sizes text in px, so the phone's own setting does not reach it.
// The switch lives in the profile screen ("Display") to keep the home screen clear.
const textBtn = $("#textsize");
function setBig(on) {
  document.documentElement.classList.toggle("big", on);
  textBtn.setAttribute("aria-pressed", String(on));
}
setBig(store.get("big") === "1");
textBtn.addEventListener("click", () => { const on = !document.documentElement.classList.contains("big"); setBig(on); store.set("big", on ? "1" : "0"); toast(on ? "Larger text." : "Normal text."); });

(() => {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const btn = $("#mic");
  if (!SR) { btn.hidden = true; return; }
  const rec = new SR(); rec.lang = navigator.language || "fr-FR"; rec.interimResults = false;
  rec.onresult = (e) => {
    const text = e.results[0][0].transcript.replace(/^(i want to go|i'm going|take me|go) to\s+/i, "");
    $("#search").value = text; $("#search").focus(); mainSearch.run();
  };
  rec.onerror = () => toast("I didn't catch that. Try again, speaking close to the phone.");
  rec.onend = () => { btn.classList.remove("listening"); btn.setAttribute("aria-label", "Say where you're going"); };
  btn.addEventListener("click", () => { btn.classList.add("listening"); btn.setAttribute("aria-label", "Listening"); toast("I'm listening. Say, for example: Gare de Lyon."); try { rec.start(); } catch {} });
})();

function applyHash() {
  const m = location.hash.match(/station=([^&]+)/);
  if (m) openStation(decodeURIComponent(m[1]));
}
window.addEventListener("hashchange", applyHash);

// Offline support: instant reloads, last known data in tunnels. Never presented as live.
if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
window.addEventListener("offline", () => toast("Offline: showing the last known information, with its time.", 5000));
window.addEventListener("online", () => { toast("Back online."); loadLifts(); loadAlerts(); });
renderFavs();

// ---------------------------------------------------------------------------
// First launch: choose a mobility profile (roadmap screen 1)
// ---------------------------------------------------------------------------
let chosen = Profile.get()?.key || null;
function renderOnboard() {
  $("#ptiles").innerHTML = PMR_PROFILES.map((p) =>
    `<button class="ptile${p.sub ? " community" : ""}" role="radio" aria-checked="${p.key === chosen}" data-p="${p.key}"><span class="tile-ic">${icon(p.ic)}</span><span><b>${esc(p.label)}</b>${p.sub ? `<small>${esc(p.sub)}</small>` : ""}</span></button>`).join("");
  document.querySelectorAll("[data-p]").forEach((b) => b.addEventListener("click", () => { chosen = b.dataset.p; renderOnboard(); $("#o-go").disabled = false; $(`[data-p="${chosen}"]`)?.focus(); }));
  $("#o-go").disabled = !chosen;
  $("#o-name").value = Profile.name();
}
$("#o-go").addEventListener("click", () => {
  if (!chosen) return;
  const first = !Profile.get();
  Profile.save(chosen, $("#o-name").value);
  renderMe();
  if (lastTrip && onboardFrom === "trip") { show("trip", "half"); runTrip(); }
  else show("home", "half");
  // First launch: centre on the user, like any maps app (the browser asks for permission once).
  if (first) locate().then((pos) => pos && flyTo(pos, 15));
  toast(chosen === "valide" ? "Thanks for joining the community! Tap Report whenever you see a broken elevator or a blocked sidewalk." : `Got it: I'll check your trips for a ${Profile.get().short}.`, 5000);
});
function renderMe() {
  const p = Profile.get();
  $("#me-ic").innerHTML = icon(p ? p.ic : "p-manuel");
  $("#me-name").textContent = p ? p.short : "your profile";
  // Short greeting: the search bar itself asks "Where to?".
  const h = new Date().getHours(), hi = h >= 18 || h < 4 ? "Good evening" : h < 12 ? "Good morning" : "Hello";
  $("#h-home").textContent = Profile.name() ? `${hi}, ${Profile.name()}` : hi;
  $("#me-chip").setAttribute("aria-label", `For: ${p ? p.short : "your profile"}. Change profile`);
}
let onboardFrom = null;
$("#me-chip").addEventListener("click", () => { onboardFrom = [...document.querySelectorAll(".view")].find((v) => !v.hidden)?.id.slice(2); renderOnboard(); show("onboard", "full"); });
renderMe();
if (!Profile.get() && !REPLAY) { renderOnboard(); show("onboard", "full"); }
if (REPLAY) openTrip(null, null);

// Report: "Change" lets the user pick the exact place (station, address) instead of the guessed one.
$("#r-place-edit").addEventListener("click", () => { $("#r-place-pick").hidden = false; $("#r-place-input").value = ""; $("#r-place-input").focus(); });
autocomplete($("#r-place-input"), $("#suggest-rplace"), (it) => {
  rep.place = { label: it.label, sub: it.sub || "", lon: it.lon, lat: it.lat };
  rep.target = it.kind === "station" ? { type: "station", id: it.id } : null;
  $("#r-place").textContent = it.label; $("#r-place-sub").textContent = it.sub || "";
  $("#r-place-pick").hidden = true; setPin([it.lon, it.lat]); flyTo([it.lon, it.lat], 16);
});
// Location already allowed (returning user): show the blue dot and centre on it, like Google Maps.
navigator.permissions?.query({ name: "geolocation" }).then((p) => {
  if (p.state === "granted" && Profile.get()) locate().then((pos) => pos && $("#v-home") && !$("#v-home").hidden && flyTo(pos, 15));
}).catch(() => {});
