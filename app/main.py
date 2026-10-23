"""Roulib – FastAPI app: serves the map page and GeoJSON layers built from open data."""
from __future__ import annotations

import asyncio
import json
import logging
import math
import os
import re
from concurrent.futures import TimeoutError as FutureTimeout
from concurrent.futures import wait as wait_futures
from datetime import datetime, timedelta
from pathlib import Path
from typing import List, Optional, Tuple
from zoneinfo import ZoneInfo

import httpx
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import agent, db, http_cache, photos, poller, profiles, reliability, reports, search, sources, station_api, verify
from .errors import ApiError

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
STATIC = Path(__file__).resolve().parent.parent / "static"
PRIM_API_KEY = os.getenv("PRIM_API_KEY")
SERVERLESS = bool(os.getenv("VERCEL"))  # Vercel functions sleep between requests
PRIM_JOURNEYS = "https://prim.iledefrance-mobilites.fr/marketplace/v2/navitia/journeys"

app = FastAPI(title="Roulib")
app.add_middleware(GZipMiddleware, minimum_size=1000)  # roadworks layer: 2.3 MB of uncompressed GeoJSON on Aiven
http_cache.install(app)


@app.middleware("http")
async def json_errors(request: Request, call_next):
    """Never a bare 500 page: an open-data source that is down (and not cached) is a 503 the app can explain.

    Registered before CORS, so these answers carry the CORS headers too (the native app could not read them otherwise).
    """
    try:
        return await call_next(request)
    except httpx.HTTPError as e:
        logging.warning("upstream failure on %s: %s", request.url.path, type(e).__name__)
        return JSONResponse({"detail": "A data source is not answering right now. Try again in a moment.",
                             "code": "upstream"}, status_code=503, headers={"Retry-After": "30"})
    except Exception:
        logging.exception("unhandled error on %s", request.url.path)
        return JSONResponse({"detail": "Something went wrong on our side. Try again in a moment.",
                             "code": "internal"}, status_code=500)


# The native shells load the page from the app bundle and call this backend cross-origin:
# capacitor://localhost (iOS), https://localhost and http://localhost (Android). The web app is same-origin.
NATIVE_ORIGINS = ["capacitor://localhost", "https://localhost", "http://localhost"]
app.add_middleware(CORSMiddleware, allow_origins=NATIVE_ORIGINS, allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
                   allow_headers=["Content-Type", "X-User-Token"], allow_credentials=False, max_age=600)


@app.exception_handler(ApiError)
async def api_error(request: Request, exc: ApiError):
    return JSONResponse(exc.body(), status_code=exc.status_code, headers=exc.headers)


@app.exception_handler(RequestValidationError)
async def validation_error(request: Request, exc: RequestValidationError):
    """FastAPI's default 422 is a list of objects; the app shows `detail` as text, so give it a sentence."""
    msgs = []
    for err in exc.errors():
        where = ".".join(str(p) for p in err.get("loc", ()) if p not in ("query", "path", "body", "header"))
        msgs.append(f"{where or 'request'}: {err.get('msg', 'invalid value')}")
    return JSONResponse({"detail": "; ".join(msgs)[:300] or "invalid request", "code": "invalid"}, status_code=422)


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

def _lifts_or_503() -> dict:
    """Live elevator status, or a 503: a trip is never checked (or shown as fine) without it."""
    try:
        return sources.lifts()
    except Exception as e:
        logging.warning("lifts unavailable: %s", type(e).__name__)
        raise ApiError(503, "Elevator status from IDFM is unavailable right now. Try again in a moment.", "upstream",
                       headers={"Retry-After": "60"})


@app.get("/api/lifts")
def api_lifts():
    if SERVERLESS:
        poller.maybe_poll()
    data = _lifts_or_503()
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
def api_bus_stops(bbox: str = Query(..., max_length=200, description="minLon,minLat,maxLon,maxLat")):
    x1, y1, x2, y2 = _bbox(bbox)
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
# Acceslibre's tabular API can take 5-15 s per page (up to 70 s for a cold area): answer with the tiles ready
# within this budget; the others keep loading in the background and are cached for the next call.
PLACES_BUDGET_S = float(os.getenv("PLACES_BUDGET_S", "10"))
MAX_PLACE_TILES = 16


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


def _bbox(bbox: str) -> Tuple[float, float, float, float]:
    try:
        x1, y1, x2, y2 = [float(v) for v in bbox.split(",")]
    except ValueError:
        raise HTTPException(400, "bbox must be minLon,minLat,maxLon,maxLat")
    if not all(math.isfinite(v) for v in (x1, y1, x2, y2)) or x1 > x2 or y1 > y2:
        raise HTTPException(400, "bbox must be minLon,minLat,maxLon,maxLat (numbers, min before max)")
    return x1, y1, x2, y2


@app.get("/api/places")
def api_places(bbox: str = Query(..., max_length=200, description="minLon,minLat,maxLon,maxLat")):
    x1, y1, x2, y2 = _bbox(bbox)
    t = sources.PLACE_TILE  # count before listing: a world-sized box would be millions of tiles
    if (math.floor(x2 / t) - math.floor(x1 / t) + 1) * (math.floor(y2 / t) - math.floor(y1 / t) + 1) > MAX_PLACE_TILES:
        raise HTTPException(400, "area too large: zoom in")
    tiles = sources.place_tiles(x1, y1, x2, y2)
    futures = [sources.in_background(f"places_{tx}_{ty}", lambda tx=tx, ty=ty: sources.places_tile(tx, ty),
                                     sources.places_pool) for tx, ty in tiles]
    done, _ = wait_futures(futures, timeout=PLACES_BUDGET_S)
    feats, seen, fetched, stale, missing = [], set(), [], False, 0
    for fut in futures:
        if fut not in done:
            missing += 1
            continue
        try:
            data = fut.result()
        except Exception as e:
            logging.warning("places tile unavailable: %s", type(e).__name__)
            missing += 1
            continue
        fetched.append(data["fetched_at"])
        stale = stale or data.get("stale", False)
        for r in data["rows"]:
            lon, lat = _num(r.get("longitude")), _num(r.get("latitude"))
            if lon is None or lat is None or not r.get("id") or r["id"] in seen:
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
    if not fetched:
        still_loading = any(not f.done() for f in futures)
        raise ApiError(503, "Places are still loading from Acceslibre. Try again in a few seconds." if still_loading
                       else "Acceslibre is not answering right now. Try again in a moment.", "upstream",
                       headers={"Retry-After": "5" if still_loading else "60"})
    body = fc(feats, "places", min(fetched), stale=stale, incomplete=bool(missing), missing_tiles=missing,
              counts={k: sum(f["properties"]["wheelchair"] == k for f in feats) for k in ("true", "partial", "false", "unknown")})
    if missing:  # part of the area only: never cached (browser, CDN), so the next call gets the rest
        return JSONResponse(body, headers={"Cache-Control": "no-store"})
    return body


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


def _lifts_near(rows: List[dict], lon: float, lat: float, radius: float = 150) -> List[dict]:
    out = []
    for r in rows:
        c = r.get("centroidzdc") or {}
        if c.get("lon") is not None and _dist_m(lon, lat, c["lon"], c["lat"]) <= radius:
            out.append({"liftid": r.get("liftid"), "station": r.get("zdcname"), "status": r.get("liftstatus"),
                        "reason": r.get("liftreason"), "situation": r.get("liftsituation"),
                        "source_update": r.get("liftstateupdate")})
    return out


@app.get("/api/geocode")
def api_geocode(q: str = Query(..., min_length=1, max_length=200)):
    res = sources.geocode(q)
    if not res:
        raise HTTPException(404, "address not found")
    return res


@app.get("/api/suggest")
def api_suggest(q: str = Query(..., min_length=2, max_length=200),
                lon: Optional[float] = Query(None, ge=-180, le=180), lat: Optional[float] = Query(None, ge=-90, le=90)):
    return {"results": sources.suggest(q, near=(lon, lat) if lon is not None and lat is not None else None)}


OUTSIDE_AREA = "Roulib covers Île-de-France only: pick a departure and an arrival in the Paris region."


def _resolve(q: str) -> Optional[dict]:
    """Accept "lon,lat" (from the UI) or free text (geocoded). Points outside Île-de-France are a 400."""
    parts = q.split(",")
    if len(parts) == 2:
        try:
            lon, lat = float(parts[0]), float(parts[1])
        except ValueError:
            pass
        else:
            if not sources._in_idf(lon, lat):  # also NaN and swapped "lat,lon"
                raise ApiError(400, OUTSIDE_AREA, "outside_area")
            return {"label": q, "lon": lon, "lat": lat}
    try:
        res = sources.geocode(q)
    except httpx.HTTPError as e:
        logging.warning("geocoder unavailable: %s", type(e).__name__)
        raise ApiError(503, "Address search is not answering right now. Pick a place from the suggestions "
                            "or try again in a moment.", "upstream")
    if res and not sources._in_idf(float(res["lon"]), float(res["lat"])):
        raise ApiError(400, OUTSIDE_AREA, "outside_area")
    return res


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
PRIM_TIMEOUT = httpx.Timeout(20, connect=5)  # PRIM answers in about 1 s; a plan B call doubles the worst case
# PRIM / Navitia error ids that mean "no trip", not "service down": HTTP 404 {"code": "no_route", "reason": id}.
NO_ROUTE = {
    "no_solution": "No step-free trip found by IDFM for this time. Try another time.",
    "no_origin": "The departure point is not reachable by public transport according to IDFM. "
                 "Try a nearby station or address.",
    "no_destination": "The arrival point is not reachable by public transport according to IDFM. "
                      "Try a nearby station or address.",
    "no_origin_nor_destination": "Neither the departure nor the arrival is reachable by public transport according "
                                 "to IDFM. Try nearby stations or addresses.",
    "date_out_of_bounds": "IDFM has no timetable for this date yet. Pick an earlier date.",
}
NO_ROUTE_ANY_TRIP = "No trip found by IDFM for this time. Try another time."  # profiles that can take stairs


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
    """Journeys from PRIM, or an ApiError: 404 "no_route" when IDFM finds no trip, 503 "upstream" otherwise.

    The upstream body is logged by its error id only and never sent to the app.
    """
    params = _navitia_params(a, b, forbidden, when, arrive, profile)
    try:
        r = httpx.get(PRIM_JOURNEYS, headers={"apiKey": PRIM_API_KEY}, timeout=PRIM_TIMEOUT, params=params)
    except httpx.TimeoutException:
        logging.warning("PRIM journeys: timeout")
        raise ApiError(503, "IDFM's trip planner is taking too long to answer. Try again in a moment.", "upstream",
                       headers={"Retry-After": "10"})
    except httpx.HTTPError as e:
        logging.warning("PRIM journeys unreachable: %s", type(e).__name__)
        raise ApiError(503, "IDFM's trip planner can't be reached right now. Try again in a moment.", "upstream",
                       headers={"Retry-After": "30"})
    try:
        body = r.json()
    except ValueError:
        body = None
    body = body if isinstance(body, dict) else {}
    error_id = str((body.get("error") or {}).get("id") or "") if isinstance(body.get("error"), dict) else ""
    if r.status_code == 200:
        journeys = body.get("journeys") or []
        if journeys:
            return journeys
        error_id = error_id or "no_solution"  # 200 with nothing in it: same answer for the user
    if error_id in NO_ROUTE:
        stairs_ok = dict(profiles.navitia_params(profile)).get("wheelchair") == "false"
        detail = NO_ROUTE_ANY_TRIP if error_id == "no_solution" and stairs_ok else NO_ROUTE[error_id]
        raise ApiError(404, detail, "no_route", reason=error_id)
    logging.warning("PRIM journeys answered %s (%s)", r.status_code, error_id or "no error id")
    if r.status_code == 429:
        raise ApiError(503, "Live trip planning is very busy right now. Try again in a few minutes.", "upstream",
                       headers={"Retry-After": "120"})
    raise ApiError(503, "IDFM's trip planner is not answering properly right now. Try again in a moment.", "upstream",
                   headers={"Retry-After": "30"})


def _legacy(j: dict, lift_rows: List[dict]) -> dict:
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
                    lifts = _lifts_near(lift_rows, float(coord["lon"]), float(coord["lat"]))
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


REPORTS_PAD_DEG = 0.01  # about 1 km around the journeys: reports further away cannot touch them


def _journeys_bbox(journeys: List[dict]) -> Optional[Tuple[float, float, float, float]]:
    """Box around every point of these journeys (walk lines and stops), padded; None when there is none."""
    xs, ys = [], []
    for j in journeys:
        for s in j.get("sections") or []:
            for p in ((s.get("geojson") or {}).get("coordinates") or []):
                if isinstance(p, (list, tuple)) and len(p) >= 2:
                    xs.append(float(p[0]))
                    ys.append(float(p[1]))
            for end in ("from", "to"):
                lon, lat, _, _ = verify._stop(s.get(end) or {})
                if lon is not None:
                    xs.append(lon)
                    ys.append(lat)
    if not xs:
        return None
    d = REPORTS_PAD_DEG
    return min(xs) - d, min(ys) - d, max(xs) + d, max(ys) + d


def _reports(bbox: Optional[Tuple[float, float, float, float]] = None) -> List[dict]:
    """Community reports (chantier B) near the journeys, without the ones hidden by moderation (flagged)."""
    if not db.enabled():
        return []
    where, args = "", []
    if bbox:
        where, args = " AND r.lon BETWEEN %s AND %s AND r.lat BETWEEN %s AND %s", [bbox[0], bbox[2], bbox[1], bbox[3]]
    try:
        with db.conn().cursor() as cur:
            cur.execute(f"""SELECT r.id, r.lon, r.lat, r.categorie, r.temporaire, r.confirmations, r.created_at,
                                   r.target_type, r.target_id, r.message
                            FROM user_reports r
                            WHERE r.lon IS NOT NULL{where}
                              AND (SELECT count(*) FROM report_flags f WHERE f.report_id = r.id) < %s""",
                        (*args, reports.HIDE_AFTER_FLAGS))
            cols = [c.name for c in cur.description]
            return [dict(zip(cols, row), description=row[-1]) for row in cur.fetchall()]
    except Exception:
        logging.warning("user_reports not readable yet, journeys checked without community reports")
        return []


_layers: dict = {}
# How long a journey waits for a layer that is not in memory yet (cold start, slow opendata.paris.fr: minutes).
# The download goes on in the background for the next journeys.
LAYER_BUDGET_S = {"works": 3.0, "stairs": 10.0}
LOW_VISION_BUDGET_S = 6.0  # all six visually impaired layers together; a missing one is checked as unknown


def _layer(fn_name: str) -> Tuple[Optional[List[dict]], Optional[str]]:
    """Optional GeoJSON-like layer from sources, built once per upstream refresh (bbox precomputed).

    (None, None) when the layer is unavailable: the caller must treat that as unknown, not as "nothing there".
    """
    fn = getattr(sources, fn_name, None)
    if fn is None:
        return None, None
    try:
        data = sources.in_background(f"layer_{fn_name}", fn).result(timeout=LAYER_BUDGET_S.get(fn_name, 10.0))
    except FutureTimeout:
        logging.warning("%s still loading, journey checked without it", fn_name)
        return None, None
    except Exception:
        logging.exception("%s unavailable, journey checked without it", fn_name)
        return None, None
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
    if not journeys:
        return []  # nothing to check: do not load (or wait for) the layers
    works, works_at = _layer("works")  # information only: never changes a verdict, fine to skip
    stairs, _ = _layer("stairs")  # None (unavailable) makes every walk "unknown" for stairs, never "clear"
    reports = _reports(_journeys_bbox(journeys))
    if rel is None:
        rel = reliability.for_lifts(_lifts_on_route(journeys, lifts["rows"]))
    low_vision = sources.low_vision(LOW_VISION_BUDGET_S) if verify.cares_about_low_vision(profile) else None
    return [verify.verify_journey(j, profile, lifts["rows"], lifts.get("fetched_at"), works or [], works_at,
                                  stairs, reports, reliability=rel, it_id=f"{prefix}{i + 1}", low_vision=low_vision)
            for i, j in enumerate(journeys)]


@app.get("/api/journey")
def api_journey(from_q: str = Query(..., alias="from", min_length=1, max_length=200),
                to_q: str = Query(..., alias="to", min_length=1, max_length=200),
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
            raise ApiError(503, "Live trip planning is not available on this server.", "unavailable")
        a, b = _resolve(from_q), _resolve(to_q)
        if not a or not b:
            raise ApiError(404, "Departure or arrival address not found. Try a station, an address or a landmark.",
                           "address_not_found")
        journeys = _navitia(a, b, when=at, arrive=arrive, profile=profile)
        lifts = _lifts_or_503()
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
            "journeys": [] if replay == "demo" else [_legacy(j, lifts["rows"]) for j in journeys],  # kept for the current UI
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
