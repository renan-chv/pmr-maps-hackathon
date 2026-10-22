// PMR Maps – front-end: MapLibre map + layers from /api/*.
const COLORS = { ok: "#15803d", partial: "#d97706", ko: "#b91c1c", unk: "#6b7280", works: "#7c3aed" };
const STATUS_FR = { available: "en service", notavailable: "en panne", unknown: "état inconnu" };
const ACCESS_FR = { true: "accessible", partial: "partiellement accessible", false: "non accessible", unknown: "inconnu" };
const TYPE_FR = { metro: "Métro", rail: "Train / RER", tram: "Tram", cableway: "Câble", bus: "Bus" };

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtTime = (iso) => {
  if (!iso) return "?";
  const d = new Date(iso);
  return isNaN(d) ? iso : d.toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
};
const getJSON = async (url) => {
  const r = await fetch(url);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.detail || `HTTP ${r.status}`);
  return body;
};

const map = new maplibregl.Map({
  container: "map",
  style: "https://tiles.openfreemap.org/styles/positron",
  center: [2.3488, 48.8566],
  zoom: 12,
});
map.addControl(new maplibregl.NavigationControl(), "top-left");
map.addControl(new maplibregl.GeolocateControl({ trackUserLocation: false }), "top-left");

const LAYERS = {
  lifts: ["lifts"],
  stations: ["stations"],
  train: ["train"],
  bus: ["bus"],
  works: ["works-fill", "works-line"],
};

function popup(lngLat, html) {
  new maplibregl.Popup({ maxWidth: "320px" }).setLngLat(lngLat).setHTML(html).addTo(map);
}

map.on("load", async () => {
  // Roadworks (polygons) first so points draw on top.
  map.addSource("works", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({ id: "works-fill", type: "fill", source: "works", paint: { "fill-color": COLORS.works, "fill-opacity": 0.25 } });
  map.addLayer({ id: "works-line", type: "line", source: "works", paint: { "line-color": COLORS.works, "line-width": 1 } });

  map.addSource("stations", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({
    id: "stations", type: "circle", source: "stations",
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 2, 15, 6],
      "circle-color": ["match", ["get", "accessibility"], "true", COLORS.ok, "partial", COLORS.partial, "false", COLORS.ko, COLORS.unk],
      "circle-stroke-color": "#fff", "circle-stroke-width": 1,
    },
  });

  map.addSource("train", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({
    id: "train", type: "circle", source: "train",
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 4, 15, 9],
      "circle-color": ["match", ["get", "level"], 4, COLORS.ok, 2, COLORS.partial, 3, COLORS.partial, 1, COLORS.ko, COLORS.unk],
      "circle-stroke-color": "#111827", "circle-stroke-width": 1.5,
    },
  });

  map.addSource("bus", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({
    id: "bus", type: "circle", source: "bus", minzoom: 14, layout: { visibility: "none" },
    paint: {
      "circle-radius": 4,
      "circle-color": ["match", ["get", "accessibility"], "true", COLORS.ok, "partial", COLORS.partial, "false", COLORS.ko, COLORS.unk],
      "circle-stroke-color": "#fff", "circle-stroke-width": 1,
    },
  });

  map.addSource("lifts", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({
    id: "lifts", type: "circle", source: "lifts",
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 4, 15, 10],
      "circle-color": ["match", ["get", "status"], "available", COLORS.ok, "notavailable", COLORS.ko, COLORS.unk],
      "circle-stroke-color": "#fff", "circle-stroke-width": 2,
    },
  });

  map.addSource("journey", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({ id: "journey", type: "line", source: "journey", paint: { "line-color": "#1d4ed8", "line-width": 5, "line-opacity": 0.8 } });

  bindPopups();
  bindToggles();
  loadLifts();
  loadStatic();
  loadAlerts();
  setInterval(loadLifts, 5 * 60 * 1000);
  setInterval(loadAlerts, 60 * 1000);
});

async function loadLifts() {
  try {
    const d = await getJSON("/api/lifts");
    map.getSource("lifts").setData(d);
    const c = d.meta.counts;
    document.getElementById("lift-stats").innerHTML =
      `<div class="stat ok"><b>${c.available || 0}</b>en service</div>` +
      `<div class="stat ko"><b>${c.notavailable || 0}</b>en panne</div>` +
      `<div class="stat unk"><b>${c.unknown || 0}</b>inconnu</div>`;
    document.getElementById("lift-fresh").textContent =
      `Récupéré à ${fmtTime(d.meta.fetched_at)} · source : ${d.meta.source.name} (mis à jour ~3 fois par jour par IDFM)`;
  } catch (e) {
    document.getElementById("lift-stats").innerHTML = `<span class="err">Ascenseurs indisponibles : ${esc(e.message)}</span>`;
  }
}

async function loadStatic() {
  const jobs = [
    ["stations", "/api/stations"],
    ["train", "/api/train-stations"],
    ["works", "/api/works"],
  ];
  await Promise.all(jobs.map(async ([src, url]) => {
    try { map.getSource(src).setData(await getJSON(url)); }
    catch (e) { console.warn(src, e); }
  }));
}

async function loadBus() {
  if (map.getLayoutProperty("bus", "visibility") === "none" || map.getZoom() < 14) return;
  const b = map.getBounds();
  const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map((v) => v.toFixed(5)).join(",");
  try { map.getSource("bus").setData(await getJSON(`/api/bus-stops?bbox=${bbox}`)); }
  catch (e) { console.warn("bus", e); }
}
map.on("moveend", loadBus);

async function loadAlerts() {
  try {
    const d = await getJSON("/api/alerts");
    const ul = document.getElementById("alerts");
    if (!d.alerts.length) {
      ul.innerHTML = `<li class="muted">Aucun changement depuis le démarrage (dernier relevé : ${fmtTime(d.poller.last_poll)}).</li>`;
      return;
    }
    ul.innerHTML = d.alerts.slice(0, 30).map((a) =>
      `<li class="${a.to === "available" ? "up" : ""}"><b>${esc(a.station)}</b> : ${esc(STATUS_FR[a.from] || a.from)} → <b>${esc(STATUS_FR[a.to] || a.to)}</b>` +
      `<br><small>${esc(a.situation || "")}<br>Détecté à ${fmtTime(a.detected_at)} · info IDFM du ${esc(a.source_update)}</small></li>`
    ).join("");
  } catch (e) { console.warn("alerts", e); }
}

function bindPopups() {
  map.on("click", "lifts", (e) => {
    const p = e.features[0].properties;
    popup(e.lngLat,
      `<h3>${esc(p.station)}</h3>Ascenseur <b>${esc(STATUS_FR[p.status] || p.status)}</b>${p.reason && p.reason !== "null" ? ` (${esc(p.reason)})` : ""}` +
      `<br>${esc(p.situation)}<br><i>${esc(p.direction)}</i>` +
      `<div class="src">Info IDFM du ${esc(p.source_update)} · État des ascenseurs (Licence Mobilité)</div>`);
  });
  map.on("click", "stations", (e) => {
    const p = e.features[0].properties;
    popup(e.lngLat, `<h3>${esc(p.name)}</h3>${esc(TYPE_FR[p.type] || p.type)} · ${esc(p.town)}<br>Quai : <b>${esc(ACCESS_FR[p.accessibility] || p.accessibility)}</b>` +
      `<div class="src">IDFM Référentiel des arrêts (arrid ${esc(p.id)})</div>`);
  });
  map.on("click", "train", (e) => {
    const p = e.features[0].properties;
    popup(e.lngLat, `<h3>${esc(p.name)}</h3><b>${esc(p.level_name)}</b>${p.comment && p.comment !== "null" ? `<br>${esc(p.comment)}` : ""}` +
      `<div class="src">IDFM Accessibilité en gare</div>`);
  });
  map.on("click", "bus", (e) => {
    const p = e.features[0].properties;
    popup(e.lngLat, `<h3>${esc(p.name)}</h3>Arrêt de bus · ${esc(p.town)}<br><b>${esc(ACCESS_FR[p.accessibility] || p.accessibility)}</b>` +
      `<div class="src">IDFM Référentiel des arrêts (arrid ${esc(p.id)})</div>`);
  });
  map.on("click", "works-fill", (e) => {
    const p = e.features[0].properties;
    popup(e.lngLat, `<h3>Chantier ${esc(p.id)}</h3>${esc(p.summary)}<br>${esc(p.owner)}<br>Du ${esc(p.start)} au ${esc(p.end)}` +
      `<br>Emprise : ${esc(p.where)}<div class="src">Ville de Paris – Chantiers à Paris (ODbL)</div>`);
  });
  for (const id of ["lifts", "stations", "train", "bus", "works-fill"]) {
    map.on("mouseenter", id, () => (map.getCanvas().style.cursor = "pointer"));
    map.on("mouseleave", id, () => (map.getCanvas().style.cursor = ""));
  }
}

function bindToggles() {
  document.querySelectorAll("[data-layer]").forEach((cb) => {
    cb.addEventListener("change", () => {
      for (const id of LAYERS[cb.dataset.layer]) map.setLayoutProperty(id, "visibility", cb.checked ? "visible" : "none");
      if (cb.dataset.layer === "bus" && cb.checked) {
        if (map.getZoom() < 14) map.easeTo({ zoom: 14.5 });
        loadBus();
      }
    });
  });
}

// --- Journey ---------------------------------------------------------------
document.getElementById("journey-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const from = document.getElementById("from").value.trim();
  const to = document.getElementById("to").value.trim();
  const out = document.getElementById("journey-result");
  out.innerHTML = "Recherche…";
  try {
    const d = await getJSON(`/api/journey?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    if (!d.journeys.length) { out.innerHTML = "Aucun itinéraire accessible trouvé."; return; }
    out.innerHTML = d.journeys.map((j, i) => {
      const steps = j.sections.filter((s) => s.type === "public_transport" || s.type === "street_network")
        .map((s) => s.type === "public_transport"
          ? `<li>${esc(s.mode)} ${esc(s.line)} : ${esc(s.from)} → ${esc(s.to)}</li>`
          : `<li>À pied / en fauteuil ${Math.round((s.duration_s || 0) / 60)} min</li>`).join("");
      const warn = j.lifts_not_available.length
        ? `<p class="err">⚠ ${j.lifts_not_available.length} ascenseur(s) hors service sur le trajet : ${j.lifts_not_available.map((l) => esc(l.station)).join(", ")}</p>` : "";
      return `<div class="journey ${warn ? "warn" : ""}" data-i="${i}"><b>${Math.round(j.duration_s / 60)} min</b>${warn}<ol>${steps}</ol></div>`;
    }).join("") + `<p class="fresh">Itinéraires : ${esc(d.source)} · ascenseurs vérifiés à ${fmtTime(d.lifts_fetched_at)}</p>`;
    const show = (i) => {
      const feats = d.journeys[i].sections.filter((s) => s.geojson).map((s) => ({ type: "Feature", geometry: s.geojson, properties: {} }));
      map.getSource("journey").setData({ type: "FeatureCollection", features: feats });
      const b = new maplibregl.LngLatBounds([d.from.lon, d.from.lat], [d.from.lon, d.from.lat]).extend([d.to.lon, d.to.lat]);
      map.fitBounds(b, { padding: 60 });
    };
    out.querySelectorAll(".journey").forEach((el) => el.addEventListener("click", () => show(+el.dataset.i)));
    show(0);
  } catch (e) {
    out.innerHTML = `<p class="err">${esc(e.message)}</p>`;
  }
});

// --- Voice input (Web Speech API, Chrome/Edge/Safari) -----------------------
(() => {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const btn = document.getElementById("voice");
  if (!SR) { btn.hidden = true; return; }
  const rec = new SR();
  rec.lang = "fr-FR";
  rec.onresult = (e) => {
    const text = e.results[0][0].transcript;
    // "de Gare de Lyon à Musée d'Orsay" / "depuis X jusqu'à Y"
    const m = text.match(/(?:de|depuis)\s+(.+?)\s+(?:à|a|jusqu'à|vers)\s+(.+)/i);
    if (m) { document.getElementById("from").value = m[1]; document.getElementById("to").value = m[2]; }
    else document.getElementById("to").value = text;
  };
  rec.onend = () => btn.classList.remove("listening");
  btn.addEventListener("click", () => { btn.classList.add("listening"); rec.start(); });
})();
