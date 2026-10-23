"""Fetchers for the open data sources, with a small in-memory TTL cache.

Every fetcher returns plain dicts and records where the data came from and when,
so the UI (and later the agent) can always show source + freshness.
"""
from __future__ import annotations

import hashlib
import json
import logging
import math
import re
import os
import threading
import time
import unicodedata
from concurrent.futures import Future, ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeout
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

import httpx

log = logging.getLogger("sources")
CACHE_DIR = Path(os.getenv("CACHE_DIR", "/tmp/pmr-cache"))
SERVERLESS = bool(os.getenv("VERCEL"))  # functions freeze between requests: no background refresh there

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
        "name": "IDFM – État des ascenseurs",
        "url": "https://data.iledefrance.fr/explore/dataset/etat-des-ascenseurs/",
        "license": "Licence Mobilité",
    },
    "lifts_sncf": {
        "name": "SNCF Gares & Connexions – État des équipements d'élévatique en gare",
        "url": "https://ressources.data.sncf.com/explore/dataset/etat-fonctionnement-elevatique-gare/",
        "license": "ODbL",
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
    "stairs": {
        "name": "Ville de Paris – Plan de voirie, voies en escalier",
        "url": "https://opendata.paris.fr/explore/dataset/plan-de-voirie-voies-en-escalier/",
        "license": "ODbL",
    },
    "places": {
        "name": "Acceslibre – Accessibilité des ERP (export data.gouv.fr)",
        "url": "https://www.data.gouv.fr/fr/datasets/60a528e8b656ce01b4c0c0a6/",
        "license": "Licence Ouverte v2.0 (Etalab)",
    },
}

_cache: Dict[str, Tuple[float, Any]] = {}
_locks: Dict[str, threading.Lock] = {}
_client = httpx.Client(timeout=httpx.Timeout(180, connect=15), headers={"User-Agent": "pmr-maps-hackathon"})


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


_SAFE_KEY = re.compile(r"[A-Za-z0-9_.:()-]{1,120}")


def _disk(key: str) -> Path:
    # Keys can carry user text (a search query): hash anything that is not a plain file name.
    name = key if _SAFE_KEY.fullmatch(key) and ".." not in key else "h_" + hashlib.sha1(key.encode()).hexdigest()
    return CACHE_DIR / f"{name}.json"


def _read_disk(key: str) -> Any:
    try:
        return json.loads(_disk(key).read_text()) if _disk(key).exists() else None
    except (OSError, ValueError):
        return None


def cached(key: str, ttl: int, fn: Callable[[], Any]) -> Any:
    """TTL cache, one download at a time per key, with a stale fallback.

    The last good payload is also written to disk. If the upstream API fails,
    we serve the last known version flagged with "stale": True so the UI can
    say how old it is instead of showing nothing.

    Expired but in memory: answered at once (its fetched_at says how old it is) while a background refresh
    runs. A slow upstream (Paris roadworks export: minutes at times) then never blocks a journey. ttl=0 forces.
    """
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < ttl:
        return hit[1]
    if hit and ttl > 0 and not SERVERLESS:
        in_background(f"refresh:{key}", lambda: _load(key, ttl, fn))
        value = hit[1]
        if isinstance(value, dict) and not value.get("stale") and time.time() - hit[0] > 2 * ttl + 60:
            # the refreshes keep failing: say so, as the blocking path does (same object every time after this)
            value = {**value, "stale": True}
            _cache[key] = (hit[0], value)
        return value
    return _load(key, ttl, fn)


def _load(key: str, ttl: int, fn: Callable[[], Any]) -> Any:
    with _locks.setdefault(key, threading.Lock()):
        hit = _cache.get(key)
        if hit and time.time() - hit[0] < ttl:
            return hit[1]
        try:
            value = fn()
        except Exception as e:
            stale = hit[1] if hit else None
            if stale is None:
                stale = _read_disk(key)
            if not isinstance(stale, dict):
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


_bg_pool = ThreadPoolExecutor(max_workers=8, thread_name_prefix="bg")
places_pool = ThreadPoolExecutor(max_workers=6, thread_name_prefix="places")  # slow tiles never starve the layers
_inflight: Dict[str, Future] = {}
_inflight_lock = threading.Lock()


def in_background(key: str, fn: Callable[[], Any], pool: Optional[ThreadPoolExecutor] = None) -> Future:
    """Run fn in a worker thread, once per key at a time. A caller that stops waiting (time budget) leaves it
    running: the result lands in the cache and the next request gets it at once."""
    with _inflight_lock:
        fut = _inflight.get(key)
        if fut is None:
            fut = (pool or _bg_pool).submit(fn)
            _inflight[key] = fut
            fut.add_done_callback(lambda _f: _inflight.pop(key, None))
    return fut


def _get_json(url: str, params: dict, label: str, timeout: Optional[float] = None) -> Any:
    for attempt in range(3):
        try:
            t0 = time.time()
            r = _client.get(url, params=params, timeout=timeout if timeout is not None else httpx.USE_CLIENT_DEFAULT)
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

# "Dalle routià¨re" (Gare du Nord, IDFM feed): an "è" whose two UTF-8 bytes were read as Latin-1 upstream, then case-mangled.
# Only these letter pairs are repaired, never a real "à" followed by a space.
_MOJIBAKE = re.compile("[\u00c3\u00e0]([\u00a2\u00a7\u00a8\u00a9\u00aa\u00ab\u00ae\u00af\u00b4\u00b6\u00b9\u00bb\u00bc])")


def fix_mojibake(s: Any) -> Any:
    if not isinstance(s, str) or ("\u00c3" not in s and "\u00e0" not in s):
        return s
    return _MOJIBAKE.sub(lambda m: bytes([0xC3, ord(m.group(1))]).decode("utf-8"), s)


def fetch_lifts_raw() -> List[dict]:
    rows = _export(IDF_REGION, "etat-des-ascenseurs")
    return [{k: fix_mojibake(v) for k, v in r.items()} for r in rows]


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
ACCESLIBRE_TIMEOUT_S = 45  # per page; the tabular API is slow but should not hold a worker for minutes
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
        first = _get_json(ACCESLIBRE, {**base, "page": 1}, label, timeout=ACCESLIBRE_TIMEOUT_S)
        rows = first["data"]
        pages = min(-(-first["meta"]["total"] // 200), 15)  # at most 3000 places per tile
        more = _tile_pool.map(lambda p: _get_json(ACCESLIBRE, {**base, "page": p}, label,
                                                  timeout=ACCESLIBRE_TIMEOUT_S)["data"], range(2, pages + 1))
        for chunk in more:
            rows += chunk
        return {"fetched_at": now_iso(), "rows": rows}

    return cached(f"places_{tx}_{ty}", 86400, load)


# --- Geocoding (IGN Géoplateforme, no key) ---------------------------------

def geocode(q: str) -> Optional[dict]:
    """Best match for free text, in Île-de-France (same ranking as the search box)."""
    hits = suggest(q, limit=1)
    if hits:
        return {"label": hits[0]["label"], "lon": hits[0]["lon"], "lat": hits[0]["lat"]}
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
    for fn in (stations, train_stations, works, bus_stops, low_vision):
        try:
            fn()
        except Exception:
            log.exception("warm-up failed for %s", fn.__name__)
    if PLACES_WARM_BBOX:
        try:
            tiles = place_tiles(*[float(v) for v in PLACES_WARM_BBOX.split(",")])
            # Not on _tile_pool: places_tile queues its pages there, and waiting on them from inside the same
            # pool deadlocks once every worker holds a tile.
            for f in [in_background(f"places_{tx}_{ty}", lambda tx=tx, ty=ty: places_tile(tx, ty), places_pool)
                      for tx, ty in tiles]:
                f.result()
            log.info("places warm-up: %d tiles", len(tiles))
        except Exception:
            log.exception("warm-up failed for places (%s)", PLACES_WARM_BBOX)


# City of Paris roadworks types (chantier_synthese) are shown as published, in a few cases shortened.
_WORKS_SHORT = {
    "Travaux sur réseau d’éclairage public ou signalisation lumineuse tricolore": "Travaux sur l'éclairage public ou les feux",
    "Aménagements de voirie pour la sécurité (ralentisseurs, passages surélevés, …)": "Aménagement de voirie pour la sécurité",
    "Espaces verts – Emprise pour cantonnement ou stockage": "Zone de stockage de chantier",
}


def works_label(summary: Optional[str]) -> str:
    """Roadworks type as the app shows it: the City's own words, without its internal "(VdP*)" mark."""
    s = (summary or "").strip()
    return _WORKS_SHORT.get(s) or re.sub(r"\s*\(VdP\*\)$", "", s) or "Travaux"


# IDF bounding box, used to drop homonyms elsewhere in France.
IDF_BBOX = (1.40, 48.10, 3.60, 49.25)


def _in_idf(lon: float, lat: float) -> bool:
    return IDF_BBOX[0] <= lon <= IDF_BBOX[2] and IDF_BBOX[1] <= lat <= IDF_BBOX[3]


# Photon (OpenStreetMap, Komoot): addresses AND places (shops, restaurants, hospitals) in one call,
# ranked around the user like Google Maps. Public instance, fair use: self-host it for production.
PHOTON = os.environ.get("PHOTON_URL", "https://photon.komoot.io/api/")
PARIS_CENTER = (2.3522, 48.8566)  # not PARIS: that name is the opendata.paris.fr URL above
# OSM tags -> short category shown under the name (app.js GENERIC_SUB lists the generic ones).
_OSM_LABEL = {
    "restaurant": "Restaurant", "cafe": "Café", "bar": "Bar", "fast_food": "Restauration rapide", "pub": "Pub",
    "hospital": "Hôpital", "clinic": "Clinique", "doctors": "Médecin", "pharmacy": "Pharmacie", "dentist": "Dentiste",
    "supermarket": "Supermarché", "convenience": "Épicerie", "bakery": "Boulangerie", "museum": "Musée",
    "school": "École", "university": "Université", "library": "Bibliothèque", "theatre": "Théâtre", "cinema": "Cinéma",
    "townhall": "Mairie", "post_office": "Bureau de poste", "park": "Parc", "attraction": "Attraction",
    "hotel": "Hôtel", "place_of_worship": "Lieu de culte", "station": "Station", "stop": "Station",
    "tram_stop": "Arrêt de tram", "bus_stop": "Arrêt de bus", "house": "Adresse", "street": "Rue",
    "suburb": "Quartier", "city": "Ville", "town": "Ville", "village": "Village", "tower": "Monument",
}
# Tag key when the value is not listed above: the subtitle always says what the result is.
_OSM_KEY_LABEL = {
    "tourism": "Site touristique", "historic": "Monument", "man_made": "Monument", "amenity": "Lieu", "shop": "Commerce",
    "craft": "Commerce", "office": "Bureau", "building": "Bâtiment", "leisure": "Loisirs", "healthcare": "Santé",
    "railway": "Station", "public_transport": "Station", "highway": "Rue", "aeroway": "Aéroport",
    "place": "Secteur", "boundary": "Secteur", "landuse": "Secteur", "natural": "Nature", "waterway": "Cours d'eau",
}
# Noise for a trip destination: bike docks, parkings, bus stops duplicate better results.
_OSM_SKIP = {"bicycle_rental", "parking", "parking_entrance", "charging_station", "vending_machine",
             "waste_basket", "bench", "toilets", "atm", "parking_space", "motorcycle_parking", "bus_stop"}


def _area(pr: dict) -> str:
    """"7e" for a Paris arrondissement (75007, 75116), else "92130 Vanves" or the city."""
    pc, city = pr.get("postcode") or "", pr.get("city") or ""
    m = re.fullmatch(r"75(?:0(\d\d)|1(16))", pc)
    if m:
        n = int(m.group(1) or m.group(2))
        if 1 <= n <= 20:
            return "1er" if n == 1 else f"{n}e"
    return " ".join(x for x in (pc, city) if x)


def _photon_item(f: dict) -> Optional[dict]:
    pr = f.get("properties", {})
    lon, lat = f["geometry"]["coordinates"]
    if not _in_idf(lon, lat) or pr.get("osm_value") in _OSM_SKIP:
        return None
    street = " ".join(x for x in (pr.get("housenumber"), pr.get("street")) if x)
    is_address = pr.get("osm_value") in ("house", "street") or (not pr.get("name") and street)
    if is_address:
        label = street or pr.get("name") or ""
        kind = "Rue" if pr.get("osm_value") == "street" and not pr.get("housenumber") else "Adresse"
        return {"kind": "address", "label": label, "sub": " · ".join(x for x in (kind, _area(pr)) if x),
                "lon": lon, "lat": lat}
    cat = (_OSM_LABEL.get(pr.get("osm_value"))
           or {"city": "Ville", "district": "Quartier", "locality": "Secteur"}.get(pr.get("type"))
           or _OSM_KEY_LABEL.get(pr.get("osm_key"), "Lieu"))
    where = ", ".join(x for x in (street, _area(pr) or pr.get("city")) if x)
    return {"kind": "place", "label": pr.get("name") or street, "sub": " · ".join(x for x in (cat, where) if x),
            "lon": lon, "lat": lat}


def norm_text(s: str) -> str:
    """Lowercase, accents and punctuation dropped: "Musée d'Orsay" -> "musee d orsay"."""
    s = unicodedata.normalize("NFD", s or "")
    s = "".join(c for c in s if not unicodedata.combining(c)).lower()
    return " ".join(re.sub(r"[^a-z0-9]+", " ", s).split())


def rank_exact_first(q: str, items: List[dict]) -> List[dict]:
    """A result named exactly like the query goes first (stable: Photon's order otherwise),
    so "Tour Eiffel" gives the tower before "Champ de Mars - Tour Eiffel"."""
    nq = norm_text(q)
    return sorted(items, key=lambda it: norm_text(it.get("label", "")) != nq)


_suggest_cache: Dict[tuple, Tuple[float, List[dict]]] = {}
SUGGEST_TTL_S = 24 * 3600


def _suggest_photon(q: str, near: Tuple[float, float], limit: int) -> List[dict]:
    # Same text typed near the same place: answer from memory (typing sends many requests).
    key = (q.strip().lower(), round(near[0], 2), round(near[1], 2), limit)
    hit = _suggest_cache.get(key)
    if hit and time.time() - hit[0] < SUGGEST_TTL_S:
        return hit[1]
    params = {"q": q, "limit": limit * 2, "lang": "fr", "lon": near[0], "lat": near[1],
              "bbox": ",".join(str(v) for v in IDF_BBOX)}
    r = _client.get(PHOTON, timeout=6, params=params)
    if r.status_code in (429, 503):  # public instance throttling: one more try
        time.sleep(0.4)
        r = _client.get(PHOTON, timeout=6, params=params)
    r.raise_for_status()
    out, seen = [], set()
    for f in r.json().get("features", []):
        it = _photon_item(f)
        if not it or not it["label"]:
            continue
        dedupe = (it["label"].lower(), round(it["lon"], 3), round(it["lat"], 3))
        if dedupe not in seen:
            seen.add(dedupe)
            out.append(it)
    out = rank_exact_first(q, out)[:limit]
    if len(_suggest_cache) > 5000:
        _suggest_cache.clear()
    _suggest_cache[key] = (time.time(), out)
    return out


def suggest(q: str, limit: int = 6, near: Optional[Tuple[float, float]] = None) -> List[dict]:
    """Addresses and places in Île-de-France for the search box, closest to `near` first."""
    try:
        res = _suggest_photon(q, near or PARIS_CENTER, limit)
        if res:
            return res
    except (httpx.HTTPError, ValueError, KeyError):
        log.warning("Photon unavailable for %r, falling back to the IGN geocoder", q, exc_info=False)
    return _suggest_ign(q, limit)


def _suggest_ign(q: str, limit: int = 6) -> List[dict]:
    """Places (POI) + addresses in Île-de-France from the IGN geocoder (fallback)."""
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


# --- Visually impaired travellers (profile "malvoyant") --------------------
# Only what the open data really says: audio/visual information per stop and per line (IDFM),
# SNCF assistance and equipment in train stations, audible pedestrian signals in Paris.

SOURCES.update({
    "stop_signals": {
        "name": "IDFM – Référentiel des arrêts (information sonore et visuelle)",
        "url": "https://data.iledefrance-mobilites.fr/explore/dataset/arrets/",
        "license": "Licence Ouverte v2.0 (Etalab)",
    },
    "line_signals": {
        "name": "IDFM – Référentiel des lignes (annonces à bord)",
        "url": "https://data.iledefrance-mobilites.fr/explore/dataset/referentiel-des-lignes/",
        "license": "Licence Ouverte v2.0 (Etalab)",
    },
    "sncf_assistance": {
        "name": "SNCF – Service d'assistance aux voyageurs handicapés en gare",
        "url": "https://data.iledefrance.fr/explore/dataset/service-d-assistance-voyageur-handicape-en-gare-sncf/",
        "license": "ODbL",
    },
    "sncf_equipment": {
        "name": "SNCF – Équipements d'accessibilité en gare",
        "url": "https://data.iledefrance.fr/explore/dataset/equipements-accessibilite-en-gare/",
        "license": "ODbL",
    },
    "crossing_lights": {
        "name": "Ville de Paris – Signalisation tricolore (feux piétons)",
        "url": "https://opendata.paris.fr/explore/dataset/signalisation-tricolore/",
        "license": "ODbL",
    },
    "sound_modules": {
        "name": "Ville de Paris – Modules sonores des passages piétons",
        "url": "https://opendata.paris.fr/explore/dataset/modules-sonores-passages-pietons/",
        "license": "ODbL",
    },
})

WEEKDAYS_FR = ("lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche")


def stop_signals() -> dict:
    """Every stop (bus included) with its audio (arraudiblesignals) and visual (arrvisualsigns) information."""
    def load():
        rows = _export(IDFM, "arrets", select="arrid,arrname,arrtype,arraudiblesignals,arrvisualsigns,arrgeopoint")
        return {"fetched_at": now_iso(), "rows": rows}

    return cached("stop_signals", 86400, load)


def line_signals() -> dict:
    """Active lines with their on-board audio / visual next-stop information."""
    def load():
        rows = _export(IDFM, "referentiel-des-lignes",
                       select="id_line,shortname_line,transportmode,audiblesigns_available,visualsigns_available")
        return {"fetched_at": now_iso(), "rows": rows}

    return cached("line_signals", 86400, load)


def sncf_assistance() -> dict:
    """SNCF stations of Île-de-France where staff assist disabled travellers, with their hours per weekday."""
    def load():
        rows = _export(IDF_REGION, "service-d-assistance-voyageur-handicape-en-gare-sncf",
                       select="nom_gare,code_uic,typepriseencharge,typetarification,premierauderniertrain,"
                              "position_geographique," + ",".join(f"horaires_jour_nominal_{d}" for d in WEEKDAYS_FR))
        return {"fetched_at": now_iso(), "rows": rows}

    return cached("sncf_assistance", 86400, load)


def sncf_equipment() -> dict:
    """Accessibility equipment listed by SNCF per station (UIC code). A list of what exists, not of what is missing."""
    def load():
        rows = _export(IDF_REGION, "equipements-accessibilite-en-gare", select="uic,nom_de_la_gare,accessibilite")
        return {"fetched_at": now_iso(), "rows": rows}

    return cached("sncf_equipment", 86400, load)


def crossing_lights() -> dict:
    """Pedestrian signal heads of Paris traffic lights (one installation = one cod_ouvrag, several heads)."""
    def load():
        rows = _export(PARIS, "signalisation-tricolore",
                       where='lib_lumi_1 = "Caisson Piéton" or lib_lumi_1 = "Caisson Piéton R25"',
                       select="cod_ouvrag,geo_point_2d")
        return {"fetched_at": now_iso(), "rows": rows}

    return cached("crossing_lights", 86400, load)


def sound_modules() -> dict:
    """Audible pedestrian signals (répétiteurs sonores), at most one per traffic light installation."""
    def load():
        rows = _export(PARIS, "modules-sonores-passages-pietons", select="code_ouvrage,date_inst_accessoire")
        return {"fetched_at": now_iso(), "rows": rows}

    return cached("sound_modules", 86400, load)


def low_vision(budget_s: Optional[float] = None) -> Dict[str, Optional[dict]]:
    """Every layer of the visually impaired checks, loaded in parallel. A layer that cannot be loaded (or, with
    budget_s, is not ready in time: it keeps loading in the background) is None: checked as unknown."""
    fns = (stop_signals, line_signals, sncf_assistance, sncf_equipment, crossing_lights, sound_modules)
    futures = {fn.__name__: in_background(f"lv_{fn.__name__}", fn) for fn in fns}
    deadline = None if budget_s is None else time.monotonic() + budget_s
    out: Dict[str, Optional[dict]] = {}
    for name, fut in futures.items():
        try:
            out[name] = fut.result(timeout=None if deadline is None else max(0.0, deadline - time.monotonic()))
        except FutureTimeout:
            log.warning("%s still loading, visually impaired checks degrade to unknown for now", name)
            out[name] = None
        except Exception:
            log.exception("%s unavailable, visually impaired checks degrade to unknown", name)
            out[name] = None
    return out
