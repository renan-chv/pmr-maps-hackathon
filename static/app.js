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
const WC_FR = { true: ["ok", "Toilettes adaptées"], false: ["ko", "Toilettes non adaptées"], none: ["unk", "Pas de toilettes"], unknown: ["unk", "Toilettes : non renseigné"] };
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
// One MediaQueryList each, read many times per gesture (matchMedia() parses its query on every call).
const PHONE_MQ = window.matchMedia("(max-width: 1023px) and (not ((orientation: landscape) and (max-height: 540px)))");
const isPhone = () => PHONE_MQ.matches;
const MOTION_MQ = window.matchMedia("(prefers-reduced-motion: reduce)");
// iOS only applies :active (the pressed look of every button) when a touch listener exists: one passive, empty one.
document.addEventListener("touchstart", () => {}, { passive: true });
// Work that can wait (big map layers, prefetches): when the phone is idle, never in the middle of a gesture or a first paint.
// Safari has no requestIdleCallback: a short timeout stands in.
const whenIdle = (fn, timeout = 2000) => (window.requestIdleCallback ? requestIdleCallback(fn, { timeout }) : setTimeout(fn, 300));

// In the native iOS/Android shell the page is served from the app bundle: API calls go to the hosted backend.
const API = window.ROULIB_API || "";
// Every call to the backend: a failed connection (or a gateway that cannot reach the app) tells Net,
// any real answer clears it. Errors carry the HTTP status and the API's machine code ({"code": "no_route"}).
async function api(path, opts) {
  let r;
  try { r = await fetch(path.startsWith("/api/") ? API + path : path, opts); }
  catch (e) { Net.fail(); const err = new Error("network"); err.offline = true; throw err; }
  if (r.status === 502 || r.status === 504) Net.fail(); else Net.ok();
  return r;
}
async function getJSON(url) {
  const r = await api(url);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    const d = body.detail;  // FastAPI: a string, or the object given to HTTPException
    const e = new Error((typeof d === "string" ? d : d?.detail || d?.message) || `Erreur ${r.status}`);
    e.status = r.status; e.code = body.code || d?.code || null;
    throw e;
  }
  return body;
}
const postJSON = (path, data, method = "POST", headers = {}) => api(path, { method, headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(data) });

// Date formats built once: toLocale*String() with options builds a new formatter on every call (a station sheet
// formats two dates per elevator).
const FMT = {
  dayMonth: new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "long" }),
  hm: new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit" }),
  dayTime: new Intl.DateTimeFormat("fr-FR", { weekday: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }),
  date: new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "long", year: "numeric" }),
};
function rel(iso) {
  if (!iso) return "date inconnue";
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  const min = Math.round((Date.now() - d) / 60000);
  if (min < 1) return "à l'instant";
  if (min < 60) return `il y a ${min} min`;
  if (min < 24 * 60) return `il y a ${Math.round(min / 60)} h`;
  return `le ${FMT.dayMonth.format(d)}`;
}
const ageH = (iso) => { const d = new Date(iso); return isNaN(d) ? Infinity : (Date.now() - d) / 3600000; };
const hhmm = (iso) => { const d = new Date(iso); return isNaN(d) ? "?" : FMT.hm.format(d); };
const dayTime = (iso) => { const d = new Date(iso); return isNaN(d) ? iso : FMT.dayTime.format(d); };
// "2026-12-31" (open data) -> "31 décembre 2026"; anything else stays as it is.
const frDate = (s) => { const m = /^(\d{4})-(\d\d)-(\d\d)/.exec(s || ""); return m ? FMT.date.format(new Date(+m[1], m[2] - 1, +m[3])).replace(/^1 /, "1er ") : (s || ""); };

function distM(a, b) {
  const k = Math.PI / 180, x = (b[0] - a[0]) * k * Math.cos((a[1] + b[1]) * k / 2), y = (b[1] - a[1]) * k;
  return 6371000 * Math.hypot(x, y);
}
const fmtDist = (m) => (m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1).replace(".", ",")} km`);
const plural = (n, one, many) => `${n} ${n > 1 ? many : one}`;
// "Rue en escalier" -> "rue en escalier" after a colon; "RER A" and station names keep their capitals.
const lcFirst = (s) => (/^\p{Lu}\p{Ll}/u.test(s || "") ? s[0].toLowerCase() + s.slice(1) : s || "");

function toast(msg, ms = 3800) {
  const t = $("#toast"); t.textContent = "";
  requestAnimationFrame(() => { t.textContent = msg; });
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.textContent = ""), ms);
}
// Network banner, in the sheet under the grip: offline, or the server not answering. Never blocks anything:
// what was loaded stays on screen with its own time. Retries by itself, and as soon as the phone is back online.
const Net = (() => {
  const bar = $("#netbar"), text = $("#netbar-t"), btn = $("#netbar-retry");
  let down = false, timer = null;
  const render = () => {
    const off = navigator.onLine === false;
    bar.hidden = !(off || down);
    text.textContent = off ? "Vous êtes hors connexion. J'affiche ce qui était déjà chargé." : "Le serveur de Roulib ne répond pas. J'affiche ce qui était déjà chargé.";
    btn.hidden = off;
  };
  // In the background (app switched away, screen locked) nothing is retried: it runs again when the app comes back.
  const retry = () => { if (document.hidden) return; loadLifts(); loadAlerts(); loadReports(true); };
  btn.addEventListener("click", () => {
    btn.disabled = true; btn.textContent = "Nouvel essai…";
    retry();
    setTimeout(() => { btn.disabled = false; btn.textContent = "Réessayer"; }, 2500);
  });
  window.addEventListener("offline", render);
  window.addEventListener("online", () => { down = false; clearInterval(timer); render(); toast("De nouveau en ligne."); retry(); Net.onUp?.(); });
  render();
  return {
    onUp: null,  // called when the connection or the server comes back
    isDown: () => down || navigator.onLine === false,
    fail() { if (down) return; down = true; render(); clearInterval(timer); timer = setInterval(retry, 30000); },
    ok() { if (!down) return; down = false; clearInterval(timer); render(); Net.onUp?.(); },
  };
})();

// Safety net: a promise nobody waited for (a plugin, a library) logs one readable warning, never "Uncaught (in promise) Object".
window.addEventListener("unhandledrejection", (e) => {
  const r = e.reason;
  console.warn("Unhandled:", (r && (r.message || r.code || r.status)) || String(r));
  e.preventDefault();
});

// Short message for screen readers (results, errors), without re-reading the whole list.
function announce(msg) {
  const r = $("#sr-status"); if (!r) return;
  r.textContent = ""; requestAnimationFrame(() => { r.textContent = msg; });
}
// Move keyboard / screen reader focus to freshly rendered content.
function focusEl(el) { if (!el) return; el.setAttribute("tabindex", "-1"); el.focus({ preventScroll: true }); }
// Text equivalent of a state mark, for screen readers (the mark itself is an icon).
const SR_STATE = { ok: "OK", warn: "À surveiller", ko: "Bloqué", unk: "Inconnu" };
const srState = (st) => `<span class="sr">${SR_STATE[st] || ""}</span>`;

// ---------------------------------------------------------------------------
// Bottom sheet: three heights on phones, side panel elsewhere (CSS)
// ---------------------------------------------------------------------------
// Height of the notch / status bar (0 in a browser tab): the full sheet and the map padding keep clear of it.
const safeTop = (() => {
  const p = document.createElement("div");
  p.style.cssText = "position:fixed;top:0;left:0;width:0;height:env(safe-area-inset-top,0px);visibility:hidden;pointer-events:none";
  document.body.appendChild(p);
  return () => p.offsetHeight;
})();
const Sheet = (() => {
  const el = $("#sheet"), grip = $("#grip"), body = $("#sheet-body"), root = document.documentElement.style;
  const LABEL = { peek: "réduit", half: "moitié", full: "plein écran" };
  const ORDER = ["peek", "half", "full"];
  let snap = "half", cur = 0, full = 0;
  // Numbers that depend on the viewport, measured on resize, keyboard and text size changes, never during a gesture:
  // reading layout right after writing the panel height forced a full style and layout pass on every finger move.
  let H = null, toolsH = 0, chipsBottom = 0;
  function measure() {
    const vh = window.visualViewport ? window.visualViewport.height : window.innerHeight, safe = safeTop();
    // Larger text steps: the half sheet opens higher, or it would only show a title and the search bar.
    const big = Number(document.documentElement.dataset.text || 0) >= 2;
    H = { peek: Math.min(big ? 260 : 210, Math.round(vh * 0.3)), half: Math.round(vh * (big ? 0.75 : 0.6)), full: vh - Math.max(76, safe + 28), vh, safe };
    toolsH = $("#map-tools").offsetHeight; chipsBottom = $("#chips").getBoundingClientRect().bottom;
  }
  const heights = () => H || (measure(), H);
  // The sheet keeps its full height and slides with transform (GPU), so the map never relayouts mid-animation.
  // At rest, one CSS variable places the sheet and everything that rides on its top edge; the CSS transition animates a change.
  function commit(h) {
    cur = Math.round(h);
    root.setProperty("--sheet-h", `${cur}px`);
    if (heights().full !== full) { full = heights().full; root.setProperty("--sheet-full", `${full}px`); }
  }
  function set(name) {
    snap = name;
    if (grip.getAttribute("aria-valuetext") !== LABEL[name]) grip.setAttribute("aria-valuetext", LABEL[name]);
    const phone = isPhone();
    document.body.classList.toggle("sheet-full", name === "full" && phone);
    commit(phone ? heights()[name] : 0);
    // Large text, sheet at 75 %: locate would sit over the map filters, so it hides until there is room.
    document.body.classList.toggle("tools-off", phone && heights().vh - cur - 12 - toolsH < chipsBottom + 8);
  }

  // During a gesture only the sheet and its followers move, by inline transforms written once per frame.
  // The variable (and the layout that depends on it) changes once, when the finger lifts.
  let g = null;
  const frame = () => {
    g.raf = 0;
    el.style.transform = `translate3d(0, ${heights().full - g.h}px, 0)`;
    for (const x of g.els) x.style.transform = `translate3d(0, ${-g.h}px, 0)`;
  };
  function begin(y) {
    g = { h0: cur, h: cur, y, raf: 0, pts: [], snap0: snap,
      els: [...document.querySelectorAll("#map-tools, #snap, .maplibregl-ctrl-bottom-right, .maplibregl-ctrl-bottom-left")] };
    document.body.classList.add("dragging");
  }
  function move(y, t) {
    const hs = heights();
    g.h = Math.max(hs.peek * 0.7, Math.min(hs.full, g.h0 + (g.y - y)));
    g.pts.push([t, g.h]); if (g.pts.length > 10) g.pts.shift();
    if (!g.raf) g.raf = requestAnimationFrame(frame);
  }
  // Where the sheet settles. A flick (fast release) goes one level its way from where the finger let go; a slower
  // release goes to the level nearest to where its speed would carry the sheet; a short slow pull still changes level.
  function target({ h, h0, pts, snap0 }, tEnd) {
    const hs = heights(), last = pts[pts.length - 1];
    let v = 0;  // px per ms over the last 100 ms, + = growing; none if the finger rested before lifting
    if (last && !(tEnd - last[0] > 80)) {
      const first = pts.find((p) => last[0] - p[0] <= 100) || last;
      if (last[0] > first[0]) v = (last[1] - first[1]) / (last[0] - first[0]);
    }
    if (Math.abs(v) > 0.5 && Math.abs(h - h0) > 12) {
      const ahead = ORDER.filter((k) => (v > 0 ? hs[k] > h + 8 : hs[k] < h - 8));
      return ahead.length ? (v > 0 ? ahead[0] : ahead[ahead.length - 1]) : (v > 0 ? "full" : "peek");
    }
    const x = h + v * 150, near = ORDER.reduce((a, k) => (Math.abs(hs[k] - x) < Math.abs(hs[a] - x) ? k : a));
    if (near === snap0 && Math.abs(h - h0) > 40 && !(Math.abs(v) > 0.2 && Math.sign(v) !== Math.sign(h - h0))) {
      return ORDER[Math.max(0, Math.min(2, ORDER.indexOf(snap0) + Math.sign(h - h0)))];
    }
    return near;
  }
  function end(tap, t = performance.now()) {
    if (!g) return;
    if (g.raf) cancelAnimationFrame(g.raf);
    const d = g; g = null;
    // Inline transforms off and the new level in the same frame: the CSS transition starts from where the finger let go.
    el.style.transform = ""; d.els.forEach((x) => (x.style.transform = ""));
    document.body.classList.remove("dragging");
    set(tap ? ORDER[(ORDER.indexOf(d.snap0) + 1) % 3] : target(d, t));
  }

  // The grip: mouse, pen or finger (a tap goes one level up, from full back to collapsed).
  let pid = null, moved = false;
  grip.addEventListener("pointerdown", (e) => {
    if (!isPhone() || g) return;
    pid = e.pointerId; moved = false; begin(e.clientY);
    grip.setPointerCapture(e.pointerId);
  });
  grip.addEventListener("pointermove", (e) => {
    if (!g || e.pointerId !== pid) return;
    if (Math.abs(g.y - e.clientY) > 4) moved = true;
    move(e.clientY, e.timeStamp || performance.now());
  });
  const up = (e) => { if (pid == null || e.pointerId !== pid) return; pid = null; end(!moved, e.timeStamp || performance.now()); };
  grip.addEventListener("pointerup", up);
  grip.addEventListener("pointercancel", up);
  grip.addEventListener("lostpointercapture", up);
  // Drag from anywhere else on the sheet (its top band, its content): up to expand before scrolling,
  // down from the top of the content to lower it. Sideways swipes (rows of places, filters) are left alone.
  let pull = null;
  el.addEventListener("touchstart", (e) => {
    pull = isPhone() && e.touches.length === 1 && !grip.contains(e.target) && !g
      ? { x: e.touches[0].clientX, y: e.touches[0].clientY, on: false, inBody: body.contains(e.target) } : null;
  }, { passive: true });
  el.addEventListener("touchmove", (e) => {
    if (!pull) return;
    const t = e.touches[0], dy = t.clientY - pull.y;
    if (!pull.on) {
      if (Math.abs(t.clientX - pull.x) > Math.abs(dy) && Math.abs(t.clientX - pull.x) > 8) { pull = null; return; }
      const down = dy > 8 && (!pull.inBody || body.scrollTop <= 0), upw = dy < -8 && snap !== "full";
      if (down || upw) { pull.on = true; begin(t.clientY); }
      else if (Math.abs(dy) > 8) { pull = null; return; }
      else return;
    }
    e.preventDefault();
    move(t.clientY, e.timeStamp || performance.now());
  }, { passive: false });
  // touchcancel (an incoming call, iOS taking the gesture): same as lifting the finger, the sheet settles on a level.
  const release = (e) => { if (pull?.on) end(false, e.timeStamp || performance.now()); pull = null; };
  el.addEventListener("touchend", release);
  el.addEventListener("touchcancel", release);
  grip.addEventListener("keydown", (e) => {
    const i = ORDER.indexOf(snap);
    if (e.key === "ArrowUp") { set(ORDER[Math.min(2, i + 1)]); e.preventDefault(); }
    if (e.key === "ArrowDown") { set(ORDER[Math.max(0, i - 1)]); e.preventDefault(); }
    if (e.key === "Enter" || e.key === " ") { set(ORDER[(i + 1) % 3]); e.preventDefault(); }
  });
  // Resize, rotation, keyboard (visual viewport), fonts, text size: measured again once per frame at most.
  let rz = 0;
  const refresh = () => { if (!rz) rz = requestAnimationFrame(() => { rz = 0; measure(); if (!g) set(snap); }); };
  window.addEventListener("resize", refresh);
  window.visualViewport?.addEventListener("resize", refresh);
  document.fonts?.ready.then(refresh);
  set("half");
  return {
    set, get: () => snap, refresh,
    padding: () => (isPhone() ? { bottom: heights()[snap === "full" ? "half" : snap] + 20, top: 76 + heights().safe, left: 24, right: 24 }
      : { left: el.getBoundingClientRect().right + 20, top: 76 + heights().safe, right: 76, bottom: 40 }),
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

// "Vous pouvez passer en fauteuil." only for wheelchairs: each profile gets its own words.
const THROUGH = { manuel: "en fauteuil", electrique: "en fauteuil", poussette: "avec une poussette", deambulateur: "sans escalier" };
const throughText = () => `Vous pouvez passer ${THROUGH[Profile.key()] || "sans escalier"}.`;
// Lines whose elevators report working and none out of order: ["14", "A", "D"].
const workingLines = (lifts) => liftGroups(lifts).filter((g) => g.code && g.lifts.some((l) => l.status === "available")
  && !g.lifts.some((l) => l.status === "notavailable")).map((g) => g.code);
// Station verdict: what works first, unknowns second ("Ascenseurs en service sur les lignes 14, A, D").
function verdictText(st) {
  const n = st.lifts.length, ko = st.lifts.filter((l) => l.status === "notavailable").length;
  const ok = st.lifts.filter((l) => l.status === "available").length, unk = n - ko - ok;
  const lines = st.status === "warn" ? workingLines(st.lifts) : [];
  const onLines = lines.length ? `${lines.length > 1 ? "sur les lignes" : "sur la ligne"} ${lines.join(", ")}` : "";
  switch (st.status) {
    case "ok": return [n > 1 ? `Les ${n} ascenseurs fonctionnent` : "L'ascenseur fonctionne", throughText()];
    case "ko": return [n > 1 ? `Aucun des ${n} ascenseurs ne marche` : "L'ascenseur est en panne", "Mieux vaut éviter cette station pour l'instant."];
    case "warn": return ko
      ? [`${ko} ascenseur${ko > 1 ? "s" : ""} sur ${n} en panne`, `${onLines ? `En service ${onLines}. ` : ""}Vérifiez que celui dont vous avez besoin marche.`]
      : [onLines ? `Ascenseurs en service ${onLines}` : `${ok} ascenseur${ok > 1 ? "s" : ""} sur ${n} en service`,
        `État inconnu pour ${unk} sur ${n}. Vérifiez que celui dont vous avez besoin marche.`];
    default: return ["On ne sait pas", "IDFM n'a pas d'information récente."];
  }
}
// Shared by the station sheet and the search suggestions, so both give the same counts:
// passenger elevators only (staff and service lifts aside), all of them when none looks like a passenger one.
function stationLiftVerdict(st) {
  const pub = st.lifts.filter((l) => !isServiceLift(l));
  const lifts = pub.length ? pub : st.lifts;
  const status = stationStatus(lifts);
  const [title, sub] = verdictText({ ...st, lifts, status });
  return { lifts, status, title, sub };
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
// A partial answer (meta.incomplete: some tiles were still loading on the server) is never kept: it is asked
// again once, about 4 s later, and `onMore` gets the complete list when it comes.
const placeCache = new Map(), placeRetry = new Map();
async function placesAround(coord, dLon = 0.008, dLat = 0.0055, onMore = null) {
  // Snap to the server's 0.01° tiles: nearby positions share one URL, so the browser and the CDN reuse it.
  // Edges sit 0.0001° inside the tile grid so float rounding never adds a neighbour tile server-side.
  const T = 0.01, f = (v) => (Math.floor(v / T) * T + 0.0001).toFixed(4), c = (v) => (Math.ceil(v / T) * T - 0.0001).toFixed(4);
  const bbox = [f(coord[0] - dLon), f(coord[1] - dLat), c(coord[0] + dLon), c(coord[1] + dLat)].join(",");
  const ask = () => getJSON(`/api/places?bbox=${bbox}`).then((d) => {
    if (d.meta?.incomplete) placeCache.delete(bbox);
    return d;
  }, (e) => { placeCache.delete(bbox); throw e; });
  if (!placeCache.has(bbox)) placeCache.set(bbox, ask());
  const d = await placeCache.get(bbox);
  S.meta.places = d.meta;
  if (d.meta?.incomplete) {
    if (!placeRetry.has(bbox)) {
      placeRetry.set(bbox, new Promise((ok) => setTimeout(ok, 4000)).then(() => {
        const p = ask(); placeCache.set(bbox, p);
        return p.finally(() => placeRetry.delete(bbox));
      }));
    }
    if (onMore) placeRetry.get(bbox).then((full) => { if ((full.features?.length || 0) > d.features.length) { S.meta.places = full.meta; onMore(full.features); } }).catch(() => {});
  }
  return d.features;
}

// ---------------------------------------------------------------------------
// Map
// ---------------------------------------------------------------------------
// No map library (the app opened offline before it was ever cached) or no WebGL: a stand-in that does nothing,
// so search, trips, lists and reports keep working. The map area says so and offers to try again.
function createMap(opts) {
  try { if (window.maplibregl) return new maplibregl.Map(opts); } catch (e) { console.warn("Map unavailable:", e.message || e); }
  document.body.classList.add("no-map");
  $("#map").innerHTML = `<div class="map-off"><p><b>La carte ne peut pas s'afficher pour l'instant.</b> La recherche, les trajets et les listes fonctionnent toujours.</p>` +
    `<button class="btn" type="button" id="map-retry">Réessayer</button></div>`;
  $("#map-retry").addEventListener("click", () => location.reload());
  const fixed = { getZoom: () => 12.4, getCenter: () => ({ lng: 2.3488, lat: 48.8566 }), isStyleLoaded: () => false, getLayer: () => undefined,
    getBounds: () => ({ getWest: () => 2.33, getEast: () => 2.37, getSouth: () => 48.84, getNorth: () => 48.87 }) };
  const noop = new Proxy(function () {}, { get: (_, k) => (k in fixed ? fixed[k] : noop), apply: () => noop });
  return noop;
}
const hasMap = () => !document.body.classList.contains("no-map");
const map = createMap({
  container: "map",  // the style is set below, edited before MapLibre reads it (baseStyle)
  center: [2.3488, 48.8566], zoom: 12.4, attributionControl: { compact: true }, dragRotate: false, pitchWithRotate: false,
  // iPhones render at 3x: capping at 2x divides the GPU work by ~2.25 with no visible loss on a map.
  pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
  fadeDuration: 0, renderWorldCopies: false, maxPitch: 0, antialias: false,
  maxTileCacheSize: 120, refreshExpiredTiles: false,
});
map.touchZoomRotate.disableRotation();
// With no listener, MapLibre does console.error(errorObject): Android's WebView log shows just "Object".
// Here: one readable line (what failed, which URL); offline tile failures are expected and only feed the banner.
map.on("error", (e) => {
  if (navigator.onLine === false) return Net.fail();
  const err = e?.error || {};
  console.warn(`map: ${err.message || err.status || "error"}${err.url ? ` (${String(err.url).split("?")[0]})` : ""}`);
});

const MARK_PATHS = { ok: "m5 12.5 4.5 4.5L19 7.5", ko: "M6 6l12 12M18 6 6 18", warn: "M12 5v9M12 19h.01", unk: "M9 9a3 3 0 1 1 4 2.8c-.7.3-1 .9-1 1.6V14M12 19h.01",
  food: "M7 3v18M4 3v5a3 3 0 0 0 6 0V3M18 21V3c-2.5 1.5-4 4.5-4 8h4" };
// Drawn at 2x, the map's own pixel ratio (pixelRatio above): a 3x image was 2.25 times the pixels for nothing.
// willReadFrequently keeps the canvas in memory, so getImageData() is not a read back from the GPU.
const MARK_R = Math.min(Math.max(2, window.devicePixelRatio || 1), 2);
function markImage(color, glyph, { size = 44, square = false } = {}) {
  const r = MARK_R, px = size * r, c = document.createElement("canvas");
  c.width = c.height = px;
  const g = c.getContext("2d", { willReadFrequently: true }), pad = 2.5 * r;
  g.beginPath();
  if (square) g.roundRect(pad, pad, px - 2 * pad, px - 2 * pad, 11 * r); else g.arc(px / 2, px / 2, px / 2 - pad, 0, Math.PI * 2);
  g.fillStyle = color; g.fill(); g.lineWidth = 3 * r; g.strokeStyle = "#fff"; g.stroke();
  const s = (px * 0.56) / 24; g.translate(px / 2 - 12 * s, px / 2 - 12 * s); g.scale(s, s);
  g.strokeStyle = "#fff"; g.lineWidth = glyph === "food" ? 2.4 : 3.2; g.lineCap = "round"; g.lineJoin = "round"; g.stroke(new Path2D(MARK_PATHS[glyph]));
  return { image: g.getImageData(0, 0, px, px), pixelRatio: r };
}
function hatchImage() {
  const r = MARK_R, px = 12 * r, c = document.createElement("canvas");
  c.width = c.height = px;
  const g = c.getContext("2d", { willReadFrequently: true });
  g.fillStyle = "rgba(194,65,12,.16)"; g.fillRect(0, 0, px, px);
  g.strokeStyle = "rgba(194,65,12,.85)"; g.lineWidth = 2.2 * r;
  for (const o of [-px, 0, px]) { g.beginPath(); g.moveTo(o, px); g.lineTo(o + px, 0); g.stroke(); }
  return { image: g.getImageData(0, 0, px, px), pixelRatio: r };
}
const empty = () => ({ type: "FeatureCollection", features: [] });

// The base map's own shop icons and road shields compete with ours: hide them.
const BASE_CLUTTER = /^(poi_|highway-shield|road_shield)/;
// The base map's look is written into the style itself, before MapLibre reads it. The same edits made after "load"
// (about 150 property changes) made it parse and draw every visible tile a second time while the app opened.
function baseStyle(_prev, next) {
  // Shop icons, road shields and 3D buildings: gone rather than hidden, so no tile ever lays them out.
  next.layers = next.layers.filter((l) => !BASE_CLUTTER.test(l.id) && l.type !== "fill-extrusion");
  for (const l of next.layers) {
    const paint = () => (l.paint ||= {});
    // Street numbers, minor street names and the base map's points of interest: only at street level.
    if (l.type === "symbol" && /housenumber|poi|road_oneway|highway-name-minor|highway_name_other/.test(l.id)) { l.minzoom = 16; l.maxzoom = 24; }
    // Place names in French (the base style prefers English for districts).
    if (l.type === "symbol" && l.layout && l.layout["text-field"]) l.layout["text-field"] = ["coalesce", ["get", "name:fr"], ["get", "name"]];
    // Calm, warm base: white streets on cream, so our markers are what stands out.
    if (l.type === "line" && /^(road|bridge|tunnel)_/.test(l.id) && !/rail|pattern/.test(l.id)) {
      const casing = /casing/.test(l.id);
      paint()["line-color"] = casing ? (/motorway|trunk|primary|secondary|link/.test(l.id) ? "#e2d6c2" : "#e9e1d3") : (/motorway/.test(l.id) ? "#fde9c8" : "#ffffff");
    }
    // Quieter ground so our markers carry the screen: flat pale buildings, softer residential areas.
    if (l.id === "background") paint()["background-color"] = "#f6f0e6";
    else if (l.type === "fill" && /^building/.test(l.id)) Object.assign(paint(), { "fill-color": "#ebe4d8", "fill-opacity": 0.6 });
    else if (l.id === "landuse_residential") paint()["fill-opacity"] = 0.25;
  }
  return next;
}
map.setStyle("https://tiles.openfreemap.org/styles/liberty", { transformStyle: baseStyle });

map.on("load", () => {
  // The credits open folded (an "i" button): unfolded, they ran under the Report and locate buttons.
  const attrib = document.querySelector(".maplibregl-ctrl-attrib");
  attrib?.removeAttribute("open"); attrib?.classList.remove("maplibregl-compact-show");
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
  let moveT = null;
  map.on("moveend", () => { clearTimeout(moveT); moveT = setTimeout(() => { loadBus(); loadPlacesLayer(); loadReports(); }, 250); });
  map.on("dragstart", () => { if (isPhone() && Sheet.get() === "full") Sheet.set("half"); });
  const TAPPABLE = ["stations", "stations-dot", "places", "reports", "works-fill", "quais", "bus"];
  map.on("click", (e) => {
    if (!isPhone() || Sheet.get() === "peek") return;
    if (map.queryRenderedFeatures(e.point, { layers: TAPPABLE.filter((id) => map.getLayer(id)) }).length) return;
    Sheet.set(Sheet.get() === "full" ? "half" : "peek");
  });

  // Elevator data loads with the page, not with the map: it may already be here.
  if (S.stations.size) setSource("stations", stationsGeoJSON(), liftsSig);
  if (reportsData.length) renderReports();
  // The credits button shows once the map has drawn (style.css), then the heavy layers load when the phone is idle:
  // roadworks are 2.3 MB of GeoJSON, and parsing them used to land in the middle of the first frames.
  map.once("idle", () => {
    document.body.classList.add("map-ready");
    whenIdle(() => { loadStatic(); loadReports(); });
    // Platforms: search and station sheets use them. Small enough to prefetch once the screen is calm.
    whenIdle(() => ensureQuais(), 5000);
  });
});

function quickPopup(e, kind) {
  const p = e.features[0].properties;
  new maplibregl.Popup({ maxWidth: "260px" }).setLngLat(e.lngLat)
    .setHTML(`<b>${esc(p.name)}</b><br>${esc(kind)}${p.type ? " · " + esc(TYPE_FR[p.type] || p.type) : ""}<br>` +
      `<b>${esc(ACCESS_FR[p.accessibility] || p.accessibility)}</b><div style="color:#5a524a;font-size:.85em;margin-top:4px">IDFM, référentiel des arrêts</div>`)
    .addTo(map);
}

// setData sends the whole layer to MapLibre's worker, which indexes it again and redraws: skipped when nothing changed
// (every return home used to clear the pin, the trip and the restaurants again, every poll re-sent all the stations).
const sourceSig = new Map();
function setSource(id, data, sig) {
  const src = map.getSource(id);
  if (!src) return false;
  if (sig !== undefined && sourceSig.get(id) === sig) return false;
  sourceSig.set(id, sig);
  src.setData(data);
  return true;
}
function setPin(coord) { setSource("pin", coord ? { type: "Feature", geometry: { type: "Point", coordinates: coord } } : empty(), coord ? coord.join(",") : ""); }
const reduceMotion = () => MOTION_MQ.matches;
const flyTo = (coord, zoom = 15.5) => (reduceMotion() ? map.jumpTo({ center: coord, zoom, padding: Sheet.padding() })
  : map.flyTo({ center: coord, zoom, padding: Sheet.padding(), essential: true }));
function fitTo(coords) {
  if (!hasMap() || !coords.length) return;
  const b = new maplibregl.LngLatBounds(coords[0], coords[0]);
  coords.forEach((c) => b.extend(c));
  // The canvas size from its attributes: clientHeight here, right after a list was drawn, forced a full layout.
  const pad = Sheet.padding(), c = map.getCanvas(), r = map.getPixelRatio?.() || 1, h = c.height / r, w = c.width / r;
  pad.bottom = Math.min(pad.bottom, h - pad.top - 80); pad.right = Math.min(pad.right, w - pad.left - 80);
  map.setPadding({ top: 0, bottom: 0, left: 0, right: 0 });  // flyTo leaves its padding on the camera; fitBounds would add both
  map.fitBounds(b, { padding: pad, maxZoom: 15.5, animate: !reduceMotion() });
}
function showPlacesOnMap(feats) {
  S.places = feats;
  setSource("places", { type: "FeatureCollection", features: feats.map((f) => ({ ...f, properties: { id: f.properties.id, st: PLACE_ST[f.properties.wheelchair] } })) },
    feats.map((f) => f.properties.id).join(","));
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------
// Station statuses as one string: the map layer is only sent again when a status changed (polls every 5 min).
let liftsSig = "";
const lastLoad = { lifts: 0, alerts: 0 };  // when each poll last ran (it pauses while the app is in the background)
async function loadLifts() {
  lastLoad.lifts = Date.now();
  try {
    const d = await getJSON("/api/lifts");
    buildStations(d);
    S.meta.lifts = d.meta;
    liftsSig = [...S.stations.values()].map((st) => st.id + st.status).join();
    setSource("stations", stationsGeoJSON(), liftsSig);
    renderToday();
    renderSources();
  } catch (e) {
    $("#today").innerHTML = `<p class="err">Je n'arrive pas à charger l'état des ascenseurs. Réessayez dans un instant.</p>`;
  }
}

// Heavy layers load on demand, once: platforms when a station opens or the chip is on,
// roadworks when the map reaches street level or a sheet needs them.
const errText = (e) => (e && (e.message || e.status)) || String(e);
const once = (fn) => { let p = null; return () => (p ||= fn().catch((e) => { p = null; console.warn("load:", errText(e)); })); };
const ensureQuais = once(async () => {
  const d = await getJSON("/api/stations");
  // Names normalised once (search looks them up on every keystroke).
  for (const f of d.features) f._k = norm(f.properties.name || "");
  S.quais = d.features; S.meta.quais = d.meta;
  // 3,500 points: sent to the map only when its layer is shown, not on the first search.
  if (layerOn.quais) setSource("quais", d, "all");
  renderSources();
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
  try { map.getSource("bus").setData(await getJSON(`/api/bus-stops?bbox=${bbox}`)); } catch (e) { console.warn("bus:", errText(e)); }
}

async function loadPlacesLayer() {
  if (!layerOn.places || map.getZoom() < 14) return;
  // Cover the visible map (the server accepts at most 4x4 tiles of 0.01°, so cap each half-span at 0.015°).
  const c = map.getCenter(), b = map.getBounds(), my = ++loadPlacesLayer.seq;
  const dLon = Math.min((b.getEast() - b.getWest()) / 2, 0.015), dLat = Math.min((b.getNorth() - b.getSouth()) / 2, 0.015);
  const food = (fs) => fs.filter((f) => f.properties.category === "food");
  const put = (fs) => { if (my === loadPlacesLayer.seq && layerOn.places) showPlacesOnMap(food(fs)); };
  try { put(await placesAround([c.lng, c.lat], dLon, dLat, put)); } catch (e) { console.warn("places:", errText(e)); }
}
loadPlacesLayer.seq = 0;

async function loadAlerts() {
  lastLoad.alerts = Date.now();
  try {
    const d = await getJSON("/api/alerts");
    const ul = $("#alerts");
    // Polled every minute: the list is only rebuilt when it changed (keeps focus, no re-layout of home).
    const put = (html) => { if (loadAlerts.html !== html) { loadAlerts.html = html; ul.innerHTML = html; bindOpen(ul); } };
    if (!d.alerts.length) {
      put(`<li class="empty-li">Rien n'a bougé depuis ${d.poller.last_poll ? hhmm(d.poller.last_poll) : "tout à l'heure"}. Je revérifie toutes les 15 minutes.</li>`);
      return;
    }
    put(d.alerts.slice(0, 6).map((a) => {
      const st = a.to === "available" ? "ok" : a.to === "notavailable" ? "ko" : "unk";
      const what = st === "ok" ? "Ascenseur réparé" : st === "ko" ? "Ascenseur tombé en panne" : "On ne sait plus";
      return `<li><button class="item" data-open="${esc(a.zdcid)}">${mark(st)}<span class="t"><b>${esc(a.station)}</b>` +
        `<small>${what}, ${rel(a.detected_at)}</small></span>${icon("chev-r", "chev")}</button></li>`;
    }).join(""));
  } catch (e) { console.warn("alerts:", errText(e)); }
}

// ---------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------
function renderToday() {
  const m = S.meta.lifts, c = m.counts, total = (c.available || 0) + (c.notavailable || 0) + (c.unknown || 0);
  const latest = [...S.stations.values()].map((s) => s.latest).filter(Boolean).sort().pop();
  const pct = (n) => `${(100 * n / total).toFixed(2)}%`;
  $("#tile-pannes").textContent = c.notavailable ? `${plural(c.notavailable, "ascenseur", "ascenseurs")} en panne` : "Aucune panne signalée en ce moment";
  $("#today").innerHTML =
    `<p class="headline">Aujourd'hui, <em>${c.notavailable}</em> ${c.notavailable > 1 ? "ascenseurs sont" : "ascenseur est"} en panne dans les gares d'Île-de-France.</p>` +
    `<div class="bar" aria-hidden="true"><span style="width:${pct(c.available)};background:${C.ok}"></span>` +
    `<span style="width:${pct(c.notavailable)};background:${C.ko}"></span><span style="width:${pct(c.unknown)};background:${C.unk}"></span></div>` +
    `<ul class="legend"><li><span class="sw ok"></span><b>${c.available}</b> marchent</li><li><span class="sw ko"></span><b>${c.notavailable}</b> en panne</li>` +
    `<li><span class="sw unk"></span><b>${c.unknown}</b> on ne sait pas</li></ul>` +
    `<p class="fresh">${icon("clock")}${m.stale ? "Source IDFM injoignable, dernière version connue. " : ""}Info IDFM ${rel(latest)}, vérifiée à ${hhmm(m.fetched_at)}</p>`;
}

function renderSources() {
  const items = Object.values(S.meta).filter((m) => m && m.source).map((m) =>
    `<li><a href="${esc(m.source.url)}" target="_blank" rel="noopener">${esc(m.source.name)}</a>, ${esc(m.source.license)}.${m.fetched_at ? ` Récupéré à ${hhmm(m.fetched_at)}.` : ""}</li>`);
  $("#sources-list").innerHTML = items.join("") + `<li>Recherche de lieux : Photon (Komoot), données © contributeurs OpenStreetMap (ODbL) ; IGN Géoplateforme en secours.</li><li>Fond de carte © OpenStreetMap, OpenFreeMap.</li>`;
}

// Favourites (Maison, Travail) kept on this phone only.
const FAVS = [{ key: "home", label: "Maison", ic: "home" }, { key: "work", label: "Travail", ic: "work" }];
let pendingFav = null;
const PENCIL = `<svg class="i" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16zM14 6l4 4"/></svg>`;
// Home row, maps-app style: Maison, Travail, then recent places, each one tap from a trip.
function renderFavs() {
  const ul = $("#favs");
  const favs = FAVS.map((f) => {
    const v = store.json(`fav-${f.key}`);
    return `<li class="hp${v ? " set" : ""}"><button class="hp-go" data-fav="${f.key}">${icon(f.ic)}<span class="t"><b>${f.label}</b>` +
      `<small>${v ? esc(v.label) : "Ajouter"}</small></span></button>` +
      (v ? `<button class="hp-edit" data-fav-edit="${f.key}" aria-label="Changer l'adresse ${f.label}">${PENCIL}</button>` : "") + `</li>`;
  });
  const rec = recents().map((r, i) => `<li class="hp"><button class="hp-go" data-recent="${i}">${icon("clock")}<span class="t">` +
    `<b><span class="sr">Récent : </span>${esc(r.label)}</b><small>${esc(recentSub(r))}</small></span></button></li>`);
  const html = [...favs, ...rec].join("");
  if (renderFavs.html === html) return;  // re-rendered on every return home: keep focus when nothing changed
  renderFavs.html = html;
  const hadFocus = ul.contains(document.activeElement);
  ul.innerHTML = html;
  ul.scrollLeft = 0;
  if (hadFocus) ul.querySelector("button")?.focus({ preventScroll: true });
}
// One listener for the row (index.html already holds Maison and Travail, so the row is there on the first paint).
$("#favs").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.favEdit) return askFav(b.dataset.favEdit);
  if (b.dataset.fav) { const v = store.json(`fav-${b.dataset.fav}`); return v ? tripTo({ ...v, kind: "fav" }) : askFav(b.dataset.fav); }
  if (b.dataset.recent != null) { const r = recents()[+b.dataset.recent]; if (r) { addRecent(r); tripTo({ ...r, kind: "recent" }); } }
});
// A trip to `to` from where the user is (never the start of a previous trip), like Google Maps.
function tripTo(to) {
  if (!S.myPos) trip.from = null;
  $("#search").value = "";
  openTrip(myPosItem(), to);
}
function askFav(key) {
  pendingFav = key;
  const s = $("#search");
  s.placeholder = key === "home" ? "Tapez votre adresse (Maison)" : "Tapez l'adresse de votre travail";
  s.value = ""; s.focus();
  toast(key === "home" ? "Tapez votre adresse, puis choisissez-la dans la liste." : "Tapez l'adresse de votre travail, puis choisissez-la dans la liste.");
}
function saveFav(it) {
  store.set(`fav-${pendingFav}`, JSON.stringify({ label: it.label, lon: it.lon, lat: it.lat }));
  const name = pendingFav === "home" ? "Maison" : "Travail";
  toast(`Adresse ${name} enregistrée. Touchez « ${name} » pour y aller.`);
  pendingFav = null;
  $("#search").placeholder = "Où allez-vous ?";
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
  const foodView = (view === "list" && $("#l-title").textContent === FOOD_TITLE) || (view === "detail" && $("#detail")?.dataset.kind === "place");
  const wantPlaces = layerOn.places || foodView;
  if (map.getLayer("places")) map.setLayoutProperty("places", "visibility", wantPlaces ? "visible" : "none");
  Sheet.scrollTop();
  if (snap) Sheet.set(snap);
  // After the caller has injected its content (next frame), focus the view title.
  if (view !== "home") requestAnimationFrame(() => focusEl($(`#v-${view} .title`) || $(`#v-${view} h2, #v-${view} h3`)));
  if (view !== "home" && !history.state?.roulib) history.pushState({ roulib: true }, "", location.href);
}
function goHome() {
  // Focus was in the closing sheet (or nowhere): give it back to what opened it, else to the search bar,
  // quietly (no full sheet, no suggestions until the user types), as Google Maps does.
  const lost = $("#sheet").contains(document.activeElement) || document.activeElement === document.body || !document.activeElement;
  show("home", "half"); setPin(null); setSource("trip", empty(), ""); setSource("trip-ends", empty(), "");
  if (!layerOn.places) showPlacesOnMap([]);
  history.replaceState(null, "", location.pathname);
  const o = show.opener;
  if (!lost) return;
  if (o && o !== document.body && o !== $("#search") && document.contains(o)) o.focus({ preventScroll: true });
  else { const s = $("#search"); s.dataset.quiet = "1"; s.focus({ preventScroll: true }); delete s.dataset.quiet; }
}
window.addEventListener("popstate", () => {
  if ($("#all-routes") && !$("#v-trip").hidden && lastTrip) return renderResults(lastTrip);  // detail -> list
  // A #station= link fires popstate before hashchange: open that station instead of going home (which clears the hash).
  if (/station=/.test(location.hash)) return applyHash();
  if ($("#v-home").hidden) goHome();
});
document.querySelectorAll("[data-back]").forEach((b) => b.addEventListener("click", goHome));
// Escape closes the open sheet like its visible Back button (trip detail: back to the list).
// Capture phase: an open suggestion list or time picker is seen before its own Escape closes it, and keeps priority.
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || e.defaultPrevented || !$("#when-panel").hidden || document.querySelector(".suggest:not([hidden]), dialog[open]")) return;
  const view = document.querySelector(".view:not([hidden])");
  const back = view && [...view.querySelectorAll("#all-routes, [data-back], [data-back-trip]")].find((b) => b.offsetParent);
  if (back) { e.preventDefault(); back.click(); }
}, true);

document.querySelectorAll("[data-go]").forEach((t) => t.addEventListener("click", () => {
  ({ trip: () => openTrip(null, null), food: openFood, near: openNearby, pannes: openPannes })[t.dataset.go]();
}));
// Recent places change in the trip form: refresh the home row each time home comes back.
new MutationObserver(() => { if (!$("#v-home").hidden) renderFavs(); }).observe($("#v-home"), { attributes: true, attributeFilter: ["hidden"] });

async function here() {
  let pos = await locate();
  if (!pos) { const c = map.getCenter(); pos = [c.lng, c.lat]; toast("Je ne trouve pas votre position. Je cherche autour du centre de la carte."); }
  return pos;
}

// Placeholder rows in the shape of the coming list (hidden from screen readers, which hear "Je cherche…").
const skeleton = (n = 4, cls = "", say = "Je cherche…") => `${say ? `<p class="sr">${say}</p>` : ""}<ul class="skel ${cls}" aria-hidden="true">` +
  `<li><span class="sk-dot"></span><span class="sk-t"><span></span><span></span></span></li>`.repeat(n) + `</ul>`;
function listView(title, sub) {
  $("#l-title").textContent = title;
  $("#l-sub").textContent = sub || "";
  $("#l-filters").innerHTML = "";
  $("#l-body").innerHTML = skeleton();
  show("list", "half");
}

async function openNearby() {
  listView("Autour de moi", "Les stations avec ascenseur les plus proches.");
  const pos = await here();
  if (!S.myPos) setPin(pos);
  flyTo(pos, 14.5);
  const near = nearestStations(pos, 8, 3000);
  $("#l-body").innerHTML = near.length ? stationList(near) : `<p class="muted">Aucune station avec ascenseur à moins de 3 km.</p>`;
  bindOpen($("#l-body"));
}

async function openPannes() {
  listView("Ascenseurs en panne", "Les stations où au moins un ascenseur ne marche pas, de la plus proche à la plus loin.");
  const pos = S.myPos || [map.getCenter().lng, map.getCenter().lat];
  const rows = [...S.stations.values()].filter((st) => st.ko > 0).map((st) => ({ st, d: distM(pos, st.coord) })).sort((a, b) => a.d - b.d).slice(0, 30);
  $("#l-body").innerHTML = rows.length ? stationList(rows) : `<p class="muted">Aucune panne signalée en ce moment. Bonne nouvelle !</p>`;
  bindOpen($("#l-body"));
}

// --- Restaurants ----------------------------------------------------------------
const foodFilters = { ok: true, help: true, wc: false };
let foodPos = null, foodAll = [];
const FOOD_TITLE = "Manger près d'ici";

async function openFood({ again = false } = {}) {
  if (!again) {
    openFood.waits = 0;
    listView(FOOD_TITLE, "Restaurants, cafés et bars décrits sur Acceslibre.");
    renderFoodFilters();
    foodPos = await here();
    if (!S.myPos) setPin(foodPos);
    flyTo(foodPos, 15.5);
  }
  // Acceslibre can take a while on a cold area: say so rather than look stuck.
  const here_ = () => !$("#v-list").hidden && $("#l-title").textContent === FOOD_TITLE;
  const slow = setTimeout(() => { if (here_() && !foodAll.length) $("#l-body").innerHTML = `<p class="muted loading">Je cherche encore. Acceslibre peut mettre quelques secondes la première fois</p>` + skeleton(3, "", ""); }, 6000);
  try {
    foodAll = [];
    const pos = foodPos;
    const toFood = (fs) => fs.filter((f) => f.properties.category === "food")
      .map((f) => ({ f, d: distM(pos, f.geometry.coordinates) })).sort((a, b) => a.d - b.d);
    // Part of the area was still loading on the server: the rest comes in a few seconds later, in place.
    const feats = await placesAround(pos, undefined, undefined, (more) => { if (here_() && foodPos === pos) { foodAll = toFood(more); renderFood(); } });
    if (!here_()) return;  // the user moved on: no list, no pins behind their back
    foodAll = toFood(feats);
    openFood.waits = 0;
    renderFood();
  } catch (e) {
    if (!here_()) return;
    // The server is still downloading this area from Acceslibre (503 "upstream" while loading): keep waiting
    // in place a few times, like a maps app does, instead of a dead end the user has to retry by hand.
    if (!e.offline && e.status === 503 && e.code === "upstream" && (openFood.waits = (openFood.waits || 0) + 1) <= 12) {
      $("#l-body").innerHTML = `<p class="muted loading">Je cherche encore. Acceslibre peut mettre quelques secondes la première fois</p>` + skeleton(3, "", "");
      setTimeout(() => { if (here_()) openFood({ again: true }); }, 5000);
      return;
    }
    openFood.waits = 0;
    $("#l-body").innerHTML = `<p class="err">${e.offline ? "Vous êtes hors connexion : je ne peux pas charger les restaurants." : e.code ? esc(e.message) : "Je n'arrive pas à charger les restaurants pour l'instant."}</p>` +
      `<button class="btn block" type="button" id="food-retry">Réessayer</button>`;
    $("#food-retry").addEventListener("click", () => openFood());
  } finally { clearTimeout(slow); }
}
function renderFoodFilters() {
  const F = [["ok", "ok", "Sans marche"], ["help", "hand", "Avec un peu d'aide"], ["wc", "wc", "Toilettes adaptées"]];
  $("#l-filters").innerHTML = F.map(([k, ic, label]) => `<button class="fchip" data-f="${k}" aria-pressed="${foodFilters[k]}">${icon(ic)}${label}</button>`).join("");
}
// One listener each for the filters and the rows (they are drawn again on every filter tap).
$("#l-filters").addEventListener("click", (e) => {
  const b = e.target.closest("[data-f]");
  if (!b) return;
  foodFilters[b.dataset.f] = !foodFilters[b.dataset.f]; b.setAttribute("aria-pressed", String(foodFilters[b.dataset.f]));
  // The pressed state shows at once; the list follows in the next frame.
  requestAnimationFrame(renderFood);
});
let foodShown = [];
$("#l-body").addEventListener("click", (e) => {
  const b = e.target.closest("[data-place]");
  if (b && foodShown[+b.dataset.place]) openAcceslibre(foodShown[+b.dataset.place].f);
});
function renderFood() {
  const keep = foodAll.filter(({ f }) => {
    const p = f.properties;
    const okLevel = (foodFilters.ok && p.wheelchair === "true") || (foodFilters.help && p.wheelchair === "partial") || (!foodFilters.ok && !foodFilters.help);
    return okLevel && (!foodFilters.wc || p.toilets === "true");
  });
  showPlacesOnMap(keep.map((x) => x.f));
  const total = foodAll.length;
  foodShown = keep;
  $("#l-sub").textContent = `${plural(keep.length, "adresse", "adresses")} sur ${total} autour de vous.`;
  $("#l-body").innerHTML = keep.length
    ? `<ul class="list">${keep.slice(0, 40).map(({ f, d }, i) => {
        const p = f.properties, st = PLACE_ST[p.wheelchair];
        return `<li><button class="item" data-place="${i}">${mark(st, "food")}<span class="t"><b>${esc(p.name || "Sans nom")}</b>` +
          `<small>${esc(PLACE_FR[p.wheelchair][0])}${p.toilets === "true" ? " · toilettes adaptées" : ""}</small>` +
          `<small>${esc(p.activity || "")}</small></span><span class="end">${fmtDist(d)}${icon("chev-r", "chev")}</span></button></li>`;
      }).join("")}</ul>`
    : `<p class="muted">Aucune adresse avec ces filtres. Essayez d'en enlever un.</p>`;
}

function acceslibreBlock(p) {
  const st = PLACE_ST[p.wheelchair], [title, sub] = PLACE_FR[p.wheelchair], wc = WC_FR[p.toilets] || WC_FR.unknown;
  const reasonIcon = (r) => /marche|\bsteps?\b(?!-)/i.test(r) ? "steps" : /porte|door/i.test(r) ? "door" : /rampe|aide|ramp|help|assist/i.test(r) ? "hand" : "ok";
  return `<div class="verdict ${st}">${mark(st, "lg")}<span><strong>${esc(title)}</strong>${esc(sub)}</span></div>` +
    `<ul class="facts">` + (p.reasons || []).map((r) => `<li>${icon(reasonIcon(r))}<span>${esc(r)}</span></li>`).join("") +
    `<li>${icon("wc", wc[0])}<span>${esc(wc[1])}</span></li>` +
    (p.parking ? `<li>${icon("parking", "ok")}<span>Place de parking adaptée</span></li>` : "") + `</ul>`;
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
    (near.length ? stationList(near) : `<p class="muted">Aucune station avec ascenseur à moins de 1,5 km.</p>`) +
    nearSlot() +
    `<p class="src">Accessibilité : Acceslibre (beta.gouv.fr), décrite par les lieux et les visiteurs. Licence Ouverte.</p>`;
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
  setPin(null);
  show("detail", "half");
  // After show(): the entry below (home) keeps its clean URL, so Back never reopens this station.
  history.replaceState(history.state, "", `#station=${encodeURIComponent(st.id)}`);
  flyTo(st.coord, 16);
  // Service lifts would drown the answer: the verdict, the summary and the groups only count passenger ones.
  const pub = st.lifts.filter((l) => !isServiceLift(l)), other = st.lifts.filter(isServiceLift);
  const { lifts: base, title, sub } = stationLiftVerdict(st);
  const groups = liftGroups(pub);
  const stale = base.filter((l) => ageH(liftTime(l.source_update)) > STALE_H).length;
  const oldest = base.map((l) => liftTime(l.source_update)).filter(Boolean).sort((a, b) => a - b)[0];
  const who = stale === base.length ? (base.length > 1 ? "tous les ascenseurs" : "cet ascenseur") : `${stale} ascenseur${stale > 1 ? "s" : ""} sur ${base.length}`;
  const summary = groups.length > 1 ? groups.map((g) => `<span class="ls-sum-i">${esc(g.label)} : ${esc(groupState(g.lifts).short)}</span>`)
    .join(`<span aria-hidden="true"> · </span>`) : esc(sub);

  $("#detail").innerHTML =
    `<h2 id="d-title" class="title">${esc(st.name)}</h2><p class="sub">${esc(MODE_FR[st.mode] || st.mode || "Station")}</p>` +
    `<div class="verdict ${stationStatus(base)}">${mark(stationStatus(base), "lg")}<span><strong>${esc(title)}</strong><span class="ls-sum">${summary}</span></span></div>` +
    (stale ? `<p class="note">${icon("clock")}<span><b>À confirmer.</b> Pour ${who}, ${oldest ? `la dernière info IDFM date ${rel(oldest.toISOString()).replace(/^le /, "du ").replace("il y a", "d'il y a")}` : "l'heure de l'état est inconnue"}. Ça a pu changer depuis.</span></p>` : "") +
    `<div class="btn-row"><button class="btn primary" id="go-to">Y aller</button><button class="btn" id="go-from">Partir d'ici</button></div>` +
    `<ul class="facts" id="st-facts" hidden></ul>` +
    (pub.length ? `<h3 class="h2">${groups.length > 1 ? "Ascenseurs par ligne" : "Ascenseurs"} (${pub.length})</h3>` : "") +
    groups.map((g, i) => liftGroupHTML(g, i, groups.length === 1)).join("") +
    (other.length ? `<button class="linkish ls-more" id="ls-more" aria-expanded="false" aria-controls="ls-other">${icon("chev-r")}<span>Voir ${plural(other.length, "autre ascenseur", "autres ascenseurs")}</span></button>` +
      `<div class="card ls-other" id="ls-other" hidden><p class="ls-note">Ascenseurs du personnel, de service ou techniques. Ils ne sont pas sur le parcours des voyageurs.</p><ul class="ls-lifts">${other.map((l) => liftRowHTML(l)).join("")}</ul></div>` : "") +
    nearSlot() +
    `<p class="src">Source : IDFM, état des ascenseurs (Licence Mobilité), zone ${esc(st.id)}. Vérifié à ${hhmm(S.meta.lifts.fetched_at)}.</p>`;
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
// They never have a public status worth acting on, so they go behind "Voir N autres ascenseurs".
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
  if (k.startsWith("M")) return { label: `Ligne ${k.slice(1)}`, chip: `M ${k.slice(1)}`, mode: "Métro", code: k.slice(1) };
  return { label: `Tram ${k}`, chip: k, mode: "Tramway", code: k.slice(1) };
}
// One group per line named in the descriptions (a lift serving two lines shows in both: each line's answer must
// be complete). Lifts naming no line go to "Accès à la station". No line anywhere: a single plain group.
function liftGroups(lifts) {
  const by = new Map(), rest = [];
  for (const l of lifts) {
    const ks = liftLines(l);
    if (!ks.length) rest.push(l);
    ks.forEach((k) => { if (!by.has(k)) by.set(k, []); by.get(k).push(l); });
  }
  const groups = [...by.entries()].sort(([a], [b]) => LINE_ORDER(a) - LINE_ORDER(b) || a.localeCompare(b, "fr", { numeric: true }))
    .map(([k, ls]) => ({ key: k, ...lineInfo(k), lifts: ls }));
  if (rest.length) groups.push(groups.length ? { key: "access", label: "Accès à la station", lifts: rest, note: "Les données ne disent pas quelle ligne ils desservent." }
    : { key: "all", label: lifts.length > 1 ? "Ascenseurs" : "Ascenseur", lifts: rest });
  return groups;
}
// Synthetic state of a group: class, header words, short words for the summary line.
function groupState(lifts) {
  const n = lifts.length, ko = lifts.filter((l) => l.status === "notavailable").length, ok = lifts.filter((l) => l.status === "available").length, unk = n - ko - ok;
  if (ok === n) return { st: "ok", text: n > 1 ? `Les ${n} fonctionnent` : "Fonctionne", short: n > 1 ? "ascenseurs en service" : "ascenseur en service" };
  if (ko === n) return { st: "ko", text: n > 1 ? `Les ${n} en panne` : "En panne", short: n > 1 ? `les ${n} en panne` : "en panne" };
  if (ko) return { st: "warn", text: `${ko} sur ${n} en panne`, short: `${ko} en panne` };
  if (unk === n) return { st: "unk", text: "État inconnu", short: "état inconnu" };
  return { st: "unk", text: `${unk} sur ${n} à l'état inconnu`, short: `${unk} à l'état inconnu` };
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
// Plain-text name of a lift for buttons: "Ascenseur ligne 14, direction Saint-Denis - Pleyel, sortie 1 Cour de Rome".
// Same as liftName, as HTML with the French parts marked (screen readers switch voice).
function liftNameHTML(l, g) {
  const { dir, exit } = liftWay(l);
  const fr = (t) => `<span lang="fr">${esc(t)}</span>`;
  const bits = [dir ? (dir === "all" ? "toutes directions" : `direction ${fr(dir)}`) : "", exit ? `sortie ${fr(exit)}` : ""].filter(Boolean);
  if (!bits.length) bits.push(l.situation ? fr(l.situation.split(/[.,]/)[0].replace(/\s+/g, " ").slice(0, 70)) : "emplacement non précisé");
  return `${g && g.key !== "all" && g.key !== "access" ? `Ascenseur ${esc(lcFirst(g.label))}` : "Ascenseur"}, ${bits.join(", ")}`;
}
function liftName(l, g) {
  const { dir, exit } = liftWay(l);
  const bits = [dir ? (dir === "all" ? "toutes directions" : `direction ${dir}`) : "", exit ? `sortie ${exit}` : ""].filter(Boolean);
  if (!bits.length) bits.push((l.situation || "emplacement non précisé").split(/[.,]/)[0].replace(/\s+/g, " ").slice(0, 70));
  return `${g && g.key !== "all" && g.key !== "access" ? `Ascenseur ${lcFirst(g.label)}` : "Ascenseur"}, ${bits.join(", ")}`;
}
// withState false: the group header already says it (a group with a single elevator).
function liftRowHTML(l, showDir = true, withState = true) {
  const s = liftStatusSt(l), t = liftTime(l.source_update), { dir, exit } = liftWay(l);
  const way = [showDir && dir ? (dir === "all" ? "Toutes directions" : `Direction <span lang="fr">${esc(dir)}</span>`) : "", exit ? `Sortie <span lang="fr">${esc(exit)}</span>` : ""].filter(Boolean).join(" · ");
  const head = withState ? esc(LIFT_FR[l.status] || l.status) : "";
  return `<li class="lift${withState ? "" : " no-state"}">${withState ? mark(s) : ""}<div class="lift-body">${head || way ? `<div class="st">${head}${way ? `<span class="ls-way">${way}</span>` : ""}</div>` : ""}` +
    `<div class="where">${l.situation ? `<span lang="fr">${esc(l.situation)}</span>` : "Emplacement non précisé"}</div>` +
    (l.direction && !dir ? `<small lang="fr">${esc(l.direction)}</small>` : "") +
    (t ? `<small class="${ageH(t) > STALE_H ? "old" : ""}">Info IDFM ${rel(t.toISOString())} (${esc(dayTime(t))})</small>` : `<small class="old">Heure de l'état inconnue</small>`) +
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
      ? `<h5 class="ls-dir">${d ? (d === "all" ? "Toutes directions" : `Direction <span lang="fr">${esc(d)}</span>`) : "Direction non précisée"}</h5><ul class="ls-lifts">${ls.map((l) => liftRowHTML(l, false)).join("")}</ul>` : ""; }).join("")
    : `<ul class="ls-lifts">${lifts.map((l) => liftRowHTML(l, true, lifts.length > 1)).join("")}</ul>`;
  const can = lifts.filter((l) => l.status !== "notavailable");
  const report = !can.length ? "" : can.length === 1
    ? `<button class="linkish ls-report" data-g="${i}" data-lift="${esc(can[0].liftid)}">Signaler une panne<span class="sr">, ${liftNameHTML(can[0], g)}</span></button>`
    : `<button class="linkish ls-report" data-g="${i}" aria-expanded="false" aria-controls="ls-pick-${i}">Signaler une panne${g.key === "all" || g.key === "access" ? "" : `, ${esc(lcFirst(g.label))}`}</button>` +
      `<div class="ls-pick" id="ls-pick-${i}" hidden><p class="ls-note">Quel ascenseur est en panne ?</p>` +
      can.map((l) => `<button class="ls-pick-b" data-lift="${esc(l.liftid)}"><span class="sr">Signaler une panne, </span>${liftNameHTML(l, g).replace(/^[^,]*,\s*(<span lang="fr">)?(.)/, (_, sp, c) => (sp || "") + c.toUpperCase())}</button>`).join("") + `</div>`;
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
    more.querySelector("span").textContent = on ? "Masquer les autres ascenseurs" : `Voir ${plural(st.lifts.filter(isServiceLift).length, "autre ascenseur", "autres ascenseurs")}`;
  });
}

async function fillStationFacts(st) {
  await Promise.all([ensureQuais(), ensureWorks()]);
  const ul = $("#st-facts");
  if (!ul || $("#d-title")?.textContent !== st.name) return;  // the user moved on
  const quais = S.quais.filter((q) => distM(st.coord, q.geometry.coordinates) < 350 && norm(q.properties.name) === st.key);
  const qCount = {};
  quais.forEach((q) => { const k = q.properties.accessibility || "unknown"; qCount[k] = (qCount[k] || 0) + 1; });
  const Q_FR = { true: ["accessible", "accessibles"], partial: ["partiellement accessible", "partiellement accessibles"], false: ["non accessible", "non accessibles"], unknown: ["sans information", "sans information"] };
  const qText = ["true", "partial", "false", "unknown"].filter((k) => qCount[k]).map((k) => `${qCount[k]} ${Q_FR[k][qCount[k] > 1 ? 1 : 0]}`).join(", ");
  const works = worksNear(st.coord, 200);
  ul.innerHTML = (quais.length ? `<li>${icon("train")}<span><b>Quais :</b> ${qText}</span></li>` : "") +
    (works.length ? `<li>${icon("cone", "warn")}<span><b>${plural(works.length, "chantier", "chantiers")}</b> sur le trottoir à moins de 200 m</span></li>` : "");
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
        el.textContent = `Historique : en service ${Math.round(r.availability * 100)} % du temps de 6 h à 21 h sur les ${String(+Number(r.window_days).toFixed(1)).replace(".", ",")} derniers jours, ${r.outages ? plural(r.outages, "panne", "pannes") : "aucune panne"}.`;
        el.classList.toggle("bad", r.availability < UNRELIABLE_BELOW);
      });
    }
  } catch { /* the history is a bonus */ }
}

// ---------------------------------------------------------------------------
// Community reports (workstream B owns the API and the photo screen; A shows them)
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
// The API (POST /api/reports, /api/reports/analyze) belongs to workstream B; without it we say so.
// ---------------------------------------------------------------------------
const R_CATS = [
  { key: "ascenseur_panne", label: "Ascenseur en panne", ic: "lift", gravite: "bloquant", temporaire: true },
  { key: "trottoir_encombre", label: "Obstacle sur le passage", ic: "cone", gravite: "genant", temporaire: true },
  { key: "marche", label: "Marche ou rampe impossible", ic: "steps", gravite: "bloquant", temporaire: false },
  { key: "autre", label: "Autre problème", ic: "unk", gravite: "info", temporaire: true },
];
const rep = { cat: null, place: null, target: null, text: "", photo: null, thumb: null, ai: null };

async function openReportFlow({ cat = null, place = null, target = null }) {
  Object.assign(rep, { cat, target, text: "", photo: null, thumb: null, ai: null });
  if (!place) {
    if (!S.myPos) await locate();
    const pos = S.myPos || [map.getCenter().lng, map.getCenter().lat];
    const near = nearestStations(pos, 1, 250)[0];
    place = near ? { label: near.st.name, sub: S.myPos ? "La station la plus proche de vous" : "Près du centre de la carte", lon: near.st.coord[0], lat: near.st.coord[1] }
      : { label: "Ici", sub: S.myPos ? "Votre position" : "Le centre de la carte", lon: pos[0], lat: pos[1] };
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

// Custom radio groups: one tab stop (the checked option, else the first), arrows move and select like native radios.
const radioTab = (key, picked, i) => ((picked ? key === picked : i === 0) ? "0" : "-1");
function radioKeys(group) {
  group.addEventListener("keydown", (e) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    const all = [...group.querySelectorAll('[role="radio"]')], i = all.indexOf(document.activeElement);
    if (!step || i < 0) return;
    e.preventDefault();
    all[(i + step + all.length) % all.length].click();
  });
}
radioKeys($("#r-cats"));
function renderReportCats() {
  $("#r-cats").innerHTML = R_CATS.map((c, i) => `<button class="r-cat" role="radio" aria-checked="${rep.cat === c.key}" tabindex="${radioTab(c.key, rep.cat, i)}" data-cat="${c.key}">${icon(c.ic)}<span>${c.label}</span></button>`).join("");
  document.querySelectorAll("[data-cat]").forEach((b) => b.addEventListener("click", () => {
    rep.cat = b.dataset.cat;
    // The user's own pick wins over the photo's suggestion (it was ignored when sending); the description stays.
    if (rep.ai) rep.ai = { ...rep.ai, categorie: null, gravite: null, temporaire: null };
    renderReportCats(); $(`[data-cat="${rep.cat}"]`)?.focus();
  }));
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
    (ai ? `<p class="muted">Vérifiez avant d'envoyer : c'est une proposition, pas une certitude.</p>` : "");
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
  // Small copy for the map and the database (the server refuses thumbnails over 300 KB)
  const kt = Math.min(1, 320 / Math.max(bmp.width, bmp.height));
  const tv = document.createElement("canvas"); tv.width = Math.round(bmp.width * kt); tv.height = Math.round(bmp.height * kt);
  tv.getContext("2d").drawImage(bmp, 0, 0, tv.width, tv.height);
  rep.thumb = tv.toDataURL("image/jpeg", 0.7);
  $("#r-thumb").src = rep.photo; $("#r-thumb").hidden = false;
  $("#r-summary").insertAdjacentHTML("afterbegin", `<p class="muted" id="r-analyzing">${icon("spark")}J'analyse la photo…</p>`);
  try {
    const r = await postJSON("/api/reports/analyze", { image_base64: rep.photo.split(",")[1], lat: rep.place.lat, lon: rep.place.lon });
    if (!r.ok) throw new Error(r.status);
    const ai = await r.json().catch(() => null);
    // No analysis (no key, refusal, blurry photo): the route answers an empty card. That is not an answer,
    // and it must not replace what the user picked ("Obstacle sur le passage" became "Autre problème, pour information").
    if (!ai || ai.analyse === "indisponible" || !(ai.confiance > 0)) throw new Error("no analysis");
    rep.ai = ai;
    if (rep.ai?.categorie) rep.cat = R_CATS.some((c) => c.key === rep.ai.categorie) ? rep.ai.categorie : (rep.ai.categorie === "escalier" ? "marche" : rep.cat || "autre");
    renderReportCats();
  } catch {
    $("#r-analyzing")?.remove();
    toast("Photo ajoutée. L'analyse automatique n'est pas disponible pour l'instant.");
  }
});

$("#r-send").addEventListener("click", async () => {
  const c = R_CATS.find((x) => x.key === rep.cat);
  if (!c) return;
  const btn = $("#r-send"); btn.disabled = true; btn.textContent = "Envoi…";
  try {
    const r = await postJSON("/api/reports", {
      categorie: rep.ai?.categorie || c.key, temporaire: rep.ai?.temporaire ?? c.temporaire, gravite: rep.ai?.gravite || c.gravite,
      description: rep.text || rep.ai?.description || `${c.label} à ${rep.place.label}`, confiance: rep.ai?.confiance ?? 1,
      user_id: userId(), lat: rep.place.lat, lon: rep.place.lon, target_type: rep.target?.type || "place", target_id: rep.target?.id || null,
      photo_thumb: rep.thumb || null,
    });
    if (r.status === 429) { toast("Vous avez envoyé beaucoup de signalements d'affilée. Réessayez dans une heure.", 5000); return; }
    if (!r.ok) {
      const b = await r.json().catch(() => ({}));
      throw Object.assign(new Error(typeof b.detail === "string" ? b.detail : r.status), { status: r.status, code: b.code || b.detail?.code });
    }
    toast("Merci ! C'est sur la carte. Les autres utilisateurs pourront confirmer.");
    goHome(); loadReports(true);
  } catch (e) {
    // The report stays filled in: nothing to type again.
    if (e.code === "offensive") { $("#r-text").hidden = false; $("#r-text").focus(); }  // the words to change are there
    toast(e.offline ? "Vous êtes hors connexion : ce signalement n'a pas été envoyé. Renvoyez-le quand vous serez de nouveau en ligne."
      : e.code === "offensive" ? e.message
      : e.status === 503 || e.status === 404 ? "Les signalements ne sont pas encore branchés : celui-ci n'a pas été envoyé. Réessayez plus tard."
      : "Je n'ai pas pu envoyer votre signalement. Réessayez dans un instant.", 6000);
  } finally { btn.disabled = false; btn.textContent = "Envoyer le signalement"; }
});

// Moderation (community content): "Signaler comme inapproprié" on every report shown, and "Masquer les signalements de cette personne".
// The hidden people stay on this phone; their reports are filtered out everywhere (map, report sheet, trip steps).
const idList = (k) => { const v = store.json(k); return new Set(Array.isArray(v) ? v.map(String) : []); };
const blockedAuthors = () => idList("pmr_blocked_authors");
const isBlocked = (author) => author != null && author !== "" && blockedAuthors().has(String(author));
function setBlocked(author, on) {
  const s = blockedAuthors(); on ? s.add(String(author)) : s.delete(String(author));
  store.set("pmr_blocked_authors", JSON.stringify([...s].slice(-500)));
  renderReports(); renderUnhide();
}
const isFlagged = (id) => idList("pmr_flagged_reports").has(String(id));
// The two actions, under a report. Hiding needs the report's author, never shown, and never yourself.
function modHTML(id, author) {
  if (id == null) return "";
  const canHide = author != null && author !== "" && String(author) !== String(userId() ?? "");
  return `<div class="mod" data-report="${esc(id)}" data-author="${esc(author ?? "")}">` +
    (isFlagged(id) ? `<p class="mod-done">${icon("ok")}<span>Vous l'avez signalé comme inapproprié. Merci.</span></p>`
      : `<button class="linkish mod-btn" type="button" data-mod="flag">${icon("flag")}<span>Signaler comme inapproprié</span></button>`) +
    (canHide ? `<button class="linkish mod-btn" type="button" data-mod="hide">${icon("eye-off")}<span>Masquer les signalements de cette personne</span></button>` : "") + `</div>`;
}
async function flagReport(btn) {
  const box = btn.closest(".mod"), id = box.dataset.report, label = btn.querySelector("span");
  btn.disabled = true; btn.setAttribute("aria-busy", "true"); label.textContent = "Envoi…";
  try {
    // The token proves this phone owns user_id: the server then counts one flag per person, not per connection.
    const token = Profile.token();
    const r = await postJSON(`/api/reports/${encodeURIComponent(id)}/flag`, { user_id: userId() }, "POST", token ? { "X-User-Token": token } : {});
    if (!r.ok) throw Object.assign(new Error(r.status), { status: r.status });
    const s = idList("pmr_flagged_reports"); s.add(String(id));
    store.set("pmr_flagged_reports", JSON.stringify([...s].slice(-500)));
    const done = document.createElement("p");
    done.className = "mod-done"; done.setAttribute("role", "status"); done.tabIndex = -1;
    done.innerHTML = `${icon("ok")}<span>Merci. Ce signalement va être examiné.</span>`;
    btn.replaceWith(done); done.focus({ preventScroll: true });
  } catch (e) {
    btn.disabled = false; btn.removeAttribute("aria-busy"); label.textContent = "Signaler comme inapproprié";
    toast(e.offline ? "Vous êtes hors connexion : rien n'a été envoyé. Réessayez une fois de nouveau en ligne."
      : e.status === 429 ? "Vous en avez envoyé beaucoup d'affilée. Réessayez plus tard." : "Je n'ai pas pu l'envoyer. Réessayez dans un instant.", 5000);
  }
}
function hideAuthor(btn) {
  const box = btn.closest(".mod"), author = box.dataset.author;
  setBlocked(author, true);
  // In place of the report (sheet or trip step): what happened, and a way back.
  const note = document.createElement("div");
  note.className = "mod-hidden"; note.setAttribute("role", "status"); note.tabIndex = -1;
  note.innerHTML = `<p>${icon("eye-off")}<span><b>Les signalements de cette personne sont masqués</b> sur ce téléphone. Vous pouvez les réafficher depuis votre profil.</span></p>` +
    `<button class="linkish" type="button">Annuler</button>`;
  note.querySelector("button").addEventListener("click", () => {
    setBlocked(author, false);
    note.innerHTML = `<p>${icon("ok")}<span>Ses signalements s'affichent de nouveau. Rouvrez cette page pour les voir.</span></p>`;
  });
  const host = box.closest(".check") || $("#detail");
  if (host.classList?.contains("check")) {
    // The same person's other reports on this trip go too.
    document.querySelectorAll(".check .mod").forEach((m) => { if (m !== box && m.dataset.author === author) m.closest(".check").outerHTML = hiddenCheckHTML(); });
    host.replaceChildren(note);
  } else { host.innerHTML = ""; host.append(note); setPin(null); }
  note.focus({ preventScroll: true });
}
$("#sheet-body").addEventListener("click", (e) => {
  const b = e.target.closest(".mod-btn");
  if (!b || b.disabled) return;
  b.dataset.mod === "flag" ? flagReport(b) : hideAuthor(b);
});
// A trip step's check that comes from a community report.
const reportCheck = (c) => c.kind === "report" || c.report_id != null;
const checkAuthor = (c) => c.author ?? reportsAll.find((f) => String(f.properties.id) === String(c.report_id))?.properties.author;
const hiddenCheck = (c) => reportCheck(c) && isBlocked(checkAuthor(c));

let reportsData = [], reportsAll = [];
let reportsApi = true, reportsPause = 0;  // 503 (no database): ask again in 5 minutes, not on every map move
function renderReports() {
  reportsData = reportsAll.filter((f) => !isBlocked(f.properties.author));
  const feats = reportsData.map((f, i) => ({ ...f, properties: { i, st: GRAV_ST[f.properties.gravite] || "warn" } }));
  setSource("reports", { type: "FeatureCollection", features: feats }, feats.map((f, i) => `${reportsData[i].properties.id}:${f.properties.st}`).join());
}
// Reports are asked for the view plus half a screen around it: panning within that area (for 2 minutes)
// asks nothing new, instead of one request per map move.
let reportsBox = null, reportsAt = 0, reportsSeq = 0;
async function loadReports(force = false) {
  if (!reportsApi || Date.now() < reportsPause || map.getZoom() < 13) return;
  const b = map.getBounds(), w = b.getWest(), e = b.getEast(), so = b.getSouth(), n = b.getNorth();
  const inside = reportsBox && w >= reportsBox[0] && so >= reportsBox[1] && e <= reportsBox[2] && n <= reportsBox[3];
  if (!force && inside && Date.now() - reportsAt < 2 * 60 * 1000) return;
  const mx = (e - w) / 2, my = (n - so) / 2, box = [w - mx, so - my, e + mx, n + my], seq = ++reportsSeq;
  try {
    const d = await getJSON(`/api/reports?bbox=${box.map((v) => v.toFixed(5)).join(",")}`).catch((e) => {
      if (e.status === 404 || e.status === 405) reportsApi = false;
      if (e.status === 503) reportsPause = Date.now() + 5 * 60 * 1000;
      throw e;
    });
    if (seq !== reportsSeq) return;  // a newer request was sent meanwhile
    reportsAll = d.features || []; reportsBox = box; reportsAt = Date.now();
    renderReports();
  } catch { /* no reports API yet */ }
}

function openReport(f) {
  const p = f.properties, coord = f.geometry.coordinates, st = GRAV_ST[p.gravite] || "warn";
  if (isBlocked(p.author)) return;
  $("#detail").dataset.kind = "report";
  setPin(coord);
  show("detail", "half");
  flyTo(coord, 17);
  $("#detail").innerHTML =
    // The photo has its own cached address (the map list no longer carries the images); older servers inline it.
    (p.photo_url || p.photo_thumb ? `<figure class="photo" id="photo"><img alt="Photo du signalement" decoding="async" src="${esc(p.photo_url ? API + p.photo_url : p.photo_thumb)}"><figcaption>Photo prise par un utilisateur</figcaption></figure>` : "") +
    `<h2 id="d-title" class="title">${esc(REPORT_FR[p.categorie] || "Obstacle signalé")}</h2>` +
    `<p class="sub">Signalé par la communauté ${p.created_at ? rel(p.created_at) : ""}${p.is_demo ? " · signalement de démonstration" : ""}</p>` +
    `<div class="verdict ${st}">${mark(st, "lg")}<span><strong>${p.gravite === "bloquant" ? "Bloquant en fauteuil" : p.gravite === "genant" ? "Gênant" : "Pour information"}</strong>${esc(p.description || "")}</span></div>` +
    `<p class="trip-meta">${confPill(p.confidence || 2)} <span class="muted">${plural(p.confirmations || 1, "personne l'a vu", "personnes l'ont vu")}</span></p>` +
    `<button class="btn primary block" id="still-there">${icon("ok")}<span>C'est toujours là</span></button>` +
    modHTML(p.id, p.author) +
    `<p class="src">Signalement communautaire, non vérifié par une source officielle. Il perd en confiance s'il n'est pas confirmé.</p>`;
  $("#still-there").addEventListener("click", async (e) => {
    const btn = e.currentTarget, label = btn.querySelector("span");
    // Shown as done at once; put back (with a message) if the server did not save it.
    btn.disabled = true; label.textContent = "Confirmé";
    try {
      const r = await postJSON(`/api/reports/${encodeURIComponent(p.id)}/confirm`, { user_id: userId() });
      if (!r.ok) throw new Error(r.status);
      const d = await r.json().catch(() => ({}));
      toast(`Merci ! ${d.confirmations ? plural(d.confirmations, "personne l'a confirmé", "personnes l'ont confirmé") : "Confirmation enregistrée"}.`);
      loadReports(true);
    } catch (err) {
      btn.disabled = false; label.textContent = "C'est toujours là";
      toast(err.offline ? "Vous êtes hors connexion : rien n'a été enregistré. Réessayez une fois de nouveau en ligne." : "Je n'ai pas pu enregistrer. Réessayez dans un instant.");
    }
  });
}

async function openPlace(item) {
  const coord = [item.lon, item.lat];
  $("#detail").dataset.kind = "address";
  setPin(coord);
  show("detail", "half");
  flyTo(coord, 16);
  const near = nearestStations(coord, 3, 1500);
  $("#detail").innerHTML = photoSlot() +
    `<h2 id="d-title" class="title">${esc(item.label)}</h2><p class="sub">${esc(item.sub || "")}</p>` +
    `<div id="place-access" aria-busy="true"><p class="muted">Je regarde si le lieu est accessible…</p></div>` +
    `<div id="place-works"></div>` +
    `<div class="btn-row"><button class="btn primary" id="go-to">Y aller</button><button class="btn" id="go-from">Partir d'ici</button></div>` +
    `<h3 class="h2">Stations avec ascenseur à côté</h3>` +
    (near.length ? stationList(near) : `<p class="muted">Aucune station avec ascenseur à moins de 1,5 km.</p>`) +
    nearSlot() +
    `<p class="src">Lieu : © contributeurs OpenStreetMap (Photon) ou IGN. Ascenseurs : IDFM. Chantiers : Ville de Paris.</p>`;
  bindOpen($("#detail"));
  $("#go-to").addEventListener("click", () => openTrip(null, item));
  $("#go-from").addEventListener("click", () => openTrip(item, null));
  // Roadworks load once (a few seconds on a slow network): the sheet is already open meanwhile.
  ensureWorks().then(() => {
    const box = $("#place-works"), works = worksNear(coord, 150);
    if (!box || $("#d-title")?.textContent !== item.label || !works.length) return;
    box.innerHTML = `<p class="note">${icon("cone")}<span><b>${plural(works.length, "chantier", "chantiers")} sur le trottoir</b> à moins de 150 m. ${esc(works[0].p.summary || "Travaux")}, jusqu'au ${esc(frDate(works[0].p.end))}.</span></p>`;
  });
  // Same place in Acceslibre? Match by name within 120 m.
  try {
    const key = norm(item.label);
    const cands = (await placesAround(coord, 0.003, 0.002))
      .map((f) => ({ f, d: distM(coord, f.geometry.coordinates), k: norm(f.properties.name) }))
      .filter((x) => x.d < 120 && x.k && (x.k.includes(key) || key.includes(x.k))).sort((a, b) => a.d - b.d);
    const box = $("#place-access");
    if (!box) return;
    fillPhoto(coord, cands.length ? cands[0].f.properties.id : null);
    box.removeAttribute("aria-busy");
    box.innerHTML = cands.length
      ? acceslibreBlock(cands[0].f.properties) + `<p class="src"><a href="${esc(cands[0].f.properties.url)}" target="_blank" rel="noopener">Voir la fiche Acceslibre</a></p>`
      : `<div class="verdict unk">${mark("unk", "lg")}<span><strong>Pas encore décrit</strong>Ce lieu n'a pas de fiche d'accessibilité sur Acceslibre.</span></div>`;
  } catch {
    // Unknown is never shown as accessible: say the check could not run.
    const box = $("#place-access");
    if (box) { box.removeAttribute("aria-busy"); box.innerHTML = `<div class="verdict unk">${mark("unk", "lg")}<span><strong>Accessibilité non vérifiée</strong>Je n'ai pas pu joindre Acceslibre. Réessayez dans un instant.</span></div>`; }
  }
}

function openWorks(p, lngLat) {
  setPin([lngLat.lng, lngLat.lat]);
  show("detail", "half");
  $("#detail").innerHTML =
    `<h2 id="d-title" class="title">Travaux sur le trottoir</h2><p class="sub">${esc(p.postcode || "Paris")}</p>` +
    `<div class="verdict warn">${mark("warn", "lg")}<span><strong>${esc(p.summary || "Travaux")}</strong>Du ${esc(frDate(p.start))} au ${esc(frDate(p.end))}.</span></div>` +
    `<ul class="facts"><li>${icon("cone")}<span><b>Où :</b> ${esc((p.where || "").replace(/EMPRISE_([A-Z_]+)/g, (_, k) => ({ TROTTOIR: "trottoir", CHAUSSEE: "chaussée", STATIONNEMENT: "stationnement" }[k] || k.toLowerCase().replace(/_/g, " "))))}</span></li>` +
    `<li>${icon("place")}<span><b>Qui :</b> ${esc(p.owner || "non précisé")}</span></li></ul>` +
    `<p class="muted">Le passage peut être plus étroit ou dévié. Prévoyez de traverser un peu avant.</p>` +
    `<p class="src">Source : Ville de Paris, chantiers à Paris (ODbL), emprise ${esc(p.id)}.</p>`;
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
  // A trip started from a station sheet: drop its #station= hash, or Back would reopen the station.
  if (/station=/.test(location.hash)) history.replaceState(history.state, "", location.pathname + location.search);
  tripHint("");
  show("trip", "full");
  if (!trip.from) locate().then(() => {
    if (!trip.from && S.myPos) { trip.from = myPosItem(); $("#trip-from").value = trip.from.label; if (trip.to) runTrip(); }
    else if (!trip.from && !$("#trip-from").value.trim()) { tripHint("La localisation est désactivée. D'où partez-vous ?"); $("#trip-from").focus(); }
  });
  if (REPLAY || (trip.from && trip.to)) runTrip(); else if (trip.from) $("#trip-to").focus();
  else $("#trip-from").focus();
}

// Line above the fields when the start could not be filled in (location off or refused).
function tripHint(msg) { const h = $("#trip-hint"); h.textContent = msg; h.hidden = !msg; }
$("#trip-from").addEventListener("input", () => tripHint(""));
const REPLAY = new URLSearchParams(location.search).get("replay") === "demo";
const VERDICT = {
  passe: { st: "ok", title: () => "Ce trajet passe", sub: () => `Rien ne bloque${forWho()}.` },
  risque: { st: "warn", title: () => "Possible, avec des risques", sub: () => "Regardez les étapes marquées « À surveiller » avant de partir." },
  bloque: { st: "ko", title: (it) => blockedTitle(it), sub: () => "Ne partez pas sur ce trajet." },
};
// "Bloqué : rue en escalier près de Bastille", "Trop loin à pied", never a bare "Bloqué à Long trajet à pied".
function blockedTitle(it) {
  const why = it.blocked_reason || "";
  if (/^Long trajet/.test(why)) return ["manuel", "electrique"].includes(Profile.key()) ? "Trop loin en fauteuil" : "Trop loin à pied";
  if (!why) return it.blocked_at ? `Bloqué à ${it.blocked_at}` : "Bloqué";
  return `Bloqué : ${lcFirst(why)}${it.blocked_near && !why.includes(it.blocked_near) ? ` près de ${it.blocked_near}` : ""}`;
}
// " en fauteuil manuel", " avec une poussette" (profiles.js), nothing for the able-bodied helper profile.
const forWho = () => { const w = Profile.get()?.who; return w ? ` ${w}` : ""; };
// Confidence levels (roadmap 4.3): colour + icon + words, never colour alone. Shown for community reports only.
const CONF = {
  5: ["ok", "shield", "Info en direct"], 4: ["ok", "people", "Confirmé par des utilisateurs"],
  3: ["unk", "shield", "Pas en direct"], 2: ["warn", "people", "Signalé une fois"], 1: ["unk", "unk", "Inconnu"],
};
// "info": worth knowing, nothing to do (roadworks that leave a way round).
// A broken lift that only slows this profile down (walker, pushchair: stairs are possible) is a warning, not a block.
const checkState = (c) => c.status === "ok" ? "ok" : c.effect === "bloquant" || (c.status === "en_panne" && c.effect !== "genant") ? "ko"
  : c.status === "inconnu" ? "unk" : c.status === "info" ? "info" : "warn";
// In replay mode a level-5 source is official but recorded, not live: say so.
const confPill = (n, recorded) => {
  let [st, ic, label] = CONF[n] || CONF[1];
  if (recorded && n === 5) label = "Info enregistrée";
  return `<span class="pill ${st}">${icon(ic)}${label}</span>`;
};
// Freshness only where it means something: elevator status (live IDFM data) and community reports.
// Checks computed by Roulib (walk length) or from static registers (announcements, crossings) carry no pill.
function freshPill(c, recorded) {
  if (c.kind === "report" || (c.kind === "lift" && /signalement/i.test(c.source || ""))) return confPill(c.confidence);
  if (c.kind !== "lift" || c.status === "inconnu" || !c.fetched_at) return "";
  return `<span class="pill ok">${icon("clock")}${recorded ? "Enregistré" : `Mis à jour ${rel(c.fetched_at)}`}</span>`;
}
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
  return `<span class="wchip" aria-label="${s.duration_min || ""} minutes ${stepTitle(s).toLowerCase()}${st ? `, ${SR_STATE[st].toLowerCase()}` : ""}">${icon(Profile.get()?.ic || "p-manuel")}${s.duration_min ? `${s.duration_min}′` : ""}${flag}</span>`;
}
const chipsRow = (it) => it.steps.filter((s) => s.type !== "walk" || (s.duration_min || 0) >= 1)
  .map(stepChip).join(`<span class="chev-sep" aria-hidden="true">›</span>`);
const RANK = { passe: 0, risque: 1, bloque: 2 };
let lastTrip = null;

async function runTrip(opts = {}) {
  const out = $("#trip-result");
  const demo = opts.demo || REPLAY;
  // Typed but not picked (Google Maps style): take the best match when it is a sure one, never the previous trip's point.
  if (!demo) for (const k of ["from", "to"]) {
    const v = $(`#trip-${k}`).value.trim();
    if (trip[k]?.label === v) continue;
    const best = v.length >= 2 ? await tripAC[k].first() : null;
    if (best === CHOOSE) { trip[k] = null; out.innerHTML = ""; return; }  // the list is open on that field
    trip[k] = best;
    if (trip[k]) $(`#trip-${k}`).value = trip[k].label;
    else if (v) { out.innerHTML = `<p class="err">Aucun lieu trouvé pour « ${esc(v)} ». Essayez une station, une adresse ou un lieu connu.</p>`; return; }
  }
  if (!demo && (!trip.from || !trip.to)) { out.innerHTML = `<p class="err">Indiquez ${trip.from ? "une destination" : "un point de départ"}.</p>`; return; }
  document.activeElement?.blur();
  tripRetry = false;
  out.setAttribute("aria-busy", "true");
  out.innerHTML = `<p class="muted loading">Je vérifie chaque étape${esc(forWho())}…</p>` + skeleton(3, "sk-routes", "");
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
    renderTripError(e, demo);
  } finally { out.removeAttribute("aria-busy"); }
}

// A trip that cannot be checked is never a raw error: what happened in plain words, then what to do next.
let tripRetry = false;  // the last check failed for lack of a connection: run it again once it is back
Net.onUp = () => { if (tripRetry && !$("#v-trip").hidden) runTrip(); };
const inParis = (p) => p?.lon > 2.224 && p.lon < 2.47 && p.lat > 48.815 && p.lat < 48.903;
function tripState({ ic, title, sub, actions = "", extra = "" }) {
  $("#v-trip").classList.remove("has-result");  // the form stays in view: changing a place or the time is the way out
  $("#trip-result").innerHTML = `<div class="verdict unk trip-state"><span class="mark neutral lg" aria-hidden="true">${icon(ic)}</span>` +
    `<span><strong role="heading" aria-level="3">${esc(title)}</strong>${esc(sub)}</span></div>` +
    (actions ? `<div class="state-actions">${actions}</div>` : "") + extra;
  $("#trip-result [data-act=retry]")?.addEventListener("click", () => runTrip());
  $("#trip-result [data-act=time]")?.addEventListener("click", changeTime);
  $("#trip-result [data-act=places]")?.addEventListener("click", () => { $("#trip-to").focus(); $("#trip-to").select(); });
  bindOpen($("#trip-result"));
  bindDemo();
  announce(`${title}. ${sub}`);
  focusEl($("#trip-result .verdict strong"));
}
function renderTripError(e, demo) {
  const act = (k, ic, label, primary) => `<button class="btn block${primary ? " primary" : ""}" type="button" data-act="${k}">${icon(ic)}${label}</button>`;
  const when = tripTime.mode === "now" ? "en ce moment" : "à cette heure-là";
  const nearTo = () => {
    const to = trip.to, near = to?.lon != null ? nearestStations([to.lon, to.lat], 6, 1000).filter((x) => x.st.status === "ok").slice(0, 3) : [];
    return (near.length ? `<h3 class="h2">Stations où tous les ascenseurs marchent, près de ${esc(to.label)}</h3>${stationList(near)}` : "") +
      (inParis(to) ? `<p class="note"><span><b>PAM 75</b>, le transport de porte à porte pour les personnes à mobilité réduite à Paris, peut vous y emmener. Réservez à l'avance.</span></p>` : "");
  };
  if (e.offline) {
    tripRetry = true;
    return navigator.onLine === false
      ? tripState({ ic: "offline", title: "Vous êtes hors connexion", sub: "J'ai besoin d'une connexion pour vérifier ce trajet. Je le vérifierai dès que vous serez de nouveau en ligne.",
        actions: act("retry", "route", "Réessayer", true) })
      : tripState({ ic: "offline", title: "Je n'arrive pas à joindre le serveur de Roulib", sub: "Votre connexion est peut-être faible. Je vérifierai ce trajet dès que le serveur répondra.",
        actions: act("retry", "route", "Réessayer", true) });
  }
  if (e.code === "no_route") {
    return tripState({ ic: "route", title: "Aucun trajet sans marche trouvé", sub: `Les transports en commun n'ont pas de trajet sans escalier entre ces lieux ${when}.`,
      actions: (demo ? "" : act("time", "clock", "Essayer une autre heure", true)) + act("places", "pin", "Changer la destination"), extra: nearTo() });
  }
  if (e.status === 503 && e.code === "upstream") {
    return tripState({ ic: "clock", title: "Le calcul d'itinéraire ne répond pas", sub: "Le service d'itinéraires d'Île-de-France Mobilités n'a pas répondu. Ça arrive de temps en temps : réessayez dans un instant.",
      actions: act("retry", "route", "Réessayer", true) + (demo ? "" : act("time", "clock", "Essayer une autre heure")), extra: nearTo() });
  }
  if (e.code === "outside_area") {
    return tripState({ ic: "pin", title: "Roulib couvre seulement l'Île-de-France", sub: "Choisissez un départ et une arrivée en Île-de-France, ou voyez à quoi ressemble une vérification complète avec le trajet d'exemple enregistré.",
      actions: act("places", "pin", "Modifier les lieux", true) + demoButton() });
  }
  if (e.status === 503) return renderTripFallback();
  if (e.status === 429) {
    return tripState({ ic: "clock", title: "Trop de vérifications d'affilée", sub: "Attendez quelques minutes, puis réessayez.", actions: act("retry", "route", "Réessayer", true) });
  }
  if (!demo && (e.status === 404 || /not reachable|no_(origin|destination)|not found|introuvable|pas desservi/i.test(e.message || ""))) {
    return tripState({ ic: "pin", title: "Je ne trouve pas l'un de ces lieux", sub: "Aucun transport en commun n'y va, ou l'adresse est inconnue. Essayez une station, une adresse ou un lieu connu à proximité.",
      actions: act("places", "pin", "Modifier les lieux", true) });
  }
  tripState({ ic: "unk", title: "Je n'ai pas pu vérifier ce trajet", sub: "Un problème est survenu du côté de Roulib. Réessayez dans un instant.", actions: act("retry", "route", "Réessayer", true) });
}
// "Essayer une autre heure": the form comes back with the time picker open (the results header hides the form).
function changeTime() {
  $("#v-trip").classList.remove("has-result");
  if (isPhone()) Sheet.set("full");
  openWhen();
  // "Another time" means a set time: "Partir à" is picked, the date field is next.
  if (tripTime.mode === "now") { document.querySelector('input[name="when-mode"][value="depart"]').checked = true; syncWhenMode(); }
  $("#when-panel").scrollIntoView({ block: "nearest", behavior: reduceMotion() ? "auto" : "smooth" });
  document.querySelector('input[name="when-mode"]:checked').focus({ preventScroll: true });
}

// Trip time, like Google Maps: "Partir maintenant" by default, or "Partir à" / "Arriver avant" a local Paris time.
const tripTime = { mode: "now", at: "" };
const WHEN_MAX_DAYS = 30;  // same limit as the server: timetables are not published further ahead
// datetime-local wants "YYYY-MM-DDTHH:MM" in local time, not toISOString's UTC.
const localISO = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
// "18:30" today, "ven. 23 oct. à 18:30" another day.
function whenText(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return "";
  const t = FMT.hm.format(d);
  return d.toDateString() === new Date().toDateString() ? t
    : `${d.toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short" })} à ${t}`;
}
const whenPhrase = (mode, at) => (mode === "now" || !at ? "Partir maintenant" : `${mode === "arrive" ? "Arriver avant" : "Partir à"} ${whenText(at)}`);
const whenMode = () => document.querySelector('input[name="when-mode"]:checked')?.value || "now";

function openWhen() {
  document.querySelector(`input[name="when-mode"][value="${tripTime.mode}"]`).checked = true;
  // Next 5-minute slot by default, so "Partir à" is one tap away from a valid time.
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
// The date field only matters for "Partir à" / "Arriver avant".
function syncWhenMode() {
  const now = whenMode() === "now";
  $("#when-at").disabled = now;
  $(".when-at-l").classList.toggle("off", now);
}
function applyWhen() {
  const mode = whenMode(), at = $("#when-at").value;
  if (mode !== "now") {
    const t = new Date(at);
    const err = isNaN(t) ? "Choisissez une date et une heure."
      : t < Date.now() - 10 * 60000 ? "Cette heure est passée. Choisissez une heure plus tard, ou « Partir maintenant »."
      : t > Date.now() + WHEN_MAX_DAYS * 864e5 ? `Choisissez une heure dans les ${WHEN_MAX_DAYS} prochains jours.` : "";
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

const demoButton = () => `<button class="btn block" id="trip-demo">${icon("route")}Voir un trajet d'exemple (enregistré)</button>`;
const bindDemo = () => $("#trip-demo")?.addEventListener("click", () => runTrip({ demo: true }));
// Home entry: the recorded example from anywhere (App Review tests outside Paris), no search or location needed.
function openDemo() {
  $("#v-trip").classList.remove("has-result");
  $("#trip-result").innerHTML = "";
  if (/station=/.test(location.hash)) history.replaceState(history.state, "", location.pathname + location.search);
  tripHint("");
  show("trip", "full");
  runTrip({ demo: true });
}
$("#demo-trip").addEventListener("click", openDemo);

function renderTripFallback() {
  const a = [trip.from.lon, trip.from.lat], b = [trip.to.lon, trip.to.lat];
  const block = (label, coord) => {
    const near = nearestStations(coord, 3, 1500);
    return `<h3 class="h2">${label}</h3>` + (near.length ? stationList(near) : `<p class="muted">Aucune station avec ascenseur à moins de 1,5 km.</p>`);
  };
  $("#trip-result").innerHTML =
    `<div class="verdict unk">${mark("unk", "lg")}<span><strong>Le calcul du trajet n'est pas encore branché</strong>En attendant, voici les stations avec ascenseur au départ et à l'arrivée.</span></div>` +
    demoButton() + block("Au départ", a) + block("À l'arrivée", b);
  bindOpen($("#trip-result"));
  Sheet.set("half");
  fitTo([a, b]);
}

function stepTitle(s) {
  // The coloured chip already says "M 14": the title gives the direction, like Google Maps.
  if (s.type === "transit") return s.direction ? `Direction ${esc(s.direction.replace(/\s*\(.*\)$/, ""))}` : `Jusqu'à ${esc(s.to)}`;
  if (s.type === "transfer") return "Correspondance";
  return { manuel: "En fauteuil", electrique: "En fauteuil", poussette: "Avec la poussette" }[Profile.key()] || "À pied";
}
// A report from a person the user chose to hide: not shown, but the step says one was left out (its verdict counted it).
const hiddenCheckHTML = () => `<li class="check check-hidden"><span class="mark neutral" aria-hidden="true">${icon("eye-off")}</span>` +
  `<div><b>Signalement masqué</b><small>D'une personne que vous avez choisi de masquer. Il peut quand même compter dans le verdict de cette étape.</small></div></li>`;
function checkLine(c, recorded) {
  if (hiddenCheck(c)) return hiddenCheckHTML();
  const st = checkState(c);
  const rel = "";  // reliability is part of c.message ("Historique : en service 92 % du temps…"), said once
  // A lift that is not plainly OK: one tap to that station's elevators (state, history, report).
  const zd = c.kind === "lift" && st !== "ok" && c.zdcid != null && [c.zdcid, String(c.zdcid), Number(c.zdcid)].find((k) => S.stations.has(k));
  const link = zd != null && zd !== undefined && zd !== false ? `<button class="linkish" data-open="${esc(zd)}">Voir les ascenseurs de cette station</button>` : "";
  const lead = st === "info" ? `<span class="mark neutral" aria-hidden="true">${icon(c.kind === "works" ? "cone" : "unk")}</span><span class="sr">Pour information</span>`
    : mark(st) + srState(st);
  return `<li class="check">${lead}<div><b>${esc(c.label || c.kind)}</b><div>${esc(c.message || "")}</div>${rel}${link}` +
    `<div class="meta">${freshPill(c, recorded)}<span class="muted">${esc(c.source || "")}</span></div>` +
    (reportCheck(c) ? modHTML(c.report_id, checkAuthor(c)) : "") + `</div></li>`;
}

// Every option blocked: never a dead end. The option closest to working, another time, nearby stations, PAM 75.
function wayOutHTML(d, skipId = null) {
  const w = d.way_out;
  if (!w) return "";
  const least = w.least_blocked_id !== skipId && d.itineraries.find((x) => x.id === w.least_blocked_id);
  const to = d.to || trip.to;
  const near = to?.lon != null ? nearestStations([to.lon, to.lat], 6, 1000).filter((x) => x.st.status === "ok").slice(0, 3) : [];
  return `<section class="way-out" aria-labelledby="way-h"><h3 class="h2" id="way-h">Ce que vous pouvez faire</h3>` +
    (least ? `<button class="btn block" id="way-least" data-way="${esc(least.id)}">${icon("route")}Voir l'option la moins bloquée (${least.duration_min} min)</button>` : "") +
    (w.try_other_time && d.replay !== "demo" ? `<button class="btn block" id="way-time">${icon("clock")}Essayer une autre heure</button>` : "") +
    (near.length ? `<p class="muted">Stations où tous les ascenseurs marchent, près de votre destination :</p>${stationList(near)}` : "") +
    (w.pam ? `<p class="note"><span><b>PAM 75</b>, le transport de porte à porte pour les personnes à mobilité réduite à Paris, peut vous y emmener. Réservez à l'avance.</span></p>` : "") +
    `</section>`;
}
function bindWayOut(d, stations = true) {
  $("#way-least")?.addEventListener("click", (e) => renderItinerary(d, e.currentTarget.dataset.way));
  $("#way-time")?.addEventListener("click", changeTime);  // the form is hidden under results: openWhen alone showed nothing
  const box = $("#trip-result .way-out");
  if (stations && box) bindOpen(box);
}

// Ranked options, like Citymapper's result list, but ordered by what works for this profile.
function renderResults(d) {
  // Same verdict: rank by time, counting 15 extra minutes per lift that often breaks down.
  const cost = (it) => it.duration_min + 15 * it.steps.flatMap((s) => s.checks || []).filter((c) => c.reliability != null && c.reliability < 0.8).length;
  // All blocked: the option closest to working comes first.
  const least = d.way_out?.least_blocked_id;
  const sorted = [...d.itineraries].sort((x, y) => (RANK[x.verdict] - RANK[y.verdict]) || ((y.id === least) - (x.id === least)) || (cost(x) - cost(y)));
  // Like Google Maps: an option more than twice as long as the fastest one that works (and 30 min more) is noise.
  const fastest = Math.min(...sorted.filter((x) => x.verdict !== "bloque").map((x) => x.duration_min));
  const its = sorted.filter((x, i) => i === 0 || !Number.isFinite(fastest) || x.duration_min <= Math.max(2 * fastest, fastest + 30));
  const rec = d.replay === "demo";
  const prof = Profile.get()?.short || "votre profil";
  $("#v-trip").classList.add("has-result");
  $("#trip-summary").innerHTML = `<span class="t">${esc(trip.from?.label || d.from?.label || "")} → ${esc(trip.to?.label || d.to?.label || "")}</span><span class="linkish">Modifier</span>`;
  if (!its.length) return renderTripError({ code: "no_route" }, rec);
  const best = its[0];
  $("#trip-result").innerHTML =
    `<h3 class="results-head">${best.verdict === "bloque" ? `Aucun trajet ne passe${esc(forWho())} ${d.when ? "à cette heure-là" : "en ce moment"}.` : `${plural(its.filter((x) => x.verdict !== "bloque").length, "trajet possible", "trajets possibles")}${esc(forWho())}`}</h3>` +
    (rec ? `<p class="rec-line">${icon("clock")}Exemple enregistré, pas en direct</p>` : "") +
    // The chosen time, and plainly that lift statuses are today's, not a forecast.
    (d.when ? `<p class="when-line">${icon("clock")}<span><b>${esc(whenPhrase(d.arrive ? "arrive" : "depart", d.when))}</b>${d.time_note ? `<small>${esc(d.time_note)}</small>` : ""}</span></p>` : "") +
    `<ul class="routes">` + its.map((it, i) => {
      const V = VERDICT[it.verdict] || VERDICT.risque;
      const why = it.verdict === "bloque" ? V.title(it)
        : it.verdict === "risque" ? `À surveiller : ${[...new Set(it.steps.flatMap((s) => (s.checks || []).filter((c) => (checkState(c) === "warn" || c.effect === "genant") && !hiddenCheck(c)).map((c) => lcFirst(c.label))))].slice(0, 2).join(", ") || "voir les étapes"}`
        : "Rien ne bloque sur ce trajet";
      return `<li><button class="route ${V.st}" data-it="${esc(it.id)}">` +
        `<span class="route-top">${i === 0 && it.verdict !== "bloque" ? `<span class="tag">Le mieux pour vous</span>` : it.id === least ? `<span class="tag">La moins bloquée</span>` : ""}<span class="chips">${chipsRow(it)}</span>` +
        `<span class="mins"><b>${it.duration_min}</b><small>min</small></span></span>` +
        `<span class="route-why">${mark(V.st)}<span>${esc(why)}${it.departure ? `<small>Départ ${yyyymmddToTime(it.departure)} · arrivée ${yyyymmddToTime(it.arrival)}</small>` : ""}</span></span>` +
        `</button></li>`;
    }).join("") + `</ul>` +
    (best.verdict === "bloque" ? wayOutHTML(d) : "") +
    // The side-by-side comparison is a demo tool: only with the recorded example.
    (rec && d.baseline?.length ? `<button class="btn block" id="compare-btn">${icon("swap")}Comparer avec une appli classique</button>` : "") +
    `<p class="src">Trajets d'Île-de-France Mobilités, vérifiés étape par étape par Roulib pour le profil « ${esc(prof)} ». Ascenseurs vérifiés à ${hhmm(d.lifts_fetched_at)}.</p>` +
    (Profile.key() === "malvoyant" ? `<p class="note"><span>Vérifié pour vous : annonces sonores aux arrêts et à bord (IDFM), assistance du personnel SNCF et bandes d'éveil sur les quais, feux piétons sonores sur les trajets à pied dans Paris. Non vérifié : bandes de guidage dans les gares, et feux hors de Paris.</span></p>` : "");
  document.querySelectorAll("[data-it]").forEach((b) => b.addEventListener("click", () => renderItinerary(d, b.dataset.it)));
  $("#compare-btn")?.addEventListener("click", () => openCompare(d));
  bindWayOut(d);
  whenMap(() => drawItinerary(best));
  Sheet.set("half");
  Sheet.scrollTop();
  focusEl($("#trip-result .results-head"));
  announce(`${$("#trip-result .results-head").textContent}. Le mieux : ${best.duration_min} minutes, ${best.verdict === "bloque" ? blockedTitle(best) : VERDICT[best.verdict].title(best)}.`);
}

function renderItinerary(d, id, fromId = null) {
  const it = d.itineraries.find((x) => x.id === id) || d.itineraries[0];
  if (!it) { $("#trip-result").innerHTML = `<p class="err">Je n'ai pas trouvé de trajet.</p>`; return; }
  const prof = Profile.get()?.short || "votre profil";
  const V = VERDICT[it.verdict] || VERDICT.risque;
  const isPlanB = Boolean(fromId);
  // Plan B for any trip that does not fully work: the server's pick, else the best better-ranked option.
  const planB = (it.plan_b_id && d.itineraries.find((x) => x.id === it.plan_b_id)) || (it.verdict === "passe" ? null
    : [...d.itineraries].filter((x) => RANK[x.verdict] < RANK[it.verdict]).sort((x, y) => (RANK[x.verdict] - RANK[y.verdict]) || (x.duration_min - y.duration_min))[0]);
  const sub = it.verdict === "bloque" ? (planB ? "Ne partez pas sur ce trajet. Un plan B est proposé plus bas." : "Ne partez pas sur ce trajet. Aucun autre trajet ne l'évite en ce moment : voyez plus bas ce que vous pouvez faire.") : V.sub(prof);
  const rec = d.replay === "demo";
  $("#v-trip").classList.add("has-result");
  $("#trip-summary").innerHTML = `<span class="t">${esc(trip.from?.label || d.from?.label || "")} → ${esc(trip.to?.label || d.to?.label || "")}</span><span class="linkish">Modifier</span>`;
  $("#trip-result").innerHTML =
    `<button class="back" id="all-routes">${icon("chev-l")}Tous les trajets</button>` +
    (isPlanB ? `<p class="badge-b">Plan B</p>` : "") +
    `<div class="verdict big ${V.st}">${mark(V.st, "lg")}<span><strong role="heading" aria-level="3">${esc(V.title(it))}</strong>${esc(sub)}</span></div>` +
    `<p class="trip-meta">${it.duration_min} min${it.departure ? ` · départ ${yyyymmddToTime(it.departure)}, arrivée ${yyyymmddToTime(it.arrival)}` : ""}</p>` +
    (rec ? `<p class="rec-line">${icon("clock")}Exemple enregistré, pas en direct</p>` : "") +
    (planB ? `<button class="btn primary block" id="planb">${icon("swap")}Voir le plan B (${planB.duration_min} min)</button>` : "") +
    (isPlanB ? `<button class="btn block" id="plana">Revenir au trajet précédent</button>` : "") +
    `<ol class="timeline">` + it.steps.map((s) => {
      const st = { passe: "ok", risque: "warn", bloque: "ko" }[s.verdict] || "unk";
      const rail = s.type === "transit" ? lineColor(s.mode, s.line) : null;
      const badge = s.type === "transit"
        ? `<span class="lchip" style="background:${rail};color:${inkOn(rail)}">${esc(modeShort(s.mode))}&nbsp;${esc(s.line || "")}</span>`
        : `<span class="wchip">${icon(Profile.get()?.ic || "p-manuel")}</span>`;
      return `<li class="tl ${s.type} ${st}" style="--rail:${rail || "#b9b0a2"}">` +
        `<div class="tl-stop"><span class="tl-dot"></span><b>${esc(s.from)}</b></div>` +
        `<div class="tl-body">${badge}<div><b>${stepTitle(s)}</b><small>${s.duration_min ? `${s.duration_min} min` : ""}${s.type === "transit" ? ` · jusqu'à ${esc(s.to)}` : ""}</small></div><span class="tl-state">${mark(st)}${srState(st)}</span></div>` +
        (s.checks?.length ? `<ul class="checks">${s.checks.map((c) => checkLine(c, rec)).join("")}</ul>` : `<p class="muted small">Rien de particulier signalé.</p>`) + `</li>`;
    }).join("") + `<li class="tl end"><div class="tl-stop"><span class="tl-dot"></span><b>${esc(it.steps[it.steps.length - 1]?.to || "")}</b></div></li></ol>` +
    (it.verdict === "bloque" && !planB ? wayOutHTML(d, it.id) : "") +
    `<p class="src">Vérification Roulib pour le profil « ${esc(prof)} ». Ascenseurs vérifiés à ${hhmm(d.lifts_fetched_at)}.</p>`;
  bindWayOut(d, false);  // its station links are bound with the others below
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
  setSource("trip", { type: "FeatureCollection", features: it.steps.filter((s) => s.geojson).map((s) => ({
    type: "Feature", geometry: s.geojson, properties: { c: color[s.verdict] || C.brand } })) });
  const pts = it.steps.flatMap((s) => (s.geojson?.coordinates || []));
  const pt = (c, end) => ({ type: "Feature", geometry: { type: "Point", coordinates: c }, properties: { end } });
  setSource("trip-ends", { type: "FeatureCollection", features: pts.length ? [pt(pts[0], "a"), pt(pts[pts.length - 1], "b")] : [] });
  if (pts.length) fitTo(pts.filter((_, i) => i % Math.ceil(pts.length / 40) === 0).concat([pts[pts.length - 1]]));
}

// Same Navitia route on both sides: what it says vs what our checks find.
function openCompare(d) {
  const base = d.baseline[0];
  const ours = d.itineraries[0];
  const planB = ours.plan_b_id && d.itineraries.find((x) => x.id === ours.plan_b_id);
  const blockers = ours.steps.flatMap((s) => (s.checks || []).filter((c) => !["ok", "info"].includes(checkState(c)) && !hiddenCheck(c)));
  $("#compare").innerHTML =
    `<div class="cmp">` +
    `<div class="cmp-col"><h3>Appli classique</h3><div class="verdict ok">${mark("ok")}<span><strong>« Accessible »</strong>${base.duration_min} min</span></div>` +
    `<ul class="cmp-list">${base.steps.map((s) => `<li>${s.type === "public_transport" ? `${esc(s.mode)} ${esc(s.line)}` : "À pied"}<small>${esc(s.from)} → ${esc(s.to)}</small></li>`).join("")}</ul></div>` +
    `<div class="cmp-col ours"><h3>Roulib</h3><div class="verdict ${VERDICT[ours.verdict].st}">${mark(VERDICT[ours.verdict].st)}<span><strong>${esc(VERDICT[ours.verdict].title(ours))}</strong>${ours.duration_min} min</span></div>` +
    `<ul class="cmp-list">${blockers.map((c) => `<li class="hit">${mark(checkState(c))}<span>${esc(c.label)}<small>${esc(c.message || "")}</small></span></li>`).join("") || "<li>Rien à signaler</li>"}</ul></div>` +
    `</div>` + (planB ? `<button class="btn primary block" id="cmp-planb">${icon("swap")}Roulib propose un plan B (${planB.duration_min} min)</button>` : "") +
    `<p class="src">À gauche : la réponse de Navitia seule (option fauteuil). À droite : le même trajet vérifié étape par étape avec les données ${d.replay === "demo" ? "enregistrées le 22/10 au matin" : "en direct"}.</p>`;
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
  // Names normalised once (ensureQuais, buildStations): this runs on every keystroke over 3,500 stops.
  const n = norm(q), seen = new Set([...S.stations.values()].map((st) => st.key)), key = (f) => f._k ?? norm(f.properties.name || "");
  return S.quais.filter((f) => key(f).startsWith(n))
    .filter((f) => { const k = key(f); return !seen.has(k) && seen.add(k); }).slice(0, max)
    .map((f) => ({ kind: "place", label: f.properties.name, lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1],
      sub: `${STOP_TYPE[f.properties.type] || "Station"} · ${{ true: "sans marche", partial: "en partie sans marche", false: "avec des marches" }[f.properties.accessibility] || "accès inconnu"}` }));
}
const STOP_TYPE = { metro: "Station de métro", rail: "Gare", tram: "Arrêt de tram", cableway: "Câble" };
// Last places picked in the trip form, newest first (this phone only).
const recents = () => (store.json("recents") || []).slice(0, 5);
function addRecent(it) {
  if (it.lon == null || it.kind === "me") return;
  // A station keeps its id, never its elevator status: that is read again each time it is shown.
  const st = recentStation(it);
  const r = st ? { label: it.label, sub: "", lon: it.lon, lat: it.lat, id: st.id } : { label: it.label, sub: it.sub || "", lon: it.lon, lat: it.lat };
  store.set("recents", JSON.stringify([r, ...recents().filter((x) => x.label !== r.label)].slice(0, 5)));
}
// Station behind a recent or picked item: by id, or by name for recents saved before ids were kept.
function recentStation(r) {
  if (r.id != null && S.stations.has(String(r.id))) return S.stations.get(String(r.id));
  if (r.kind && r.kind !== "recent" && r.kind !== "station") return null;
  const k = norm(r.label);
  return [...S.stations.values()].find((st) => st.key === k && Math.abs(st.coord[0] - r.lon) < 0.01 && Math.abs(st.coord[1] - r.lat) < 0.01) || null;
}
// Subtitle of a recent: a station's elevators as they are now; old saved statuses ("2 ascenseurs sur 5…") are dropped.
function recentSub(r) {
  const st = recentStation(r);
  if (st) return stationSub(st).sub;
  return r.sub && !/elevator|ascenseur|^unknown$|^inconnu$/i.test(r.sub) ? r.sub : "Récent";
}
// "Station de métro · ascenseurs OK": what the result is, and its passenger elevators counted like the station sheet.
const STATION_KIND = { Metro: "Station de métro", RapidTransit: "Gare RER", Tramway: "Arrêt de tram", LocalTrain: "Gare" };
function stationSub(st) {
  const { lifts: base, status } = stationLiftVerdict(st), n = base.length;
  const ko = base.filter((l) => l.status === "notavailable").length, unk = base.filter((l) => l.status === "unknown").length;
  const lifts = { ok: n > 1 ? "ascenseurs OK" : "ascenseur OK", ko: n > 1 ? "aucun ascenseur en service" : "ascenseur en panne",
    warn: ko ? `${ko} ascenseur${ko > 1 ? "s" : ""} sur ${n} en panne` : `${unk} ascenseur${unk > 1 ? "s" : ""} sur ${n} à l'état inconnu`, unk: "état des ascenseurs inconnu" }[status];
  return { status, sub: `${STATION_KIND[st.mode] || "Station"} · ${lifts}` };
}
// Addresses and places (shops, hospitals, restaurants…), ranked around `ref` [lon, lat].
const suggestAPI = (q, ref) => getJSON(`/api/suggest?q=${encodeURIComponent(q)}&lon=${ref[0]}&lat=${ref[1]}`).catch(() => ({ results: [] }));
function localStations(q, max = 4) {
  const words = norm(q).split(" ").filter(Boolean);
  if (!words.length) return [];
  return [...S.stations.values()].filter((st) => words.every((w) => st.key.includes(w)))
    .sort((a, b) => (b.key.startsWith(words[0]) - a.key.startsWith(words[0])) || a.name.length - b.name.length)
    .slice(0, max)
    .map((st) => ({ kind: "station", id: st.id, label: st.name, ...stationSub(st), lon: st.coord[0], lat: st.coord[1] }));
}
// A place named exactly like the query ("Musée d'Orsay", "Tour Eiffel") beats the station named after it.
// Generic results (a station, a street, a neighbourhood) do not: "Bastille" stays the metro station.
const GENERIC_SUB = /^(Station|Gare|Arrêt de tram|Arrêt de bus|Quartier|Secteur|Ville|Village|Rue|Adresse|Lieu|Bâtiment)(?![\p{L}\d])/u;
const exactPlace = (it, q) => it.lon != null && norm(it.label) === norm(q) && !GENERIC_SUB.test(it.sub || "");
// Text too loose to guess from: "10 rue", "ga". The user picks in the list instead.
const vagueQuery = (q) => norm(q).length < 3 || /^\d+( ?(bis|ter))?( (rue|av|avenue|bd|boulevard|place|pl|quai|impasse|allee|chemin|route))?$/.test(norm(q));
const CHOOSE = "choose";

function autocomplete(input, list, onPick, { withMe = false, onFocus, onEnter, stations = true } = {}) {
  let items = [], sel = -1, timer = null, seq = 0, askHint = "", remote = [];
  const render = () => {
    if (!items.length) { list.hidden = true; input.setAttribute("aria-expanded", "false"); input.removeAttribute("aria-activedescendant"); return; }
    list.innerHTML = (askHint ? `<li class="sg-ask" role="presentation">${esc(askHint)}</li>` : "") + items.map((it, i) => {
      const lead = it.kind === "station" ? mark(it.status) : it.kind === "acces" ? mark(it.status, "food")
        : `<span class="mark neutral sq" aria-hidden="true">${icon(it.kind === "me" ? "locate" : it.kind === "place" ? "place" : it.kind === "fav" ? "home" : it.kind === "recent" ? "clock" : "address")}</span>`;
      return `<li role="option" id="${list.id}-${i}" aria-selected="${i === sel}" data-i="${i}">${lead}<span class="t"><b>${esc(it.label)}</b><small>${esc(it.sub || "")}</small></span></li>`;
    }).join("");
    list.hidden = false; input.setAttribute("aria-expanded", "true");
    if (sel >= 0) input.setAttribute("aria-activedescendant", `${list.id}-${sel}`);
  };
  // One listener for the list (it is drawn again on every keystroke and every answer).
  list.addEventListener("click", (e) => { const li = e.target.closest("li[data-i]"); if (li) pick(+li.dataset.i); });
  const pick = (i) => { const it = items[i]; if (!it || it.kind === "none") return; ++seq; items = []; askHint = ""; render(); input.value = it.label; input.blur(); if (withMe) addRecent(it); onPick(it); };
  const favItems = () => [...FAVS.map((f) => { const v = store.json(`fav-${f.key}`); return v && { ...v, kind: "fav", sub: f.label }; }).filter(Boolean),
    ...recents().map((r) => ({ ...r, kind: "recent", sub: recentSub(r) }))];
  // Addresses and places from the last answer stay on screen while the next one loads, when they still match
  // what is typed: the list grows or changes in place instead of shrinking to the stations and growing back.
  const stillMatches = (it, q) => { const k = norm(`${it.label} ${it.sub || ""}`); return norm(q).split(" ").filter(Boolean).every((w) => k.includes(w)); };
  // remoteToo false: what is known on the phone only, at once (stations, Home, Work, recents).
  const run = async (remoteToo = true) => {
    const q = input.value.trim(), my = ++seq;
    const head = [];
    if (withMe && myPosItem() && (!q || norm("ma position").startsWith(norm(q)))) head.push({ ...myPosItem(), sub: "Partir d'où vous êtes" });
    if (withMe && !q) head.push(...favItems());
    if (q.length < 2) { items = head; sel = -1; render(); return; }
    let local = [], ign = null, places = [];
    const kept = remote.filter((it) => stillMatches(it, q));
    const show = () => {
      if (my !== seq) return;
      if (!ign) { items = [...head, ...local, ...kept]; render(); return; }
      const found = ign.results.slice(0, 5), exact = found.filter((it) => exactPlace(it, q)), rest = found.filter((it) => !exact.includes(it));
      remote = [...exact, ...rest, ...places.slice(0, 3)];
      items = [...head, ...exact, ...local, ...rest, ...places.slice(0, 3)]; render();
    };
    const findLocal = () => { local = stations ? [...localStations(q), ...otherStations(q)].slice(0, 4) : []; };
    findLocal(); sel = -1; show();
    // Stops without elevators (Bastille, Opéra) join the list as soon as the platforms list is here.
    if (stations && !S.quais?.length) ensureQuais().then(() => { if (my === seq) { findLocal(); show(); } });
    if (!remoteToo) return;
    const ref = S.myPos || [map.getCenter().lng, map.getCenter().lat];
    // Addresses and places first (fast), restaurants from Acceslibre added when they arrive (can take seconds).
    const accP = q.length >= 3 ? getJSON(`/api/places/search?q=${encodeURIComponent(q)}&lon=${ref[0]}&lat=${ref[1]}`).catch(() => ({ features: [] })) : null;
    const r = await suggestAPI(q, ref);
    if (my !== seq) return;
    const localNames = new Set(local.map((it) => norm(it.label)));
    r.results = r.results.filter((it) => !(/^Station/.test(it.sub || "") && localNames.has(norm(it.label))));
    ign = r; show();
    if (!accP) return;
    const acc = await accP;
    places = acc.features.map((f) => ({ kind: "acces", f, label: f.properties.name, status: PLACE_ST[f.properties.wheelchair],
      sub: `${PLACE_FR[f.properties.wheelchair][0]} · ${f.properties.address || f.properties.activity || ""}`, lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] }));
    show();
    if (my === seq && !local.length && !ign.results.length && !places.length) { items = [{ kind: "none", label: `Aucun lieu trouvé pour « ${q} »`, sub: "Essayez une station, une adresse ou un lieu connu" }]; render(); }
  };
  // A quiet focus (focus given back after closing a view) neither expands the sheet nor opens the list: that waits for typing.
  let quiet = false;
  // Each keystroke: stations at once, addresses and places 150 ms after the last one.
  input.addEventListener("input", () => { if (quiet) { quiet = false; onFocus?.(); } askHint = ""; clearTimeout(timer); run(false); timer = setTimeout(run, 150); });
  input.addEventListener("focus", () => { if (input.dataset.quiet) { delete input.dataset.quiet; quiet = true; return; } quiet = false; onFocus?.(); run(); });
  input.addEventListener("click", () => { if (quiet) { quiet = false; onFocus?.(); run(); } });  // a tap on the quietly focused field
  // Closed a moment after leaving the field (a tap on a suggestion lands first), unless the field got the focus back.
  input.addEventListener("blur", () => setTimeout(() => { if (document.activeElement !== input) { items = []; askHint = ""; render(); } }, 200));
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { sel = Math.min(items.length - 1, sel + 1); render(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { sel = Math.max(0, sel - 1); render(); e.preventDefault(); }
    // Enter on typed text: the highlighted suggestion, else the best match when it is a sure one (onEnter), else the list stays open.
    else if (e.key === "Enter") {
      if (sel >= 0 && items[sel]) pick(sel);
      else if (onEnter && input.value.trim()) { ++seq; onEnter(); }
      else if (items.length) pick(0);
      else { ++seq; onEnter?.(); }
      e.preventDefault();
    }
    // Escape closes the list and keeps the text: a search field would otherwise clear itself and reopen the default list.
    else if (e.key === "Escape" && items.length) { e.preventDefault(); clearTimeout(timer); ++seq; items = []; askHint = ""; render(); }
  });
  // Best match for text validated without picking. Returns the item, null when nothing is found, or CHOOSE
  // when the text is loose ("10 rue") or nothing really matches it: the list is then shown with a question.
  const first = async () => {
    const q = input.value.trim(), nq = norm(q); ++seq; items = []; askHint = ""; render();
    if (withMe && myPosItem() && norm("ma position").startsWith(nq)) return myPosItem();
    const local = stations ? localStations(q) : [];
    // Stations without elevators (Bastille…) are not in S.stations but are valid trip ends.
    await ensureQuais();
    const quai = (S.quais || []).find((f) => (f._k ?? norm(f.properties.name || "")) === nq);
    const ign = await suggestAPI(q, S.myPos || [map.getCenter().lng, map.getCenter().lat]);
    const all = [...local, ...ign.results].filter((x) => x.lon != null);
    const exact = ign.results.find((x) => exactPlace(x, q)) || local.find((x) => norm(x.label) === nq)
      || (quai && { kind: "place", label: quai.properties.name, lon: quai.geometry.coordinates[0], lat: quai.geometry.coordinates[1] })
      || all.find((x) => norm(x.label) === nq);
    if (exact) return exact;
    const starts = all.find((x) => norm(x.label).startsWith(nq));
    if (starts && !vagueQuery(q) && nq.split(" ").length >= 2) return starts;
    if (!all.length) return null;
    ask(q);
    return CHOOSE;
  };
  // Keep the list open under the field with the question, instead of guessing.
  const ask = (q) => {
    askHint = `Quel lieu voulez-vous dire par « ${q} » ? Choisissez dans la liste.`;
    announce(askHint);
    if (document.activeElement === input) run(); else input.focus();
  };
  return { run, first };
}

// Home search = "Où allez-vous ?": a picked place goes straight to a trip from here (the map still opens station and place sheets).
const pickMain = (it) => {
  if (pendingFav) return saveFav(it);
  if (it.lon == null) return;
  addRecent(it);
  $("#search").value = "";
  // Google Maps: a search result opens its card first (a station shows its elevators), "Y aller" plans the trip.
  return it.kind === "station" ? openStation(it.id) : it.kind === "acces" ? openAcceslibre(it.f) : openPlace(it);
};
const mainSearch = autocomplete($("#search"), $("#suggest"), pickMain, {
  onFocus: () => isPhone() && Sheet.set("full"),
  // Enter before the suggestions arrive: take the best match, as the trip form does.
  onEnter: async () => {
    if ($("#search").value.trim().length < 2) return;
    const it = await mainSearch.first();
    if (it === CHOOSE) return;
    if (it) pickMain(it); else toast("Aucun lieu trouvé. Essayez une station, une adresse ou un lieu connu.");
  },
});
// A new start or destination: the old results never stay under the new places.
function tripChanged() {
  $("#trip-result").innerHTML = "";
  if (trip.from && trip.to) runTrip();
}
$("#trip-swap").addEventListener("click", () => {
  [trip.from, trip.to] = [trip.to, trip.from];
  [$("#trip-from").value, $("#trip-to").value] = [$("#trip-to").value, $("#trip-from").value];
  tripChanged();
});
const tripAC = {
  from: autocomplete($("#trip-from"), $("#suggest-from"), (it) => { trip.from = it; tripHint(""); tripChanged(); if (!trip.to) $("#trip-to").focus(); }, { withMe: true,
    // Enter in "Je pars de" with no destination yet: settle the start, then go to "Je vais à" (as picking it does).
    onEnter: async () => {
      if ($("#trip-to").value.trim() || $("#trip-from").value.trim().length < 2) return runTrip();
      const it = await tripAC.from.first();
      if (it === CHOOSE) return;
      if (!it) return runTrip();
      trip.from = it; $("#trip-from").value = it.label; tripHint(""); $("#trip-to").focus();
    } }),
  to: autocomplete($("#trip-to"), $("#suggest-to"), (it) => { trip.to = it; tripChanged(); }, { withMe: true, onEnter: () => runTrip() }),
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
$("#locate").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  if (btn.classList.contains("busy")) return;
  btn.classList.add("busy"); btn.setAttribute("aria-busy", "true");  // a fix can take a few seconds
  const pos = await locate();
  btn.classList.remove("busy"); btn.removeAttribute("aria-busy");
  if (!pos) return toast("Je ne trouve pas votre position. Autorisez la localisation dans les réglages du téléphone.");
  flyTo(pos, 15.5);
});
// + and − exist on large screens only (style.css): phones zoom with the fingers.
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
  if (k === "quais" && layerOn.quais) ensureQuais().then(() => S.quais.length && setSource("quais", { type: "FeatureCollection", features: S.quais }, "all"));
  if (k === "works" && layerOn.works && map.getZoom() >= 14) ensureWorks();
  const minZ = { places: 15, works: 14.5 }[k];
  if (minZ && layerOn[k] && map.getZoom() < minZ) {
    toast(k === "places" ? "Je rapproche la carte pour montrer les restos." : "Je rapproche la carte pour montrer les travaux.");
    map.easeTo({ zoom: minZ + 0.5, padding: Sheet.padding() });
  } else if (k === "places") loadPlacesLayer();
}));

// Text size (low vision): four steps, from 18 to 32 px body text, set by html[data-text] (style.css).
// Radios inside the profile screen ("Affichage") keep the home screen clear and give arrow-key navigation.
// Stored on this phone; the old on/off switch ("big" = "1") becomes "Grand".
const TEXT_STEPS = ["normal", "grand", "plus grand", "très grand"];
const textSeg = $("#textsize");
function setTextSize(n) {
  n = Math.max(0, Math.min(TEXT_STEPS.length - 1, Math.trunc(Number(n)) || 0));
  // Phone or browser text already at 200 % (root 20 px or more): the "Plus grand" layouts at least, the font size the user chose (data-tz).
  const html = document.documentElement, zoomed = parseFloat(getComputedStyle(html).fontSize) >= 20 && n < 2;
  html.dataset.text = String(zoomed ? 2 : n);
  if (zoomed) html.dataset.tz = String(n); else delete html.dataset.tz;
  textSeg.querySelectorAll("input").forEach((r) => { r.checked = r.value === String(n); });
  Sheet.refresh();  // panel heights, filters and map buttons depend on the text size
  return n;
}
setTextSize(store.get("text") ?? (store.get("big") === "1" ? 1 : 0));
textSeg.addEventListener("change", (e) => {
  const n = setTextSize(e.target.value); store.set("text", String(n));
  toast(`Taille du texte : ${TEXT_STEPS[n]}.`);
});

(() => {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const btn = $("#mic");
  if (!SR) { btn.hidden = true; return; }
  const rec = new SR(); rec.lang = "fr-FR"; rec.interimResults = false;
  rec.onresult = (e) => {
    // "Je veux aller à Gare de Lyon", "Emmène-moi au Louvre" -> "Gare de Lyon", "Louvre"
    const text = e.results[0][0].transcript.replace(/^(?:je (?:veux|voudrais) aller|aller|emm[eè]ne[sz]?-moi|je vais|on va)\s+(?:à la |à l'|au |aux |à |a |en )?/i, "");
    $("#search").value = text; $("#search").focus(); mainSearch.run();
  };
  rec.onerror = () => toast("Je n'ai pas bien entendu. Réessayez en parlant près du téléphone.");
  rec.onend = () => { btn.classList.remove("listening"); btn.setAttribute("aria-label", "Dire où vous allez"); };
  btn.addEventListener("click", () => { btn.classList.add("listening"); btn.setAttribute("aria-label", "Je vous écoute"); toast("Je vous écoute. Dites par exemple : Gare de Lyon."); try { rec.start(); } catch {} });
})();

function applyHash() {
  const m = location.hash.match(/station=([^&]+)/);
  if (!m) return;
  // Shared link: the page below the sheet is home, without the hash (Back closes the station).
  if (!history.state?.roulib) history.replaceState(null, "", location.pathname + location.search);
  openStation(decodeURIComponent(m[1]));
}
window.addEventListener("hashchange", applyHash);

// Offline support: instant reloads, last known data in tunnels. Never presented as live.
if ("serviceWorker" in navigator && !window.ROULIB_NATIVE) window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
// Offline / back online: the Net banner says it and retries (top of this file).
renderFavs();
// Elevator status and the "Ça vient de changer" feed load at once, map or no map.
loadLifts().then(applyHash);
loadAlerts();
// Polls (elevators every 5 min, the feed every minute) stop while the app is in the background (switched away,
// screen locked) and catch up as soon as it is back on screen.
const POLL = [["lifts", loadLifts, 5 * 60 * 1000], ["alerts", loadAlerts, 60 * 1000]];
let pollT = null;
const poll = () => POLL.forEach(([k, fn, ms]) => { if (Date.now() - lastLoad[k] >= ms - 2000) fn(); });
const startPolls = () => { pollT ||= setInterval(poll, 20 * 1000); };
document.addEventListener("visibilitychange", () => {
  if (document.hidden) { clearInterval(pollT); pollT = null; } else { poll(); startPolls(); }
});
if (!document.hidden) startPolls();

// ---------------------------------------------------------------------------
// First launch: choose a mobility profile (roadmap screen 1)
// ---------------------------------------------------------------------------
let chosen = Profile.get()?.key || null;
radioKeys($("#ptiles"));
function renderOnboard() {
  $("#ptiles").innerHTML = profileTilesHTML(chosen);  // profiles.js: same tiles as the first paint (index.html)
  document.querySelectorAll("[data-p]").forEach((b) => b.addEventListener("click", () => { chosen = b.dataset.p; renderOnboard(); $("#v-onboard").classList.add("picked"); $("#o-go").disabled = false; $(`[data-p="${chosen}"]`)?.focus(); }));
  $("#o-go").disabled = !chosen;
  $(".brand-line").textContent = Profile.get() ? "Profil" : "Roulib";
  $("#o-go").textContent = Profile.get() ? "Enregistrer" : "C'est parti";
  $("#o-name").value = Profile.name();
  // Deleting only means something once there is a profile or an account.
  $("#delete-row").hidden = !(Profile.get() || userId());
  renderUnhide();
}

// ---------------------------------------------------------------------------
// Help, privacy and "Supprimer mes données" (profile screen)
// ---------------------------------------------------------------------------
// In the app the bundle has no web address of its own: the policy opens from the hosted site in the in-app browser.
if (API) { $("#privacy-link").href = `${API}/static/privacy.html`; $("#help-link").href = `${API}/static/support.html`; }
function renderUnhide() {
  const n = blockedAuthors().size;
  $("#unhide-row").hidden = !n;
  $("#unhide-sub").textContent = n ? `Signalements de ${plural(n, "personne", "personnes")} que vous avez choisi de masquer` : "";
}
$("#unhide").addEventListener("click", () => {
  store.set("pmr_blocked_authors", "[]"); renderReports(); renderUnhide();
  toast("Les signalements masqués s'affichent de nouveau."); $("#delete-data").focus();
});

// Everything Roulib keeps on this phone. Profile.clear() takes the pmr_* keys (account, name, hidden people, flags).
const LOCAL_KEYS = /^(fav-|recents$|text$|big$)/;
function clearThisPhone() {
  Profile.clear();
  try { Object.keys(localStorage).filter((k) => LOCAL_KEYS.test(k)).forEach((k) => localStorage.removeItem(k)); } catch {}
}
const dlg = $("#confirm");
let dlgOpener = null;
function openDelete() {
  const id = userId();
  dlgOpener = $("#delete-data");  // iOS Safari does not focus a tapped button: name the way back explicitly
  $("#cf-title").textContent = id ? "Supprimer vos données ?" : "Effacer vos données ?";
  $("#cf-body").innerHTML = (id
    ? `<p>Cela supprime votre compte Roulib de notre serveur et efface ce que l'app garde sur ce téléphone : votre profil, votre prénom, Maison, Travail, les lieux récents et les réglages d'affichage.</p>`
    : `<p>Vous n'avez pas de compte Roulib : tout est sur ce téléphone. Cela efface votre profil, votre prénom, Maison, Travail, les lieux récents et les réglages d'affichage.</p>`) +
    `<p class="muted">C'est définitif. Vous choisirez de nouveau votre profil, comme au premier jour.</p>`;
  $("#cf-ok").textContent = id ? "Supprimer mes données" : "Effacer mes données";
  $("#cf-ok").disabled = false; $("#cf-local").hidden = true; $("#cf-err").textContent = "";
  dlg.removeAttribute("aria-busy");
  if (typeof dlg.showModal === "function") dlg.showModal(); else dlg.setAttribute("open", "");
  $("#cf-cancel").focus();
}
function closeDelete() {
  if (dlg.open) dlg.close();
  dlgOpener?.focus?.({ preventScroll: true });
}
function failDelete(msg, offerLocal) {
  dlg.removeAttribute("aria-busy");
  $("#cf-err").textContent = msg;
  $("#cf-ok").disabled = false; $("#cf-ok").textContent = "Réessayer";
  $("#cf-local").hidden = !offerLocal;
}
async function confirmDelete() {
  const id = userId(), ok = $("#cf-ok");
  $("#cf-err").textContent = "";
  if (id) {
    ok.disabled = true; ok.textContent = "Suppression…"; dlg.setAttribute("aria-busy", "true");
    let r;
    try {
      const token = Profile.token();
      r = await api(`/api/users/${encodeURIComponent(id)}`, { method: "DELETE", headers: token ? { "X-User-Token": token } : {} });
    } catch { return failDelete("Je n'arrive pas à joindre le serveur de Roulib : votre compte n'a pas été supprimé. Vérifiez votre connexion et réessayez."); }
    const body = await r.json().catch(() => ({}));
    // 404 with the API's own message: the account is already gone. FastAPI's bare "Not Found": the route itself is missing.
    const gone = r.ok || (r.status === 404 && body.detail && body.detail !== "Not Found");
    if (!gone) {
      if (r.status === 401 || r.status === 403) return failDelete("Le serveur de Roulib n'a pas pu confirmer que ce compte est le vôtre : il n'a pas été supprimé. Écrivez-nous depuis « Aide et contact », ou effacez seulement ce téléphone.", true);
      if (r.status === 429) return failDelete("Trop d'essais d'affilée. Attendez quelques minutes, puis réessayez.");
      return failDelete("La suppression des comptes n'est pas disponible pour l'instant : votre compte n'a pas été supprimé. Réessayez plus tard, ou effacez seulement ce téléphone.", true);
    }
  }
  finishDelete(id ? "Votre compte et les données de ce téléphone sont supprimés." : "Les données de ce téléphone sont effacées.");
}
function finishDelete(msg) {
  clearThisPhone();
  chosen = null; lastTrip = null; onboardFrom = null; trip.from = null; trip.to = null; pendingFav = null;
  Object.assign(tripTime, { mode: "now", at: "" }); $("#when-label").textContent = whenPhrase("now");
  for (const s of ["#trip-from", "#trip-to", "#search", "#o-name"]) $(s).value = "";
  $("#trip-result").innerHTML = ""; $("#v-trip").classList.remove("has-result");
  setTextSize(0);
  if (dlg.open) dlg.close();
  renderFavs(); renderMe(); renderReports();
  $("#v-onboard").classList.remove("picked");
  renderOnboard();
  show("onboard", "full");
  toast(msg, 5000);
}
$("#delete-data").addEventListener("click", openDelete);
$("#cf-ok").addEventListener("click", confirmDelete);
$("#cf-cancel").addEventListener("click", closeDelete);
$("#cf-local").addEventListener("click", () => finishDelete("Les données de ce téléphone sont effacées. Votre compte est toujours sur le serveur de Roulib."));
dlg.addEventListener("cancel", (e) => { if (dlg.getAttribute("aria-busy")) e.preventDefault(); else setTimeout(closeDelete); });
// A tap on the dimmed backdrop (outside the panel) cancels, like an iOS sheet.
dlg.addEventListener("click", (e) => { if (e.target === dlg && !dlg.getAttribute("aria-busy")) closeDelete(); });
$("#o-go").addEventListener("click", () => {
  if (!chosen) return;
  const first = !Profile.get();
  Profile.save(chosen, $("#o-name").value);
  renderMe();
  if (lastTrip && onboardFrom === "trip") { show("trip", "half"); runTrip(); }
  else { show("home", "half"); focusEl($("#h-home")); }
  // First launch: centre on the user, like any maps app (the browser asks for permission once).
  if (first) locate().then((pos) => pos && flyTo(pos, 15));
  toast(chosen === "valide" ? "Merci de rejoindre la communauté ! Touchez « Signaler » dès que vous voyez un ascenseur en panne ou un trottoir bloqué." : `C'est noté : je vérifierai vos trajets${forWho()}.`, 5000);
});
function renderMe() {
  const p = Profile.get();
  $("#me-ic").innerHTML = icon(p ? p.ic : "p-manuel");
  $("#me-name").textContent = p ? p.short : "à choisir";
  // Short greeting: the search bar itself asks "Où allez-vous ?".
  const h = new Date().getHours(), hi = h >= 18 || h < 4 ? "Bonsoir" : "Bonjour";
  $("#h-home").textContent = Profile.name() ? `${hi} ${Profile.name()}` : hi;
  $("#me-chip").setAttribute("aria-label", `Profil : ${p ? p.short : "à choisir"}. Changer de profil`);
}
let onboardFrom = null;
$("#me-chip").addEventListener("click", () => { onboardFrom = [...document.querySelectorAll(".view")].find((v) => !v.hidden)?.id.slice(2); $("#v-onboard").classList.remove("picked"); renderOnboard(); show("onboard", "full"); });
renderMe();
if (!Profile.get() && !REPLAY) { renderOnboard(); show("onboard", "full"); }
// The first paint showed the profile screen by CSS (html[data-first]); from now on the views' hidden attributes say it.
delete document.documentElement.dataset.first;
if (REPLAY) openTrip(null, null);

// Report: "Changer" lets the user pick the exact place (station, address) instead of the guessed one.
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
