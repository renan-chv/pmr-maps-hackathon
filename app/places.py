"""Accessible restaurants and shops: one normalized format, several pluggable sources.

Each upstream API is a Provider: it downloads the raw rows for a bbox and turns each
row into a Place. Everything downstream (cache, merge of duplicates across sources,
verdict for the user's wheelchair, GeoJSON, map layer, place card, PostgreSQL) only
sees Place, so plugging a new API = one Provider subclass decorated with @register.

No provider is shipped enabled: until an API is plugged in, /api/places answers an
empty collection with meta.configured = false and the UI says the layer is coming.
"""
from __future__ import annotations

import logging
import os
import re
import unicodedata
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Dict, List, Optional, Tuple

from . import db, sources

log = logging.getLogger("places")

Bbox = Tuple[float, float, float, float]  # minLon, minLat, maxLon, maxLat

CATEGORIES = {
    "restaurant": "Restaurant",
    "cafe": "Café / bar",
    "food_shop": "Commerce alimentaire",
    "shop": "Commerce",
    "other": "Autre",
}
LEVELS = ("ok", "partial", "ko", "unknown")  # overall wheelchair level given by the source

GRID = 0.01          # bboxes are snapped to this grid (~1 km) so panning reuses the cache
MAX_SPAN = 0.05      # refuse bigger areas: the map only asks from zoom 15
MERGE_RADIUS_M = 35  # two rows closer than this with similar names are the same place
STALE_DAYS = 730     # accessibility info older than this is flagged "à confirmer"


# --- Normalized format -------------------------------------------------------

@dataclass
class Access:
    level: str = "unknown"              # one of LEVELS, as stated by the source
    step_free: Optional[bool] = None    # entrance without any step
    steps: Optional[int] = None         # number of steps at the entrance
    ramp: Optional[bool] = None         # ramp available (fixed or removable)
    door_width_cm: Optional[int] = None
    toilets: Optional[bool] = None      # adapted toilets
    parking: Optional[bool] = None      # disabled parking nearby
    notes: List[str] = field(default_factory=list)  # free text from the source


@dataclass
class Place:
    source: str                         # Provider.key
    source_id: str                      # id in the upstream API
    name: str
    category: str                       # key of CATEGORIES
    lon: float
    lat: float
    address: Optional[str] = None
    access: Access = field(default_factory=Access)
    url: Optional[str] = None           # page of the place on the source site
    updated_at: Optional[str] = None    # when the source last updated the accessibility info (ISO)

    @property
    def id(self) -> str:
        return f"{self.source}:{self.source_id}"


def place_from_dict(d: dict) -> Place:
    return Place(**{**d, "access": Access(**d.get("access") or {})})


# --- Providers ---------------------------------------------------------------

class Provider:
    """Subclass, set key/meta, implement fetch() and normalize(), decorate with @register."""

    key = ""        # short id, also used in PLACES_PROVIDERS and Place.source
    meta: dict = {}  # {"name", "url", "license"} shown in "D'où viennent les données ?"
    ttl = 3600      # seconds a bbox stays cached

    def enabled(self) -> bool:
        """False when a required API key is missing."""
        return True

    def fetch(self, bbox: Bbox) -> List[dict]:
        """Raw rows from the API for this bbox (use sources._client for HTTP)."""
        raise NotImplementedError

    def normalize(self, row: dict) -> Optional[Place]:
        """One raw row -> Place, or None to drop it (no coordinates, closed, out of scope)."""
        raise NotImplementedError


PROVIDERS: Dict[str, Provider] = {}


def register(cls):
    PROVIDERS[cls.key] = cls()
    return cls


def active() -> List[Provider]:
    """Enabled providers, in priority order (PLACES_PROVIDERS=a,b to choose and order them)."""
    wanted = [k.strip() for k in os.getenv("PLACES_PROVIDERS", "").split(",") if k.strip()]
    keys = wanted or list(PROVIDERS)
    return [PROVIDERS[k] for k in keys if k in PROVIDERS and PROVIDERS[k].enabled()]


# --- Fetch, cache, merge -----------------------------------------------------

def parse_bbox(raw: str) -> Bbox:
    x1, y1, x2, y2 = [float(v) for v in raw.split(",")]
    if x2 <= x1 or y2 <= y1:
        raise ValueError("empty bbox")
    if x2 - x1 > MAX_SPAN or y2 - y1 > MAX_SPAN:
        raise ValueError("bbox too large, zoom in")
    return x1, y1, x2, y2


def _snap(bbox: Bbox) -> Bbox:
    lo = lambda v: round((v // GRID) * GRID, 2)
    hi = lambda v: round(-((-v) // GRID) * GRID, 2)
    return lo(bbox[0]), lo(bbox[1]), hi(bbox[2]), hi(bbox[3])


def _inside(p: Place, bbox: Bbox) -> bool:
    return bbox[0] <= p.lon <= bbox[2] and bbox[1] <= p.lat <= bbox[3]


def _load(provider: Provider, bbox: Bbox) -> dict:
    """Normalized places of one provider for a snapped bbox, cached (with stale fallback)."""
    snapped = _snap(bbox)

    def load():
        places = []
        for row in provider.fetch(snapped):
            try:
                p = provider.normalize(row)
            except Exception:
                log.exception("%s: could not normalize a row", provider.key)
                continue
            if p and p.category in CATEGORIES:
                places.append(p)
        try:
            db.save_places(places, sources.now_iso())
        except Exception:
            log.exception("%s: could not save places in PostgreSQL", provider.key)
        return {"fetched_at": sources.now_iso(), "rows": [asdict(p) for p in places]}

    key = "places-{}-{:.2f}_{:.2f}_{:.2f}_{:.2f}".format(provider.key, *snapped)
    return sources.cached(key, provider.ttl, load)


def _norm_name(s: str) -> str:
    s = unicodedata.normalize("NFD", s or "").encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", " ", s).strip()


def _same(a: Place, b: Place) -> bool:
    if sources.dist_m(a.lon, a.lat, b.lon, b.lat) > MERGE_RADIUS_M:
        return False
    na, nb = _norm_name(a.name), _norm_name(b.name)
    return bool(na and nb) and (na == nb or na in nb or nb in na)


def merge(places: List[Place]) -> List[dict]:
    """Group the same place seen by several sources.

    The first source (priority order) gives the name and position; missing access
    fields are filled from the others. When two sources disagree on a field, the most
    recently updated value wins and the disagreement is kept in "conflicts".
    """
    groups: List[List[Place]] = []
    for p in places:
        for g in groups:
            if _same(g[0], p):
                g.append(p)
                break
        else:
            groups.append([p])

    out = []
    for g in groups:
        head = g[0]
        newest_first = sorted(g, key=lambda p: p.updated_at or "", reverse=True)
        access, conflicts = Access(), []
        for f in ("level", "step_free", "steps", "ramp", "door_width_cm", "toilets", "parking"):
            values = {p.source: getattr(p.access, f) for p in newest_first
                      if getattr(p.access, f) is not None and getattr(p.access, f) != "unknown"}
            if values:
                setattr(access, f, next(iter(values.values())))
            if len(set(map(str, values.values()))) > 1:
                conflicts.append({"field": f, "values": values})
        access.notes = [n for p in g for n in p.access.notes]
        out.append({
            "id": head.id, "name": head.name, "category": head.category, "lon": head.lon, "lat": head.lat,
            "address": next((p.address for p in g if p.address), None),
            "access": asdict(access),
            "sources": [{"source": p.source, "source_id": p.source_id, "url": p.url, "updated_at": p.updated_at} for p in g],
            "updated_at": newest_first[0].updated_at,
            "conflicts": conflicts,
        })
    return out


# --- Verdict for the user ----------------------------------------------------

def assess(place: dict, width_cm: Optional[int] = None, max_steps: int = 0) -> dict:
    """Can this wheelchair get in? verdict ok / warn / ko / unk with the reasons, in French.

    Reason kinds: ok / ko (decide the verdict), info (a fact), caveat (why to double-check).

    Measured facts (steps, door width) beat the source's overall level, because the
    level is generic while the facts can be checked against this user's wheelchair.
    """
    a = place["access"]
    reasons: List[dict] = []
    ko = False

    if a["steps"] is not None and a["steps"] > max_steps and not a["ramp"]:
        ko = True
        reasons.append({"kind": "ko", "text": f"{a['steps']} marche{'s' if a['steps'] > 1 else ''} à l'entrée, sans rampe"})
    elif a["step_free"] or a["steps"] == 0:
        reasons.append({"kind": "ok", "text": "Entrée de plain-pied"})
    elif a["steps"] and a["ramp"]:
        reasons.append({"kind": "ok", "text": f"{a['steps']} marche{'s' if a['steps'] > 1 else ''}, rampe disponible"})

    if a["door_width_cm"] is not None:
        if width_cm and a["door_width_cm"] < width_cm:
            ko = True
            reasons.append({"kind": "ko", "text": f"Porte de {a['door_width_cm']} cm, votre fauteuil fait {width_cm} cm"})
        else:
            reasons.append({"kind": "ok" if width_cm else "info", "text": f"Porte de {a['door_width_cm']} cm"})

    if a["toilets"] is not None:
        reasons.append({"kind": "ok" if a["toilets"] else "info",
                        "text": "Toilettes adaptées" if a["toilets"] else "Pas de toilettes adaptées"})
    if a["parking"]:
        reasons.append({"kind": "info", "text": "Place de stationnement PMR à proximité"})

    level = a["level"]
    if ko or level == "ko":
        verdict = "ko"
    elif level == "ok":
        verdict = "ok"
    elif level == "partial" or reasons:
        verdict = "warn"
    else:
        verdict = "unk"

    if place["conflicts"] and verdict == "ok":
        verdict = "warn"
    if place["conflicts"]:
        reasons.append({"kind": "caveat", "text": "Les sources ne sont pas d'accord, à confirmer sur place"})
    age = _age_days(place["updated_at"])
    if age is not None and age > STALE_DAYS:
        if verdict == "ok":
            verdict = "warn"
        reasons.append({"kind": "caveat", "text": f"Information vieille de plus de {age // 365} ans"})
    if verdict == "unk":
        reasons.append({"kind": "caveat", "text": "Accessibilité non renseignée"})
    return {"verdict": verdict, "reasons": reasons}


def _age_days(iso: Optional[str]) -> Optional[int]:
    if not iso:
        return None
    try:
        d = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except ValueError:
        return None
    if d.tzinfo is None:
        d = d.replace(tzinfo=timezone.utc)
    return (datetime.now(timezone.utc) - d).days


# --- Entry point used by the API (and later by the agent's find_places tool) --

def query(bbox: Bbox, categories: Optional[List[str]] = None,
          width_cm: Optional[int] = None, max_steps: int = 0) -> dict:
    provs = active()
    metas, places = [], []

    def one(p: Provider):
        try:
            return p, _load(p, bbox), None
        except Exception as e:
            log.exception("%s: fetch failed", p.key)
            return p, None, str(e)

    with ThreadPoolExecutor(max_workers=max(1, len(provs))) as pool:
        results = list(pool.map(one, provs))
    for p, data, err in results:  # pool.map keeps the priority order
        rows = [place_from_dict(r) for r in (data or {}).get("rows", [])]
        rows = [r for r in rows if _inside(r, bbox) and (not categories or r.category in categories)]
        places += rows
        metas.append({**p.meta, "key": p.key, "fetched_at": (data or {}).get("fetched_at"),
                      "stale": bool((data or {}).get("stale")), "error": err, "count": len(rows)})

    feats = []
    for pl in merge(places):
        res = assess(pl, width_cm, max_steps)
        feats.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [pl["lon"], pl["lat"]]},
                      "properties": {**pl, **res}})
    return {
        "type": "FeatureCollection",
        "features": feats,
        "meta": {"configured": bool(provs), "sources": metas, "count": len(feats),
                 "fetched_at": max((m["fetched_at"] for m in metas if m["fetched_at"]), default=None),
                 "profile": {"width_cm": width_cm, "max_steps": max_steps}},
    }
