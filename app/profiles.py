"""Mobility profiles: how much each kind of obstacle matters for each profile.

Single source of truth for the obstacle x profile matrix (roadmap section 4.4).
Values are estimates built from accessibility norms, to be checked with real users.
"""
from __future__ import annotations

from typing import Dict, List, Literal, Tuple, Union

Profile = Literal["manuel", "electrique", "poussette", "deambulateur", "malvoyant", "valide"]
Effect = Literal["bloquant", "genant", "sans_effet"]

PROFILES: Dict[str, str] = {
    "manuel": "Manual wheelchair",
    "electrique": "Power wheelchair",
    "poussette": "Stroller",
    "deambulateur": "Walker or cane",
    "malvoyant": "Visually impaired",
    "valide": "No mobility difficulty",  # walks without difficulty: mostly here to report obstacles for others
}
DEFAULT_PROFILE = "manuel"

# Obstacle kinds, shared with verify.py and the community reports (chantier B).
OBSTACLES = (
    "escalier", "ascenseur_panne", "escalator_seul", "pente", "bordure_haute",
    "trottoir_etroit", "long_trajet_pied", "pas_annonce_sonore", "feu_sans_son",
)
# Obstacles that only exist for people who cannot rely on sight (no spoken announcement, silent traffic light).
# A profile for which they are all "sans_effet" does not get these checks at all.
LOW_VISION_OBSTACLES = ("pas_annonce_sonore", "feu_sans_son")

_B, _G, _N = "bloquant", "genant", "sans_effet"
MATRIX: Dict[str, Dict[str, Effect]] = {
    #                     manuel  electrique poussette deambulateur malvoyant valide
    "escalier":           dict(manuel=_B, electrique=_B, poussette=_G, deambulateur=_G, malvoyant=_N, valide=_N),
    "ascenseur_panne":    dict(manuel=_B, electrique=_B, poussette=_G, deambulateur=_G, malvoyant=_N, valide=_N),
    "escalator_seul":     dict(manuel=_B, electrique=_B, poussette=_B, deambulateur=_G, malvoyant=_N, valide=_N),
    "pente":              dict(manuel=_G, electrique=_N, poussette=_N, deambulateur=_G, malvoyant=_N, valide=_N),
    "bordure_haute":      dict(manuel=_B, electrique=_B, poussette=_G, deambulateur=_G, malvoyant=_N, valide=_N),
    "trottoir_etroit":    dict(manuel=_B, electrique=_B, poussette=_G, deambulateur=_G, malvoyant=_G, valide=_N),
    "long_trajet_pied":   dict(manuel=_G, electrique=_N, poussette=_N, deambulateur=_G, malvoyant=_N, valide=_N),
    "pas_annonce_sonore": dict(manuel=_N, electrique=_N, poussette=_N, deambulateur=_N, malvoyant=_G, valide=_N),
    # Traffic light without audible signal: crossing is possible (wait for others, ask), so a risk, not a block.
    "feu_sans_son":       dict(manuel=_N, electrique=_N, poussette=_N, deambulateur=_N, malvoyant=_G, valide=_N),
}
# Long walks (or rolls), per profile. Below LONG_WALK_WARN_M nothing is said; between the two thresholds it is a
# risk (plan rests); beyond LONG_WALK_BLOCKING_M it blocks: nobody pushes a manual wheelchair for an hour.
# A walker or cane user can usually manage 500 m to 1 km with rests (estimates, to be checked with real users).
# Profiles missing from LONG_WALK_WARN_M are never warned; missing from LONG_WALK_BLOCKING_M, never blocked.
LONG_WALK_WARN_M = {"deambulateur": 500, "manuel": 800}
LONG_WALK_BLOCKING_M = {"deambulateur": 1000, "manuel": 2500, "poussette": 4000, "electrique": 8000}
# Walking or rolling speed in m/s for the trip planner (Navitia default: 1.12 m/s). Slower than average,
# so that walking times are realistic and the planner prefers a bus stop next door to a far station.
WALKING_SPEED_MS = {"manuel": 0.9, "electrique": 1.1, "poussette": 1.0, "deambulateur": 0.7, "malvoyant": 0.9}
NAVITIA_MAX_TO_PT_S = 30 * 60  # Navitia's own default cap on the walk to or from public transport

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
        warn = LONG_WALK_WARN_M.get(profile)
        if warn is None or walk_m <= warn:
            return "sans_effet"
    return MATRIX[obstacle][profile]


def walk_word(profile: str) -> str:
    """"roll" for wheelchairs, "walk" for everyone else: "479 m to roll"."""
    return "roll" if normalize(profile) in ("manuel", "electrique") else "walk"


def navitia_params(profile: str) -> List[Tuple[str, Union[str, int, float]]]:
    """Journey planner parameters for this profile (PRIM Navitia v2 /journeys).

    wheelchair=true (step-free stations only) for profiles hampered by stairs; walking speed and a cap on the
    walk to and from public transport, so the planner never proposes a walk that would block this profile.
    """
    profile = normalize(profile)
    out: List[Tuple[str, Union[str, int, float]]] = [
        ("wheelchair", "true" if MATRIX["escalier"][profile] != "sans_effet" else "false")]
    speed = WALKING_SPEED_MS.get(profile)
    if speed is not None:
        out.append(("walking_speed", speed))
    limit = LONG_WALK_BLOCKING_M.get(profile)
    if limit is not None:
        cap = min(NAVITIA_MAX_TO_PT_S, round(limit / (speed or 1.12)))
        out += [("max_walking_duration_to_pt", cap), ("max_walking_direct_path_duration", cap)]
    return out


def worst(effects) -> Effect:
    """Most severe effect of a list (sans_effet when empty)."""
    out: Effect = "sans_effet"
    for e in effects:
        if _SEVERITY[e] > _SEVERITY[out]:
            out = e
    return out
