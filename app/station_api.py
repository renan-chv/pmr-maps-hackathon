"""Station sheet data for the UI (chantier A): reliability of each lift of a station.

Reuses D's reliability module (Dispotrains archive); this file only exposes it per station.
"""
from __future__ import annotations

from fastapi import APIRouter

from . import reliability, sources

router = APIRouter()


@router.get("/api/stations/{zdcid}/reliability")
def api_station_reliability(zdcid: str):
    rows = [r for r in sources.lifts()["rows"] if str(r.get("zdcid")) == zdcid]
    return {"zdcid": zdcid, "lifts": reliability.for_lifts(rows), "source": reliability.SOURCE}
