"""Benchmark sans IA : ce que Navitia dit accessible en fauteuil, vérifié par PMR Maps.

Pour N trajets réels dans Paris, on prend le premier itinéraire « accessible fauteuil » de Navitia
(ce que propose l'appli IDFM), on le passe dans le moteur de vérification (état des ascenseurs en
direct, historique Dispotrains, chantiers, escaliers) et on compte ce que Navitia ne voit pas.

Usage : PRIM_API_KEY=... python -m bench.navitia_vs_pmr [--trips 50] [--seed 42]
Sortie : bench/results/navitia_vs_pmr_<date>.json (détail) et un résumé à l'écran.
"""
from __future__ import annotations

import argparse
import json
import random
import sys
import time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional

from app import main, sources, verify

PLACES = [
    "Gare de Lyon, Paris", "Gare du Nord, Paris", "Gare Montparnasse, Paris", "Gare Saint-Lazare, Paris",
    "Gare de l'Est, Paris", "Gare d'Austerlitz, Paris", "Hôpital Lariboisière, Paris", "Hôpital Necker, Paris",
    "Hôpital de la Pitié-Salpêtrière, Paris", "Hôpital Européen Georges-Pompidou, Paris",
    "Hôpital Saint-Louis, Paris", "Musée du Louvre, Paris", "Musée d'Orsay, Paris", "Centre Pompidou, Paris",
    "Hôtel de Ville, Paris", "Bibliothèque François Mitterrand, Paris", "Place de la République, Paris",
    "Place de la Bastille, Paris", "Tour Eiffel, Paris", "Opéra Garnier, Paris", "Parc de la Villette, Paris",
    "Mairie du 15e arrondissement, Paris", "Mairie du 18e arrondissement, Paris",
    "Mairie du 20e arrondissement, Paris", "Cité des Sciences et de l'Industrie, Paris", "Porte Maillot, Paris",
    "Accor Arena, Paris", "Panthéon, Paris", "Place d'Italie, Paris", "Parvis de La Défense, Puteaux",
]
PROFILE = "manuel"


def causes(it: dict) -> List[str]:
    """What makes this itinerary not clear for a wheelchair, one tag per kind of problem."""
    out = []
    for st in it["steps"]:
        for c in st["checks"]:
            if c["effect"] == "sans_effet":
                continue
            if c["kind"] == "lift":
                tag = {"en_panne": "ascenseur_en_panne", "partiel": "ascenseur_partiel",
                       "inconnu": "ascenseur_sans_donnee", "ok": "ascenseur_souvent_en_panne"}[c["status"]]
            else:
                tag = {"works": "chantier_trottoir", "stairs": "escalier", "report": "signalement",
                       "walk": "longue_marche"}[c["kind"]]
            if tag not in out:
                out.append(tag)
    return out


def run_trip(a: dict, b: dict, lifts: dict) -> Optional[dict]:
    journeys = main._navitia(a, b)
    if not journeys:
        return None
    its = main._check_all(journeys, PROFILE, lifts)
    plan_b_source = "navitia_alternative"
    if all(it["verdict"] == "bloque" for it in its):
        forbidden = verify.blocking_stop_areas(its[0])
        if forbidden:
            its += main._check_all(main._navitia(a, b, forbidden), PROFILE, lifts, prefix="b")
            plan_b_source = "navitia_replan"
    its = verify.pick_plan_b(its)
    first = its[0]
    best = min(its, key=lambda it: verify._RANK[it["verdict"]])
    return {
        "from": a["label"], "to": b["label"],
        "navitia_first": {"duration_min": first["duration_min"], "verdict": first["verdict"],
                          "confidence": first["confidence"], "blocked_at": first["blocked_at"], "causes": causes(first)},
        "best_pmr": {"id": best["id"], "verdict": best["verdict"], "duration_min": best["duration_min"]},
        "plan_b": bool(first["plan_b_id"]), "plan_b_source": plan_b_source if first["plan_b_id"] else None,
    }


def pct(n: int, d: int) -> str:
    return f"{round(100 * n / d)} %" if d else "n/a"


def main_cli() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--trips", type=int, default=50)
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()
    if not main.PRIM_API_KEY:
        print("PRIM_API_KEY manquante", file=sys.stderr)
        return 1

    geo = {}
    for p in PLACES:
        g = sources.geocode(p)
        if g:
            geo[p] = {"label": p, "lon": g["lon"], "lat": g["lat"]}
        else:
            print(f"introuvable : {p}", file=sys.stderr)
    rng = random.Random(args.seed)
    names = sorted(geo)
    pairs = []
    while len(pairs) < args.trips:
        a, b = rng.sample(names, 2)
        if (a, b) not in pairs:
            pairs.append((a, b))

    lifts = sources.lifts()
    started = datetime.now(timezone.utc)
    rows, errors = [], 0
    for i, (a, b) in enumerate(pairs, 1):
        try:
            r = run_trip(geo[a], geo[b], lifts)
        except Exception as e:  # keep going: one failed request must not kill the run
            errors += 1
            print(f"[{i}/{len(pairs)}] erreur {a} -> {b}: {e}", file=sys.stderr)
            continue
        if r:
            rows.append(r)
            print(f"[{i}/{len(pairs)}] {a} -> {b}: {r['navitia_first']['verdict']} {r['navitia_first']['causes']}")
        time.sleep(0.3)

    n = len(rows)
    v = Counter(r["navitia_first"]["verdict"] for r in rows)
    cause_count = Counter(c for r in rows for c in r["navitia_first"]["causes"])
    lift_problem = sum(1 for r in rows if any(c.startswith("ascenseur") for c in r["navitia_first"]["causes"]))
    lift_blocked = sum(1 for r in rows if "ascenseur_en_panne" in r["navitia_first"]["causes"])
    not_passe = [r for r in rows if r["navitia_first"]["verdict"] != "passe"]
    blocked = [r for r in rows if r["navitia_first"]["verdict"] == "bloque"]
    rescued = sum(1 for r in blocked if r["best_pmr"]["verdict"] != "bloque")
    summary = {
        "run_at": started.isoformat(timespec="seconds"), "lifts_fetched_at": lifts.get("fetched_at"),
        "profile": PROFILE, "trips_requested": len(pairs), "trips_with_result": n, "errors": errors,
        "navitia_first_verdicts": dict(v), "causes": dict(cause_count),
        "lift_problem_trips": lift_problem, "lift_blocked_trips": lift_blocked,
        "blocked_trips": len(blocked), "blocked_with_plan_b": rescued,
        "not_clear_trips": len(not_passe),
        "mode": "live (PRIM/Navitia, état IDFM des ascenseurs, Dispotrains, Ville de Paris)",
    }
    out = Path(__file__).resolve().parent / "results" / f"navitia_vs_pmr_{started:%Y%m%d_%H%M}.json"
    out.write_text(json.dumps({"summary": summary, "trips": rows}, ensure_ascii=False, indent=1))

    print(f"\nTrajets « accessibles » selon Navitia : {n} (profil fauteuil manuel, {started:%d/%m %Hh%M} UTC)")
    print(f"  bloqués par un ascenseur en panne : {lift_blocked} ({pct(lift_blocked, n)})")
    print(f"  au moins un problème d'ascenseur (panne, partiel, sans donnée, souvent en panne) : {lift_problem} ({pct(lift_problem, n)})")
    print(f"  verdicts PMR Maps : {dict(v)}")
    print(f"  bloqués avec un plan B trouvé : {rescued}/{len(blocked)}")
    print(f"  causes : {dict(cause_count)}")
    print(f"Détail : {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main_cli())
