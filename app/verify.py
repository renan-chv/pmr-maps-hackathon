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


# Labels of the community report categories shown in the app (keys are the API values).
REPORT_LABELS = {
    "escalier": "escalier", "marche": "marche", "travaux": "travaux", "trottoir_encombre": "trottoir encombré",
    "trottoir_etroit": "trottoir étroit", "bordure_haute": "bordure haute", "pente": "pente forte",
    "ascenseur_panne": "ascenseur en panne", "escalator_panne": "escalator en panne",
    "rampe": "problème de rampe", "autre": "autre problème",
}
NB = "\u00a0"  # no-break space, before « : ; ? ! » and inside « »


def _count(n: int, noun: str, plural: Optional[str] = None) -> str:
    """"1 ascenseur", "2 ascenseurs", "0 panne" (French: singular up to 1), "3 feux" with plural="feux"."""
    return f"{n} {noun if n <= 1 else (plural or noun + 's')}"


def _num(x: float) -> str:
    """11.2 -> "11,2", 1200 -> "1 200" (French separators)."""
    if isinstance(x, float) and not x.is_integer():
        return f"{x:g}".replace(".", ",")
    return f"{round(x):,}".replace(",", NB)


def _lc(s: str) -> str:
    """"Construction ou réhabilitation" -> "construction ou réhabilitation"; "RER A" stays."""
    return s[0].lower() + s[1:] if len(s) > 1 and s[0].isupper() and s[1].islower() else s


_MONTHS = ("janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre",
           "novembre", "décembre")


def date_fr(s: Optional[str]) -> str:
    """"2026-12-31" -> "31 décembre 2026", "2026-11-01" -> "1er novembre 2026"; anything else unchanged."""
    m = re.match(r"(\d{4})-(\d\d)-(\d\d)", s or "")
    if not m or not 1 <= int(m.group(2)) <= 12:
        return s or ""
    day = int(m.group(3))
    return f"{'1er' if day == 1 else day} {_MONTHS[int(m.group(2)) - 1]} {m.group(1)}"


def _of(part: list, whole: list) -> str:
    """"1 ascenseur sur 3", "2 ascenseurs sur 3"."""
    return f"{_count(len(part), 'ascenseur')} sur {len(whole)}"


def _since(stamp: Optional[str]) -> str:
    if not stamp:
        return ""
    try:
        d = datetime.fromisoformat(stamp)
    except ValueError:
        return ""
    return f" (signalé le {d:%d/%m} à {d:%H:%M})"


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
        noun = "Ascenseurs" if plural else "Ascenseur"
        return f"{noun} ligne {code} à {station}" if code else f"{noun} à {station}"

    base = {"kind": "lift", "source": "IDFM – État des ascenseurs", "fetched_at": fetched_at,
            "station": station, "zdcid": (relevant[0].get("zdcid") if relevant else None),
            "lift_ids": [r.get("liftid") for r in relevant]}
    rel = _worst_reliability(relevant, reliability)
    if rel:
        base.update(reliability=rel["availability"], reliability_window_days=rel["window_days"],
                    reliability_outages=rel.get("outages"), reliability_source=rel["source"])
    outages = rel.get("outages", 0) if rel else 0
    rel_text = (f" Historique{NB}: en service {round(rel['availability'] * 100)}{NB}% du temps de 6{NB}h à 21{NB}h "
                f"sur les {_num(float(rel['window_days']))} derniers jours, "
                f"{_count(outages, 'panne') if outages else 'aucune panne'}.") if rel else ""

    full = profiles.effect("ascenseur_panne", profile)
    if not relevant:
        eff = _at_most_genant(full)
        return {**base, "status": "inconnu", "confidence": 1, "obstacle": "ascenseur_panne", "effect": eff,
                "label": f"Ascenseurs à {station}", "message": "Aucune donnée d'ascenseur pour cette station"}
    conf = 5 if matched_line else 3  # 3: we could not tell which lift serves this line
    reported = [r for r in down if r.get("reported")]
    if reported:
        # a live user report overrides older official data: say so, with the report's own confidence
        base["source"] = "Signalement Roulib, plus récent que l'info IDFM"
        conf = max(r["report_confidence"] for r in reported)
        official = "en service" if reported[0].get("liftstatus_official") == "available" else "inconnu"
        rel_text = (f" Signalé en panne par un utilisateur après la dernière mise à jour officielle "
                    f"(IDFM{NB}: «{NB}{official}{NB}»).") + rel_text
    if down and not up:
        since = _since(min((r.get("liftstateupdate") or "") for r in down) or None)
        unknown = len(relevant) - len(down)
        extra = f", {unknown} à l'état inconnu" if unknown else ""
        return {**base, "status": "en_panne", "confidence": conf, "obstacle": "ascenseur_panne", "effect": full,
                "label": label(False),
                "message": (f"L'ascenseur est en panne{since}.{rel_text}" if len(relevant) == 1 else
                            f"{_of(down, relevant)} en panne{since}{extra}, aucun en service confirmé.{rel_text}")}
    nearby = _nearby_lift_reports(reports, lon, lat, relevant, now)
    if nearby and not down:
        # a photo, voice or text report of a broken elevator here, newer than the official data,
        # corrects it: the step becomes risky until someone confirms or IDFM updates
        r = max(nearby, key=lambda x: _as_dt(x["created_at"]))
        at = _as_dt(r["created_at"]).astimezone(PARIS)
        return {**base, "status": "signale", "confidence": _report_confidence(r, now), "obstacle": "ascenseur_panne",
                "effect": _at_most_genant(full), "label": label(True),
                "source": "Signalement Roulib (photo, voix ou texte), plus récent que l'info IDFM",
                "message": f"Un utilisateur a signalé un ascenseur en panne ici à {at:%H:%M}, après la dernière mise à "
                           f"jour officielle. Vérifiez avant de partir.{rel_text}", "report_id": r.get("id")}
    if down:
        eff = _at_most_genant(full)
        return {**base, "status": "partiel", "confidence": conf, "obstacle": "ascenseur_panne", "effect": eff,
                "label": label(True),
                "message": f"{_of(down, relevant)} en panne{NB}: vérifiez que le vôtre fonctionne.{rel_text}"}
    if not up:
        eff = _at_most_genant(full)
        return {**base, "status": "inconnu", "confidence": 1, "obstacle": "ascenseur_panne", "effect": eff,
                "label": label(True), "message": "État des ascenseurs inconnu"}
    if rel and rel["availability"] < UNRELIABLE_BELOW:
        return {**base, "status": "ok", "confidence": conf, "obstacle": "ascenseur_panne",
                "effect": _at_most_genant(full), "label": label(True),
                "message": f"{_count(len(up), 'ascenseur')} en service, mais souvent en panne{NB}: prévoyez un plan B.{rel_text}"}
    return {**base, "status": "ok", "confidence": conf, "obstacle": None, "effect": "sans_effet",
            "label": label(True),
            "message": f"{_count(len(up), 'ascenseur')} en service.{rel_text}"}


# --- Walking steps -------------------------------------------------------------

def _report_confidence(r: dict, now: datetime) -> int:
    created = _as_dt(r.get("created_at"))  # naive stamps are Paris time, never a crash on aware - naive
    if now.tzinfo is None:
        now = now.replace(tzinfo=PARIS)
    age_h = (now - created).total_seconds() / 3600 if created is not None else 0.0
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
    crossed = [f for f in works if not _bbox_apart(f, box, 1e-4) and _crosses(f.get("geometry"), line, f.get("_bbox"))]
    works_line = works_summary(crossed, profile, works_fetched_at)
    if works_line:
        out.append(works_line)
    for f in stairs:
        if _bbox_apart(f, box, 1e-4):
            continue
        if _crosses(f.get("geometry"), line, f.get("_bbox")):
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
                    "source": "Signalement de la communauté Roulib", "fetched_at": str(r.get("created_at") or ""),
                    "label": f"Signalé{NB}: {REPORT_LABELS.get(r.get('categorie') or '', (r.get('categorie') or 'obstacle').replace('_', ' '))}",
                    "message": r.get("description") or "", "report_id": r.get("id")})
    length = line_length_m(line) if len(line) > 1 else 0.0
    walk = long_walk_check(length, profile)
    if walk:
        out.append(walk)
    return out


def stairs_unknown_check(profile: str) -> Optional[dict]:
    """The stepped-streets layer could not be loaded: unknown is never shown as clear (risk, not a block)."""
    full = profiles.effect("escalier", profile)
    if full == "sans_effet":
        return None
    return {"kind": "stairs", "status": "inconnu", "confidence": 1, "obstacle": "escalier",
            "effect": _at_most_genant(full), "source": "Ville de Paris – Voies en escalier", "fetched_at": None,
            "label": "Rues en escalier", "message": f"Les données des rues en escalier sont indisponibles pour l'instant{NB}: "
                                                    "les marches n'ont pas pu être vérifiées sur ce trajet."}


def works_summary(crossed: List[dict], profile: str, fetched_at: Optional[str] = None) -> Optional[dict]:
    """One line for all the sidewalk worksites along a walk, never one per worksite.

    The open-data layer only says that a worksite takes up part of the sidewalk, and a way round is almost
    always left: it is information, not something to act on, so it never raises the verdict.
    """
    if not crossed or profiles.effect("trottoir_etroit", profile) == "sans_effet":
        return None
    n = len(crossed)
    first = crossed[0].get("properties") or {}
    what = _lc(first.get("summary") or "Travaux")
    until = f", jusqu'au {date_fr(first['end'])}" if first.get("end") else ""
    return {"kind": "works", "status": "info", "confidence": 5, "obstacle": None, "effect": "sans_effet",
            "count": n, "source": "Ville de Paris – Chantiers à Paris", "fetched_at": fetched_at,
            "label": "Travaux sur le trottoir",
            "message": (f"Un chantier sur le trottoir le long de ce trajet ({what}{until}){NB}; en général on passe, "
                        "mais le trottoir peut être plus étroit." if n == 1 else
                        f"{n} chantiers sur le trottoir le long de ce trajet{NB}; en général on passe, mais le trottoir "
                        f"peut être plus étroit. Le premier{NB}: {what}{until}.")}


def long_walk_check(length: float, profile: str) -> Optional[dict]:
    """A walk (or roll) long enough to matter for this profile: a risk past its warning threshold,
    blocking past its limit (profiles.LONG_WALK_WARN_M and LONG_WALK_BLOCKING_M). Nothing below."""
    eff = profiles.effect("long_trajet_pied", profile, walk_m=length)
    if eff == "sans_effet":
        return None
    word = profiles.walk_word(profile)
    limit = profiles.LONG_WALK_BLOCKING_M.get(profiles.normalize(profile))
    advice = (f"plus de {_num(limit)}{NB}m, c'est trop loin pour ce profil." if eff == "bloquant"
              else "prévoyez une pause en chemin.")
    # Computed by Roulib from the route: no live data behind it, hence no confidence level.
    # The label starts with "Long trajet": the app turns a blocking one into "Trop loin à pied / en fauteuil".
    return {"kind": "walk", "status": "obstacle", "confidence": None, "obstacle": "long_trajet_pied",
            "effect": eff, "source": "Calcul Roulib", "fetched_at": None, "length_m": round(length),
            "label": f"Long trajet {word}", "message": f"{_num(round(length))}{NB}m {word}{NB}: {advice}"}


# --- Visually impaired travellers ------------------------------------------------
# Input: sources.low_vision(), one entry per layer ({"fetched_at", "rows"} or None when unavailable).
# A missing layer or an unmatched stop gives an "unknown" check, never a crash and never a block.

LV_STOP_RADIUS_M = 200     # Navitia stop point -> IDFM stops of the same mode
LV_SAME_STATION_M = 80     # other quays of the same station, beyond the nearest one
LV_ASSIST_RADIUS_M = 300   # SNCF gives one point per station, sometimes far from the platforms
CROSSING_NEAR_M = 20       # pedestrian signal head this close to the walking path (Navitia often follows the street axis)
COVERAGE_M = 300           # no traffic light at all this close: outside Paris, where nothing is mapped
_GRID = 0.002              # degrees, about 150 x 220 m
_ARRTYPE = (("métro", "metro"), ("metro", "metro"), ("rer", "rail"), ("train", "rail"), ("transilien", "rail"),
            ("ter", "rail"), ("tram", "tram"), ("câble", "cableway"), ("cable", "cableway"), ("bus", "bus"),
            ("noctilien", "bus"))
_SNCF_MODES = ("rer", "train", "transilien", "ter")
LV_SRC = {
    "stop": "IDFM – Référentiel des arrêts", "line": "IDFM – Référentiel des lignes", "assist": "SNCF – Assistance en gare",
    "equip": "SNCF – Équipements d'accessibilité en gare", "lights": "Ville de Paris – Feux piétons sonores",
}
_lv_cache: Dict[tuple, Tuple[list, dict]] = {}


def cares_about_low_vision(profile: str) -> bool:
    """Only profiles for which a missing announcement matters get these checks (others stay unchanged)."""
    return any(profiles.effect(o, profile) != "sans_effet" for o in profiles.LOW_VISION_OBSTACLES)


def _grid_key(lon: float, lat: float) -> Tuple[int, int]:
    return math.floor(lon / _GRID), math.floor(lat / _GRID)


def _grid_add(grid: Dict[Tuple[int, int], list], lon: float, lat: float, item) -> None:
    grid.setdefault(_grid_key(lon, lat), []).append(item)


def _grid_near(grid: Dict[Tuple[int, int], list], lon: float, lat: float, radius_m: float) -> list:
    reach = int(radius_m / 150) + 1
    gx, gy = _grid_key(lon, lat)
    return [it for dx in range(-reach, reach + 1) for dy in range(-reach, reach + 1) for it in grid.get((gx + dx, gy + dy), ())]


def _point(row: dict, field: str) -> Optional[Tuple[float, float]]:
    g = row.get(field) or {}
    try:
        return float(g["lon"]), float(g["lat"])
    except (KeyError, TypeError, ValueError):
        return None


def _layer_stamp(layer: Optional[dict]) -> Optional[str]:
    return layer.get("fetched_at") if layer else None


def low_vision_index(lv: Dict[str, Optional[dict]]) -> dict:
    """Spatial and id indexes of the raw layers, built once per upstream refresh."""
    # sources.cached returns the same objects until the next refresh: identity is the right key.
    # The cache keeps the layers alive, so their ids cannot be reused by other objects meanwhile.
    key = tuple((k, id(v), _layer_stamp(v)) for k, v in sorted(lv.items()))
    if key in _lv_cache:
        return _lv_cache[key][1]
    idx: dict = {"stops": None, "stops_by_id": {}, "lines": None, "assist": None, "equip": None,
                 "lights": None, "sound": None, "at": {k: _layer_stamp(v) for k, v in lv.items()}}
    if lv.get("stop_signals"):
        idx["stops"] = {}
        for r in lv["stop_signals"]["rows"]:
            p = _point(r, "arrgeopoint")
            if p:
                item = (p[0], p[1], r)
                _grid_add(idx["stops"], p[0], p[1], item)
                idx["stops_by_id"][str(r.get("arrid"))] = item
    if lv.get("line_signals"):
        idx["lines"] = {str(r.get("id_line")): r for r in lv["line_signals"]["rows"] if r.get("id_line")}
    if lv.get("sncf_assistance"):
        idx["assist"] = [(p[0], p[1], r) for r in lv["sncf_assistance"]["rows"] if (p := _point(r, "position_geographique"))]
    if lv.get("sncf_equipment"):
        idx["equip"] = {}
        for r in lv["sncf_equipment"]["rows"]:
            item = (r.get("accessibilite") or "").strip()
            # keyed by UIC code and by name: Paris Gare de Lyon is 87686006 here, 87686030 in the assistance list
            # (not named `key`: that is the cache key below, and overwriting it rebuilt the index on every journey)
            for station_key in (str(r.get("uic")), (r.get("nom_de_la_gare") or "").strip().lower()):
                idx["equip"].setdefault(station_key, set()).add(item)
    if lv.get("crossing_lights") and lv.get("sound_modules"):
        idx["lights"] = {}
        for r in lv["crossing_lights"]["rows"]:
            p = _point(r, "geo_point_2d")
            if p and r.get("cod_ouvrag"):
                _grid_add(idx["lights"], p[0], p[1], (p[0], p[1], str(r["cod_ouvrag"])))
        idx["sound"] = {str(r["code_ouvrage"]) for r in lv["sound_modules"]["rows"] if r.get("code_ouvrage")}
    if len(_lv_cache) > 4:
        _lv_cache.clear()
    _lv_cache[key] = (list(lv.values()), idx)
    return idx


def _arrtype(mode: Optional[str]) -> Optional[str]:
    m = (mode or "").lower()
    return next((t for word, t in _ARRTYPE if word in m), None)


def _stop_rows(idx: dict, lon: float, lat: float, mode: Optional[str], stop_point_id: Optional[str]) -> List[dict]:
    """IDFM stops of this station and mode: the exact stop point when Navitia gives its id, else the nearest quays."""
    m = re.fullmatch(r"stop_point:IDFM:(\d+)", stop_point_id or "")
    if m and m.group(1) in idx["stops_by_id"]:
        return [idx["stops_by_id"][m.group(1)][2]]
    kind = _arrtype(mode)
    near = [(dist_m(lon, lat, x, y), r) for x, y, r in _grid_near(idx["stops"], lon, lat, LV_STOP_RADIUS_M)
            if r.get("arrtype") == kind]
    near = [(d, r) for d, r in near if d <= LV_STOP_RADIUS_M]
    if not near:
        return []
    closest = min(d for d, _ in near)
    return [r for d, r in near if d <= closest + LV_SAME_STATION_M]


def _sncf_stations(idx: dict, lon: float, lat: float) -> List[dict]:
    """SNCF stations around this stop, nearest first (big hubs have several: Gare de Lyon main line and RER)."""
    near = sorted((d, i, r) for i, (x, y, r) in enumerate(idx["assist"] or [])
                  if (d := dist_m(lon, lat, x, y)) <= LV_ASSIST_RADIUS_M)
    return [r for _, _, r in near]


def _sncf_listed(idx: dict, stations: List[dict]) -> set:
    """Equipment SNCF lists for any of these stations (joined on the UIC code)."""
    equip = idx["equip"] or {}
    return set().union(*[equip.get(str(r.get("code_uic")), set()) | equip.get((r.get("nom_gare") or "").strip().lower(), set())
                         for r in stations])


def _combine(values: List[str]) -> str:
    """true / false / partial / unknown over the quays of one station (unknown quays are ignored)."""
    known = [v for v in values if v in ("true", "false", "partial")]
    if not known:
        return "unknown"
    if "false" in known:
        return "false"
    return "true" if all(v == "true" for v in known) else "partial"


def station_audio_check(lon: float, lat: float, station: str, mode: Optional[str], stop_point_id: Optional[str],
                        idx: dict, profile: str) -> dict:
    """Spoken (and displayed) next-departure information at the stop, from IDFM, else from the SNCF list."""
    obstacle = "pas_annonce_sonore"
    base = {"kind": "audio", "station": station, "label": f"Annonces sonores à {station}",
            "source": LV_SRC["stop"], "fetched_at": idx["at"].get("stop_signals")}
    rows = _stop_rows(idx, lon, lat, mode, stop_point_id) if idx["stops"] is not None else []
    audio = _combine([r.get("arraudiblesignals") for r in rows])
    visual = _combine([r.get("arrvisualsigns") for r in rows])
    screens = {"true": " Écrans des prochains départs aussi.", "partial": " Écrans des prochains départs sur une partie de la gare.",
               "false": " Pas d'écran des prochains départs."}.get(visual, "")
    if audio == "unknown" and (mode or "").lower().startswith(_SNCF_MODES):
        listed = _sncf_listed(idx, _sncf_stations(idx, lon, lat))
        if "Information sonore en gare et/ou sur les quais" in listed:
            return {**base, "status": "ok", "confidence": 3, "obstacle": None, "effect": "sans_effet",
                    "source": LV_SRC["equip"], "fetched_at": idx["at"].get("sncf_equipment"),
                    "message": "La SNCF indique des annonces sonores en gare ou sur les quais."}
    if audio == "true":
        return {**base, "status": "ok", "confidence": 3, "obstacle": None, "effect": "sans_effet",
                "message": "Les prochains départs sont annoncés à voix haute à cet arrêt." + screens}
    if audio == "false":
        return {**base, "status": "absent", "confidence": 3, "obstacle": obstacle,
                "effect": _at_most_genant(profiles.effect(obstacle, profile)),
                "message": f"Pas d'annonce sonore à cet arrêt, selon IDFM{NB}: demandez au personnel ou à d'autres voyageurs." + screens}
    if audio == "partial":
        return {**base, "status": "partiel", "confidence": 3, "obstacle": obstacle,
                "effect": _at_most_genant(profiles.effect(obstacle, profile)),
                "message": "Annonces sonores sur une partie de la gare seulement, selon IDFM." + screens}
    why = "Données IDFM indisponibles pour l'instant." if idx["stops"] is None else "IDFM n'a pas encore d'information pour cet arrêt."
    return {**base, "status": "inconnu", "confidence": 1, "obstacle": None, "effect": "sans_effet",
            "message": f"On ne sait pas si les départs sont annoncés à voix haute. {why}"}


def _line_id(section: dict) -> Optional[str]:
    """IDFM line id (C01371) from the Navitia links of a section (line:IDFM:C01371)."""
    info = section.get("display_informations") or {}
    for link in (section.get("links") or []) + (info.get("links") or []):
        m = re.fullmatch(r"line:IDFM:(\w+)", str(link.get("id") or "")) if link.get("type") == "line" else None
        if m:
            return m.group(1)
    return None


def onboard_audio_check(line_id: Optional[str], mode: Optional[str], code: Optional[str], idx: dict,
                        profile: str) -> Optional[dict]:
    """Next-stop announcements inside the vehicle. Only shown when IDFM says something about this line."""
    row = (idx["lines"] or {}).get(line_id or "")
    value = (row or {}).get("audiblesigns_available")
    if value not in ("true", "false", "partial"):
        return None
    obstacle = "pas_annonce_sonore"
    base = {"kind": "audio", "label": f"Annonces à bord, {mode or 'ligne'} {code or ''}".strip(),
            "source": LV_SRC["line"], "fetched_at": idx["at"].get("line_signals"), "confidence": 3, "at": "board"}
    if value == "true":
        return {**base, "status": "ok", "obstacle": None, "effect": "sans_effet",
                "message": "Le prochain arrêt est annoncé à voix haute à bord."}
    eff = _at_most_genant(profiles.effect(obstacle, profile))
    if value == "partial":
        return {**base, "status": "partiel", "obstacle": obstacle, "effect": eff,
                "message": f"Seuls certains véhicules de cette ligne annoncent le prochain arrêt à voix haute{NB}: comptez les arrêts ou demandez au conducteur."}
    return {**base, "status": "absent", "obstacle": obstacle, "effect": eff,
            "message": f"Le prochain arrêt n'est pas annoncé à voix haute sur cette ligne, selon IDFM{NB}: comptez les arrêts ou demandez au conducteur."}


def assistance_checks(lon: float, lat: float, station: str, mode: Optional[str], idx: dict,
                      now: datetime) -> List[dict]:
    """SNCF staff assistance and platform warning strips. Facts only: SNCF does not list what is missing."""
    if not (mode or "").lower().startswith(_SNCF_MODES):
        return []
    stations = _sncf_stations(idx, lon, lat)
    if not stations:
        return []
    sncf = stations[0]
    day = sources_weekday(now)
    today = sncf.get(f"horaires_jour_nominal_{day}")
    hours = ("du premier au dernier train" if sncf.get("premierauderniertrain")
             else f"aujourd'hui {today}" if today else None)
    how = "réservez à l'avance ou demandez sur place" if "SPONTANE" in (sncf.get("typepriseencharge") or "") else "réservez à l'avance"
    free = "gratuit, " if sncf.get("typetarification") == "GRATUIT" else ""
    out = [{"kind": "assistance", "station": station, "label": f"Assistance en gare à {station}",
            "status": "ok" if hours else "inconnu", "confidence": 3, "obstacle": None,
            "effect": "sans_effet", "source": LV_SRC["assist"], "fetched_at": idx["at"].get("sncf_assistance"),
            "message": f"Le personnel SNCF peut vous accompagner jusqu'à votre train ({free}{how}), {hours}." if hours
            else f"Le personnel SNCF peut vous accompagner jusqu'à votre train ({free}{how}), mais pas ce jour de la semaine."}]
    listed = _sncf_listed(idx, stations)
    if "Bande d'éveil de vigilance sur les quais" in listed:
        out.append({"kind": "tactile", "station": station, "label": f"Bandes d'éveil à {station}",
                    "status": "ok", "confidence": 3, "obstacle": None, "effect": "sans_effet",
                    "source": LV_SRC["equip"], "fetched_at": idx["at"].get("sncf_equipment"),
                    "message": "Bandes d'éveil de vigilance le long des quais."})
    return out


def sources_weekday(now: datetime) -> str:
    """French weekday name used by the SNCF hours columns (horaires_jour_nominal_lundi…)."""
    return ("lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche")[now.astimezone(PARIS).weekday()]


def crossing_check(line: List[List[float]], idx: dict, profile: str) -> Optional[dict]:
    """Traffic lights along the walk and how many have an audible signal (répétiteur sonore, Paris only)."""
    base = {"kind": "crossings", "label": "Feux piétons sonores", "source": LV_SRC["lights"],
            "fetched_at": idx["at"].get("sound_modules"), "confidence": 3}
    if len(line) < 2:
        return None
    if idx["lights"] is None:
        return {**base, "status": "inconnu", "confidence": 1, "obstacle": None, "effect": "sans_effet",
                "message": "Les données des feux de la Ville de Paris sont indisponibles pour l'instant."}
    # Paris has about 19,000 signalised junctions: none within 300 m means we are outside the mapped area
    # (La Défense is inside any simple bounding box of Paris, hence this test rather than a box).
    if not any(dist_m(p[0], p[1], x, y) <= COVERAGE_M
               for p in line for x, y, _ in _grid_near(idx["lights"], p[0], p[1], COVERAGE_M)):
        return {**base, "status": "inconnu", "confidence": 1, "obstacle": None, "effect": "sans_effet",
                "message": "Les feux piétons sonores ne sont recensés que dans Paris."}
    # Segment by segment, only the grid cells around that segment: the bounding box of a long diagonal walk
    # holds thousands of lights, and testing each against every segment took seconds per walk.
    pad = 0.0003
    near: set = set()
    for a, b in zip(line, line[1:]):
        gx0, gy0 = _grid_key(min(a[0], b[0]) - pad, min(a[1], b[1]) - pad)
        gx1, gy1 = _grid_key(max(a[0], b[0]) + pad, max(a[1], b[1]) + pad)
        near.update(code for gx in range(gx0, gx1 + 1) for gy in range(gy0, gy1 + 1)
                    for x, y, code in idx["lights"].get((gx, gy), ())
                    if code not in near and _point_segment_m([x, y], a, b) <= CROSSING_NEAR_M)
    if not near:
        return None  # no traffic light along this walk: nothing to say
    audible = near & idx["sound"]
    n, a = len(near), len(audible)
    remote = "avec la télécommande universelle des personnes aveugles et malvoyantes"
    if a == n:
        return {**base, "status": "ok", "obstacle": None, "effect": "sans_effet",
                "message": f"{'Le feu piéton de ce trajet est sonore' if n == 1 else f'Les {n} feux piétons de ce trajet sont sonores'} "
                           f"{remote}."}
    obstacle = "feu_sans_son"
    silent = n - a
    with_sound = f"{NB}; {a} {'est sonore' if a == 1 else 'sont sonores'} {remote}" if a else ""
    return {**base, "status": "partiel" if audible else "absent", "obstacle": obstacle,
            "label": "Feux piétons sans son", "effect": _at_most_genant(profiles.effect(obstacle, profile)),
            "message": f"{_count(silent, 'feu', 'feux')} sans son sur ce trajet{with_sound}. "
                       f"À un feu muet, traversez avec d'autres personnes ou demandez de l'aide."}


# --- Journeys ------------------------------------------------------------------

def _low_vision_transit(s: dict, info: dict, idx: dict, profile: str, now: datetime) -> List[dict]:
    """Audio announcements at both ends and on board, SNCF assistance and warning strips."""
    mode, out = info.get("commercial_mode"), []
    is_bus = _arrtype(mode) == "bus"
    for where in ("from", "to"):
        lon, lat, name, _ = _stop(s.get(where) or {})
        if lon is None:
            continue
        sp_id = (((s.get(where) or {}).get("stop_point")) or {}).get("id")
        c = station_audio_check(lon, lat, name, mode, sp_id, idx, profile)
        if not (is_bus and c["status"] == "inconnu"):  # most bus stops are not described yet: no noise
            out.append({**c, "at": where})
        out += [{**a, "at": where} for a in assistance_checks(lon, lat, name, mode, idx, now)]
    board = onboard_audio_check(_line_id(s), mode, info.get("code"), idx, profile)
    if board:
        out.append(board)
    return out


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
                   stairs: Optional[Iterable[dict]] = (), reports: Iterable[dict] = (),
                   reliability: Optional[Dict[str, dict]] = None, it_id: str = "it1",
                   now: Optional[datetime] = None, low_vision: Optional[Dict[str, Optional[dict]]] = None) -> dict:
    """stairs=None means the stepped-streets layer is unavailable: walks get an "unknown" stairs check."""
    profile = profiles.normalize(profile)
    stairs_unknown = stairs is None
    works, stairs, reports = list(works), list(stairs or ()), list(reports)
    # Visually impaired checks: only for profiles they matter to, so the others keep their exact results.
    lv = low_vision_index(low_vision) if low_vision is not None and cares_about_low_vision(profile) else None
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
            if lv is not None:
                step["checks"] += _low_vision_transit(s, info, lv, profile, now or datetime.now(timezone.utc))
        elif line and stype == "crow_fly":
            # straight line drawn by Navitia, not a real path: only its length means something
            step["checks"] = walk_checks(line, profile, now=now)
        elif line:
            step["checks"] = walk_checks(line, profile, works, stairs, reports, works_fetched_at, now)
            if stairs_unknown and stype == "street_network":
                unknown = stairs_unknown_check(profile)
                if unknown:
                    step["checks"].append(unknown)
            crossing = crossing_check(line, lv, profile) if lv is not None else None
            if crossing:
                step["checks"].append(crossing)
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
        # What blocks and where, for a readable title: "Rue en escalier" after "Bastille".
        "blocked_reason": blocking["label"] if blocking else None,
        "blocked_near": (blocking.get("station") or blocking_step.get("from")) if blocking else None,
        "steps": steps,
        "plan_b_id": None,
    }


def _blockers(itinerary: dict) -> List[dict]:
    return [c for st in itinerary.get("steps") or [] for c in st.get("checks") or [] if c.get("effect") == "bloquant"]


def least_blocked(itineraries: List[dict]) -> Optional[dict]:
    """When every option is blocked, the one closest to working: fewest blocking checks, then a walk only a
    little too long rather than a broken elevator, then the shortest."""
    blocked = [it for it in itineraries if it["verdict"] == "bloque"]
    if not blocked or len(blocked) < len(itineraries):
        return None

    def cost(it: dict) -> Tuple[int, int, int]:
        bl = _blockers(it)
        over = sum((c.get("length_m") or 0) for c in bl if c["kind"] == "walk")
        lifts = sum(1 for c in bl if c["kind"] != "walk")
        return len(bl), lifts * 100000 + over, it.get("duration_min") or 0
    return min(blocked, key=cost)


# Door-to-door service for people with reduced mobility in Paris (PAM 75, Île-de-France Mobilités).
# Only for disabilities it serves: not for a stroller or the able-bodied helper.
PAM_PROFILES = ("manuel", "electrique", "deambulateur", "malvoyant")


def way_out(itineraries: List[dict], profile: str) -> Optional[dict]:
    """Every option blocked: never a dead end. The least blocked option, other times, and PAM 75."""
    best = least_blocked(itineraries)
    if best is None:
        return None
    profile = profiles.normalize(profile)
    return {"least_blocked_id": best["id"],
            "least_blocked_reason": best.get("blocked_reason"),
            "try_other_time": True,
            "pam": profile in PAM_PROFILES}


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
