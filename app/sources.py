"""Fetchers for the open data sources, with a small in-memory TTL cache.

Every fetcher returns plain dicts and records where the data came from and when,
so the UI (and later the agent) can always show source + freshness.
"""
from __future__ import annotations

import json
import logging
import os
import threading
import time
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

import httpx

log = logging.getLogger("sources")
CACHE_DIR = Path(os.getenv("CACHE_DIR", "/tmp/pmr-cache"))

IDF_REGION = "https://data.iledefrance.fr/api/explore/v2.1/catalog/datasets"
IDFM = "https://data.iledefrance-mobilites.fr/api/explore/v2.1/catalog/datasets"
PARIS = "https://opendata.paris.fr/api/explore/v2.1/catalog/datasets"
GEOCODER = "https://data.geopf.fr/geocodage/search"

SOURCES = {
    "lifts": {
        "name": "IDFM – État des ascenseurs",
        "url": "https://data.iledefrance.fr/explore/dataset/etat-des-ascenseurs/",
        "license": "Licence Mobilité",
    },
    "stations": {
        "name": "IDFM – Référentiel des arrêts",
        "url": "https://data.iledefrance-mobilites.fr/explore/dataset/arrets/",
        "license": "Licence Ouverte v2.0 (Etalab)",
    },
    "train_stations": {
        "name": "IDFM – Accessibilité en gare",
        "url": "https://data.iledefrance-mobilites.fr/explore/dataset/accessibilite-en-gare/",
        "license": "Licence Ouverte v2.0 (Etalab)",
    },
    "works": {
        "name": "Ville de Paris – Chantiers à Paris",
        "url": "https://opendata.paris.fr/explore/dataset/chantiers-a-paris/",
        "license": "ODbL",
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


def _export(base: str, dataset: str, where: Optional[str] = None, select: Optional[str] = None) -> List[dict]:
    params = {}
    if where:
        params["where"] = where
    if select:
        params["select"] = select
    url = f"{base}/{dataset}/exports/json"
    for attempt in range(3):
        try:
            t0 = time.time()
            r = _client.get(url, params=params)
            r.raise_for_status()
            rows = r.json()
            log.info("%s: %d rows in %.1fs", dataset, len(rows), time.time() - t0)
            return rows
        except (httpx.TimeoutException, httpx.TransportError, httpx.HTTPStatusError) as e:
            log.warning("%s: attempt %d failed: %r", dataset, attempt + 1, e)
            if attempt == 2:
                raise
            time.sleep(2 * (attempt + 1))
    raise RuntimeError("unreachable")


# --- Lifts (live, ~3 updates a day upstream) -------------------------------

def fetch_lifts_raw() -> List[dict]:
    return _export(IDF_REGION, "etat-des-ascenseurs")


def lifts(force: bool = False) -> dict:
    ttl = 0 if force else 300

    def load():
        rows = fetch_lifts_raw()
        return {"fetched_at": now_iso(), "rows": rows}

    return cached("lifts", ttl, load)


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
