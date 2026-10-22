"""Community reports (chantier B): light accounts, obstacle reports, confirmations.

Routes used by the map (static/app.js, static/profiles.js, static/report.js):
  POST /api/users                -> {"id": 12}
  POST /api/reports              -> {"id": 34}
  POST /api/reports/{id}/confirm -> {"confirmations": 2}
  GET  /api/reports?bbox=...     -> GeoJSON FeatureCollection
  POST /api/reports/analyze      -> the report card Claude proposes from a photo (the user validates it)

The description is stored in user_reports.message: the journey engine (main._reports) reads it there.
Every input is checked here and refused with a 400 in plain English; without a database the routes answer 503.
"""
from __future__ import annotations

import base64
import binascii
import logging
import os
import time
from datetime import datetime, timezone
from typing import Any, Callable, Optional

from fastapi import APIRouter, Body, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from . import db, limits, profiles, verify

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
        raise ValueError("user_id must be a number")
    if n <= 0:
        raise ValueError("user_id must be a positive number")
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
            raise ValueError(f"profile must be one of: {', '.join(profiles.PROFILES)}")
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
            raise ValueError(f"categorie must be one of: {', '.join(CATEGORIES)}")
        return v

    @field_validator("gravite")
    @classmethod
    def _gravite(cls, v):
        if v not in GRAVITES:
            raise ValueError(f"gravite must be one of: {', '.join(GRAVITES)}")
        return v

    @field_validator("confiance")
    @classmethod
    def _confiance(cls, v):
        if v is not None and not 0 <= v <= 1:
            raise ValueError("confiance must be between 0 and 1")
        return v

    @field_validator("lat")
    @classmethod
    def _lat(cls, v):
        if not LAT_RANGE[0] <= v <= LAT_RANGE[1]:
            raise ValueError(f"lat must be between {LAT_RANGE[0]} and {LAT_RANGE[1]} (Île-de-France)")
        return v

    @field_validator("lon")
    @classmethod
    def _lon(cls, v):
        if not LON_RANGE[0] <= v <= LON_RANGE[1]:
            raise ValueError(f"lon must be between {LON_RANGE[0]} and {LON_RANGE[1]} (Île-de-France)")
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
            raise ValueError(f"target_type must be one of: {', '.join(TARGET_TYPES)}")
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
            raise ValueError("photo_thumb must be a data:image/jpeg;base64,… image")
        if len(v) > MAX_THUMB_BYTES:
            raise ValueError("photo_thumb too large (300 KB maximum)")
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
        raise HTTPException(400, "the request body must be a JSON object")
    try:
        return model.model_validate(payload)
    except ValidationError as e:
        msgs = []
        for err in e.errors():
            field = ".".join(str(p) for p in err.get("loc", ())) or "request"
            if err.get("type") == "value_error":
                msgs.append(str(err.get("msg", "")).removeprefix("Value error, "))
            elif err.get("type") == "missing":
                msgs.append(f"{field} missing")
            elif err.get("type") == "string_too_long":
                msgs.append(f"{field} too long ({err.get('ctx', {}).get('max_length')} characters maximum)")
            else:
                msgs.append(f"{field} invalid")
        raise HTTPException(400, "; ".join(msgs))


# --- Database helpers -------------------------------------------------------------

def _run(fn: Callable):
    """Run fn(cursor) on the shared connection. Retries once if Aiven closed an idle connection."""
    if not db.enabled():
        raise HTTPException(503, "database not configured (DATABASE_URL): reports unavailable")
    import psycopg
    for attempt in (1, 2):
        try:
            with db.conn().cursor() as cur:
                return fn(cur)
        except psycopg.OperationalError:
            if attempt == 2:
                log.exception("database unreachable")
                raise HTTPException(503, "database unreachable, try again in a moment")
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
def create_user(request: Request, payload: Any = Body(None)):
    limits.check("user", request, "too many profiles created from this connection: try again later")
    u = parse(NewUser, payload or {})

    def go(cur):
        cur.execute("""INSERT INTO user_profile (display_name, profile, is_demo)
                       VALUES (%s, %s, false) RETURNING id""", (u.display_name, u.profile))
        return cur.fetchone()[0]

    return {"id": _run(go)}


@router.post("/api/reports")
def create_report(request: Request, payload: Any = Body(None)):
    limits.check("report", request, "too many reports sent in a row: try again in an hour")
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
def confirm_report(report_id: int, request: Request, payload: Any = Body(None)):
    limits.check("confirm", request, "too many confirmations in a row: try again later")
    parse(Confirm, payload or {})  # user_id accepted for later use (one vote per person)

    def go(cur):
        cur.execute("""UPDATE user_reports SET confirmations = COALESCE(confirmations, 1) + 1
                       WHERE id = %s RETURNING confirmations""", (report_id,))
        row = cur.fetchone()
        return row[0] if row else None

    n = _run(go)
    if n is None:
        raise HTTPException(404, "report not found")
    return {"confirmations": n}


@router.get("/api/reports")
def list_reports(bbox: str = Query(..., description="minLon,minLat,maxLon,maxLat")):
    try:
        x1, y1, x2, y2 = [float(v) for v in bbox.split(",")]
    except ValueError:
        raise HTTPException(400, "bbox must be minLon,minLat,maxLon,maxLat")
    if x1 > x2 or y1 > y2:
        raise HTTPException(400, "bbox must be minLon,minLat,maxLon,maxLat (min before max)")

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
            "meta": {"source": "Roulib community reports", "count": len(feats)}}


# --- B2: photo analysis by Claude --------------------------------------------------
# The user always validates (or changes) the card: Claude only pre-fills it. On any error or refusal the
# route still answers 200 with an empty card, so the screen falls back to manual input.

ANALYZE_MODEL = os.getenv("REPORTS_MODEL", "claude-sonnet-5-5")  # set REPORTS_MODEL=claude-haiku-5-5 if > 3 s
MAX_IMAGE_BYTES = 4 * 1024 * 1024        # the screen sends a 1024 px JPEG (~150 Ko); this is a safety cap

PROMPT = """You help wheelchair users report obstacles in the streets and stations of the Paris region \
(Île-de-France). Look at the photo and always fill in the card by calling the `fiche` tool, with no text around it.

Categories (use these exact keys):
- escalier: several steps; marche: a single step or ledge; bordure_haute: curb with no curb cut
- travaux: roadworks, hoarding, trench; trottoir_encombre: something blocking the way (scooters, bins, car, cafe terrace)
- trottoir_etroit: passage narrower than about 90 cm; pente: steep slope or cross slope
- ascenseur_panne / escalator_panne: machine stopped, barrier or "out of order" sign
- rampe: access ramp (useful info, not an obstacle); autre: nothing clear or not an obstacle

Severity for a wheelchair (gravite): bloquant (impossible to get through alone), genant (difficult passage or detour), \
info (no obstacle). temporaire = true for roadworks, objects, breakdowns; false for stairs, steps, curbs, slopes.

Description: one sentence in English, 120 characters maximum, concrete ("Three steps with no ramp in front of the entrance"). \
Never describe people, faces or license plates. If the photo shows no obstacle or is blurry, \
set categorie=autre, gravite=info and a low confiance. confiance = your certainty between 0 and 1."""

FICHE_TOOL = {
    "name": "fiche",
    "description": "Obstacle report card suggested to the user, who confirms or corrects it.",
    "strict": True,
    "input_schema": {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "categorie": {"type": "string", "enum": list(CATEGORIES)},
            "temporaire": {"type": "boolean"},
            "gravite": {"type": "string", "enum": list(GRAVITES)},
            "description": {"type": "string", "description": "One sentence in English, 120 characters maximum."},
            "confiance": {"type": "number", "description": "Certainty between 0 and 1."},
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
            {"type": "text", "text": "What obstacle do you see in this photo? Fill in the card."},
        ]}],
    )
    for block in msg.content:
        if getattr(block, "type", None) == "tool_use" and block.name == "fiche":
            return Fiche.model_validate(block.input)
    raise ValueError(f"no card in Claude's answer (stop_reason={msg.stop_reason})")


@router.post("/api/reports/analyze")
def analyze_photo(request: Request, payload: Any = Body(None)):
    if not isinstance(payload, dict) or not isinstance(payload.get("image_base64"), str):
        raise HTTPException(400, "image_base64 missing (base64 JPEG, without the data: prefix)")
    b64 = payload["image_base64"].strip()
    if b64.startswith("data:"):
        b64 = b64.split(",", 1)[-1]  # tolerate the prefix anyway
    if len(b64) > MAX_IMAGE_BYTES * 4 // 3 + 4:
        raise HTTPException(400, "photo too large (4 MB maximum)")
    try:
        raw = base64.b64decode(b64, validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(400, "image_base64 is not valid base64")
    media_type = _media_type(raw)
    if not media_type:
        raise HTTPException(400, "the photo must be a JPEG, PNG or WebP image")
    for k, (lo, hi) in (("lat", LAT_RANGE), ("lon", LON_RANGE)):
        v = payload.get(k)
        if v is not None and (not isinstance(v, (int, float)) or not lo <= v <= hi):
            raise HTTPException(400, f"{k} must be between {lo} and {hi} (Île-de-France)")
    limits.check("analyze", request, "too many photos analyzed in a row: try again in a few minutes")

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
