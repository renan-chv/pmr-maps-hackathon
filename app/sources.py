"""Fetchers for the open data sources, with a small in-memory TTL cache.

Every fetcher returns plain dicts and records where the data came from and when,
so the UI (and later the agent) can always show source + freshness.
"""
from __future__ import annotations

import json
import logging
import math
import re
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

import httpx

log = logging.getLogger("sources")
CACHE_DIR = Path(os.getenv("CACHE_DIR", "/tmp/pmr-cache"))

IDF_REGION = "https://data.iledefrance.fr/api/explore/v2.1/catalog/datasets"
IDFM = "https://data.iledefrance-mobilites.fr/api/explore/v2.1/catalog/datasets"
PARIS = "https://opendata.paris.fr/api/explore/v2.1/catalog/datasets"
SNCF = "https://ressources.data.sncf.com/api/explore/v2.1/catalog/datasets"
GEOCODER = "https://data.geopf.fr/geocodage/search"
# Acceslibre nightly export on data.gouv.fr (acceslibre.csv), queried through the tabular API (no key).
# The "with-web-url" resource is 3-4x slower to query; the /uuid/ permalink gives the same page.
ACCESLIBRE = "https://tabular-api.data.gouv.fr/api/resources/5b0f44f2-e6ea-4a58-874d-6fe364b40342/data/"
ACCESLIBRE_PAGE = "https://acceslibre.beta.gouv.fr/uuid/{id}/"
# Optional "minLon,minLat,maxLon,maxLat" preloaded at startup, e.g. the neighbourhood shown in the demo.
PLACES_WARM_BBOX = os.getenv("PLACES_WARM_BBOX", "")

SOURCES = {
    "lifts": {
        "name": "IDFM – Elevator status",
        "url": "https://data.iledefrance.fr/explore/dataset/etat-des-ascenseurs/",
        "license": "Licence Mobilité",
    },
    "lifts_sncf": {
        "name": "SNCF Gares & Connexions – Status of station elevators and escalators",
        "url": "https://ressources.data.sncf.com/explore/dataset/etat-fonctionnement-elevatique-gare/",
        "license": "ODbL",
    },
    "stations": {
        "name": "IDFM – Stop register",
        "url": "https://data.iledefrance-mobilites.fr/explore/dataset/arrets/",
        "license": "Licence Ouverte v2.0 (Etalab)",
    },
    "train_stations": {
        "name": "IDFM – Station accessibility",
        "url": "https://data.iledefrance-mobilites.fr/explore/dataset/accessibilite-en-gare/",
        "license": "Licence Ouverte v2.0 (Etalab)",
    },
    "works": {
        "name": "Ville de Paris – Roadworks in Paris",
        "url": "https://opendata.paris.fr/explore/dataset/chantiers-a-paris/",
        "license": "ODbL",
    },
    "stairs": {
        "name": "Ville de Paris – Street map, stepped streets",
        "url": "https://opendata.paris.fr/explore/dataset/plan-de-voirie-voies-en-escalier/",
        "license": "ODbL",
    },
    "places": {
        "name": "Acceslibre – Accessibility of public venues (data.gouv.fr export)",
        "url": "https://www.data.gouv.fr/fr/datasets/60a528e8b656ce01b4c0c0a6/",
        "license": "Licence Ouverte v2.0 (Etalab)",
    },
}

_cache: Dict[str, Tuple[float, Any]] = {}
_locks: Dict[str, threading.Lock] = {}
_client = httpx.Client(timeout=httpx.Timeout(180, connect=15), headers={"User-Agent": "pmr-maps-hackathon"})


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _disk(key: str) -> Path:
    return CACHE_DIR / f"{key}.json"


def cached(key: str, ttl: int, fn: Callable[[], Any]) -> Any:
    """TTL cache, one download at a time per key, with a stale fallback.

    The last good payload is also written to disk. If the upstream API fails,
    we serve the last known version flagged with "stale": True so the UI can
    say how old it is instead of showing nothing.
    """
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < ttl:
        return hit[1]
    with _locks.setdefault(key, threading.Lock()):
        hit = _cache.get(key)
        if hit and time.time() - hit[0] < ttl:
            return hit[1]
        try:
            value = fn()
        except Exception as e:
            stale = hit[1] if hit else None
            if stale is None and _disk(key).exists():
                stale = json.loads(_disk(key).read_text())
            if stale is None:
                raise
            log.warning("%s: upstream failed (%s), serving stale data from %s", key, e, stale.get("fetched_at"))
            return {**stale, "stale": True, "error": str(e)}
        _cache[key] = (time.time(), value)
        try:
            CACHE_DIR.mkdir(parents=True, exist_ok=True)
            _disk(key).write_text(json.dumps(value))
        except OSError:
            log.warning("could not write disk cache for %s", key)
        return value


def _get_json(url: str, params: dict, label: str) -> Any:
    for attempt in range(3):
        try:
            t0 = time.time()
            r = _client.get(url, params=params)
            r.raise_for_status()
            body = r.json()
            log.info("%s: %.1fs", label, time.time() - t0)
            return body
        except (httpx.TimeoutException, httpx.TransportError, httpx.HTTPStatusError) as e:
            log.warning("%s: attempt %d failed: %r", label, attempt + 1, e)
            if attempt == 2:
                raise
            time.sleep(2 * (attempt + 1))
    raise RuntimeError("unreachable")


def _export(base: str, dataset: str, where: Optional[str] = None, select: Optional[str] = None) -> List[dict]:
    params = {}
    if where:
        params["where"] = where
    if select:
        params["select"] = select
    rows = _get_json(f"{base}/{dataset}/exports/json", params, dataset)
    log.info("%s: %d rows", dataset, len(rows))
    return rows


# --- Lifts (live: IDFM ~3 updates a day, refreshed hourly by SNCF for stations) --

def fetch_lifts_raw() -> List[dict]:
    return _export(IDF_REGION, "etat-des-ascenseurs")


def lifts(force: bool = False) -> dict:
    ttl = 0 if force else 300

    def load():
        rows = fetch_lifts_raw()
        fetched_at = now_iso()
        try:
            sncf = lifts_sncf()
        except Exception as e:  # SNCF down: the IDFM data alone is still valid
            log.warning("lifts_sncf unavailable, IDFM only: %r", e)
            sncf = None
        if sncf:
            rows, n = overlay_sncf(rows, sncf["rows"], sncf["fetched_at"])
            log.info("lifts: %d/%d statuses refreshed from SNCF", n, len(rows))
            return {"fetched_at": fetched_at, "rows": rows, "sncf_fetched_at": sncf["fetched_at"], "sncf_refreshed": n}
        return {"fetched_at": fetched_at, "rows": rows}

    return cached("lifts", ttl, load)


# --- SNCF station lifts (hourly upstream) ----------------------------------
# The SNCF dataset uses the same equipment ids as the IDFM liftid of train-station lifts
# (e.g. 33847f22-… = Paris Saint-Lazare, lift "ASC 2" in both). It has no coordinates, so
# instead of adding new points we refresh the status of the IDFM rows it covers:
# SNCF is updated every hour, IDFM about 3 times a day.

SNCF_STATUS = {"OK": "available", "KO": "notavailable"}  # "Inconnu" -> keep the IDFM status


def _paris_local(stamp: str) -> str:
    """UTC ISO stamp -> naive Paris local time "YYYY-MM-DDTHH:MM", the format of IDFM liftstateupdate."""
    try:
        from zoneinfo import ZoneInfo
        return datetime.fromisoformat(stamp).astimezone(ZoneInfo("Europe/Paris")).strftime("%Y-%m-%dT%H:%M")
    except Exception:
        return stamp[:16]


def lifts_sncf() -> dict:
    def load():
        rows = _export(SNCF, "etat-fonctionnement-elevatique-gare",
                       select="id,gareid,libelle,localisationdescriptive,etat_de_fonctionnement")
        return {"fetched_at": now_iso(), "rows": rows}

    return cached("lifts_sncf", 1800, load)


def overlay_sncf(idfm_rows: List[dict], sncf_rows: List[dict], sncf_fetched_at: str) -> Tuple[List[dict], int]:
    """Return the IDFM rows with the fresher SNCF status where the lift ids match, and how many matched."""
    sncf_by_id = {str(r.get("id")): r for r in sncf_rows if r.get("id")}
    out, n = [], 0
    for row in idfm_rows:
        s = sncf_by_id.get(str(row.get("liftid")))
        status = SNCF_STATUS.get(str((s or {}).get("etat_de_fonctionnement") or "").strip().upper())
        if not status:
            out.append(row)
            continue
        n += 1
        new = {**row, "status_source": "SNCF", "sncf_status": s.get("etat_de_fonctionnement"),
               "sncf_fetched_at": sncf_fetched_at}
        if status != row.get("liftstatus"):
            # Status changed since the last IDFM update: SNCF saw it first, date it from the SNCF read
            new.update({"liftstatus": status, "liftstatus_idfm": row.get("liftstatus"),
                        "liftstateupdate_idfm": row.get("liftstateupdate"),
                        "liftstateupdate": _paris_local(sncf_fetched_at)})
            if status == "available":
                new["liftreason"] = None
        out.append(new)
    return out, n


# --- Stations / stops (static, refreshed daily) ----------------------------

def stations() -> dict:
    def load():
        rows = _export(
            IDFM, "arrets",
            where='arrtype != "bus"',
            select="arrid,arrname,arrtype,arraccessibility,arrtown,zdaid,arrgeopoint",
        )
        return {"fetched_at": now_iso(), "rows": rows}

    return cached("stations", 86400, load)


def bus_stops() -> dict:
    def load():
        rows = _export(
            IDFM, "arrets",
            where='arrtype = "bus"',
            select="arrid,arrname,arraccessibility,arrtown,arrgeopoint",
        )
        return {"fetched_at": now_iso(), "rows": rows}

    return cached("bus_stops", 86400, load)


def train_stations() -> dict:
    def load():
        rows = _export(IDFM, "accessibilite-en-gare")
        return {"fetched_at": now_iso(), "rows": rows}

    return cached("train_stations", 86400, load)


# --- Roadworks in Paris (active today) -------------------------------------

def works() -> dict:
    """Active roadworks whose footprint includes the sidewalk (the ones that block a wheelchair)."""
    def load():
        today = date.today().isoformat()
        rows = _export(
            PARIS, "chantiers-a-paris",
            where=f'date_debut <= "{today}" and date_fin >= "{today}" and localisation_detail = "EMPRISE_TROTTOIR"',
            select="num_emprise,chantier_categorie,chantier_synthese,moa_principal,date_debut,date_fin,"
                   "localisation_detail,cp_arrondissement,geo_shape",
        )
        return {"fetched_at": now_iso(), "rows": rows}

    return cached("works", 3600, load)


# --- Stairs in the street (static, ~550 objects in Paris) ------------------

def stairs() -> dict:
    """Public stairs on the street network: the only way through for some passages (Montmartre, Belleville…)."""
    def load():
        rows = _export(PARIS, "plan-de-voirie-voies-en-escalier", select="objectid,num_pave,lib_classe,geo_shape")
        return {"fetched_at": now_iso(), "rows": rows}

    return cached("stairs", 86400, load)


# --- Places: restaurants, shops… (Acceslibre) -----------------------------

PLACE_TILE = 0.01  # degrees, about 730 m x 1.1 km in Paris
PLACE_COLUMNS = ",".join([
    "id", "name", "activite", "numero", "voie", "postal_code", "commune", "longitude", "latitude",
    "stationnement_pmr", "stationnement_ext_pmr",
    "cheminement_ext_plain_pied", "cheminement_ext_rampe", "cheminement_ext_ascenseur",
    "entree_plain_pied", "entree_marches", "entree_marches_rampe", "entree_ascenseur", "entree_ascenseur_pmr",
    "entree_pmr", "entree_largeur_mini", "entree_aide_humaine", "entree_dispositif_appel",
    "accueil_cheminement_plain_pied", "accueil_cheminement_rampe", "accueil_cheminement_ascenseur",
    "sanitaires_presence", "sanitaires_adaptes",
])
_tile_pool = ThreadPoolExecutor(max_workers=6)


def place_tiles(x1: float, y1: float, x2: float, y2: float) -> List[Tuple[int, int]]:
    t = PLACE_TILE
    return [(tx, ty) for tx in range(math.floor(x1 / t), math.floor(x2 / t) + 1)
            for ty in range(math.floor(y1 / t), math.floor(y2 / t) + 1)]


def places_tile(tx: int, ty: int) -> dict:
    """Every Acceslibre place in one grid tile (tx, ty = floor(lon / PLACE_TILE), floor(lat / PLACE_TILE)).

    The tabular API caps pages at 200 rows: read page 1 to get the total, then the other pages in parallel.
    """
    def load():
        base = {
            "columns": PLACE_COLUMNS, "page_size": 200,
            "longitude__greater": f"{tx * PLACE_TILE:.4f}", "longitude__less": f"{(tx + 1) * PLACE_TILE:.4f}",
            "latitude__greater": f"{ty * PLACE_TILE:.4f}", "latitude__less": f"{(ty + 1) * PLACE_TILE:.4f}",
        }
        label = f"acceslibre {tx},{ty}"
        first = _get_json(ACCESLIBRE, {**base, "page": 1}, label)
        rows = first["data"]
        pages = min(-(-first["meta"]["total"] // 200), 15)  # at most 3000 places per tile
        more = _tile_pool.map(lambda p: _get_json(ACCESLIBRE, {**base, "page": p}, label)["data"], range(2, pages + 1))
        for chunk in more:
            rows += chunk
        return {"fetched_at": now_iso(), "rows": rows}

    return cached(f"places_{tx}_{ty}", 86400, load)


# --- Geocoding (IGN Géoplateforme, no key) ---------------------------------

def geocode(q: str) -> Optional[dict]:
    r = _client.get(GEOCODER, params={"q": q, "limit": 1})
    r.raise_for_status()
    feats = r.json().get("features", [])
    if not feats:
        return None
    f = feats[0]
    lon, lat = f["geometry"]["coordinates"]
    return {"label": f["properties"].get("label"), "lon": lon, "lat": lat, "score": f["properties"].get("score")}


def warm_up() -> None:
    """Preload every layer so the first visitor does not wait for the downloads."""
    for fn in (stations, train_stations, works, bus_stops):
        try:
            fn()
        except Exception:
            log.exception("warm-up failed for %s", fn.__name__)
    if PLACES_WARM_BBOX:
        try:
            tiles = place_tiles(*[float(v) for v in PLACES_WARM_BBOX.split(",")])
            list(_tile_pool.map(lambda xy: places_tile(*xy), tiles))
            log.info("places warm-up: %d tiles", len(tiles))
        except Exception:
            log.exception("warm-up failed for places (%s)", PLACES_WARM_BBOX)


# IDF bounding box, used to drop homonyms elsewhere in France.
IDF_BBOX = (1.40, 48.10, 3.60, 49.25)


def _in_idf(lon: float, lat: float) -> bool:
    return IDF_BBOX[0] <= lon <= IDF_BBOX[2] and IDF_BBOX[1] <= lat <= IDF_BBOX[3]


def suggest(q: str, limit: int = 6) -> List[dict]:
    """Places (POI) + addresses in Île-de-France for the search box."""
    out, seen = [], set()
    # "10 rue de Rivoli", "boulevard Saint-Michel": the user wants an address, not a place named after it.
    looks_like_address = bool(re.match(r"\s*\d", q)) or bool(
        re.search(r"\b(rue|avenue|av|bd|boulevard|place|quai|impasse|allée|chemin)\b", q, re.I))
    for index in (("address", "poi") if looks_like_address else ("poi", "address")):
        params = {"q": q, "index": index, "limit": 20, "lat": 48.8566, "lon": 2.3522}
        if index == "address":
            params["autocomplete"] = 1
        try:
            r = _client.get(GEOCODER, params=params, timeout=8)
            r.raise_for_status()
        except httpx.HTTPError:
            continue
        for f in r.json().get("features", []):
            lon, lat = f["geometry"]["coordinates"]
            if not _in_idf(lon, lat):
                continue
            pr = f["properties"]
            if index == "poi":
                name = pr.get("toponym") or (pr.get("name") or [""])[0]
                city = pr.get("city")
                city = city[-1] if isinstance(city, list) and city else city
                cat = pr.get("category") or []
                if any("transport" in c for c in cat):
                    continue  # stations come from our own data
                item = {"kind": "place", "label": name, "sub": ", ".join([c for c in [cat[0] if cat else None, city] if c]),
                        "lon": lon, "lat": lat}
            else:
                item = {"kind": "address", "label": pr.get("name") or pr.get("label"),
                        "sub": f'{pr.get("postcode", "")} {pr.get("city", "")}'.strip(), "lon": lon, "lat": lat}
            key = (item["label"], round(lon, 3), round(lat, 3))
            if key in seen:
                continue
            seen.add(key)
            out.append(item)
    # Paris first, then the rest of Île-de-France (stable: keeps the geocoder's order inside each group).
    out.sort(key=lambda it: not (it["kind"] == "place" and "Paris" in it["sub"] or it["sub"].startswith("75")))
    return out[:limit]
