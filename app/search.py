"""Search Acceslibre places by name (chantier A): small restaurants and shops the IGN geocoder does not know."""
from __future__ import annotations

import math
import re
import unicodedata

from fastapi import APIRouter, Query

from . import sources

router = APIRouter()


def _norm(s: str) -> str:
    s = unicodedata.normalize("NFD", s or "").encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", " ", s).strip()


def _rank(name: str, q: str) -> int:
    n, q = _norm(name), _norm(q)
    if n == q:
        return 0
    if n.startswith(q):
        return 1
    if re.search(rf"\b{re.escape(q)}\b", n):
        return 2
    return 3

IDF = {"longitude__greater": "1.40", "longitude__less": "3.60", "latitude__greater": "48.10", "latitude__less": "49.25"}


@router.get("/api/places/search")
def api_places_search(q: str = Query(..., min_length=3), lat: float = 48.8566, lon: float = 2.3522, limit: int = 5):
    # Imported here: main.py imports this module, and owns the wheelchair verdict.
    from .main import FOOD, _num, toilets_verdict, wheelchair_verdict

    def load():
        body = sources._get_json(sources.ACCESLIBRE, {
            "columns": sources.PLACE_COLUMNS, "name__contains": q.strip(), "page_size": 50, **IDF,
        }, f"acceslibre search {q!r}")
        return {"fetched_at": sources.now_iso(), "rows": body.get("data") or []}

    data = sources.cached(f"psearch_{q.strip().lower()}", 3600, load)
    out = []
    for r in data["rows"]:
        plon, plat = _num(r.get("longitude")), _num(r.get("latitude"))
        if plon is None or plat is None:
            continue
        level, reasons = wheelchair_verdict(r)
        d = 6371000 * math.hypot((plon - lon) * math.cos(math.radians(lat)) * math.pi / 180, (plat - lat) * math.pi / 180)
        out.append(((_rank(r.get("name"), q), d), {"type": "Feature", "geometry": {"type": "Point", "coordinates": [plon, plat]}, "properties": {
            "id": r["id"], "name": r.get("name"), "activity": r.get("activite"),
            "category": "food" if FOOD.search(r.get("activite") or "") else "shop",
            "address": " ".join(str(r[k]) for k in ("numero", "voie", "postal_code", "commune") if r.get(k)),
            "wheelchair": level, "reasons": reasons, "toilets": toilets_verdict(r),
            "parking": r.get("stationnement_pmr") is True or r.get("stationnement_ext_pmr") is True,
            "url": sources.ACCESLIBRE_PAGE.format(id=r["id"]), "distance_m": round(d),
        }}))
    out.sort(key=lambda x: x[0])
    return {"type": "FeatureCollection", "features": [f for _, f in out[:limit]],
            "meta": {"source": sources.SOURCES.get("places"), "fetched_at": data["fetched_at"]}}
