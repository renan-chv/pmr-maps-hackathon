"""Checks every step of a Navitia journey against live data, for one mobility profile.

Input: a raw Navitia journey (PRIM). Output: the itinerary format of roadmap section 4.1,
with a verdict (passe / risque / bloque) and a confidence level (1 to 5) per step and overall.

Confidence levels (roadmap 4.3): 5 official live data, 4 community report confirmed by 2+ people
in the last 24 h, 3 official static data, 2 single report or OSM tag, 1 unknown.
"""
from __future__ import annotations

import math
import re
from datetime import datetime, timezone
from typing import Dict, Iterable, List, Optional, Tuple

from . import profiles

LIFT_RADIUS_M = 150     # lifts are geolocated at the station centroid
NEAR_WALK_M = 15        # an obstacle closer than this to a walking step is on the way
LONG_WALK_M = 400       # beyond this a walking step is flagged as long
UNRELIABLE_BELOW = 0.85  # lift in service less than this share of the time: warn (estimate)
RAIL_MODES = ("metro", "métro", "rer", "train", "transilien", "ter")
VERDICT = {"sans_effet": "passe", "genant": "risque", "bloquant": "bloque"}
_RANK = {"passe": 0, "risque": 1, "bloque": 2}


# --- Geometry (equirectangular, good enough at city scale) ------------------

def _xy(lon: float, lat: float, lat0: float) -> Tuple[float, float]:
    k = math.pi / 180 * 6371000
    return lon * k * math.cos(lat0 * math.pi / 180), lat * k


def dist_m(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    x1, y1 = _xy(lon1, lat1, (lat1 + lat2) / 2)
    x2, y2 = _xy(lon2, lat2, (lat1 + lat2) / 2)
    return math.hypot(x2 - x1, y2 - y1)


def _point_segment_m(p, a, b) -> float:
    lat0 = p[1]
    px, py = _xy(p[0], p[1], lat0)
    ax, ay = _xy(a[0], a[1], lat0)
    bx, by = _xy(b[0], b[1], lat0)
    dx, dy = bx - ax, by - ay
    if dx == 0 and dy == 0:
        return math.hypot(px - ax, py - ay)
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def point_to_line_m(p, line: List[List[float]]) -> float:
    if len(line) == 1:
        return dist_m(p[0], p[1], line[0][0], line[0][1])
    return min(_point_segment_m(p, line[i], line[i + 1]) for i in range(len(line) - 1))


def line_length_m(line: List[List[float]]) -> float:
    return sum(dist_m(*line[i][:2], *line[i + 1][:2]) for i in range(len(line) - 1))


def _vertices(geometry: dict) -> List[List[float]]:
    """Every coordinate pair of a GeoJSON geometry, whatever its type."""
    out: List[List[float]] = []

    def walk(c):
        if c and isinstance(c[0], (int, float)):
            out.append(c)
        else:
            for x in c or []:
                walk(x)

    walk((geometry or {}).get("coordinates"))
    return out


def _near_line(geometry: dict, line: List[List[float]], within: float = NEAR_WALK_M) -> bool:
    pts = _vertices(geometry)
    if not pts or not line:
        return False
    # cheap bounding-box filter (about 0.0005 degree = 40-55 m in Paris)
    xs, ys = [p[0] for p in line], [p[1] for p in line]
    pad = 0.0005
    if not any(min(xs) - pad <= p[0] <= max(xs) + pad and min(ys) - pad <= p[1] <= max(ys) + pad for p in pts):
        return False
    return any(point_to_line_m(p, line) <= within for p in pts)


# --- Lifts -------------------------------------------------------------------

def line_tokens(mode: Optional[str], code: Optional[str]) -> List[str]:
    """Words used in IDFM lift descriptions for a line, e.g. métro 14 -> M14, ligne 14."""
    if not code:
        return []
    code = code.strip()
    m = (mode or "").lower()
    if "rer" in m:
        return [f"RER {code}"]
    if "métro" in m or "metro" in m:
        return [f"M{code}", f"ligne {code}", f"L{code}"]
    if "tram" in m:
        return [f"T{code}".replace("TT", "T")]
    return [f"ligne {code}", code]


def _mentions(row: dict, tokens: List[str]) -> bool:
    text = f"{row.get('liftdirection') or ''} {row.get('liftsituation') or ''}"
    return any(re.search(rf"(?<![\w]){re.escape(t)}(?![\w])", text, re.I) for t in tokens)


def _since(stamp: Optional[str]) -> str:
    if not stamp:
        return ""
    try:
        d = datetime.fromisoformat(stamp)
    except ValueError:
        return ""
    return f" (signalé le {d:%d/%m} à {d:%Hh%M})"


def _at_most_genant(e: str) -> str:
    """Uncertain or avoidable obstacles warn (risque) but never block on their own."""
    return "genant" if e != "sans_effet" else "sans_effet"


def _direction_word(direction: Optional[str]) -> Optional[str]:
    """First word of a Navitia direction, e.g. "Saint-Denis Pleyel (Saint-Denis)" -> "Saint-Denis"."""
    head = (direction or "").split("(")[0].strip()
    return head.split(" ")[0] if head else None


def _worst_reliability(rows: List[dict], reliability: Optional[Dict[str, dict]]) -> Optional[dict]:
    known = [reliability[r["liftid"]] for r in rows if reliability and r.get("liftid") in reliability]
    return min(known, key=lambda x: x["availability"]) if known else None


def lift_check(lon: float, lat: float, station: str, mode: Optional[str], code: Optional[str],
               lifts_rows: Iterable[dict], fetched_at: Optional[str], profile: str,
               reliability: Optional[Dict[str, dict]] = None, direction: Optional[str] = None) -> dict:
    """Lift status for one line at one station.

    Only lifts that mention the line count when some do; among them, only those serving the
    platform of the travel direction (or "toutes directions") when the descriptions say so.
    """
    near = [r for r in lifts_rows
            if (r.get("centroidzdc") or {}).get("lon") is not None
            and dist_m(lon, lat, r["centroidzdc"]["lon"], r["centroidzdc"]["lat"]) <= LIFT_RADIUS_M]
    tokens = line_tokens(mode, code)
    relevant = [r for r in near if _mentions(r, tokens)] if tokens else []
    matched_line = bool(relevant)
    word = _direction_word(direction)
    if relevant and word:
        same_way = [r for r in relevant if _mentions(r, [word, "toutes directions"])]
        if same_way:
            relevant = same_way
    if not relevant:
        relevant = near
    up = [r for r in relevant if r.get("liftstatus") == "available"]
    down = [r for r in relevant if r.get("liftstatus") == "notavailable"]
    line_label = f"ligne {code}" if code else "la ligne"
    base = {"kind": "lift", "source": "IDFM – État des ascenseurs", "fetched_at": fetched_at,
            "station": station, "zdcid": (relevant[0].get("zdcid") if relevant else None),
            "lift_ids": [r.get("liftid") for r in relevant]}
    rel = _worst_reliability(relevant, reliability)
    if rel:
        base.update(reliability=rel["availability"], reliability_window_days=rel["window_days"],
                    reliability_outages=rel.get("outages"), reliability_source=rel["source"])
    rel_text = (f" Historique : en service {round(rel['availability'] * 100)} % du temps de 6h à 21h "
                f"sur les {rel['window_days']:g} derniers jours, {rel.get('outages', 0)} panne(s).") if rel else ""

    full = profiles.effect("ascenseur_panne", profile)
    if not relevant:
        eff = _at_most_genant(full)
        return {**base, "status": "inconnu", "confidence": 1, "obstacle": "ascenseur_panne", "effect": eff,
                "label": f"Ascenseurs à {station}", "message": "Aucune donnée d'ascenseur pour cette station"}
    conf = 5 if matched_line else 3  # 3: we could not tell which lift serves this line
    if down and not up:
        since = _since(min((r.get("liftstateupdate") or "") for r in down) or None)
        unknown = len(relevant) - len(down)
        extra = f", {unknown} à l'état inconnu" if unknown else ""
        return {**base, "status": "en_panne", "confidence": conf, "obstacle": "ascenseur_panne", "effect": full,
                "label": f"Ascenseur {line_label} à {station}",
                "message": f"{len(down)} ascenseur(s) sur {len(relevant)} en panne{since}{extra}, aucun en service confirmé.{rel_text}"}
    if down:
        eff = _at_most_genant(full)
        return {**base, "status": "partiel", "confidence": conf, "obstacle": "ascenseur_panne", "effect": eff,
                "label": f"Ascenseurs {line_label} à {station}",
                "message": f"{len(down)} ascenseur(s) sur {len(relevant)} en panne : vérifier que le vôtre fonctionne.{rel_text}"}
    if not up:
        eff = _at_most_genant(full)
        return {**base, "status": "inconnu", "confidence": 1, "obstacle": "ascenseur_panne", "effect": eff,
                "label": f"Ascenseurs {line_label} à {station}", "message": "État des ascenseurs inconnu"}
    if rel and rel["availability"] < UNRELIABLE_BELOW:
        return {**base, "status": "ok", "confidence": conf, "obstacle": "ascenseur_panne",
                "effect": _at_most_genant(full), "label": f"Ascenseurs {line_label} à {station}",
                "message": f"{len(up)} ascenseur(s) en service, mais souvent en panne : prévoir un plan B.{rel_text}"}
    return {**base, "status": "ok", "confidence": conf, "obstacle": None, "effect": "sans_effet",
            "label": f"Ascenseurs {line_label} à {station}",
            "message": f"{len(up)} ascenseur(s) en service.{rel_text}"}


# --- Walking steps -------------------------------------------------------------

def _report_confidence(r: dict, now: datetime) -> int:
    created = r.get("created_at")
    if isinstance(created, str):
        try:
            created = datetime.fromisoformat(created)
        except ValueError:
            created = None
    age_h = (now - created).total_seconds() / 3600 if isinstance(created, datetime) else 0.0
    level = 4 if (r.get("confirmations") or 1) >= 2 and age_h < 24 else 2
    if r.get("temporaire"):
        level -= int(age_h // 48)
    return max(level, 1)


def walk_checks(line: List[List[float]], profile: str, works: Iterable[dict] = (),
                stairs: Iterable[dict] = (), reports: Iterable[dict] = (),
                works_fetched_at: Optional[str] = None, now: Optional[datetime] = None) -> List[dict]:
    now = now or datetime.now(timezone.utc)
    out: List[dict] = []
    for f in works:
        if _near_line(f.get("geometry"), line):
            p = f.get("properties") or {}
            # a sidewalk worksite usually leaves a way round: never more than "genant" on its own
            eff = _at_most_genant(profiles.effect("trottoir_etroit", profile))
            out.append({"kind": "works", "status": "obstacle", "confidence": 5, "obstacle": "trottoir_etroit",
                        "effect": eff, "source": "Ville de Paris – Chantiers à Paris", "fetched_at": works_fetched_at,
                        "label": "Chantier sur le trottoir",
                        "message": f"{p.get('summary') or 'Chantier'}" + (f" (jusqu'au {p['end']})" if p.get("end") else "")})
    for f in stairs:
        if _near_line(f.get("geometry"), line, within=10):
            out.append({"kind": "stairs", "status": "obstacle", "confidence": 3, "obstacle": "escalier",
                        "effect": profiles.effect("escalier", profile),
                        "source": "Ville de Paris – Voies en escalier", "fetched_at": None,
                        "label": "Rue en escalier", "message": "Passage uniquement par des marches"})
    for r in reports:
        if r.get("lon") is None or point_to_line_m([r["lon"], r["lat"]], line) > 30:
            continue
        obstacle = profiles.REPORT_TO_OBSTACLE.get(r.get("categorie") or "")
        if not obstacle:
            continue
        out.append({"kind": "report", "status": "obstacle", "confidence": _report_confidence(r, now),
                    "obstacle": obstacle, "effect": profiles.effect(obstacle, profile),
                    "source": "Signalement PMR Maps", "fetched_at": str(r.get("created_at") or ""),
                    "label": f"Signalé : {(r.get('categorie') or '').replace('_', ' ')}",
                    "message": r.get("description") or "", "report_id": r.get("id")})
    length = line_length_m(line) if len(line) > 1 else 0.0
    if length > LONG_WALK_M:
        eff = profiles.effect("long_trajet_pied", profile, walk_m=length)
        out.append({"kind": "walk", "status": "obstacle", "confidence": 5, "obstacle": "long_trajet_pied",
                    "effect": eff, "source": "calcul PMR Maps", "fetched_at": None,
                    "label": "Long trajet à pied", "message": f"{round(length)} m à pied"})
    return out


# --- Journeys ------------------------------------------------------------------

def _stop(end: dict) -> Tuple[Optional[float], Optional[float], str, Optional[str]]:
    sp = (end or {}).get("stop_point") or {}
    c = sp.get("coord") or (end or {}).get("address", {}).get("coord") or {}
    lon, lat = c.get("lon"), c.get("lat")
    return (float(lon) if lon is not None else None, float(lat) if lat is not None else None,
            (end or {}).get("name") or "", (sp.get("stop_area") or {}).get("id"))


def _step_verdict(checks: List[dict]) -> str:
    return VERDICT[profiles.worst(c["effect"] for c in checks)]


def verify_journey(j: dict, profile: str, lifts_rows: List[dict], lifts_fetched_at: Optional[str] = None,
                   works: Iterable[dict] = (), works_fetched_at: Optional[str] = None,
                   stairs: Iterable[dict] = (), reports: Iterable[dict] = (),
                   reliability: Optional[Dict[str, dict]] = None, it_id: str = "it1",
                   now: Optional[datetime] = None) -> dict:
    profile = profiles.normalize(profile)
    works, stairs, reports = list(works), list(stairs), list(reports)
    steps: List[dict] = []
    for s in j.get("sections", []):
        stype = s.get("type")
        if stype in ("waiting", "boarding", "alighting", "park", "leave_parking"):
            continue
        info = s.get("display_informations") or {}
        f_lon, f_lat, f_name, f_area = _stop(s.get("from") or {})
        t_lon, t_lat, t_name, t_area = _stop(s.get("to") or {})
        line = ((s.get("geojson") or {}).get("coordinates")) or []
        step = {"type": {"public_transport": "transit", "transfer": "transfer"}.get(stype, "walk"),
                "from": f_name, "to": t_name, "line": info.get("code"), "mode": info.get("commercial_mode"),
                "duration_min": round((s.get("duration") or 0) / 60), "geojson": s.get("geojson"),
                "stop_areas": [a for a in (f_area, t_area) if a], "checks": []}
        if stype == "public_transport":
            mode = (info.get("commercial_mode") or "").lower()
            if any(m in mode for m in RAIL_MODES):
                for lon, lat, name, area, where in ((f_lon, f_lat, f_name, f_area, "from"),
                                                    (t_lon, t_lat, t_name, t_area, "to")):
                    if lon is None:
                        continue
                    c = lift_check(lon, lat, name, info.get("commercial_mode"), info.get("code"),
                                   lifts_rows, lifts_fetched_at, profile, reliability, info.get("direction"))
                    c["at"] = where
                    c["stop_area"] = area
                    step["checks"].append(c)
        elif line:
            step["checks"] = walk_checks(line, profile, works, stairs, reports, works_fetched_at, now)
        step["verdict"] = _step_verdict(step["checks"])
        steps.append(step)

    all_checks = [c for st in steps for c in st["checks"]]
    verdict = max((st["verdict"] for st in steps), key=_RANK.__getitem__, default="passe")
    blocking = next((c for st in steps for c in st["checks"] if c["effect"] == "bloquant"), None)
    lift_conf = [c["confidence"] for c in all_checks if c["kind"] == "lift"]
    return {
        "id": it_id,
        "duration_min": round((j.get("duration") or 0) / 60),
        "departure": j.get("departure_date_time"), "arrival": j.get("arrival_date_time"),
        "verdict": verdict,
        "confidence": min(lift_conf) if lift_conf else 3,
        "blocked_at": (blocking.get("station") or blocking["label"]) if blocking else None,
        "steps": steps,
        "plan_b_id": None,
    }


def blocking_stop_areas(itinerary: dict) -> List[str]:
    """Stop areas whose lifts block this profile: to forbid when asking Navitia for a plan B."""
    out: List[str] = []
    for st in itinerary["steps"]:
        for c in st["checks"]:
            if c["kind"] == "lift" and c["effect"] == "bloquant" and c.get("stop_area") and c["stop_area"] not in out:
                out.append(c["stop_area"])
    return out


def pick_plan_b(itineraries: List[dict]) -> List[dict]:
    """Best itinerary first if it does not block; otherwise point the first one to the best alternative."""
    if not itineraries:
        return itineraries
    first = itineraries[0]
    if first["verdict"] == "passe":
        return itineraries
    alt = sorted((it for it in itineraries[1:] if _RANK[it["verdict"]] < _RANK[first["verdict"]]),
                 key=lambda it: (_RANK[it["verdict"]], -it["confidence"], it["duration_min"]))
    if alt:
        first["plan_b_id"] = alt[0]["id"]
    return itineraries
