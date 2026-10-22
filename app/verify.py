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
from zoneinfo import ZoneInfo

from . import profiles

LIFT_RADIUS_M = 150     # lifts are geolocated at the station centroid
NEAR_WALK_M = 15        # fallback distance for obstacles given as lines or points
LONG_WALK_M = 400       # beyond this a walking step is flagged as long
REPORT_MAX_AGE_H = 24    # a live breakdown report older than this no longer overrides official data
PARIS = ZoneInfo("Europe/Paris")
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


def feature_bbox(geometry: dict) -> Optional[Tuple[float, float, float, float]]:
    pts = _vertices(geometry)
    if not pts:
        return None
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    return min(xs), min(ys), max(xs), max(ys)


def _bbox_apart(f: dict, line_box: Tuple[float, float, float, float], pad: float) -> bool:
    """Cheap reject with the feature's precomputed bbox (main._layer adds it once per layer)."""
    b = f.get("_bbox")
    if b is None:
        return False
    return b[2] < line_box[0] - pad or b[0] > line_box[2] + pad or b[3] < line_box[1] - pad or b[1] > line_box[3] + pad


def _rings(geometry: dict) -> List[List[List[float]]]:
    g = geometry or {}
    if g.get("type") == "Polygon":
        return list(g.get("coordinates") or [])
    if g.get("type") == "MultiPolygon":
        return [ring for poly in g.get("coordinates") or [] for ring in poly]
    return []


def _inside(p, ring) -> bool:
    x, y, inside = p[0], p[1], False
    for i in range(len(ring)):
        (x1, y1), (x2, y2) = ring[i][:2], ring[i - 1][:2]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            inside = not inside
    return inside


def _segments_cross(a, b, c, d) -> bool:
    def orient(p, q, r):
        return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
    return (orient(a, b, c) > 0) != (orient(a, b, d) > 0) and (orient(c, d, a) > 0) != (orient(c, d, b) > 0)


def _crosses(geometry: dict, line: List[List[float]], fbox: Optional[Tuple[float, float, float, float]] = None) -> bool:
    """True when the walking line enters a footprint (polygon); lines and points fall back to 5 m."""
    rings = _rings(geometry)
    if not rings:
        return _near_line(geometry, line, within=5)
    fbox = fbox or feature_bbox(geometry)
    if fbox is None:
        return False
    x0, y0, x1, y1 = fbox
    # only the parts of the walk that reach the footprint's box can cross it
    segs = [(line[i], line[i + 1]) for i in range(len(line) - 1)
            if not (max(line[i][0], line[i + 1][0]) < x0 or min(line[i][0], line[i + 1][0]) > x1
                    or max(line[i][1], line[i + 1][1]) < y0 or min(line[i][1], line[i + 1][1]) > y1)]
    if not segs:
        return False
    if any(_inside(p, r) for a, b in segs for p in (a, b) if x0 <= p[0] <= x1 and y0 <= p[1] <= y1 for r in rings):
        return True
    return any(_segments_cross(a, b, r[j - 1], r[j]) for a, b in segs for r in rings for j in range(len(r)))


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


# English labels for the community report categories (keys are the API values, kept in French).
REPORT_LABELS = {
    "escalier": "stairs", "marche": "step", "travaux": "roadworks", "trottoir_encombre": "blocked sidewalk",
    "trottoir_etroit": "narrow sidewalk", "bordure_haute": "high curb", "pente": "steep slope",
    "ascenseur_panne": "elevator out of order", "escalator_panne": "escalator out of order",
    "rampe": "ramp problem", "autre": "other problem",
}


def _count(n: int, noun: str) -> str:
    return f"{n} {noun}" + ("" if n == 1 else "s")


def _of(part: list, whole: list) -> str:
    """"1 of 3 elevators", "1 of 1 elevator"."""
    return f"{len(part)} of {_count(len(whole), 'elevator')}"


def _since(stamp: Optional[str]) -> str:
    if not stamp:
        return ""
    try:
        d = datetime.fromisoformat(stamp)
    except ValueError:
        return ""
    return f" (reported {d:%b} {d.day} at {d:%H:%M})"


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


def _as_dt(v) -> Optional[datetime]:
    """ISO string or datetime; naive values are Paris local time (IDFM liftstateupdate)."""
    if isinstance(v, str):
        try:
            v = datetime.fromisoformat(v)
        except ValueError:
            return None
    if not isinstance(v, datetime):
        return None
    return v if v.tzinfo else v.replace(tzinfo=PARIS)


def apply_lift_reports(rows: List[dict], reports: Iterable[dict], now: datetime) -> List[dict]:
    """Live community reports win over older official data.

    A lift reported broken (« Signaler une panne », target_type lift) after IDFM's last update for it,
    and less than REPORT_MAX_AGE_H ago, is treated as broken until the official data catches up.
    """
    newest: Dict[str, dict] = {}
    for r in reports:
        if r.get("categorie") != "ascenseur_panne" or r.get("target_type") != "lift" or not r.get("target_id"):
            continue
        created = _as_dt(r.get("created_at"))
        if created is None or (now - created).total_seconds() > REPORT_MAX_AGE_H * 3600:
            continue
        key = str(r["target_id"])
        if key not in newest or created > _as_dt(newest[key]["created_at"]):
            newest[key] = r
    if not newest:
        return rows
    out = []
    for row in rows:
        rep = newest.get(str(row.get("liftid")))
        official = _as_dt(row.get("liftstateupdate"))
        created = _as_dt(rep["created_at"]) if rep else None
        if rep and row.get("liftstatus") != "notavailable" and (official is None or created > official):
            row = {**row, "liftstatus": "notavailable", "liftstatus_official": row.get("liftstatus"),
                   "liftstateupdate_official": row.get("liftstateupdate"),
                   "liftstateupdate": created.astimezone(PARIS).strftime("%Y-%m-%dT%H:%M"),
                   "reported": True, "report_confidence": _report_confidence(rep, now)}
        out.append(row)
    return out


def _nearby_lift_reports(reports: List[dict], lon: float, lat: float, relevant: List[dict],
                         now: datetime) -> List[dict]:
    """Broken-elevator reports made near this station without naming a lift (photo, voice, text),
    less than REPORT_MAX_AGE_H old and newer than the latest official update of its elevators."""
    official = [d for d in (_as_dt(r.get("liftstateupdate_official") or r.get("liftstateupdate")) for r in relevant) if d]
    latest = max(official) if official else None
    out = []
    for r in reports:
        if r.get("categorie") != "ascenseur_panne" or r.get("target_type") == "lift" or r.get("lon") is None:
            continue
        created = _as_dt(r.get("created_at"))
        if created is None or (now - created).total_seconds() > REPORT_MAX_AGE_H * 3600:
            continue
        if latest is not None and created <= latest:
            continue
        if dist_m(lon, lat, float(r["lon"]), float(r["lat"])) <= LIFT_RADIUS_M:
            out.append(r)
    return out


def lift_check(lon: float, lat: float, station: str, mode: Optional[str], code: Optional[str],
               lifts_rows: Iterable[dict], fetched_at: Optional[str], profile: str,
               reliability: Optional[Dict[str, dict]] = None, direction: Optional[str] = None,
               stop_area: Optional[str] = None, reports: Iterable[dict] = (),
               now: Optional[datetime] = None) -> dict:
    """Lift status for one line at one station.

    Only lifts that mention the line count when some do; among them, only those serving the
    platform of the travel direction (or "toutes directions") when the descriptions say so.
    """
    reports = list(reports)
    now = now or datetime.now(timezone.utc)
    lifts_rows = apply_lift_reports(list(lifts_rows), reports, now)
    zdc = (stop_area or "").rsplit(":", 1)[-1]  # Navitia stop_area:IDFM:71485 <-> IDFM zdcid 71485
    near = [r for r in lifts_rows if zdc and str(r.get("zdcid")) == zdc]
    if not near:  # big stations: the stop point can be far from the station centroid
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
    def label(plural: bool) -> str:
        noun = "elevators" if plural else "elevator"
        return f"Line {code} {noun} at {station}" if code else f"{noun.capitalize()} at {station}"

    base = {"kind": "lift", "source": "IDFM – Elevator status", "fetched_at": fetched_at,
            "station": station, "zdcid": (relevant[0].get("zdcid") if relevant else None),
            "lift_ids": [r.get("liftid") for r in relevant]}
    rel = _worst_reliability(relevant, reliability)
    if rel:
        base.update(reliability=rel["availability"], reliability_window_days=rel["window_days"],
                    reliability_outages=rel.get("outages"), reliability_source=rel["source"])
    rel_text = (f" History: working {round(rel['availability'] * 100)}% of the time from 6 am to 9 pm "
                f"over the last {rel['window_days']:g} days, {_count(rel.get('outages', 0), 'outage')}.") if rel else ""

    full = profiles.effect("ascenseur_panne", profile)
    if not relevant:
        eff = _at_most_genant(full)
        return {**base, "status": "inconnu", "confidence": 1, "obstacle": "ascenseur_panne", "effect": eff,
                "label": f"Elevators at {station}", "message": "No elevator data for this station"}
    conf = 5 if matched_line else 3  # 3: we could not tell which lift serves this line
    reported = [r for r in down if r.get("reported")]
    if reported:
        # a live user report overrides older official data: say so, with the report's own confidence
        base["source"] = "Roulib report, newer than the IDFM data"
        conf = max(r["report_confidence"] for r in reported)
        rel_text = (f" Reported out of order by a user after the latest official update "
                    f"(IDFM: \"{'working' if reported[0].get('liftstatus_official') == 'available' else 'unknown'}\").") + rel_text
    if down and not up:
        since = _since(min((r.get("liftstateupdate") or "") for r in down) or None)
        unknown = len(relevant) - len(down)
        extra = f", {unknown} with unknown status" if unknown else ""
        return {**base, "status": "en_panne", "confidence": conf, "obstacle": "ascenseur_panne", "effect": full,
                "label": label(False),
                "message": f"{_of(down, relevant)} out of order{since}{extra}, none confirmed working.{rel_text}"}
    nearby = _nearby_lift_reports(reports, lon, lat, relevant, now)
    if nearby and not down:
        # a photo, voice or text report of a broken elevator here, newer than the official data,
        # corrects it: the step becomes risky until someone confirms or IDFM updates
        r = max(nearby, key=lambda x: _as_dt(x["created_at"]))
        at = _as_dt(r["created_at"]).astimezone(PARIS)
        return {**base, "status": "signale", "confidence": _report_confidence(r, now), "obstacle": "ascenseur_panne",
                "effect": _at_most_genant(full), "label": label(True),
                "source": "Roulib report (photo, voice or text), newer than the IDFM data",
                "message": f"A user reported a broken elevator here at {at:%H:%M}, after the latest official update. "
                           f"Check before you go.{rel_text}", "report_id": r.get("id")}
    if down:
        eff = _at_most_genant(full)
        return {**base, "status": "partiel", "confidence": conf, "obstacle": "ascenseur_panne", "effect": eff,
                "label": label(True),
                "message": f"{_of(down, relevant)} out of order: check that yours is working.{rel_text}"}
    if not up:
        eff = _at_most_genant(full)
        return {**base, "status": "inconnu", "confidence": 1, "obstacle": "ascenseur_panne", "effect": eff,
                "label": label(True), "message": "Elevator status unknown"}
    if rel and rel["availability"] < UNRELIABLE_BELOW:
        return {**base, "status": "ok", "confidence": conf, "obstacle": "ascenseur_panne",
                "effect": _at_most_genant(full), "label": label(True),
                "message": f"{_count(len(up), 'elevator')} working, but often out of order: have a Plan B ready.{rel_text}"}
    return {**base, "status": "ok", "confidence": conf, "obstacle": None, "effect": "sans_effet",
            "label": label(True),
            "message": f"{_count(len(up), 'elevator')} working.{rel_text}"}


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
    xs, ys = [p[0] for p in line], [p[1] for p in line]
    box = (min(xs), min(ys), max(xs), max(ys))
    for f in works:
        if _bbox_apart(f, box, 1e-4):
            continue
        if _crosses(f.get("geometry"), line, f.get("_bbox")):
            p = f.get("properties") or {}
            # a sidewalk worksite usually leaves a way round: never more than "genant" on its own
            eff = _at_most_genant(profiles.effect("trottoir_etroit", profile))
            out.append({"kind": "works", "status": "obstacle", "confidence": 5, "obstacle": "trottoir_etroit",
                        "effect": eff, "source": "Ville de Paris – Roadworks in Paris", "fetched_at": works_fetched_at,
                        "label": "Sidewalk works",
                        "message": f"{p.get('summary') or 'Roadworks'}" + (f" (until {p['end']})" if p.get("end") else "")})
    for f in stairs:
        if _bbox_apart(f, box, 1e-4):
            continue
        if _crosses(f.get("geometry"), line, f.get("_bbox")):
            out.append({"kind": "stairs", "status": "obstacle", "confidence": 3, "obstacle": "escalier",
                        "effect": profiles.effect("escalier", profile),
                        "source": "Ville de Paris – Stepped streets", "fetched_at": None,
                        "label": "Stepped street", "message": "The only way through is by steps"})
    for r in reports:
        if r.get("lon") is None or point_to_line_m([r["lon"], r["lat"]], line) > 30:
            continue
        obstacle = profiles.REPORT_TO_OBSTACLE.get(r.get("categorie") or "")
        if not obstacle:
            continue
        out.append({"kind": "report", "status": "obstacle", "confidence": _report_confidence(r, now),
                    "obstacle": obstacle, "effect": profiles.effect(obstacle, profile),
                    "source": "Roulib community report", "fetched_at": str(r.get("created_at") or ""),
                    "label": f"Reported: {REPORT_LABELS.get(r.get('categorie') or '', (r.get('categorie') or 'obstacle').replace('_', ' '))}",
                    "message": r.get("description") or "", "report_id": r.get("id")})
    length = line_length_m(line) if len(line) > 1 else 0.0
    if length > LONG_WALK_M:
        eff = profiles.effect("long_trajet_pied", profile, walk_m=length)
        out.append({"kind": "walk", "status": "obstacle", "confidence": 5, "obstacle": "long_trajet_pied",
                    "effect": eff, "source": "Roulib calculation", "fetched_at": None,
                    "label": "Long walk", "message": f"{round(length)} m on foot"})
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
                "direction": info.get("direction"),
                "duration_min": round((s.get("duration") or 0) / 60), "geojson": s.get("geojson"),
                "stop_areas": [a for a in (f_area, t_area) if a], "checks": []}
        if step["type"] == "transit" and f_name and f_name == t_name and step["duration_min"] <= 0:
            continue  # zero-length hop inside one station ("M 14, -1 min, Châtelet -> Châtelet"): noise
        if stype == "public_transport":
            mode = (info.get("commercial_mode") or "").lower()
            if any(m in mode for m in RAIL_MODES) and not (f_area and f_area == t_area):  # same-station hop
                for lon, lat, name, area, where in ((f_lon, f_lat, f_name, f_area, "from"),
                                                    (t_lon, t_lat, t_name, t_area, "to")):
                    if lon is None:
                        continue
                    c = lift_check(lon, lat, name, info.get("commercial_mode"), info.get("code"),
                                   lifts_rows, lifts_fetched_at, profile, reliability, info.get("direction"), area,
                                   reports, now)
                    c["at"] = where
                    c["stop_area"] = area
                    step["checks"].append(c)
        elif line and stype == "crow_fly":
            # straight line drawn by Navitia, not a real path: only its length means something
            step["checks"] = walk_checks(line, profile, now=now)
        elif line:
            step["checks"] = walk_checks(line, profile, works, stairs, reports, works_fetched_at, now)
        step["verdict"] = _step_verdict(step["checks"])
        steps.append(step)

    all_checks = [c for st in steps for c in st["checks"]]
    verdict = max((st["verdict"] for st in steps), key=_RANK.__getitem__, default="passe")
    blocking_step = next((st for st in steps for c in st["checks"] if c["effect"] == "bloquant"), None)
    blocking = next((c for c in blocking_step["checks"] if c["effect"] == "bloquant"), None) if blocking_step else None
    lift_conf = [c["confidence"] for c in all_checks if c["kind"] == "lift"]
    return {
        "id": it_id,
        "duration_min": round((j.get("duration") or 0) / 60),
        "departure": j.get("departure_date_time"), "arrival": j.get("arrival_date_time"),
        "verdict": verdict,
        "confidence": min(lift_conf) if lift_conf else 3,
        "blocked_at": (blocking.get("station") or blocking["label"]) if blocking else None,
        # What blocks and where, for a readable title: "Stepped street" after "Bastille".
        "blocked_reason": blocking["label"] if blocking else None,
        "blocked_near": (blocking.get("station") or blocking_step.get("from")) if blocking else None,
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
