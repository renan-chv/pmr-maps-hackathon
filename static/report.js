// Roulib – photo report screen (chantier B). Loaded by app.js when this file exists.
// The camera button calls window.PMRReport.open({ lat, lon, onDone }):
//   photo (rear camera) -> 1024 px JPEG -> Claude proposes a card -> the user validates or picks another category
//   -> POST /api/reports -> onDone() reloads the map.
// Plain JavaScript, no library; reuses the app's classes (btn, verdict, mark, chip, photo, title, src).
"use strict";

(() => {
  const CATS = {
    escalier: "Escalier", marche: "Marche", travaux: "Travaux", trottoir_encombre: "Trottoir encombré",
    trottoir_etroit: "Trottoir étroit", bordure_haute: "Bordure haute", pente: "Pente forte",
    ascenseur_panne: "Ascenseur en panne", escalator_panne: "Escalator en panne", rampe: "Rampe", autre: "Autre obstacle",
  };
  const QUICK = ["escalier", "travaux", "trottoir_encombre", "ascenseur_panne", "autre"]; // one-tap chips
  // [temporaire, gravite] when the user picks a category by hand
  const DEFAULTS = {
    escalier: [false, "bloquant"], marche: [false, "genant"], bordure_haute: [false, "genant"], pente: [false, "genant"],
    trottoir_etroit: [false, "genant"], travaux: [true, "genant"], trottoir_encombre: [true, "genant"],
    ascenseur_panne: [true, "bloquant"], escalator_panne: [true, "genant"], rampe: [false, "info"], autre: [false, "genant"],
  };
  const GRAV = {
    bloquant: ["ko", "Bloquant en fauteuil", "ko"], genant: ["warn", "Gênant", "warn"], info: ["unk", "Pour information", "unk"],
  };
  const IDF = { lat: [48, 49.5], lon: [1.4, 3.6] };
  const EMPTY = { categorie: "autre", temporaire: false, gravite: "info", description: "", confiance: 0 };

  const h = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const svg = (name) => `<svg class="i" aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const say = (msg) => (typeof window.toast === "function" ? window.toast(msg) : console.log(msg)); // app.js toast
  const inIdf = (lat, lon) => lat >= IDF.lat[0] && lat <= IDF.lat[1] && lon >= IDF.lon[0] && lon <= IDF.lon[1];
  const userId = () => { try { return localStorage.getItem("pmr_user_id"); } catch { return null; } };

  // Small layer on top of the app's styles: only the panel itself, everything else uses existing classes.
  const CSS = `
.pmrr-back{position:fixed;inset:0;z-index:25;background:rgba(20,16,12,.45);display:flex;align-items:flex-end;justify-content:center}
.pmrr{width:100%;max-width:520px;max-height:calc(100dvh - 24px);overflow:auto;background:var(--surface,#fff);color:var(--ink,#1e1a16);
 border-radius:var(--r-l,20px) var(--r-l,20px) 0 0;padding:var(--sp-4,16px) var(--sp-4,16px) calc(var(--sp-4,16px) + env(safe-area-inset-bottom));box-shadow:var(--shadow-2,0 -8px 30px rgba(0,0,0,.2))}
@media (min-width:1024px){.pmrr-back{align-items:center}.pmrr{border-radius:var(--r-l,20px)}}
.pmrr .title{margin-top:0}
.pmrr .photo img{aspect-ratio:16/9}
.pmrr-actions{position:sticky;bottom:calc(-1 * (var(--sp-4,16px) + env(safe-area-inset-bottom)));display:grid;grid-template-columns:2fr 1fr;gap:var(--sp-3,12px);
 margin:var(--sp-4,16px) calc(-1 * var(--sp-4,16px)) calc(-1 * (var(--sp-4,16px) + env(safe-area-inset-bottom)));padding:var(--sp-3,12px) var(--sp-4,16px) calc(var(--sp-3,12px) + env(safe-area-inset-bottom));
 background:var(--surface,#fff);box-shadow:0 -1px 0 var(--line,#e5e5e5)}
.pmrr-actions .btn{margin:0}
.pmrr-chips{display:flex;flex-wrap:wrap;gap:var(--sp-2,8px);margin:var(--sp-3,12px) 0 0;padding:0;list-style:none}
.pmrr-chips .chip{min-height:46px;cursor:pointer}
.pmrr-label{display:block;margin:var(--sp-4,16px) 0 0;font-weight:700}
.pmrr textarea{display:block;width:100%;min-height:64px;margin-top:var(--sp-2,8px);padding:10px 12px;border-radius:var(--r-s,10px);border:2px solid var(--line-2,#ccc);font:inherit;color:inherit;background:var(--surface,#fff);resize:vertical}
.pmrr-wait{display:flex;align-items:center;gap:var(--sp-3,12px);margin:var(--sp-4,16px) 0 0;font-weight:700}
.pmrr-spin{width:28px;height:28px;flex:none;border-radius:50%;border:3px solid var(--line-2,#ccc);border-top-color:var(--brand,#3d3bd6);animation:pmrr-turn .8s linear infinite}
@keyframes pmrr-turn{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.pmrr-spin{animation-duration:2.4s}}
.pmrr .btn{min-height:48px}`;

  let state = null; // the open panel

  function ensureStyle() {
    if (document.getElementById("pmrr-style")) return;
    const s = document.createElement("style"); s.id = "pmrr-style"; s.textContent = CSS; document.head.appendChild(s);
  }

  // --- Photo -> JPEG -----------------------------------------------------------
  async function bitmap(file) {
    if (window.createImageBitmap) {
      try { return await createImageBitmap(file, { imageOrientation: "from-image" }); } catch { /* fall back */ }
    }
    const url = URL.createObjectURL(file);
    try {
      const img = new Image(); img.src = url; await img.decode(); return img;
    } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
  }
  function jpeg(src, maxW, quality) {
    const w0 = src.naturalWidth || src.width, h0 = src.naturalHeight || src.height;
    const k = Math.min(1, maxW / w0), c = document.createElement("canvas");
    c.width = Math.round(w0 * k); c.height = Math.round(h0 * k);
    c.getContext("2d").drawImage(src, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", quality);
  }
  async function prepare(file) {
    const src = await bitmap(file);
    const full = jpeg(src, 1024, 0.7);
    let thumb = jpeg(src, 320, 0.7);
    if (thumb.length > 290 * 1024) thumb = jpeg(src, 320, 0.45); // server refuses > 300 Ko
    if (src.close) src.close();
    return { full, thumb, b64: full.slice(full.indexOf(",") + 1) };
  }

  // --- Position: better GPS fix if it comes quickly, else the one we were given --
  function refinePosition(fallback) {
    return new Promise((resolve) => {
      if (!navigator.geolocation) return resolve(fallback);
      const done = setTimeout(() => resolve(fallback), 6000);
      navigator.geolocation.getCurrentPosition((p) => {
        clearTimeout(done);
        const pos = { lat: p.coords.latitude, lon: p.coords.longitude };
        resolve(inIdf(pos.lat, pos.lon) ? pos : fallback);
      }, () => { clearTimeout(done); resolve(fallback); }, { enableHighAccuracy: true, timeout: 5000, maximumAge: 30000 });
    });
  }

  // --- Panel ----------------------------------------------------------------------
  function panel(inner) {
    state.card.innerHTML = inner;
    state.card.querySelector("[data-cancel]")?.addEventListener("click", close);
  }

  function showWaiting() {
    panel(
      `<h2 class="title" id="pmrr-title">Signaler un obstacle</h2>` +
      `<figure class="photo"><img alt="Votre photo" src="${state.photo.full}"></figure>` +
      `<p class="pmrr-wait" role="status"><span class="pmrr-spin" aria-hidden="true"></span>Je regarde la photo…</p>` +
      `<div class="pmrr-actions"><button class="btn primary" disabled>${svg("ok")}Valider</button><button class="btn" data-cancel>Annuler</button></div>`);
    state.card.querySelector("[data-cancel]").focus();
  }

  function render() {
    const f = state.fiche, [st, gravLabel] = GRAV[f.gravite] || GRAV.genant;
    const cats = QUICK.includes(f.categorie) ? QUICK : [f.categorie, ...QUICK];
    const failed = state.analyse !== "ok" || (f.categorie === "autre" && f.confiance < 0.3 && !state.touched);
    panel(
      `<figure class="photo"><img alt="Votre photo" src="${state.photo.full}"></figure>` +
      `<h2 class="title" id="pmrr-title" tabindex="-1">${h(CATS[f.categorie] || "Obstacle")}</h2>` +
      (failed ? `<p class="note">${svg("unk")}<span>Je n'ai pas reconnu l'obstacle à coup sûr. Choisissez ce que vous voyez.</span></p>`
              : `<p class="sub">${f.temporaire ? "Temporaire" : "Permanent"} · proposé automatiquement, à vérifier</p>`) +
      `<div class="verdict ${st}"><span class="mark ${st} lg" aria-hidden="true">${svg(st)}</span>` +
      `<span><strong>${gravLabel}</strong>${h(f.description || CATS[f.categorie] || "")}</span></div>` +
      `<p class="pmrr-label" id="pmrr-cat">Ce n'est pas ça ? Touchez ce que vous voyez :</p>` +
      `<ul class="pmrr-chips" aria-labelledby="pmrr-cat">${cats.map((k) =>
        `<li><button class="chip${k === f.categorie ? " on" : ""}" data-cat="${k}" aria-pressed="${k === f.categorie}">${h(CATS[k])}</button></li>`).join("")}</ul>` +
      `<p class="pmrr-label" id="pmrr-grav">Pour un fauteuil, c'est :</p>` +
      `<ul class="pmrr-chips" aria-labelledby="pmrr-grav">${Object.entries(GRAV).map(([k, v]) =>
        `<li><button class="chip${k === f.gravite ? " on" : ""}" data-grav="${k}" aria-pressed="${k === f.gravite}">${v[1]}</button></li>`).join("")}</ul>` +
      `<label class="pmrr-label" for="pmrr-desc">Description (facultatif)</label>` +
      `<textarea id="pmrr-desc" maxlength="500" placeholder="Ex. : trois marches sans rampe devant l'entrée">${h(f.description)}</textarea>` +
      `<p class="src">Photo analysée par Claude (IA) : vérifiez avant de valider. Elle sera visible en miniature sur la carte, évitez les visages et les plaques.</p>` +
      `<div class="pmrr-actions"><button class="btn primary" data-ok>${svg("ok")}Valider</button><button class="btn" data-cancel>Annuler</button></div>`);
    const c = state.card;
    c.querySelector("[data-ok]").addEventListener("click", submit);
    c.querySelectorAll("[data-cat]").forEach((b) => b.addEventListener("click", () => pickCategory(b.dataset.cat)));
    c.querySelectorAll("[data-grav]").forEach((b) => b.addEventListener("click", () => { keepDescription(); state.fiche.gravite = b.dataset.grav; state.touched = true; render(); c.querySelector(`[data-grav="${b.dataset.grav}"]`)?.focus(); }));
    c.querySelector("#pmrr-desc").addEventListener("input", (e) => { state.fiche.description = e.target.value; state.descEdited = true; });
    (state.focus ? c.querySelector(state.focus) : c.querySelector("[data-ok]"))?.focus();
    state.focus = null;
  }

  function keepDescription() {
    const t = state.card.querySelector("#pmrr-desc");
    if (t) state.fiche.description = t.value;
  }

  function pickCategory(cat) {
    keepDescription();
    const f = state.fiche;
    if (cat !== f.categorie) {
      const [temp, grav] = DEFAULTS[cat] || DEFAULTS.autre;
      Object.assign(f, { categorie: cat, temporaire: temp, gravite: grav, confiance: 1 });
      if (!state.descEdited) f.description = ""; // Claude's sentence described another obstacle
    }
    state.touched = true;
    state.focus = `[data-cat="${cat}"]`;
    render();
  }

  async function submit(e) {
    const btn = e.currentTarget;
    keepDescription();
    btn.disabled = true; btn.lastChild.textContent = "Envoi…";
    const f = state.fiche, pos = await state.position;
    const body = {
      categorie: f.categorie, temporaire: !!f.temporaire, gravite: f.gravite,
      confiance: state.touched || state.analyse !== "ok" ? 1 : f.confiance,
      description: (f.description || "").trim().slice(0, 500) || CATS[f.categorie],
      user_id: userId(), lat: pos.lat, lon: pos.lon, target_type: "photo", target_id: null, photo_thumb: state.photo.thumb,
    };
    try {
      const r = await fetch("/api/reports", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(r.status === 400 && d.detail ? d.detail : r.status === 503 ? "Le signalement n'est pas encore disponible." : `Erreur ${r.status}`);
      }
      const onDone = state.onDone;
      close();
      try { onDone && onDone(); } catch { /* the map reloads on its own next move */ }
      say("Merci, c'est sur la carte.");
    } catch (err) {
      btn.disabled = false; btn.lastChild.textContent = "Valider";
      say(`Je n'ai pas pu envoyer : ${err.message} Réessayez.`);
    }
  }

  function close() {
    if (!state) return;
    state.abort.abort();
    state.back.remove();
    document.removeEventListener("keydown", onKey, true);
    const back = state.returnFocus; state = null;
    back?.focus?.();
  }
  function onKey(e) { if (e.key === "Escape") { e.preventDefault(); close(); } }

  async function analyse() {
    const t = setTimeout(() => state?.abort.abort(), 25000);
    try {
      const r = await fetch("/api/reports/analyze", {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: state.abort.signal,
        body: JSON.stringify({ image_base64: state.photo.b64, lat: state.start.lat, lon: state.start.lon }),
      });
      if (!r.ok) throw new Error(r.status);
      const d = await r.json();
      return { fiche: { ...EMPTY, ...d, categorie: CATS[d.categorie] ? d.categorie : "autre", gravite: GRAV[d.gravite] ? d.gravite : "info" }, analyse: d.analyse || "ok" };
    } catch {
      return { fiche: { ...EMPTY }, analyse: "erreur" };
    } finally { clearTimeout(t); }
  }

  async function onPhoto(file) {
    ensureStyle();
    const back = document.createElement("div");
    back.className = "pmrr-back";
    back.innerHTML = `<div class="pmrr" role="dialog" aria-modal="true" aria-labelledby="pmrr-title"></div>`;
    back.addEventListener("click", (e) => { if (e.target === back) close(); });
    document.body.appendChild(back);
    document.addEventListener("keydown", onKey, true);
    state.back = back; state.card = back.firstChild;
    try {
      state.photo = await prepare(file);
    } catch {
      close();
      return say("Je n'arrive pas à lire cette photo. Réessayez avec l'appareil photo.");
    }
    showWaiting();
    state.position = refinePosition(state.start);
    const { fiche, analyse: how } = await analyse();
    if (!state) return; // cancelled meanwhile
    state.fiche = fiche; state.analyse = how;
    render();
  }

  function open(opts) {
    const { lat, lon, onDone } = opts || {};
    if (state) return;
    const start = { lat: Number(lat), lon: Number(lon) };
    const session = { start, onDone, abort: new AbortController(), returnFocus: document.activeElement, touched: false, descEdited: false };
    state = session;
    document.getElementById("pmrr-input")?.remove();
    const input = document.createElement("input");
    Object.assign(input, { type: "file", accept: "image/*", id: "pmrr-input" });
    input.setAttribute("capture", "environment"); // rear camera on phones, file picker on computers
    input.hidden = true;
    input.addEventListener("change", () => {
      const file = input.files && input.files[0];
      input.remove();
      if (!file) { if (state === session) state = null; return; }
      if (state && state !== session) return;
      state = session; // the focus fallback below may have freed it while the phone converted the photo
      onPhoto(file);
    });
    // Picker closed without a photo: no event on most browsers, so free the slot when the page gets focus back.
    window.addEventListener("focus", () => setTimeout(() => { if (state === session && !session.back) state = null; }, 1500), { once: true });
    document.body.appendChild(input);
    input.click(); // must stay inside the tap on the camera button
  }

  window.PMRReport = { open, close };
})();
