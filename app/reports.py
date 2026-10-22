"""Community reports (chantier B): light accounts, obstacle reports, confirmations.

Routes used by the map (static/app.js, static/profiles.js, static/report.js):
  POST /api/users                -> {"id": 12}
  POST /api/reports              -> {"id": 34}
  POST /api/reports/{id}/confirm -> {"confirmations": 2}
  GET  /api/reports?bbox=...     -> GeoJSON FeatureCollection
  POST /api/reports/analyze      -> the report card Claude proposes from a photo (the user validates it)

The description is stored in user_reports.message: the journey engine (main._reports) reads it there.
Every input is checked here and refused with a 400 in plain French; without a database the routes answer 503.
"""
from __future__ import annotations

import base64
import binascii
import logging
import os
import time
from collections import defaultdict, deque
from datetime import datetime, timezone
from typing import Any, Callable, Optional

from fastapi import APIRouter, Body, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from . import db, profiles, verify

log = logging.getLogger("reports")
router = APIRouter()

CATEGORIES = ("escalier", "marche", "travaux", "trottoir_encombre", "trottoir_etroit", "bordure_haute",
              "pente", "ascenseur_panne", "escalator_panne", "rampe", "autre")
GRAVITES = ("bloquant", "genant", "info")
TARGET_TYPES = ("photo", "lift", "station", "place", "works", "manual")
LAT_RANGE, LON_RANGE = (48.0, 49.5), (1.4, 3.6)  # Île-de-France
MAX_THUMB_BYTES = 300 * 1024
MAX_FEATURES = 500


# --- Input models (pydantic) ---------------------------------------------------

def _user_id(v: Any) -> Optional[int]:
    """The front sends the id kept in localStorage as a string ("12"); empty means anonymous."""
    if v is None or v == "":
        return None
    try:
        n = int(str(v).strip())
    except ValueError:
        raise ValueError("user_id doit être un nombre")
    if n <= 0:
        raise ValueError("user_id doit être un nombre positif")
    return n


class NewUser(BaseModel):
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)
    display_name: str = "Anonyme"
    profile: Optional[str] = None

    @field_validator("display_name", mode="before")
    @classmethod
    def _name(cls, v):
        return ((str(v).strip() if v is not None else "") or "Anonyme")[:40]

    @field_validator("profile")
    @classmethod
    def _profile(cls, v):
        if v is not None and v not in profiles.PROFILES:
            raise ValueError(f"profile doit être l'un de : {', '.join(profiles.PROFILES)}")
        return v


class NewReport(BaseModel):
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)
    categorie: str
    gravite: str
    temporaire: bool = False
    confiance: Optional[float] = None
    description: str = Field("", max_length=500)
    user_id: Optional[int] = None
    lat: float
    lon: float
    target_type: Optional[str] = None
    target_id: Optional[str] = Field(None, max_length=200)
    photo_thumb: Optional[str] = None

    @field_validator("categorie")
    @classmethod
    def _categorie(cls, v):
        if v not in CATEGORIES:
            raise ValueError(f"categorie doit être l'une de : {', '.join(CATEGORIES)}")
        return v

    @field_validator("gravite")
    @classmethod
    def _gravite(cls, v):
        if v not in GRAVITES:
            raise ValueError(f"gravite doit être l'une de : {', '.join(GRAVITES)}")
        return v

    @field_validator("confiance")
    @classmethod
    def _confiance(cls, v):
        if v is not None and not 0 <= v <= 1:
            raise ValueError("confiance doit être entre 0 et 1")
        return v

    @field_validator("lat")
    @classmethod
    def _lat(cls, v):
        if not LAT_RANGE[0] <= v <= LAT_RANGE[1]:
            raise ValueError(f"lat doit être entre {LAT_RANGE[0]} et {LAT_RANGE[1]} (Île-de-France)")
        return v

    @field_validator("lon")
    @classmethod
    def _lon(cls, v):
        if not LON_RANGE[0] <= v <= LON_RANGE[1]:
            raise ValueError(f"lon doit être entre {LON_RANGE[0]} et {LON_RANGE[1]} (Île-de-France)")
        return v

    @field_validator("description", mode="before")
    @classmethod
    def _description(cls, v):
        return "" if v is None else v

    @field_validator("user_id", mode="before")
    @classmethod
    def _uid(cls, v):
        return _user_id(v)

    @field_validator("target_type")
    @classmethod
    def _target_type(cls, v):
        if v is not None and v not in TARGET_TYPES:
            raise ValueError(f"target_type doit être l'un de : {', '.join(TARGET_TYPES)}")
        return v

    @field_validator("target_id", mode="before")
    @classmethod
    def _target_id(cls, v):
        return None if v in (None, "") else str(v)

    @field_validator("photo_thumb", mode="before")
    @classmethod
    def _thumb(cls, v):
        if v in (None, ""):
            return None
        if not isinstance(v, str) or not v.startswith(("data:image/jpeg;base64,", "data:image/png;base64,",
                                                       "data:image/webp;base64,")):
            raise ValueError("photo_thumb doit être une image data:image/jpeg;base64,…")
        if len(v) > MAX_THUMB_BYTES:
            raise ValueError("photo_thumb trop lourde (300 Ko maximum)")
        return v


class Confirm(BaseModel):
    model_config = ConfigDict(extra="ignore")
    user_id: Optional[int] = None

    @field_validator("user_id", mode="before")
    @classmethod
    def _uid(cls, v):
        return _user_id(v)


def parse(model: type, payload: Any):
    """Validate a JSON body and answer 400 (not FastAPI's 422) with a readable message."""
    if not isinstance(payload, dict):
        raise HTTPException(400, "le corps de la requête doit être un objet JSON")
    try:
        return model.model_validate(payload)
    except ValidationError as e:
        msgs = []
        for err in e.errors():
            field = ".".join(str(p) for p in err.get("loc", ())) or "requête"
            if err.get("type") == "value_error":
                msgs.append(str(err.get("msg", "")).removeprefix("Value error, "))
            elif err.get("type") == "missing":
                msgs.append(f"{field} manquant")
            elif err.get("type") == "string_too_long":
                msgs.append(f"{field} trop long ({err.get('ctx', {}).get('max_length')} caractères maximum)")
            else:
                msgs.append(f"{field} invalide")
        raise HTTPException(400, " ; ".join(msgs))


# --- Database helpers -------------------------------------------------------------

def _run(fn: Callable):
    """Run fn(cursor) on the shared connection. Retries once if Aiven closed an idle connection."""
    if not db.enabled():
        raise HTTPException(503, "base de données non configurée (DATABASE_URL) : signalements indisponibles")
    import psycopg
    for attempt in (1, 2):
        try:
            with db.conn().cursor() as cur:
                return fn(cur)
        except psycopg.OperationalError:
            if attempt == 2:
                log.exception("database unreachable")
                raise HTTPException(503, "base de données injoignable, réessayez dans un instant")
            try:
                db.conn().close()
            except Exception:
                pass


def _existing_user(cur, user_id: Optional[int]) -> Optional[int]:
    """A stale id from another database must not make the report fail (foreign key): keep it anonymous."""
    if user_id is None:
        return None
    cur.execute("SELECT 1 FROM user_profile WHERE id = %s", (user_id,))
    return user_id if cur.fetchone() else None


def confidence(row: dict, now: Optional[datetime] = None) -> int:
    """Level 1-5 shown by the app. Same rule as the journey engine (verify._report_confidence):
    4 if confirmed by 2+ people in the last 24 h, else 2; a temporary report loses 1 level per 48 h (min 1)."""
    return verify._report_confidence(row, now or datetime.now(timezone.utc))


# --- Routes -------------------------------------------------------------------------

@router.post("/api/users")
def create_user(payload: Any = Body(None)):
    u = parse(NewUser, payload or {})

    def go(cur):
        cur.execute("""INSERT INTO user_profile (display_name, profile, is_demo)
                       VALUES (%s, %s, false) RETURNING id""", (u.display_name, u.profile))
        return cur.fetchone()[0]

    return {"id": _run(go)}


@router.post("/api/reports")
def create_report(payload: Any = Body(None)):
    r = parse(NewReport, payload)

    def go(cur):
        cur.execute(
            """INSERT INTO user_reports (user_id, target_type, target_id, message, lon, lat, is_demo,
                                         categorie, temporaire, gravite, confiance, confirmations, photo_thumb)
               VALUES (%s, %s, %s, %s, %s, %s, false, %s, %s, %s, %s, 1, %s) RETURNING id""",
            (_existing_user(cur, r.user_id), r.target_type, r.target_id, r.description, r.lon, r.lat,
             r.categorie, r.temporaire, r.gravite, r.confiance, r.photo_thumb))
        return cur.fetchone()[0]

    rid = _run(go)
    log.info("report %s: %s / %s at %.5f,%.5f (%s)", rid, r.categorie, r.gravite, r.lat, r.lon, r.target_type or "-")
    return {"id": rid}


@router.post("/api/reports/{report_id}/confirm")
def confirm_report(report_id: int, payload: Any = Body(None)):
    parse(Confirm, payload or {})  # user_id accepted for later use (one vote per person)

    def go(cur):
        cur.execute("""UPDATE user_reports SET confirmations = COALESCE(confirmations, 1) + 1
                       WHERE id = %s RETURNING confirmations""", (report_id,))
        row = cur.fetchone()
        return row[0] if row else None

    n = _run(go)
    if n is None:
        raise HTTPException(404, "signalement introuvable")
    return {"confirmations": n}


@router.get("/api/reports")
def list_reports(bbox: str = Query(..., description="minLon,minLat,maxLon,maxLat")):
    try:
        x1, y1, x2, y2 = [float(v) for v in bbox.split(",")]
    except ValueError:
        raise HTTPException(400, "bbox doit être minLon,minLat,maxLon,maxLat")
    if x1 > x2 or y1 > y2:
        raise HTTPException(400, "bbox doit être minLon,minLat,maxLon,maxLat (min avant max)")

    def go(cur):
        cur.execute(
            """SELECT id, lon, lat, categorie, gravite, temporaire, message, created_at, is_demo,
                      COALESCE(confirmations, 1) AS confirmations, photo_thumb
               FROM user_reports
               WHERE lon BETWEEN %s AND %s AND lat BETWEEN %s AND %s
               ORDER BY created_at DESC LIMIT %s""", (x1, x2, y1, y2, MAX_FEATURES))
        cols = [c.name for c in cur.description]
        return [dict(zip(cols, row)) for row in cur.fetchall()]

    now = datetime.now(timezone.utc)
    feats = []
    for r in _run(go):
        created = r["created_at"]
        feats.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [r["lon"], r["lat"]]},
                      "properties": {
                          "id": r["id"], "categorie": r["categorie"] or "autre", "gravite": r["gravite"] or "genant",
                          "temporaire": bool(r["temporaire"]), "description": r["message"] or "",
                          "created_at": created.isoformat() if created else None, "is_demo": bool(r["is_demo"]),
                          "confirmations": r["confirmations"], "confidence": confidence(r, now),
                          "photo_thumb": r["photo_thumb"],
                      }})
    return {"type": "FeatureCollection", "features": feats,
            "meta": {"source": "Signalements PMR Maps (communauté)", "count": len(feats)}}


# --- B2: photo analysis by Claude --------------------------------------------------
# The user always validates (or changes) the card: Claude only pre-fills it. On any error or refusal the
# route still answers 200 with an empty card, so the screen falls back to manual input.

ANALYZE_MODEL = os.getenv("REPORTS_MODEL", "claude-sonnet-5-5")  # set REPORTS_MODEL=claude-haiku-5-5 if > 3 s
MAX_IMAGE_BYTES = 4 * 1024 * 1024        # the screen sends a 1024 px JPEG (~150 Ko); this is a safety cap
ANALYZE_PER_10_MIN = int(os.getenv("REPORTS_ANALYZE_LIMIT", "30"))  # per client, each call costs a few cents
_recent_calls: dict = defaultdict(deque)

PROMPT = """Tu aides des personnes en fauteuil roulant à signaler les obstacles dans la rue et les gares en \
Île-de-France. Regarde la photo et remplis toujours la fiche en appelant l'outil `fiche`, sans texte autour.

Catégories :
- escalier : plusieurs marches ; marche : une seule marche ou un ressaut ; bordure_haute : trottoir sans bateau
- travaux : chantier, palissade, tranchée ; trottoir_encombre : objet qui bloque (trottinettes, poubelles, voiture, terrasse)
- trottoir_etroit : passage de moins de 90 cm environ ; pente : pente forte ou dévers
- ascenseur_panne / escalator_panne : appareil à l'arrêt, barrière ou affiche « hors service »
- rampe : rampe d'accès (info utile, pas un obstacle) ; autre : rien de clair ou pas un obstacle

Gravité pour un fauteuil roulant : bloquant (impossible de passer seul), genant (passage difficile ou détour), \
info (pas d'obstacle). temporaire = true pour travaux, objets, pannes ; false pour escaliers, marches, bordures, pentes.

Description : une phrase en français, 120 caractères maximum, concrète (« Trois marches sans rampe devant l'entrée »). \
Ne décris jamais les personnes, visages ou plaques d'immatriculation. Si la photo ne montre pas d'obstacle ou est floue, \
mets categorie=autre, gravite=info et une confiance basse. confiance = ta certitude entre 0 et 1."""

FICHE_TOOL = {
    "name": "fiche",
    "description": "Fiche de signalement d'obstacle proposée à l'utilisateur, qui la valide ou la corrige.",
    "strict": True,
    "input_schema": {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "categorie": {"type": "string", "enum": list(CATEGORIES)},
            "temporaire": {"type": "boolean"},
            "gravite": {"type": "string", "enum": list(GRAVITES)},
            "description": {"type": "string", "description": "Une phrase en français, 120 caractères maximum."},
            "confiance": {"type": "number", "description": "Certitude entre 0 et 1."},
        },
        "required": ["categorie", "temporaire", "gravite", "description", "confiance"],
    },
}


class Fiche(BaseModel):
    categorie: str = "autre"
    temporaire: bool = False
    gravite: str = "info"
    description: str = ""
    confiance: float = 0.0

    @field_validator("categorie")
    @classmethod
    def _categorie(cls, v):
        return v if v in CATEGORIES else "autre"

    @field_validator("gravite")
    @classmethod
    def _gravite(cls, v):
        return v if v in GRAVITES else "info"

    @field_validator("description")
    @classmethod
    def _description(cls, v):
        v = " ".join(str(v).split())
        return v if len(v) <= 160 else v[:157].rstrip() + "…"

    @field_validator("confiance")
    @classmethod
    def _confiance(cls, v):
        return min(max(float(v), 0.0), 1.0)


EMPTY = Fiche()


def _media_type(raw: bytes) -> Optional[str]:
    if raw[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if raw[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        return "image/webp"
    return None


def analyser(image_base64: str, media_type: str = "image/jpeg") -> Fiche:
    """Ask Claude to fill the card. Raises on API errors; the route turns that into the empty card."""
    import anthropic  # imported here: the rest of the app works without the package or the key

    client = anthropic.Anthropic(timeout=20.0, max_retries=1)  # reads ANTHROPIC_API_KEY
    msg = client.messages.create(
        model=ANALYZE_MODEL, max_tokens=1024, system=PROMPT,
        # Forcing a tool (tool_choice "tool") is refused with a 400 by the current models: auto + strict schema
        # + the prompt asking for the tool. Low effort keeps the answer fast (target: under 3 s).
        tools=[FICHE_TOOL], tool_choice={"type": "auto"}, output_config={"effort": "low"},
        messages=[{"role": "user", "content": [
            {"type": "image", "source": {"type": "base64", "media_type": media_type, "data": image_base64}},
            {"type": "text", "text": "Quel obstacle vois-tu sur cette photo ? Remplis la fiche."},
        ]}],
    )
    for block in msg.content:
        if getattr(block, "type", None) == "tool_use" and block.name == "fiche":
            return Fiche.model_validate(block.input)
    raise ValueError(f"no card in Claude's answer (stop_reason={msg.stop_reason})")


def _client_key(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-for", "")
    return fwd.split(",")[0].strip() or (request.client.host if request.client else "?")


def _rate_limited(key: str, now: float) -> bool:
    calls = _recent_calls[key]
    while calls and now - calls[0] > 600:
        calls.popleft()
    if len(calls) >= ANALYZE_PER_10_MIN:
        return True
    calls.append(now)
    return False


@router.post("/api/reports/analyze")
def analyze_photo(request: Request, payload: Any = Body(None)):
    if not isinstance(payload, dict) or not isinstance(payload.get("image_base64"), str):
        raise HTTPException(400, "image_base64 manquant (JPEG en base64, sans le préfixe data:)")
    b64 = payload["image_base64"].strip()
    if b64.startswith("data:"):
        b64 = b64.split(",", 1)[-1]  # tolerate the prefix anyway
    if len(b64) > MAX_IMAGE_BYTES * 4 // 3 + 4:
        raise HTTPException(400, "photo trop lourde (4 Mo maximum)")
    try:
        raw = base64.b64decode(b64, validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(400, "image_base64 n'est pas du base64 valide")
    media_type = _media_type(raw)
    if not media_type:
        raise HTTPException(400, "la photo doit être une image JPEG, PNG ou WebP")
    for k, (lo, hi) in (("lat", LAT_RANGE), ("lon", LON_RANGE)):
        v = payload.get(k)
        if v is not None and (not isinstance(v, (int, float)) or not lo <= v <= hi):
            raise HTTPException(400, f"{k} doit être entre {lo} et {hi} (Île-de-France)")
    if _rate_limited(_client_key(request), time.monotonic()):
        raise HTTPException(429, "trop de photos analysées d'affilée : réessayez dans quelques minutes")

    started = time.perf_counter()
    if not os.getenv("ANTHROPIC_API_KEY"):
        log.warning("analyze: ANTHROPIC_API_KEY missing, empty card returned")
        fiche, status = EMPTY, "indisponible"
    else:
        try:
            fiche, status = analyser(b64, media_type), "ok"
        except Exception as e:  # refusal, timeout, quota...: the user fills the card by hand
            log.warning("analyze failed (%s): %r", ANALYZE_MODEL, e)
            fiche, status = EMPTY, "erreur"
    ms = round((time.perf_counter() - started) * 1000)
    log.info("analyze %s in %d ms (%s, %d Ko): %s / %s / %.2f", status, ms, ANALYZE_MODEL, len(raw) // 1024,
             fiche.categorie, fiche.gravite, fiche.confiance)
    return {**fiche.model_dump(), "analyse": status, "latency_ms": ms}
