"""PMR Maps – FastAPI app: serves the map page and GeoJSON layers built from open data."""
from __future__ import annotations

import asyncio
import logging
import math
import os
from pathlib import Path
from typing import List, Optional

import httpx
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import db, poller, sources

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
STATIC = Path(__file__).resolve().parent.parent / "static"
PRIM_API_KEY = os.getenv("PRIM_API_KEY")
PRIM_JOURNEYS = "https://prim.iledefrance-mobilites.fr/marketplace/v2/navitia/journeys"

app = FastAPI(title="PMR Maps")


@app.on_event("startup")
async def startup() -> None:
    try:
        db.init_schema()
    except Exception:
        logging.exception("database init failed, continuing without history in PostgreSQL")
    asyncio.create_task(poller.run_forever())
    asyncio.get_running_loop().run_in_executor(None, sources.warm_up)


def fc(features: list, source_key: str, fetched_at: Optional[str], **extra) -> dict:
    return {
        "type": "FeatureCollection",
        "features": features,
        "meta": {"source": sources.SOURCES.get(source_key), "fetched_at": fetched_at, "count": len(features), **extra},
    }


def point(lon, lat, props: dict) -> dict:
    return {"type": "Feature", "geometry": {"type": "Point", "coordinates": [lon, lat]}, "properties": props}


# --- Layers ----------------------------------------------------------------

@app.get("/api/lifts")
def api_lifts():
    data = sources.lifts()
    feats, counts = [], {"available": 0, "notavailable": 0, "unknown": 0}
    for r in data["rows"]:
        c = r.get("centroidzdc") or {}
        if c.get("lon") is None:
            continue
        status = r.get("liftstatus") or "unknown"
        counts[status] = counts.get(status, 0) + 1
        feats.append(point(c["lon"], c["lat"], {
            "liftid": r.get("liftid"), "zdcid": r.get("zdcid"), "station": r.get("zdcname"),
            "status": status, "reason": r.get("liftreason"), "situation": r.get("liftsituation"),
            "direction": r.get("liftdirection"), "mode": r.get("liftmode"),
            "source_update": r.get("liftstateupdate"),
        }))
    return fc(feats, "lifts", data["fetched_at"], counts=counts, poller=poller.state)


@app.get("/api/stations")
def api_stations():
    data = sources.stations()
    feats = []
    for r in data["rows"]:
        g = r.get("arrgeopoint") or {}
        if g.get("lon") is None:
            continue
        feats.append(point(g["lon"], g["lat"], {
            "id": r.get("arrid"), "name": r.get("arrname"), "type": r.get("arrtype"),
            "accessibility": r.get("arraccessibility") or "unknown", "town": r.get("arrtown"),
        }))
    return fc(feats, "stations", data["fetched_at"])


@app.get("/api/train-stations")
def api_train_stations():
    data = sources.train_stations()
    feats = []
    for r in data["rows"]:
        g = r.get("stop_point_geopoint") or {}
        if g.get("lon") is None:
            continue
        feats.append(point(g["lon"], g["lat"], {
            "id": r.get("stop_point_id"), "name": r.get("stop_name"),
            "level": r.get("accessibility_level_id"), "level_name": r.get("accessibility_level_name"),
            "comment": r.get("commentaire"),
        }))
    return fc(feats, "train_stations", data["fetched_at"])


@app.get("/api/bus-stops")
def api_bus_stops(bbox: str = Query(..., description="minLon,minLat,maxLon,maxLat")):
    try:
        x1, y1, x2, y2 = [float(v) for v in bbox.split(",")]
    except ValueError:
        raise HTTPException(400, "bbox must be minLon,minLat,maxLon,maxLat")
    data = sources.bus_stops()
    feats = []
    for r in data["rows"]:
        g = r.get("arrgeopoint") or {}
        lon, lat = g.get("lon"), g.get("lat")
        if lon is None or not (x1 <= lon <= x2 and y1 <= lat <= y2):
            continue
        feats.append(point(lon, lat, {
            "id": r.get("arrid"), "name": r.get("arrname"),
            "accessibility": r.get("arraccessibility") or "unknown", "town": r.get("arrtown"),
        }))
        if len(feats) >= 3000:
            break
    return fc(feats, "stations", data["fetched_at"])


@app.get("/api/works")
def api_works():
    data = sources.works()
    feats = []
    for r in data["rows"]:
        shape = (r.get("geo_shape") or {}).get("geometry")
        if not shape:
            continue
        where = r.get("localisation_detail") or []
        feats.append({"type": "Feature", "geometry": shape, "properties": {
            "id": r.get("num_emprise"), "category": r.get("chantier_categorie"),
            "summary": r.get("chantier_synthese"), "owner": r.get("moa_principal"),
            "start": r.get("date_debut"), "end": r.get("date_fin"),
            "where": ", ".join(where), "postcode": r.get("cp_arrondissement"),
        }})
    return fc(feats, "works", data["fetched_at"], filter="chantiers actifs aujourd'hui occupant le trottoir")


@app.get("/api/alerts")
def api_alerts():
    return {"alerts": list(poller.alerts), "poller": poller.state, "history_in_db": db.enabled()}


# --- Journey (PRIM / Navitia, needs PRIM_API_KEY) --------------------------

def _dist_m(lon1, lat1, lon2, lat2) -> float:
    k = math.pi / 180
    x = (lon2 - lon1) * k * math.cos((lat1 + lat2) * k / 2)
    y = (lat2 - lat1) * k
    return 6371000 * math.hypot(x, y)


def _lifts_near(lon: float, lat: float, radius: float = 150) -> List[dict]:
    out = []
    for r in sources.lifts()["rows"]:
        c = r.get("centroidzdc") or {}
        if c.get("lon") is not None and _dist_m(lon, lat, c["lon"], c["lat"]) <= radius:
            out.append({"liftid": r["liftid"], "station": r.get("zdcname"), "status": r.get("liftstatus"),
                        "reason": r.get("liftreason"), "situation": r.get("liftsituation"),
                        "source_update": r.get("liftstateupdate")})
    return out


@app.get("/api/geocode")
def api_geocode(q: str):
    res = sources.geocode(q)
    if not res:
        raise HTTPException(404, "adresse introuvable")
    return res


@app.get("/api/journey")
def api_journey(from_q: str = Query(..., alias="from"), to_q: str = Query(..., alias="to")):
    if not PRIM_API_KEY:
        raise HTTPException(503, "PRIM_API_KEY manquante : itinéraire indisponible")
    a, b = sources.geocode(from_q), sources.geocode(to_q)
    if not a or not b:
        raise HTTPException(404, "adresse de départ ou d'arrivée introuvable")
    r = httpx.get(PRIM_JOURNEYS, headers={"apiKey": PRIM_API_KEY}, timeout=30, params={
        "from": f"{a['lon']};{a['lat']}", "to": f"{b['lon']};{b['lat']}",
        "wheelchair": "true", "count": 3,
    })
    if r.status_code != 200:
        raise HTTPException(502, f"PRIM a répondu {r.status_code}: {r.text[:300]}")
    journeys = []
    for j in r.json().get("journeys", []):
        sections, blocking = [], []
        for s in j.get("sections", []):
            sec = {"type": s.get("type"), "mode": (s.get("display_informations") or {}).get("commercial_mode"),
                   "line": (s.get("display_informations") or {}).get("code"),
                   "from": (s.get("from") or {}).get("name"), "to": (s.get("to") or {}).get("name"),
                   "duration_s": s.get("duration"), "geojson": s.get("geojson")}
            if s.get("type") == "public_transport":
                for end in ("from", "to"):
                    coord = ((s.get(end) or {}).get("stop_point") or {}).get("coord") or {}
                    if coord.get("lon"):
                        lifts = _lifts_near(float(coord["lon"]), float(coord["lat"]))
                        sec[f"{end}_lifts"] = lifts
                        blocking += [l for l in lifts if l["status"] != "available"]
            sections.append(sec)
        journeys.append({"duration_s": j.get("duration"), "departure": j.get("departure_date_time"),
                         "arrival": j.get("arrival_date_time"), "sections": sections,
                         "lifts_not_available": blocking})
    return {"from": a, "to": b, "journeys": journeys, "source": "PRIM / Navitia (wheelchair=true)",
            "lifts_fetched_at": sources.lifts()["fetched_at"]}


# --- Health & page ---------------------------------------------------------

@app.get("/health")
def health():
    return {"ok": True, "db": db.enabled(), "prim": bool(PRIM_API_KEY), "poller": poller.state}


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html")


app.mount("/static", StaticFiles(directory=STATIC), name="static")
