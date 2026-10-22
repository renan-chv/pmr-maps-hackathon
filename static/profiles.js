// Roulib – mobility profile (chantier A). Chosen once on first launch, kept on this phone,
// sent as ?profile= with every /api/journey call. Keys match app/profiles.py.
"use strict";

const PMR_PROFILES = [
  { key: "manuel", label: "Manual wheelchair", short: "manual wheelchair", ic: "p-manuel" },
  { key: "electrique", label: "Power wheelchair", short: "power wheelchair", ic: "p-electrique" },
  { key: "poussette", label: "Stroller", short: "stroller", ic: "p-poussette" },
  { key: "deambulateur", label: "Walker or cane", short: "walker", ic: "p-deambulateur" },
  { key: "malvoyant", label: "Visually impaired", short: "visually impaired traveler", ic: "p-malvoyant" },
  // Walks without difficulty: sees the same map and reports obstacles for everyone else.
  { key: "valide", label: "Able-bodied: I help the community", short: "community helper", ic: "p-valide",
    sub: "Report broken elevators and blocked sidewalks so wheelchair users know before they go." },
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
          body: JSON.stringify({ display_name: (name || "").trim() || "Anonymous", profile: key }) })
          .then((r) => (r.ok ? r.json() : null)).then((d) => d && d.id && write("pmr_user_id", String(d.id))).catch(() => {});
      }
    },
  };
})();
