// Roulib – mobility profile (chantier A). Chosen once on first launch, kept on this phone,
// sent as ?profile= with every /api/journey call. Keys match app/profiles.py.
"use strict";

// label: the tile; short: after "Profil :" and in « … »; who: after a verb ("Rien ne bloque en fauteuil manuel").
const PMR_PROFILES = [
  { key: "manuel", label: "Fauteuil manuel", short: "fauteuil manuel", who: "en fauteuil manuel", ic: "p-manuel" },
  { key: "electrique", label: "Fauteuil électrique", short: "fauteuil électrique", who: "en fauteuil électrique", ic: "p-electrique" },
  { key: "poussette", label: "Poussette", short: "poussette", who: "avec une poussette", ic: "p-poussette" },
  { key: "deambulateur", label: "Déambulateur ou canne", short: "déambulateur", who: "avec un déambulateur ou une canne", ic: "p-deambulateur" },
  { key: "malvoyant", label: "Malvoyant", short: "malvoyance", who: "pour une personne malvoyante", ic: "p-malvoyant" },
  // Walks without difficulty: sees the same map and reports obstacles for everyone else.
  { key: "valide", label: "Sans difficulté : j'aide la communauté", short: "sans difficulté", who: "", ic: "p-valide",
    sub: "Signalez les ascenseurs en panne et les trottoirs bloqués, pour que les personnes en fauteuil le sachent avant de partir." },
];

// Tiles of the profile screen, as radios (one tab stop: the chosen one, else the first). Used by app.js and,
// on first launch, by index.html before the map library loads, so the first screen is complete when it appears.
function profileTilesHTML(chosen) {
  const e = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  return PMR_PROFILES.map((p, i) => `<button class="ptile${p.sub ? " community" : ""}" role="radio" aria-checked="${p.key === chosen}" ` +
    `tabindex="${(chosen ? p.key === chosen : i === 0) ? "0" : "-1"}" data-p="${p.key}"><span class="tile-ic"><svg class="i " aria-hidden="true"><use href="#i-${p.ic}"/></svg></span>` +
    `<span><b>${e(p.label)}</b>${p.sub ? `<small>${e(p.sub)}</small>` : ""}</span></button>`).join("");
}

const Profile = (() => {
  const read = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const write = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
  return {
    get: () => PMR_PROFILES.find((p) => p.key === read("pmr_profile")) || null,
    key: () => (PMR_PROFILES.find((p) => p.key === read("pmr_profile")) || PMR_PROFILES[0]).key,
    name: () => read("pmr_name") || "",
    // Light account: its id, and the secret that proves this phone owns it (needed to delete it).
    userId: () => read("pmr_user_id"),
    token: () => read("pmr_user_token"),
    save(key, name) {
      write("pmr_profile", key);
      write("pmr_name", (name || "").trim().slice(0, 40));
      // Light account (chantier B). Optional: the app works without it.
      if (!read("pmr_user_id")) {
        fetch((window.ROULIB_API || "") + "/api/users", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ display_name: (name || "").trim() || "Anonyme", profile: key }) })
          .then((r) => (r.ok ? r.json() : null)).then((d) => {
            if (!d || !d.id) return;
            write("pmr_user_id", String(d.id));
            if (d.token) write("pmr_user_token", String(d.token));
          }).catch(() => {});
      }
    },
    // "Supprimer mes données": every pmr_* key (profile, first name, account id and token, hidden people, flags).
    clear() {
      try { Object.keys(localStorage).filter((k) => k.startsWith("pmr_")).forEach((k) => localStorage.removeItem(k)); } catch {}
    },
  };
})();
