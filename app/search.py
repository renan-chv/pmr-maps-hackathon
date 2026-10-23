"""Search Acceslibre places by name (chantier A): small restaurants and shops the IGN geocoder does not know."""
from __future__ import annotations

import logging
import math
import os
import re
import unicodedata
from concurrent.futures import TimeoutError as FutureTimeout

from fastapi import APIRouter, Query

from . import sources
from .errors import ApiError

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
# Acceslibre's tabular API can take 10-30 s for a name search: past this budget answer 503 (the search box then
# shows the address results alone); the search goes on in the background and the next keystroke gets it cached.
SEARCH_BUDGET_S = float(os.getenv("PLACES_SEARCH_BUDGET_S", "8"))


@router.get("/api/places/search")
def api_places_search(q: str = Query(..., min_length=3, max_length=100),
                      lat: float = Query(48.8566, ge=-90, le=90), lon: float = Query(2.3522, ge=-180, le=180),
                      limit: int = Query(5, ge=1, le=20)):
    # Imported here: main.py imports this module, and owns the wheelchair verdict.
    from .main import FOOD, _num, toilets_verdict, wheelchair_verdict

    def load():
        body = sources._get_json(sources.ACCESLIBRE, {
            "columns": sources.PLACE_COLUMNS, "name__contains": q.strip(), "page_size": 50, **IDF,
        }, f"acceslibre search {q!r}", timeout=sources.ACCESLIBRE_TIMEOUT_S)
        return {"fetched_at": sources.now_iso(), "rows": body.get("data") or []}

    key = f"psearch_{q.strip().lower()}"
    try:
        data = sources.in_background(key, lambda: sources.cached(key, 3600, load)).result(timeout=SEARCH_BUDGET_S)
    except FutureTimeout:
        raise ApiError(503, "Place search is slow right now. Try again in a moment.", "upstream",
                       headers={"Retry-After": "5"})
    except Exception as e:
        logging.warning("acceslibre search unavailable: %s", type(e).__name__)
        raise ApiError(503, "Place search is not answering right now. Try again in a moment.", "upstream",
                       headers={"Retry-After": "30"})
    out = []
    for r in data["rows"]:
        plon, plat = _num(r.get("longitude")), _num(r.get("latitude"))
        if plon is None or plat is None or not r.get("id"):
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
