// Roulib – mobility profile (chantier A). Chosen once on first launch, kept on this phone,
// sent as ?profile= with every /api/journey call. Keys match app/profiles.py.
"use strict";

const PMR_PROFILES = [
  { key: "manuel", label: "Fauteuil manuel", short: "fauteuil manuel", ic: "p-manuel" },
  { key: "electrique", label: "Fauteuil électrique", short: "fauteuil électrique", ic: "p-electrique" },
  { key: "poussette", label: "Poussette", short: "poussette", ic: "p-poussette" },
  { key: "deambulateur", label: "Déambulateur ou canne", short: "déambulateur", ic: "p-deambulateur" },
  { key: "malvoyant", label: "Malvoyant", short: "malvoyance", ic: "p-malvoyant" },
];

const Profile = (() => {
  const read = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const write = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
  return {
    get: () => PMR_PROFILES.find((p) => p.key === read("pmr_profile")) || null,
    key: () => (PMR_PROFILES.find((p) => p.key === read("pmr_profile")) || PMR_PROFILES[0]).key,
    name: () => read("pmr_name") || "",
    save(key, name) {
      write("pmr_profile", key);
      write("pmr_name", (name || "").trim().slice(0, 40));
      // Light account (chantier B). Optional: the app works without it.
      if (!read("pmr_user_id")) {
        fetch("/api/users", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ display_name: (name || "").trim() || "Anonyme", profile: key }) })
          .then((r) => (r.ok ? r.json() : null)).then((d) => d && d.id && write("pmr_user_id", String(d.id))).catch(() => {});
      }
    },
  };
})();
