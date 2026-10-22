// PMR Maps – front-end. One search box, plain-language answers, freshness always visible.
"use strict";

const C = { ok: "#15803d", warn: "#b45309", ko: "#b91c1c", unk: "#6b7280", works: "#7c3aed", accent: "#1d4ed8" };
const SYM = { ok: "✓", warn: "!", ko: "✕", unk: "?" };
const LIFT_FR = { available: "En service", notavailable: "En panne", unknown: "État inconnu" };
const ACCESS_FR = { true: "accessible", partial: "partiellement accessible", false: "non accessible", unknown: "inconnu" };
const TYPE_FR = { metro: "Métro", rail: "Train / RER", tram: "Tram", cableway: "Câble", bus: "Bus" };
const PLACE_ST = { true: "ok", partial: "warn", false: "ko", unknown: "unk" };
const PLACE_FR = { true: "Accessible en fauteuil", partial: "Partiellement accessible", false: "Non accessible en fauteuil", unknown: "Accessibilité non renseignée" };
const TOILETS_FR = { true: "Toilettes adaptées", false: "Toilettes non adaptées", none: "Pas de toilettes", unknown: "Toilettes : non renseigné" };
const PLACES_MINZOOM = 15;
const MODE_FR = { Metro: "Métro", RapidTransit: "RER / Train", Tramway: "Tram", LocalTrain: "Train" };

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const norm = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} } };

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
const STALE_H = 48; // info older than this lowers confidence
const hhmm = (iso) => { const d = new Date(iso); return isNaN(d) ? "?" : d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }); };
const dayTime = (iso) => { const d = new Date(iso); return isNaN(d) ? iso : d.toLocaleString("fr-FR", { weekday: "short", hour: "2-digit", minute: "2-digit" }); };

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
// Data
// ---------------------------------------------------------------------------
const S = {
  stations: new Map(), // zdcid -> {id, name, mode, coord, lifts[], status}
  quais: [], train: [], worksCenters: [], meta: {}, myPos: null,
};

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
    if (!st) {
      st = { id: p.zdcid, name: p.station, mode: p.mode, coord: f.geometry.coordinates, lifts: [] };
      S.stations.set(p.zdcid, st);
    }
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
  return {
    type: "FeatureCollection",
    features: [...S.stations.values()].map((st) => ({
      type: "Feature", geometry: { type: "Point", coordinates: st.coord },
      properties: { id: st.id, name: st.name, status: st.status, sort: order[st.status] },
    })),
  };
}

function nearestStations(coord, max = 5, radius = 2000) {
  return [...S.stations.values()]
    .map((st) => ({ st, d: distM(coord, st.coord) }))
    .filter((x) => x.d <= radius).sort((a, b) => a.d - b.d).slice(0, max);
}

function worksNear(coord, radius = 150) {
  return S.worksCenters.filter((w) => distM(coord, w.c) <= radius);
}

// ---------------------------------------------------------------------------
// Map
// ---------------------------------------------------------------------------
const map = new maplibregl.Map({
  container: "map", style: "https://tiles.openfreemap.org/styles/positron",
  center: [2.3488, 48.8566], zoom: 12.3, attributionControl: { compact: true },
});
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");

function makeIcon(color, sym, size = 44) {
  const r = window.devicePixelRatio || 1, px = size * r;
  const c = document.createElement("canvas"); c.width = c.height = px;
  const g = c.getContext("2d");
  g.beginPath(); g.arc(px / 2, px / 2, px / 2 - 2 * r, 0, Math.PI * 2);
  g.fillStyle = color; g.fill(); g.lineWidth = 3 * r; g.strokeStyle = "#fff"; g.stroke();
  g.fillStyle = "#fff"; g.font = `bold ${px * 0.5}px system-ui, sans-serif`;
  g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(sym, px / 2, px / 2 + r);
  return { image: g.getImageData(0, 0, px, px), ratio: r };
}

const empty = () => ({ type: "FeatureCollection", features: [] });

map.on("load", () => {
  for (const k of ["ok", "warn", "ko", "unk"]) {
    const { image, ratio } = makeIcon(C[k], SYM[k]);
    map.addImage(`st-${k}`, image, { pixelRatio: ratio });
  }
  const src = (id) => map.addSource(id, { type: "geojson", data: empty() });
  ["works", "quais", "bus", "places", "trip", "stations", "pin"].forEach(src);

  map.addLayer({ id: "works-fill", type: "fill", source: "works", paint: { "fill-color": C.works, "fill-opacity": 0.22 } });
  map.addLayer({ id: "works-line", type: "line", source: "works", paint: { "line-color": C.works, "line-width": 1.2 } });
  const accColor = ["match", ["get", "accessibility"], "true", C.ok, "partial", C.warn, "false", C.ko, C.unk];
  map.addLayer({ id: "quais", type: "circle", source: "quais", layout: { visibility: "none" },
    paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 11, 2.5, 16, 7], "circle-color": accColor, "circle-stroke-color": "#fff", "circle-stroke-width": 1 } });
  map.addLayer({ id: "bus", type: "circle", source: "bus", minzoom: 14.5, layout: { visibility: "none" },
    paint: { "circle-radius": 5, "circle-color": accColor, "circle-stroke-color": "#fff", "circle-stroke-width": 1.5 } });
  map.addLayer({ id: "places", type: "circle", source: "places", minzoom: PLACES_MINZOOM, layout: { visibility: "none" },
    paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 15, 4.5, 18, 9],
      "circle-color": ["match", ["get", "wheelchair"], "true", C.ok, "partial", C.warn, "false", C.ko, C.unk],
      "circle-stroke-color": ["match", ["get", "category"], "food", "#111827", "#fff"], "circle-stroke-width": 1.5 } });
  map.addLayer({ id: "trip", type: "line", source: "trip", layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": C.accent, "line-width": 6, "line-opacity": 0.85 } });
  map.addLayer({ id: "stations", type: "symbol", source: "stations",
    layout: {
      "icon-image": ["concat", "st-", ["get", "status"]], "icon-allow-overlap": true, "symbol-sort-key": ["get", "sort"],
      "icon-size": ["interpolate", ["linear"], ["zoom"], 9, 0.35, 12, 0.55, 15, 0.85],
      "text-field": ["step", ["zoom"], "", 14, ["get", "name"]], "text-font": ["Noto Sans Regular"],
      "text-size": 13, "text-offset": [0, 1.6], "text-anchor": "top", "text-optional": true,
    },
    paint: { "text-color": "#111827", "text-halo-color": "#fff", "text-halo-width": 1.5 } });
  map.addLayer({ id: "pin", type: "circle", source: "pin",
    paint: { "circle-radius": 11, "circle-color": C.accent, "circle-stroke-color": "#fff", "circle-stroke-width": 4 } });

  map.on("click", "stations", (e) => openStation(e.features[0].properties.id));
  map.on("click", "works-fill", (e) => openWorks(e.features[0].properties, e.lngLat));
  map.on("click", "quais", (e) => quickPopup(e, "Quai"));
  map.on("click", "bus", (e) => quickPopup(e, "Arrêt de bus"));
  map.on("click", "places", (e) => {
    const f = e.features[0];
    openAcces({ ...f.properties, lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] });
  });
  for (const id of ["stations", "works-fill", "quais", "bus", "places"]) {
    map.on("mouseenter", id, () => (map.getCanvas().style.cursor = "pointer"));
    map.on("mouseleave", id, () => (map.getCanvas().style.cursor = ""));
  }
  map.on("moveend", loadBus);
  map.on("moveend", loadPlaces);

  loadLifts().then(() => applyHash());
  loadStatic();
  loadAlerts();
  setInterval(loadLifts, 5 * 60 * 1000);
  setInterval(loadAlerts, 60 * 1000);
});

function quickPopup(e, kind) {
  const p = e.features[0].properties;
  new maplibregl.Popup({ maxWidth: "280px" }).setLngLat(e.lngLat)
    .setHTML(`<b>${esc(p.name)}</b><br>${esc(kind)} ${p.type ? "· " + esc(TYPE_FR[p.type] || p.type) : ""}<br>` +
      `<b>${esc(ACCESS_FR[p.accessibility] || p.accessibility)}</b><div style="color:#4b5563;font-size:.8em;margin-top:4px">IDFM Référentiel des arrêts</div>`)
    .addTo(map);
}

function setPin(coord) { map.getSource("pin")?.setData(coord ? { type: "Feature", geometry: { type: "Point", coordinates: coord } } : empty()); }
function flyTo(coord, zoom = 15.5) {
  const desktop = window.innerWidth > 760;
  map.flyTo({ center: coord, zoom, padding: desktop ? { left: 440 } : { bottom: window.innerHeight * 0.46 }, essential: true });
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
    $("#today").innerHTML = `<p class="err">Impossible de charger l'état des ascenseurs (${esc(e.message)}).</p>`;
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

let placesReq = 0;
async function loadPlaces() {
  if (!layerOn.places || map.getZoom() < PLACES_MINZOOM) return;
  const b = map.getBounds();
  const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map((v) => v.toFixed(5)).join(",");
  const my = ++placesReq;
  try {
    const d = await getJSON(`/api/places?bbox=${bbox}`);
    if (my !== placesReq) return; // a newer request superseded this one
    map.getSource("places").setData(d);
    S.meta.places = d.meta; renderSources();
    if (d.meta.stale) toast("Acceslibre injoignable : dernière version connue des lieux.");
  } catch (e) { console.warn("places", e); }
}

// Acceslibre place closest to a point, preferring the same name (search results come from IGN).
async function accesNear(coord, label) {
  const dLon = 0.0015, dLat = 0.001;
  const bbox = [coord[0] - dLon, coord[1] - dLat, coord[0] + dLon, coord[1] + dLat].map((v) => v.toFixed(5)).join(",");
  const d = await getJSON(`/api/places?bbox=${bbox}`);
  const key = norm(label);
  const cands = d.features.map((f) => ({ p: f.properties, d: distM(coord, f.geometry.coordinates) }))
    .filter((x) => { const n = norm(x.p.name); return x.d < 80 && n.length >= 3 && key.length >= 3 && (n.includes(key) || key.includes(n)); });
  return cands.sort((a, b) => a.d - b.d)[0]?.p || null;
}

function accesBlock(p) {
  const st = PLACE_ST[p.wheelchair] || "unk";
  const reasons = typeof p.reasons === "string" ? JSON.parse(p.reasons) : p.reasons || []; // MapLibre serialises arrays
  return `<div class="verdict ${st}"><span class="badge ${st}" aria-hidden="true">${SYM[st]}</span>` +
    `<span><strong>${esc(PLACE_FR[p.wheelchair] || p.wheelchair)}</strong>${esc(TOILETS_FR[p.toilets] || "")}${p.parking ? " · place PMR" : ""}</span></div>` +
    `<ul class="reasons">${reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>`;
}

async function loadAlerts() {
  try {
    const d = await getJSON("/api/alerts");
    const ul = $("#alerts");
    if (!d.alerts.length) {
      ul.innerHTML = `<li class="empty">Aucun changement depuis ${d.poller.last_poll ? hhmm(d.poller.last_poll) : "le démarrage"}. On revérifie toutes les 15 minutes.</li>`;
      return;
    }
    ul.innerHTML = d.alerts.slice(0, 8).map((a) =>
      `<li class="${a.to === "available" ? "up" : ""}" data-station="${esc(a.zdcid)}" tabindex="0" role="button">` +
      `<b>${esc(a.station)}</b> : ${a.to === "available" ? "ascenseur réparé ✓" : a.to === "notavailable" ? "ascenseur en panne ✕" : "état devenu inconnu"}` +
      `<br><small>${esc(a.situation || "")} · détecté ${rel(a.detected_at)}</small></li>`).join("");
    ul.querySelectorAll("[data-station]").forEach((li) => {
      const go = () => openStation(li.dataset.station);
      li.addEventListener("click", go); li.addEventListener("keydown", (e) => e.key === "Enter" && go());
    });
  } catch (e) { console.warn("alerts", e); }
}

// ---------------------------------------------------------------------------
// Rendering: home
// ---------------------------------------------------------------------------
function renderToday() {
  const m = S.meta.lifts, c = m.counts, total = (c.available || 0) + (c.notavailable || 0) + (c.unknown || 0);
  const latest = [...S.stations.values()].map((s) => s.latest).filter(Boolean).sort().pop();
  const pct = (n) => `${(100 * n / total).toFixed(1)}%`;
  $("#today").innerHTML =
    `<p class="big">${c.notavailable} ascenseurs en panne aujourd'hui</p>` +
    `<div class="bar" aria-hidden="true"><span style="width:${pct(c.available)};background:${C.ok}"></span>` +
    `<span style="width:${pct(c.notavailable)};background:${C.ko}"></span><span style="width:${pct(c.unknown)};background:${C.unk}"></span></div>` +
    `<div class="row"><span><span class="dot ok"></span>${c.available} en service</span><span><span class="dot ko"></span>${c.notavailable} en panne</span>` +
    `<span><span class="dot unk"></span>${c.unknown} inconnus</span></div>` +
    `<p class="fresh">${m.stale ? "⚠ Source IDFM injoignable, dernière version connue. " : ""}` +
    `Info IDFM la plus récente : ${rel(latest)} · vérifié par nous à ${hhmm(m.fetched_at)}</p>`;
}

function renderSources() {
  const items = Object.values(S.meta).filter((m) => m && m.source).map((m) =>
    `<li><a href="${esc(m.source.url)}" target="_blank" rel="noopener">${esc(m.source.name)}</a> – ${esc(m.source.license)}` +
    ` · ${m.count} éléments · récupéré à ${hhmm(m.fetched_at)}</li>`);
  $("#sources-list").innerHTML = items.join("") + `<li>Recherche de lieux : IGN Géoplateforme</li><li>Fond de carte © OpenStreetMap, OpenFreeMap</li>`;
}

function stationCard(st, d) {
  const [title] = verdictText(st);
  return `<button class="card" data-open="${esc(st.id)}"><span class="badge ${st.status}" aria-hidden="true">${SYM[st.status]}</span>` +
    `<span><b>${esc(st.name)}</b><small>${esc(MODE_FR[st.mode] || st.mode || "")}${d != null ? " · à " + fmtDist(d) : ""}</small><br>${esc(title)}</span></button>`;
}
function bindCards(root) {
  root.querySelectorAll("[data-open]").forEach((b) => b.addEventListener("click", () => openStation(b.dataset.open)));
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------
function show(view) {
  for (const v of document.querySelectorAll(".view")) v.hidden = v.id !== `v-${view}`;
  const sheet = $("#sheet");
  sheet.scrollTop = 0;
  if (view !== "home" && sheet.classList.contains("mini")) sheet.classList.remove("mini");
  const h = $(`#v-${view} h2, #v-${view} h1`);
  if (h && view !== "home") { h.setAttribute("tabindex", "-1"); h.focus({ preventScroll: true }); }
}
document.querySelectorAll("[data-back]").forEach((b) => b.addEventListener("click", () => {
  show("home"); setPin(null); history.replaceState(null, "", location.pathname);
}));

function openStation(id) {
  const st = S.stations.get(String(id));
  if (!st) { toast("Station introuvable dans les données ascenseurs."); return; }
  history.replaceState(null, "", `#station=${encodeURIComponent(st.id)}`);
  setPin(null);
  flyTo(st.coord, 16);
  const [title, sub] = verdictText(st);
  const quais = S.quais.filter((q) => distM(st.coord, q.geometry.coordinates) < 350 && norm(q.properties.name) === st.key);
  const qCount = {};
  quais.forEach((q) => { const a = q.properties.accessibility || "unknown"; qCount[a] = (qCount[a] || 0) + 1; });
  const Q_FR = { true: ["accessible", "accessibles"], partial: ["partiellement accessible", "partiellement accessibles"], false: ["non accessible", "non accessibles"], unknown: ["sans information", "sans information"] };
  const qText = ["true", "partial", "false", "unknown"].filter((k) => qCount[k]).map((k) => `${qCount[k]} ${Q_FR[k][qCount[k] > 1 ? 1 : 0]}`).join(", ");
  const works = worksNear(st.coord, 200);
  const lifts = [...st.lifts].sort((a, b) => (a.status === "notavailable" ? -1 : 0) - (b.status === "notavailable" ? -1 : 0));

  const oldest = st.lifts.map((l) => l.source_update).filter(Boolean).sort()[0];
  const staleNote = st.staleLifts
    ? `<p class="stale">⏱ <b>Info à confirmer :</b> pour ${st.staleLifts === st.lifts.length ? (st.lifts.length > 1 ? "tous les ascenseurs" : "cet ascenseur") : `${st.staleLifts} ascenseur${st.staleLifts > 1 ? "s" : ""} sur ${st.lifts.length}`}, ` +
      `la dernière mise à jour IDFM date ${rel(oldest).replace(/^le /, "du ").replace("il y a", "d'il y a")}. Leur état réel a pu changer.</p>` : "";
  $("#detail").innerHTML =
    `<h2 id="d-title" class="title">${esc(st.name)}</h2><p class="muted">${esc(MODE_FR[st.mode] || st.mode || "")}</p>` +
    `<div class="verdict ${st.status}"><span class="badge ${st.status}" aria-hidden="true">${SYM[st.status]}</span>` +
    `<span><strong>${esc(title)}</strong>${esc(sub)}</span></div>` + staleNote +
    `<div class="btn-row"><button class="big-btn primary" id="go-to">Y aller</button><button class="big-btn secondary" id="go-from">Partir d'ici</button></div>` +
    (quais.length ? `<p>🚉 <b>Quais (${quais.length}) :</b> ${qText} <small class="muted">· référentiel IDFM</small></p>` : "") +
    (works.length ? `<p>🚧 <b>${works.length} chantier${works.length > 1 ? "s" : ""}</b> sur le trottoir à moins de 200 m</p>` : "") +
    `<h3 class="section-title">Ascenseurs (${lifts.length})</h3>` +
    lifts.map((l) => {
      const cls = l.status === "available" ? "ok" : l.status === "notavailable" ? "ko" : "";
      return `<div class="lift ${cls}"><div class="st">${SYM[cls || "unk"]} ${esc(LIFT_FR[l.status] || l.status)}${l.reason ? ` <small>(${esc(l.reason === "liftFailure" ? "panne" : l.reason)})</small>` : ""}</div>` +
        `<div>${esc(l.situation || "")}</div>${l.direction ? `<small class="muted">${esc(l.direction)}</small><br>` : ""}` +
        `<small class="${ageH(l.source_update) > STALE_H ? "stale-txt" : "muted"}">${ageH(l.source_update) > STALE_H ? "⏱ " : ""}Info IDFM ${rel(l.source_update)} (${esc(dayTime(l.source_update))})</small></div>`;
    }).join("") +
    `<p class="src">Source : IDFM – État des ascenseurs (Licence Mobilité), zone ${esc(st.id)} · vérifié par nous à ${hhmm(S.meta.lifts.fetched_at)}</p>`;
  const here = { label: st.name, lon: st.coord[0], lat: st.coord[1] };
  $("#go-to").addEventListener("click", () => openTrip(null, here));
  $("#go-from").addEventListener("click", () => openTrip(here, null));
  show("detail");
}

function openPlace(item) {
  const coord = [item.lon, item.lat];
  setPin(coord);
  flyTo(coord, 15.5);
  const near = nearestStations(coord, 4, 1500);
  const works = worksNear(coord, 150);
  $("#detail").innerHTML =
    `<h2 id="d-title" class="title">${esc(item.label)}</h2><p class="muted">${esc(item.sub || "")}</p>` +
    `<div class="btn-row"><button class="big-btn primary" id="go-to">Y aller</button><button class="big-btn secondary" id="go-from">Partir d'ici</button></div>` +
    (works.length ? `<div class="verdict warn"><span class="badge warn" aria-hidden="true">!</span><span><strong>${works.length} chantier${works.length > 1 ? "s" : ""} sur le trottoir à moins de 150 m</strong>` +
      `${esc(works[0].p.summary || "")}, jusqu'au ${esc(works[0].p.end)}</span></div>` : "") +
    `<h3 class="section-title">Stations avec ascenseur les plus proches</h3>` +
    (near.length ? near.map((x) => stationCard(x.st, x.d)).join("") : `<p class="muted">Aucune station avec ascenseur à moins de 1,5 km.</p>`) +
    `<h3 class="section-title">Accessibilité du lieu</h3><div id="place-acces"><p class="muted">Recherche dans Acceslibre…</p></div>` +
    `<p class="src">Lieu : IGN Géoplateforme · Ascenseurs : IDFM · Chantiers : Ville de Paris · Accessibilité du lieu : Acceslibre</p>`;
  accesNear(coord, item.label).then((p) => {
    const box = $("#place-acces");
    if (!box) return;
    box.innerHTML = p ? accesBlock(p) + `<p class="src"><a href="${esc(p.url)}" target="_blank" rel="noopener">Fiche Acceslibre</a> · ${esc(p.name)}</p>`
      : `<p class="muted">${item.kind === "address" ? "Aucun établissement Acceslibre à cette adresse." : "Pas de fiche Acceslibre pour ce lieu : son accessibilité n'est pas renseignée."}</p>`;
  }).catch(() => { const box = $("#place-acces"); if (box) box.innerHTML = `<p class="muted">Acceslibre indisponible pour le moment.</p>`; });
  bindCards($("#detail"));
  $("#go-to").addEventListener("click", () => openTrip(null, item));
  $("#go-from").addEventListener("click", () => openTrip(item, null));
  show("detail");
}

function openAcces(p) {
  const coord = [p.lon, p.lat];
  setPin(coord);
  const near = nearestStations(coord, 3, 1500);
  const item = { label: p.name, sub: p.address, lon: p.lon, lat: p.lat };
  $("#detail").innerHTML =
    `<h2 id="d-title" class="title">${esc(p.name)}</h2><p class="muted">${esc(p.activity)} · ${esc(p.address)}</p>` +
    accesBlock(p) +
    `<div class="btn-row"><button class="big-btn primary" id="go-to">Y aller</button><button class="big-btn secondary" id="go-from">Partir d'ici</button></div>` +
    `<h3 class="section-title">Stations avec ascenseur les plus proches</h3>` +
    (near.length ? near.map((x) => stationCard(x.st, x.d)).join("") : `<p class="muted">Aucune station avec ascenseur à moins de 1,5 km.</p>`) +
    `<p class="src"><a href="${esc(p.url)}" target="_blank" rel="noopener">Fiche Acceslibre</a> · Acceslibre via data.gouv.fr (Licence Ouverte)` +
    `${S.meta.places ? ` · récupéré à ${hhmm(S.meta.places.fetched_at)}` : ""}</p>`;
  bindCards($("#detail"));
  $("#go-to").addEventListener("click", () => openTrip(null, item));
  $("#go-from").addEventListener("click", () => openTrip(item, null));
  show("detail");
}

function openWorks(p, lngLat) {
  setPin([lngLat.lng, lngLat.lat]);
  $("#detail").innerHTML =
    `<h2 id="d-title" class="title">🚧 Chantier sur le trottoir</h2>` +
    `<div class="verdict warn"><span class="badge warn" aria-hidden="true">!</span><span><strong>${esc(p.summary || "Travaux")}</strong>` +
    `Du ${esc(p.start)} au ${esc(p.end)}</span></div>` +
    `<p><b>Emprise :</b> ${esc((p.where || "").replace(/EMPRISE_/g, "").toLowerCase())}</p><p><b>Maître d'ouvrage :</b> ${esc(p.owner || "?")}</p>` +
    `<p class="muted">Le passage peut être réduit ou dévié. Prévoyez de traverser plus tôt.</p>` +
    `<p class="src">Source : Ville de Paris – Chantiers à Paris (ODbL), emprise ${esc(p.id)}</p>`;
  show("detail");
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
  show("trip");
  if (!trip.from) $("#trip-from").focus(); else if (!trip.to) $("#trip-to").focus();
  else runTrip();
}

async function runTrip() {
  const out = $("#trip-result");
  if (!trip.from || !trip.to) { out.innerHTML = `<p class="err">Choisissez un départ et une arrivée dans la liste.</p>`; return; }
  out.innerHTML = `<p class="muted">Calcul d'un itinéraire accessible…</p>`;
  const q = (p) => `${p.lon},${p.lat}`;
  try {
    const d = await getJSON(`/api/journey?from=${q(trip.from)}&to=${q(trip.to)}`);
    renderJourneys(d);
  } catch (e) {
    if (e.status === 503) renderTripFallback(); else out.innerHTML = `<p class="err">${esc(e.message)}</p>`;
  }
}

function renderTripFallback() {
  const a = [trip.from.lon, trip.from.lat], b = [trip.to.lon, trip.to.lat];
  const block = (label, coord) => {
    const near = nearestStations(coord, 3, 1500);
    return `<h3 class="section-title">${label}</h3>` + (near.length ? near.map((x) => stationCard(x.st, x.d)).join("") : `<p class="muted">Aucune station avec ascenseur à moins de 1,5 km.</p>`);
  };
  $("#trip-result").innerHTML =
    `<div class="verdict unk"><span class="badge unk" aria-hidden="true">?</span><span><strong>Calcul d'itinéraire bientôt disponible</strong>` +
    `En attendant, voici l'état des stations proches du départ et de l'arrivée.</span></div>` +
    block("Près du départ", a) + block("Près de l'arrivée", b);
  bindCards($("#trip-result"));
  fitTo([a, b]);
}

function renderJourneys(d) {
  if (!d.journeys.length) { $("#trip-result").innerHTML = `<p>Aucun itinéraire accessible trouvé.</p>`; return; }
  $("#trip-result").innerHTML = d.journeys.map((j, i) => {
    const bad = j.lifts_not_available;
    const status = bad.length ? "warn" : "ok";
    const steps = j.sections.filter((s) => s.type === "public_transport" || (s.type === "street_network" && s.duration_s > 30)).map((s) =>
      s.type === "public_transport" ? `<li><b>${esc(s.mode)} ${esc(s.line)}</b> de ${esc(s.from)} à ${esc(s.to)}</li>`
        : `<li>Trajet en fauteuil, ${Math.max(1, Math.round(s.duration_s / 60))} min</li>`).join("");
    return `<div class="journey ${i === 0 ? "sel" : ""}" data-i="${i}" tabindex="0" role="button">` +
      `<div class="verdict ${status}"><span class="badge ${status}" aria-hidden="true">${SYM[status]}</span><span><strong>${Math.round(j.duration_s / 60)} min</strong>` +
      `${bad.length ? `${bad.length} ascenseur${bad.length > 1 ? "s" : ""} hors service : ${esc([...new Set(bad.map((l) => l.station))].join(", "))}` : "Aucun ascenseur en panne signalé sur le trajet"}</span></div>` +
      `<ol>${steps}</ol></div>`;
  }).join("") + `<p class="src">Itinéraire : ${esc(d.source)} · ascenseurs vérifiés à ${hhmm(d.lifts_fetched_at)}</p>`;
  const showJ = (i) => {
    document.querySelectorAll(".journey").forEach((el) => el.classList.toggle("sel", +el.dataset.i === i));
    const feats = d.journeys[i].sections.filter((s) => s.geojson).map((s) => ({ type: "Feature", geometry: s.geojson, properties: {} }));
    map.getSource("trip").setData({ type: "FeatureCollection", features: feats });
  };
  document.querySelectorAll(".journey").forEach((el) => {
    el.addEventListener("click", () => showJ(+el.dataset.i));
    el.addEventListener("keydown", (e) => e.key === "Enter" && showJ(+el.dataset.i));
  });
  showJ(0);
  fitTo([[d.from.lon, d.from.lat], [d.to.lon, d.to.lat]]);
}

function fitTo(coords) {
  const b = new maplibregl.LngLatBounds(coords[0], coords[0]);
  coords.forEach((c) => b.extend(c));
  const desktop = window.innerWidth > 760;
  map.fitBounds(b, { padding: desktop ? { left: 470, right: 60, top: 80, bottom: 60 } : { top: 70, left: 30, right: 30, bottom: window.innerHeight * 0.5 }, maxZoom: 15 });
}
$("#trip-go").addEventListener("click", runTrip);

// ---------------------------------------------------------------------------
// Search (stations from our data + places/addresses from IGN)
// ---------------------------------------------------------------------------
function localStations(q, max = 4) {
  const words = norm(q).split(" ").filter(Boolean);
  if (!words.length) return [];
  return [...S.stations.values()]
    .filter((st) => words.every((w) => st.key.includes(w)))
    .sort((a, b) => (b.key.startsWith(words[0]) - a.key.startsWith(words[0])) || a.name.length - b.name.length)
    .slice(0, max)
    .map((st) => ({ kind: "station", id: st.id, label: st.name, sub: verdictText(st)[0], status: st.status, lon: st.coord[0], lat: st.coord[1] }));
}

function autocomplete(input, list, onPick, { withMe = false } = {}) {
  let items = [], sel = -1, timer = null, seq = 0;
  const render = () => {
    if (!items.length) { list.hidden = true; input.setAttribute("aria-expanded", "false"); return; }
    list.innerHTML = items.map((it, i) => {
      const ic = it.kind === "station" ? `<span class="s-ic ${it.status}">${SYM[it.status]}</span>`
        : `<span class="s-ic">${it.kind === "me" ? "◎" : it.kind === "place" ? "★" : "⌂"}</span>`;
      return `<li role="option" id="${list.id}-${i}" aria-selected="${i === sel}" data-i="${i}">${ic}<span><b>${esc(it.label)}</b><small>${esc(it.sub || "")}</small></span></li>`;
    }).join("");
    list.hidden = false; input.setAttribute("aria-expanded", "true");
    if (sel >= 0) input.setAttribute("aria-activedescendant", `${list.id}-${sel}`);
    list.querySelectorAll("li").forEach((li) => li.addEventListener("mousedown", (e) => { e.preventDefault(); pick(+li.dataset.i); }));
  };
  const pick = (i) => { const it = items[i]; if (!it) return; items = []; render(); input.value = it.label; onPick(it); };
  const run = async () => {
    const q = input.value.trim(), my = ++seq;
    const head = withMe && myPosItem() && (!q || norm("ma position").startsWith(norm(q))) ? [{ ...myPosItem(), sub: "Départ depuis votre position" }] : [];
    if (q.length < 2) { items = head; sel = -1; render(); return; }
    items = [...head, ...localStations(q)]; sel = -1; render();
    try {
      const d = await getJSON(`/api/suggest?q=${encodeURIComponent(q)}`);
      if (my !== seq) return;
      items = [...head, ...localStations(q), ...d.results.slice(0, 5)]; render();
    } catch {}
  };
  input.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(run, 180); });
  input.addEventListener("focus", run);
  input.addEventListener("blur", () => setTimeout(() => { items = []; render(); }, 150));
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { sel = Math.min(items.length - 1, sel + 1); render(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { sel = Math.max(0, sel - 1); render(); e.preventDefault(); }
    else if (e.key === "Enter") { pick(sel >= 0 ? sel : 0); e.preventDefault(); }
    else if (e.key === "Escape") { items = []; render(); }
  });
  return { run };
}

const pickMain = (it) => (it.kind === "station" ? openStation(it.id) : openPlace(it));
const mainSearch = autocomplete($("#search"), $("#suggest"), pickMain);
autocomplete($("#trip-from"), $("#suggest-from"), (it) => { trip.from = it; if (trip.to) runTrip(); else $("#trip-to").focus(); }, { withMe: true });
autocomplete($("#trip-to"), $("#suggest-to"), (it) => { trip.to = it; if (trip.from) runTrip(); });

// ---------------------------------------------------------------------------
// Geolocation & nearby
// ---------------------------------------------------------------------------
function locate() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (p) => { S.myPos = [p.coords.longitude, p.coords.latitude]; resolve(S.myPos); },
      () => resolve(null), { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 });
  });
}

$("#nearby").addEventListener("click", async () => {
  const btn = $("#nearby"); btn.textContent = "📍 Localisation…";
  let pos = await locate();
  if (!pos) { const c = map.getCenter(); pos = [c.lng, c.lat]; toast("Position indisponible : recherche autour du centre de la carte."); }
  btn.textContent = "📍 Gares accessibles autour de moi";
  setPin(pos); flyTo(pos, 14.5);
  const near = nearestStations(pos, 6, 3000);
  $("#nearby-list").innerHTML = near.length ? near.map((x) => stationCard(x.st, x.d)).join("") : `<p class="muted">Aucune station avec ascenseur à moins de 3 km.</p>`;
  bindCards($("#nearby-list"));
});

$("#locate").addEventListener("click", async () => {
  const pos = await locate();
  if (!pos) return toast("Impossible d'obtenir votre position.");
  setPin(pos); flyTo(pos, 15);
});

// ---------------------------------------------------------------------------
// Chips, text size, sheet, voice, deep links
// ---------------------------------------------------------------------------
const layerOn = { lifts: true, works: true, quais: false, bus: false, places: false };
const LAYER_IDS = { lifts: ["stations"], works: ["works-fill", "works-line"], quais: ["quais"], bus: ["bus"], places: ["places"] };
document.querySelectorAll(".chip[data-layer]").forEach((chip) => chip.addEventListener("click", () => {
  const k = chip.dataset.layer; layerOn[k] = !layerOn[k];
  chip.classList.toggle("on", layerOn[k]); chip.setAttribute("aria-pressed", String(layerOn[k]));
  for (const id of LAYER_IDS[k]) map.setLayoutProperty(id, "visibility", layerOn[k] ? "visible" : "none");
  if (k === "bus" && layerOn.bus) {
    if (map.getZoom() < 14.5) { toast("Arrêts de bus affichés en zoomant."); map.easeTo({ zoom: 15 }); } else loadBus();
  }
  if (k === "places") {
    $("#place-filters").hidden = !layerOn.places;
    if (layerOn.places && map.getZoom() < PLACES_MINZOOM) { toast("Lieux affichés en zoomant sur un quartier."); map.easeTo({ zoom: PLACES_MINZOOM + 0.5 }); }
    else loadPlaces();
  }
}));

const placeFilter = { food: false, ok: false, wc: false };
document.querySelectorAll(".chip[data-filter]").forEach((chip) => chip.addEventListener("click", () => {
  const k = chip.dataset.filter; placeFilter[k] = !placeFilter[k];
  chip.classList.toggle("on", placeFilter[k]); chip.setAttribute("aria-pressed", String(placeFilter[k]));
  const f = ["all"];
  if (placeFilter.food) f.push(["==", ["get", "category"], "food"]);
  if (placeFilter.ok) f.push(["==", ["get", "wheelchair"], "true"]);
  if (placeFilter.wc) f.push(["==", ["get", "toilets"], "true"]);
  map.setFilter("places", f.length > 1 ? f : null);
}));

if (store.get("big") === "1") document.documentElement.classList.add("big");
$("#textsize").addEventListener("click", () => {
  const on = document.documentElement.classList.toggle("big");
  store.set("big", on ? "1" : "0");
  $("#textsize").setAttribute("aria-label", on ? "Réduire le texte" : "Agrandir le texte");
});

$("#grip").addEventListener("click", () => {
  const s = $("#sheet");
  if (s.classList.contains("mini")) s.classList.remove("mini");
  else if (s.classList.contains("full")) { s.classList.remove("full"); s.classList.add("mini"); }
  else s.classList.add("full");
});

(() => {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const btn = $("#mic");
  if (!SR) { btn.hidden = true; return; }
  const rec = new SR(); rec.lang = "fr-FR"; rec.interimResults = false;
  rec.onresult = (e) => {
    const text = e.results[0][0].transcript.replace(/^(je veux aller|aller|emmène-moi|je vais) (à|au|aux|a)\s+/i, "");
    $("#search").value = text; $("#search").focus(); mainSearch.run();
  };
  rec.onerror = () => toast("Je n'ai pas entendu, réessayez.");
  rec.onend = () => btn.classList.remove("listening");
  btn.addEventListener("click", () => { btn.classList.add("listening"); try { rec.start(); } catch {} });
})();

function applyHash() {
  const m = location.hash.match(/station=([^&]+)/);
  if (m) openStation(decodeURIComponent(m[1]));
}
window.addEventListener("hashchange", applyHash);
