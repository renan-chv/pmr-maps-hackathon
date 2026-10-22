"""Roulib – FastAPI app: serves the map page and GeoJSON layers built from open data."""
from __future__ import annotations

import asyncio
import json
import logging
import math
import os
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from pathlib import Path
from typing import List, Optional, Tuple
from zoneinfo import ZoneInfo

import httpx
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import agent, db, http_cache, photos, poller, profiles, reliability, reports, search, sources, station_api, verify

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
STATIC = Path(__file__).resolve().parent.parent / "static"
PRIM_API_KEY = os.getenv("PRIM_API_KEY")
SERVERLESS = bool(os.getenv("VERCEL"))  # Vercel functions sleep between requests
PRIM_JOURNEYS = "https://prim.iledefrance-mobilites.fr/marketplace/v2/navitia/journeys"

app = FastAPI(title="Roulib")
app.add_middleware(GZipMiddleware, minimum_size=1000)  # roadworks layer: 2.3 MB of uncompressed GeoJSON on Aiven
http_cache.install(app)
app.include_router(photos.router)
app.include_router(search.router)
app.include_router(station_api.router)
app.include_router(reports.router)
app.include_router(agent.router)


@app.on_event("startup")
async def startup() -> None:
    try:
        db.init_schema()
    except Exception:
        logging.exception("database init failed, continuing without history in PostgreSQL")
    if SERVERLESS:
        return  # no background tasks; layers load lazily and the poller runs on request
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
    if SERVERLESS:
        poller.maybe_poll()
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
    return fc(feats, "lifts", data["fetched_at"], stale=data.get("stale", False), counts=counts, poller=poller.state)


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
    return fc(feats, "stations", data["fetched_at"], stale=data.get("stale", False))


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
    return fc(feats, "train_stations", data["fetched_at"], stale=data.get("stale", False))


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
    return fc(feats, "stations", data["fetched_at"], stale=data.get("stale", False))


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
            "summary": sources.works_en(r.get("chantier_synthese")), "owner": r.get("moa_principal"),
            "start": r.get("date_debut"), "end": r.get("date_fin"),
            "where": ", ".join(where), "postcode": r.get("cp_arrondissement"),
        }})
    return fc(feats, "works", data["fetched_at"], stale=data.get("stale", False), filter="roadworks active today that take up the sidewalk")


@app.get("/api/stairs")
def api_stairs():
    data = sources.stairs()
    feats = [{"type": "Feature", "geometry": r["geo_shape"]["geometry"], "properties": {"id": r.get("objectid")}}
             for r in data["rows"] if (r.get("geo_shape") or {}).get("geometry")]
    return fc(feats, "stairs", data["fetched_at"], stale=data.get("stale", False))


# --- Places (Acceslibre): wheelchair verdict computed from the raw fields --

FOOD = re.compile(r"\b(restaura\w*|caf[ée]s?|bars?|brasseries?|glaciers?|salons? de th[ée]|cr[êe]peries?|pizzerias?|traiteurs?|sandwich\w*)\b", re.I)
RAMP = ("fixe", "amovible")
MIN_DOOR_CM = 77  # minimum clear width for a door in an existing ERP (arrêté du 20 avril 2017)
_places_pool = ThreadPoolExecutor(max_workers=4)


def _num(v) -> Optional[float]:
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _steps_text(steps: Optional[float]) -> str:
    if not steps:
        return "Steps"
    return f"{int(steps)} step" + ("" if int(steps) == 1 else "s")


def wheelchair_verdict(r: dict) -> Tuple[str, List[str]]:
    """Return ("true" | "partial" | "false" | "unknown", reasons in English).

    Missing fields stay unknown: we never turn "not filled in" into "not accessible".
    """
    reasons = []
    steps = _num(r.get("entree_marches"))
    if r.get("entree_plain_pied") is True:
        entrance = "true"
        reasons.append("Step-free entrance")
    elif r.get("entree_pmr") is True or r.get("entree_ascenseur_pmr") is True:
        entrance = "true"
        reasons.append("Dedicated accessible entrance" if r.get("entree_pmr") else "Accessible elevator at the entrance")
    elif r.get("entree_marches_rampe") == "fixe":
        entrance = "true"
        reasons.append("Permanent ramp at the entrance")
    elif r.get("entree_marches_rampe") == "amovible":
        entrance = "partial"
        reasons.append("Removable ramp (on request)")
    elif r.get("entree_plain_pied") is False:
        if r.get("entree_aide_humaine") is True or r.get("entree_dispositif_appel") is True:
            entrance = "partial"
            reasons.append(f"{_steps_text(steps)} at the entrance, staff can help")
        else:
            entrance = "false"
            reasons.append(f"{_steps_text(steps)} at the entrance, no ramp")
    else:
        entrance = "unknown"
        reasons.append("Entrance not documented")

    level = entrance
    width = _num(r.get("entree_largeur_mini"))
    if width is not None and width < MIN_DOOR_CM:
        level = "false"
        reasons.append(f"Narrow door: {int(width)} cm (minimum {MIN_DOOR_CM} cm)")
    elif width is not None:
        reasons.append(f"Door: {int(width)} cm")
    blocked = [
        ("cheminement_ext", "Steps on the outside path"),
        ("accueil_cheminement", "Steps between the entrance and the front desk"),
    ]
    for prefix, text in blocked:
        if (r.get(f"{prefix}_plain_pied") is False and r.get(f"{prefix}_rampe") not in RAMP
                and r.get(f"{prefix}_ascenseur") is not True):
            reasons.append(text)
            if level == "true":
                level = "partial"
    return level, reasons


def toilets_verdict(r: dict) -> str:
    if r.get("sanitaires_adaptes") is True:
        return "true"
    if r.get("sanitaires_adaptes") is False:
        return "false"
    if r.get("sanitaires_presence") is False:
        return "none"
    return "unknown"


@app.get("/api/places")
def api_places(bbox: str = Query(..., description="minLon,minLat,maxLon,maxLat")):
    try:
        x1, y1, x2, y2 = [float(v) for v in bbox.split(",")]
    except ValueError:
        raise HTTPException(400, "bbox must be minLon,minLat,maxLon,maxLat")
    tiles = sources.place_tiles(x1, y1, x2, y2)
    if len(tiles) > 16:
        raise HTTPException(400, "area too large: zoom in")
    feats, seen, fetched, stale = [], set(), [], False
    for data in _places_pool.map(lambda xy: sources.places_tile(*xy), tiles):
        fetched.append(data["fetched_at"])
        stale = stale or data.get("stale", False)
        for r in data["rows"]:
            lon, lat = _num(r.get("longitude")), _num(r.get("latitude"))
            if lon is None or lat is None or r["id"] in seen:
                continue
            seen.add(r["id"])
            level, reasons = wheelchair_verdict(r)
            feats.append(point(lon, lat, {
                "id": r["id"], "name": r.get("name"), "activity": r.get("activite"),
                "category": "food" if FOOD.search(r.get("activite") or "") else "shop",
                "address": " ".join(str(r[k]) for k in ("numero", "voie", "postal_code", "commune") if r.get(k)),
                "wheelchair": level, "reasons": reasons, "toilets": toilets_verdict(r),
                "parking": r.get("stationnement_pmr") is True or r.get("stationnement_ext_pmr") is True,
                "url": sources.ACCESLIBRE_PAGE.format(id=r["id"]),
            }))
    return fc(feats, "places", min(fetched) if fetched else None, stale=stale,
              counts={k: sum(f["properties"]["wheelchair"] == k for f in feats) for k in ("true", "partial", "false", "unknown")})


@app.get("/api/alerts")
def api_alerts():
    if SERVERLESS:
        poller.maybe_poll()
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
        raise HTTPException(404, "address not found")
    return res


@app.get("/api/suggest")
def api_suggest(q: str = Query(..., min_length=2, max_length=200),
                lon: Optional[float] = Query(None, ge=-180, le=180), lat: Optional[float] = Query(None, ge=-90, le=90)):
    return {"results": sources.suggest(q, near=(lon, lat) if lon is not None and lat is not None else None)}


def _resolve(q: str) -> Optional[dict]:
    """Accept "lon,lat" (from the UI) or free text (geocoded)."""
    parts = q.split(",")
    if len(parts) == 2:
        try:
            lon, lat = float(parts[0]), float(parts[1])
            return {"label": q, "lon": lon, "lat": lat}
        except ValueError:
            pass
    return sources.geocode(q)


FIXTURES = STATIC / "fixtures"


# Trip time (Google Maps style "Depart at" / "Arrive by"): local Paris time, as Navitia expects it.

PARIS_TZ = ZoneInfo("Europe/Paris")
WHEN_PAST_TOLERANCE = timedelta(minutes=10)  # the user picked "now" a few minutes ago: still fine
WHEN_MAX_AHEAD = timedelta(days=30)  # beyond that, the timetables are not published yet
WHEN_FUTURE_NOTE = timedelta(minutes=15)  # later than this, say that the lift status is today's


def _parse_when(when: Optional[str], now: Optional[datetime] = None) -> Optional[datetime]:
    """ISO local datetime ("2026-10-22T18:30", Europe/Paris) -> aware datetime, or HTTP 400."""
    if when is None or not when.strip():
        return None
    try:
        t = datetime.fromisoformat(when.strip())
    except ValueError:
        raise HTTPException(400, "when must be an ISO date and time, e.g. 2026-10-22T18:30")
    t = t.replace(tzinfo=PARIS_TZ) if t.tzinfo is None else t.astimezone(PARIS_TZ)
    now = now or datetime.now(PARIS_TZ)
    if t < now - WHEN_PAST_TOLERANCE:
        raise HTTPException(400, "when is in the past")
    if t > now + WHEN_MAX_AHEAD:
        raise HTTPException(400, "when is more than 30 days ahead")
    return t


def _time_note(when: Optional[datetime], now: Optional[datetime] = None) -> Optional[str]:
    """Lift statuses are live: for a later trip, say plainly that they may change by then."""
    now = now or datetime.now(PARIS_TZ)
    if when is None or when - now < WHEN_FUTURE_NOTE:
        return None
    day = "" if when.date() == now.date() else f" on {when.strftime('%a %d %b')}"
    return f"Elevator status is from now ({now:%H:%M}); it may change by {when:%H:%M}{day}."


# One PRIM call per trip (1000 a day): ask it for a few more alternatives rather than calling it again.
NAVITIA_MIN_JOURNEYS = 3
NAVITIA_MAX_JOURNEYS = 5


def _navitia_params(a: dict, b: dict, forbidden: List[str] = (), when: Optional[datetime] = None,
                    arrive: bool = False, profile: str = profiles.DEFAULT_PROFILE) -> List[Tuple[str, object]]:
    """Query of PRIM Navitia v2 /journeys: walking limits and speed of the profile, several alternatives."""
    params: List[Tuple[str, object]] = [
        ("from", f"{a['lon']};{a['lat']}"), ("to", f"{b['lon']};{b['lat']}"),
        *profiles.navitia_params(profile),
        ("min_nb_journeys", NAVITIA_MIN_JOURNEYS), ("max_nb_journeys", NAVITIA_MAX_JOURNEYS),
    ] + [("forbidden_uris[]", u) for u in forbidden]
    if when is not None:  # without it Navitia plans from now
        params += [("datetime", when.astimezone(PARIS_TZ).strftime("%Y%m%dT%H%M%S")),
                   ("datetime_represents", "arrival" if arrive else "departure")]
    return params


def _navitia(a: dict, b: dict, forbidden: List[str] = (), when: Optional[datetime] = None,
             arrive: bool = False, profile: str = profiles.DEFAULT_PROFILE) -> List[dict]:
    params = _navitia_params(a, b, forbidden, when, arrive, profile)
    r = httpx.get(PRIM_JOURNEYS, headers={"apiKey": PRIM_API_KEY}, timeout=30, params=params)
    if r.status_code != 200:
        raise HTTPException(502, f"PRIM answered {r.status_code}: {r.text[:300]}")
    return r.json().get("journeys", [])


def _legacy(j: dict) -> dict:
    """Navitia journey with lifts near each stop: what Navitia alone proposes (baseline, current UI)."""
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
    return {"duration_s": j.get("duration"), "departure": j.get("departure_date_time"),
            "arrival": j.get("arrival_date_time"), "sections": sections, "lifts_not_available": blocking}


def _summary(j: dict) -> dict:
    """What Navitia alone says about a journey (no lift or sidewalk check): the comparison baseline."""
    return {"duration_min": round((j.get("duration") or 0) / 60), "verdict_navitia": "accessible",
            "steps": [{"type": s.get("type"), "line": (s.get("display_informations") or {}).get("code"),
                       "mode": (s.get("display_informations") or {}).get("commercial_mode"),
                       "from": (s.get("from") or {}).get("name"), "to": (s.get("to") or {}).get("name")}
                      for s in j.get("sections", []) if s.get("type") in ("public_transport", "street_network")]}


def _reports() -> List[dict]:
    """Community reports (chantier B). Empty until its columns exist."""
    if not db.enabled():
        return []
    try:
        with db.conn().cursor() as cur:
            cur.execute("""SELECT id, lon, lat, categorie, temporaire, confirmations, created_at,
                                  target_type, target_id, message
                           FROM user_reports WHERE lon IS NOT NULL""")
            cols = [c.name for c in cur.description]
            return [dict(zip(cols, row), description=row[-1]) for row in cur.fetchall()]
    except Exception:
        logging.warning("user_reports not readable yet, journeys checked without community reports")
        return []


_layers: dict = {}


def _layer(fn_name: str) -> Tuple[List[dict], Optional[str]]:
    """Optional GeoJSON-like layer from sources, built once per upstream refresh (bbox precomputed)."""
    fn = getattr(sources, fn_name, None)
    if fn is None:
        return [], None
    try:
        data = fn()
    except Exception:
        logging.exception("%s unavailable, journey checked without it", fn_name)
        return [], None
    key = (fn_name, data.get("fetched_at"), len(data.get("rows", [])))
    if key not in _layers:
        feats = []
        for r in data.get("rows", []):
            shape = (r.get("geo_shape") or {}).get("geometry")
            if shape:
                feats.append({"type": "Feature", "geometry": shape, "_bbox": verify.feature_bbox(shape),
                              "properties": {"summary": sources.works_en(r.get("chantier_synthese")), "end": r.get("date_fin")}})
        _layers.clear() if len(_layers) > 8 else None
        _layers[key] = feats
    return _layers[key], data.get("fetched_at")


def _lifts_on_route(journeys: List[dict], rows: List[dict]) -> List[dict]:
    stops, zdcs = [], set()
    for j in journeys:
        for s in j.get("sections", []):
            if s.get("type") == "public_transport":
                for end in ("from", "to"):
                    sp = (s.get(end) or {}).get("stop_point") or {}
                    c = sp.get("coord") or {}
                    if c.get("lon") is not None:
                        stops.append((float(c["lon"]), float(c["lat"])))
                    area = (sp.get("stop_area") or {}).get("id")
                    if area:
                        zdcs.add(area.rsplit(":", 1)[-1])
    return [r for r in rows if str(r.get("zdcid")) in zdcs or (
        (r.get("centroidzdc") or {}).get("lon") is not None and any(
            verify.dist_m(lon, lat, r["centroidzdc"]["lon"], r["centroidzdc"]["lat"]) <= verify.LIFT_RADIUS_M
            for lon, lat in stops))]


def _check_all(journeys: List[dict], profile: str, lifts: dict, prefix: str = "it",
               rel: Optional[dict] = None) -> List[dict]:
    works, works_at = _layer("works")
    stairs, _ = _layer("stairs")
    reports = _reports()
    if rel is None:
        rel = reliability.for_lifts(_lifts_on_route(journeys, lifts["rows"]))
    low_vision = sources.low_vision() if verify.cares_about_low_vision(profile) else None
    return [verify.verify_journey(j, profile, lifts["rows"], lifts.get("fetched_at"), works, works_at,
                                  stairs, reports, reliability=rel, it_id=f"{prefix}{i + 1}", low_vision=low_vision)
            for i, j in enumerate(journeys)]


@app.get("/api/journey")
def api_journey(from_q: str = Query(..., alias="from"), to_q: str = Query(..., alias="to"),
                profile: str = Query(profiles.DEFAULT_PROFILE, description=", ".join(profiles.PROFILES)),
                replay: Optional[str] = Query(None, description="demo: recorded journeys and lift snapshot"),
                when: Optional[str] = Query(None, max_length=40, description="local Paris time, e.g. 2026-10-22T18:30; default now"),
                arrive: bool = Query(False, description="true: 'when' is the arrival time (Arrive by)")):
    if profile not in profiles.PROFILES:
        raise HTTPException(400, f"profile must be one of: {', '.join(profiles.PROFILES)}")
    # The recorded demo has fixed times: the chosen time does not apply to it.
    at = None if replay == "demo" else _parse_when(when)
    if replay == "demo":
        try:
            demo = json.loads((FIXTURES / "navitia_demo.json").read_text())
            lifts = json.loads((FIXTURES / "lifts_demo.json").read_text())
        except FileNotFoundError:
            raise HTTPException(404, "demo files missing (static/fixtures)")
        a, b, journeys = demo["from"], demo["to"], demo["journeys"]
        rel = reliability.load_fixture(FIXTURES / "reliability_demo.json")
    else:
        if not PRIM_API_KEY:
            raise HTTPException(503, "PRIM_API_KEY missing: journey planning unavailable")
        a, b = _resolve(from_q), _resolve(to_q)
        if not a or not b:
            raise HTTPException(404, "departure or arrival address not found")
        journeys = _navitia(a, b, when=at, arrive=arrive, profile=profile)
        lifts = sources.lifts()
        rel = None
    itineraries = _check_all(journeys, profile, lifts, rel=rel)
    if replay != "demo" and itineraries and all(it["verdict"] == "bloque" for it in itineraries):
        forbidden = verify.blocking_stop_areas(itineraries[0])
        if forbidden:
            try:
                itineraries += _check_all(_navitia(a, b, forbidden, when=at, arrive=arrive,
                                                    profile=profile), profile, lifts, prefix="b")
            except HTTPException:
                logging.warning("plan B request failed, keeping the blocked itineraries only")
    itineraries = verify.pick_plan_b(itineraries)
    return {"from": a, "to": b, "profile": profile, "itineraries": itineraries,
            "way_out": verify.way_out(itineraries, profile),
            "journeys": [] if replay == "demo" else [_legacy(j) for j in journeys],  # kept for the current UI
            "baseline": [_summary(j) for j in journeys], "replay": replay,
            "source": "PRIM / Navitia, with the walking limits of this profile, checked by Roulib",
            "lifts_fetched_at": lifts.get("fetched_at"),
            "when": at.strftime("%Y-%m-%dT%H:%M") if at else None, "arrive": bool(at and arrive),
            "time_note": _time_note(at)}


# --- Health & page ---------------------------------------------------------

@app.get("/health")
def health():
    return {"ok": True, "db": db.enabled(), "prim": bool(PRIM_API_KEY), "poller": poller.state}


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html")


app.mount("/static", StaticFiles(directory=STATIC), name="static")
