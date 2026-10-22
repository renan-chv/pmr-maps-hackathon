"""Mobility profiles: how much each kind of obstacle matters for each profile.

Single source of truth for the obstacle x profile matrix (roadmap section 4.4).
Values are estimates built from accessibility norms, to be checked with real users.
"""
from __future__ import annotations

from typing import Dict, Literal

Profile = Literal["manuel", "electrique", "poussette", "deambulateur", "malvoyant"]
Effect = Literal["bloquant", "genant", "sans_effet"]

PROFILES: Dict[str, str] = {
    "manuel": "Manual wheelchair",
    "electrique": "Power wheelchair",
    "poussette": "Stroller",
    "deambulateur": "Walker or cane",
    "malvoyant": "Visually impaired",
}
DEFAULT_PROFILE = "manuel"

# Obstacle kinds, shared with verify.py and the community reports (chantier B).
OBSTACLES = (
    "escalier", "ascenseur_panne", "escalator_seul", "pente", "bordure_haute",
    "trottoir_etroit", "long_trajet_pied", "pas_annonce_sonore",
)

_B, _G, _N = "bloquant", "genant", "sans_effet"
MATRIX: Dict[str, Dict[str, Effect]] = {
    #                     manuel  electrique poussette deambulateur malvoyant
    "escalier":           dict(manuel=_B, electrique=_B, poussette=_G, deambulateur=_G, malvoyant=_N),
    "ascenseur_panne":    dict(manuel=_B, electrique=_B, poussette=_G, deambulateur=_G, malvoyant=_N),
    "escalator_seul":     dict(manuel=_B, electrique=_B, poussette=_B, deambulateur=_G, malvoyant=_N),
    "pente":              dict(manuel=_G, electrique=_N, poussette=_N, deambulateur=_G, malvoyant=_N),
    "bordure_haute":      dict(manuel=_B, electrique=_B, poussette=_G, deambulateur=_G, malvoyant=_N),
    "trottoir_etroit":    dict(manuel=_B, electrique=_B, poussette=_G, deambulateur=_G, malvoyant=_G),
    "long_trajet_pied":   dict(manuel=_G, electrique=_N, poussette=_N, deambulateur=_G, malvoyant=_N),
    "pas_annonce_sonore": dict(manuel=_N, electrique=_N, poussette=_N, deambulateur=_N, malvoyant=_G),
}
LONG_WALK_BLOCKING_M = {"deambulateur": 500}  # beyond this distance a long walk becomes blocking

# Community report categories (chantier B) mapped to obstacle kinds.
REPORT_TO_OBSTACLE: Dict[str, str] = {
    "escalier": "escalier", "marche": "bordure_haute", "bordure_haute": "bordure_haute",
    "travaux": "trottoir_etroit", "trottoir_encombre": "trottoir_etroit", "trottoir_etroit": "trottoir_etroit",
    "pente": "pente", "ascenseur_panne": "ascenseur_panne", "escalator_panne": "escalator_seul",
}

_SEVERITY = {"sans_effet": 0, "genant": 1, "bloquant": 2}


def normalize(profile: str | None) -> str:
    """Unknown or missing profile falls back to the most constrained common case."""
    return profile if profile in PROFILES else DEFAULT_PROFILE


def effect(obstacle: str, profile: str, walk_m: float | None = None) -> Effect:
    if obstacle not in MATRIX:
        raise ValueError(f"unknown obstacle kind: {obstacle}")
    profile = normalize(profile)
    if obstacle == "long_trajet_pied" and walk_m is not None:
        limit = LONG_WALK_BLOCKING_M.get(profile)
        if limit is not None and walk_m > limit:
            return "bloquant"
    return MATRIX[obstacle][profile]


def worst(effects) -> Effect:
    """Most severe effect of a list (sans_effet when empty)."""
    out: Effect = "sans_effet"
    for e in effects:
        if _SEVERITY[e] > _SEVERITY[out]:
            out = e
    return out
