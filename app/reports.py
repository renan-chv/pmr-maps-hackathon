"""Community reports (chantier B): light accounts, obstacle reports, confirmations.

Routes used by the map (static/app.js, static/profiles.js):
  POST /api/users                -> {"id": 12}
  POST /api/reports              -> {"id": 34}
  POST /api/reports/{id}/confirm -> {"confirmations": 2}
  GET  /api/reports?bbox=...     -> GeoJSON FeatureCollection

The description is stored in user_reports.message: the journey engine (main._reports) reads it there.
Every input is checked here and refused with a 400 in plain French; without a database the routes answer 503.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Callable, Optional

from fastapi import APIRouter, Body, HTTPException, Query
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
