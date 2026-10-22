"""Chantier E – Roulib assistant: Claude + our own routes as tools.

POST /api/agent  {"message": "...", "profile": "electrique", "replay": "demo"?, "config": "full"|"no_tools"}

The agent makes nothing up: each tool calls an app route (/api/journey, /api/lifts,
/api/places, /api/reports) in the same process, and returns the source and time of the data.
The system prompt makes it cite the source and freshness of every fact.

config="no_tools" = Claude alone (benchmark baseline). Every call is logged in agent_runs.
"""
from __future__ import annotations

import json
import logging
import os
import time
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Literal, Optional
from zoneinfo import ZoneInfo

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from . import db, profiles

log = logging.getLogger("agent")
router = APIRouter()

MODEL = os.getenv("AGENT_MODEL", "claude-opus-5-5")  # claude-haiku-5-5 if latency is too high
MAX_TURNS = 6
PARIS = ZoneInfo("Europe/Paris")
FIXTURES = Path(__file__).resolve().parent.parent / "static" / "fixtures"

_client = None   # anthropic.Anthropic, created on demand (reads ANTHROPIC_API_KEY)
_internal = None  # HTTP client to our own routes, in the same process


def anthropic_client():
    global _client
    if _client is None:
        if not os.getenv("ANTHROPIC_API_KEY"):
            raise HTTPException(503, "ANTHROPIC_API_KEY missing: assistant unavailable")
        import anthropic
        _client = anthropic.Anthropic()
    return _client


def api():
    """Calls our routes without going through the network (no startup, no second poller)."""
    global _internal
    if _internal is None:
        from fastapi.testclient import TestClient
        from .main import app  # late import: main imports this module
        _internal = TestClient(app, raise_server_exceptions=False)
    return _internal


# --- Small helpers ----------------------------------------------------------

def _norm(s: Optional[str]) -> str:
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower()
    return " ".join(s.replace("-", " ").replace("'", " ").split())


def _age_min(iso: Optional[str]) -> Optional[int]:
    """Age of a piece of data in minutes (so the agent can say "info from 2 hours ago")."""
    if not iso:
        return None
    try:
        t = datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
    except ValueError:
        return None
    if t.tzinfo is None:
        t = t.replace(tzinfo=PARIS)
    return max(0, round((datetime.now(timezone.utc) - t).total_seconds() / 60))


def _get(path: str, **params) -> dict:
    r = api().get(path, params={k: v for k, v in params.items() if v is not None})
    if r.status_code >= 400:
        try:
            detail = r.json().get("detail")
        except ValueError:
            detail = r.text[:200]
        raise ToolError(f"{path} answered {r.status_code}: {detail}")
    return r.json()


class ToolError(Exception):
    pass


# --- Tools ------------------------------------------------------------------

def check_journey(origin: str, destination: str, profile: str, replay: Optional[str] = None) -> dict:
    data = _get("/api/journey", **{"from": origin, "to": destination, "profile": profile, "replay": replay})
    its = []
    for it in data.get("itineraries", []):
        its.append({
            "id": it.get("id"), "verdict": it.get("verdict"), "confidence": it.get("confidence"),
            "duration_min": it.get("duration_min"), "plan_b_id": it.get("plan_b_id"),
            "steps": [{
                "type": s.get("type"), "line": s.get("line"), "from": s.get("from"), "to": s.get("to"),
                "verdict": s.get("verdict"),
                "checks": [{k: c.get(k) for k in ("kind", "status", "effect", "label", "message", "source",
                                                   "fetched_at", "confidence", "reliability") if c.get(k) is not None}
                           for c in s.get("checks", [])],
            } for s in it.get("steps", [])],
        })
    lifts_at = data.get("lifts_fetched_at")
    return {
        "from": (data.get("from") or {}).get("label"), "to": (data.get("to") or {}).get("label"),
        "profile": data.get("profile"), "itineraries": its,
        "baseline_navitia_seul": data.get("baseline"),
        "source": data.get("source"), "lifts_fetched_at": lifts_at, "lifts_age_min": _age_min(lifts_at),
        "mode": "recorded snapshot (demo)" if replay == "demo" else "live",
    }


def lift_status(station: str, replay: Optional[str] = None) -> dict:
    if replay == "demo":
        snap = json.loads((FIXTURES / "lifts_demo.json").read_text())
        rows, fetched_at, src = snap["rows"], snap.get("fetched_at"), "IDFM, recorded snapshot (demo)"
    else:
        feats = _get("/api/lifts")
        rows = [dict(f["properties"], liftstatus=f["properties"].get("status"), zdcname=f["properties"].get("station"),
                     liftsituation=f["properties"].get("situation"), liftreason=f["properties"].get("reason"),
                     liftdirection=f["properties"].get("direction"), liftstateupdate=f["properties"].get("source_update"))
                for f in feats.get("features", [])]
        fetched_at, src = (feats.get("meta") or {}).get("fetched_at"), "IDFM, elevator status"
    q = _norm(station)
    match = [r for r in rows if q and (q in _norm(r.get("zdcname")) or _norm(r.get("zdcname")) in q)]
    if not match:
        return {"station": station, "found": False, "source": src, "fetched_at": fetched_at,
                "note": "No IDFM elevator found for this name. Do not conclude that the station is accessible."}
    rel: Dict[str, Any] = {}
    if replay == "demo":
        try:
            rel = json.loads((FIXTURES / "reliability_demo.json").read_text())
        except FileNotFoundError:
            rel = {}
    else:
        for zdcid in {str(r.get("zdcid")) for r in match if r.get("zdcid")}:
            try:
                rel.update(_get(f"/api/stations/{zdcid}/reliability").get("lifts") or {})
            except ToolError:
                pass
    lifts = [{
        "station": r.get("zdcname"), "status": r.get("liftstatus"), "situation": r.get("liftsituation"),
        "direction": r.get("liftdirection"), "reason": r.get("liftreason"),
        "etat_publie_par_idfm": r.get("liftstateupdate"),
        "reliability": {k: v for k, v in (rel.get(r.get("liftid")) or {}).items() if k != "source"} or None,
    } for r in match[:25]]
    return {"station": station, "found": True, "count": len(match),
            "not_available": sum(l["status"] != "available" for l in lifts), "lifts": lifts,
            "source": src, "fetched_at": fetched_at, "age_min": _age_min(fetched_at),
            "note": "IDFM updates the status ~3 times a day: beyond a few hours old, say \"to be checked\"."}


def find_places(near: str, name: Optional[str] = None, kind: Optional[str] = None, radius_m: int = 300) -> dict:
    where = _get("/api/geocode", q=near)
    lon, lat = where["lon"], where["lat"]
    d = max(100, min(radius_m, 600)) / 111_000
    bbox = f"{lon - d * 1.5:.5f},{lat - d:.5f},{lon + d * 1.5:.5f},{lat + d:.5f}"
    data = _get("/api/places", bbox=bbox)
    rank = {"true": 0, "partial": 1, "unknown": 2, "false": 3}
    out = []
    for f in data.get("features", []):
        p = f["properties"]
        if name and _norm(name) not in _norm(p.get("name")):
            continue
        if kind and kind != p.get("category"):
            continue
        out.append({k: p.get(k) for k in ("name", "activity", "address", "wheelchair", "reasons", "toilets", "url")})
    out.sort(key=lambda p: rank.get(str(p["wheelchair"]), 2))
    meta = data.get("meta") or {}
    return {"near": where.get("label"), "count": len(out), "places": out[:8],
            "legend": "wheelchair: true = accessible, partial = with difficulty, false = no, unknown = incomplete listing",
            "source": "Acceslibre (data.gouv.fr)", "fetched_at": meta.get("fetched_at"), "stale": meta.get("stale")}


def save_report(lat: float, lon: float, categorie: str, gravite: str, temporaire: bool, description: str,
                user_id: Optional[int] = None) -> dict:
    body = {"lat": lat, "lon": lon, "categorie": categorie, "gravite": gravite, "temporaire": temporaire,
            "description": description, "user_id": user_id, "target_type": "manual", "target_id": None,
            "confiance": 0.5, "source": "agent"}
    r = api().post("/api/reports", json=body)
    if r.status_code == 404:
        raise ToolError("The report service is not online yet: report NOT saved.")
    if r.status_code >= 400:
        raise ToolError(f"/api/reports answered {r.status_code}: {r.text[:200]}")
    return {"saved": True, "report": r.json(), "note": "Confidence level 2 until someone confirms it."}


PROFILE_ENUM = list(profiles.PROFILES)
TOOLS = [
    {"name": "check_journey",
     "description": "Plans and checks a public transport journey in the Paris region (Île-de-France) for a mobility "
                    "profile: verdict per step (passe = clear / risque = at risk / bloque = blocked), checks "
                    "(elevators, sidewalk works, stairs, community reports) with source and time, Plan B, and what "
                    "Navitia alone suggests. Use it for any \"can I get from A to B\" question.",
     "input_schema": {"type": "object", "properties": {
         "origin": {"type": "string", "description": "Departure: address, place or station (e.g. \"Gare de Lyon, Paris\")"},
         "destination": {"type": "string", "description": "Arrival: address, place or station"},
         "profile": {"type": "string", "enum": PROFILE_ENUM}},
         "required": ["origin", "destination", "profile"]}},
    {"name": "lift_status",
     "description": "Current status of the elevators of a station (IDFM): working, out of order, unknown, "
                    "with the time it was published and the historical reliability (share of time working).",
     "input_schema": {"type": "object", "properties": {
         "station": {"type": "string", "description": "Station name, e.g. \"Châtelet - Les Halles\""}},
         "required": ["station"]}},
    {"name": "find_places",
     "description": "Venues listed in Acceslibre (restaurants, shops…) around an address, with the wheelchair "
                    "verdict (entrance, door, steps) and accessible toilets.",
     "input_schema": {"type": "object", "properties": {
         "near": {"type": "string", "description": "Address or place to search around"},
         "name": {"type": "string", "description": "Optional: name of the venue you are looking for"},
         "kind": {"type": "string", "enum": ["food", "shop"], "description": "Optional: food = restaurants and cafes"},
         "radius_m": {"type": "integer", "description": "Radius in meters (100 to 600, 300 by default)"}},
         "required": ["near"]}},
    {"name": "save_report",
     "description": "Saves an obstacle report described by the user (stairs, roadworks, elevator out of order…). "
                    "Only use it when the user explicitly reports an obstacle AND their position is known.",
     "input_schema": {"type": "object", "properties": {
         "lat": {"type": "number"}, "lon": {"type": "number"},
         "categorie": {"type": "string", "enum": ["escalier", "marche", "travaux", "trottoir_encombre",
                                                  "trottoir_etroit", "bordure_haute", "pente", "ascenseur_panne",
                                                  "escalator_panne", "rampe", "autre"],
                       "description": "escalier = stairs, marche = single step, travaux = roadworks, "
                                      "trottoir_encombre = blocked sidewalk, trottoir_etroit = narrow sidewalk, "
                                      "bordure_haute = high curb, pente = steep slope, ascenseur_panne = elevator "
                                      "out of order, escalator_panne = escalator out of order, rampe = ramp, autre = other"},
         "gravite": {"type": "string", "enum": ["bloquant", "genant", "info"],
                     "description": "bloquant = blocking, genant = difficult, info = for information"},
         "temporaire": {"type": "boolean"},
         "description": {"type": "string", "description": "One short sentence in English"}},
         "required": ["lat", "lon", "categorie", "gravite", "temporaire", "description"]}},
]
_IMPL = {"check_journey": check_journey, "lift_status": lift_status,
         "find_places": find_places, "save_report": save_report}


def system_prompt(profile: str, replay: Optional[str], tools: bool) -> str:
    now = datetime.now(PARIS).strftime("%A %d/%m/%Y %H:%M")
    base = (
        f"You are the Roulib assistant. It is {now} (Paris time). "
        f"User profile: {profiles.PROFILES.get(profile, profile)} (code \"{profile}\"), "
        "unless the question mentions another one. "
        "Always answer in English, as if speaking (the answer is read aloud): short sentences, no tables, "
        "no markdown, 6 sentences maximum.\n"
        "Structure: 1) the verdict first (\"You can make it\", \"It's risky\", \"Blocked at …\"), "
        "2) the risky step and why, 3) the Plan B if there is one, "
        "4) the sources with their time, for example \"elevators: IDFM, info from 9:30 am\".\n"
    )
    if not tools:
        return base + "You have no access to any live data."
    rules = (
        "Rules:\n"
        "- Never say a place or a journey is accessible unless a tool confirms it. "
        "If the information is missing, say \"I don't know\" and what should be checked.\n"
        "- Every fact cites its source and its time. If a piece of data is more than 3 hours old (field age_min or "
        "lifts_age_min > 180), say \"info from <time>, to be checked\".\n"
        "- The data is about right now. If the question is about later (tomorrow at 10 am…), say so: "
        "the status may change by then; rely on the historical reliability of the elevators, with the figure "
        "given by the tool (field reliability, e.g. \"working 88% of the time over 11 days\"), and suggest checking "
        "again before leaving.\n"
        "- Confidence levels: 5 official live data, 4 confirmed report, 3 official static data, 2 single "
        "report, 1 unknown (never presented as accessible).\n"
        "- Compare with what a regular app suggests (baseline_navitia_seul) when it changes the verdict.\n"
        "- One journey question = one call to check_journey; use lift_status to detail a station.\n"
        "- Place and station names stay as they are (in French).\n"
    )
    if replay == "demo":
        rules += ("- DEMO MODE: the data comes from a real snapshot recorded on 10/22/2026 around 11 am. "
                  "Say it once (\"snapshot from 11 am\"). The demo journey is set by the server.\n")
    return base + rules


# --- Route ------------------------------------------------------------------

class AgentIn(BaseModel):
    message: str = Field(..., min_length=2, max_length=2000)
    profile: str = profiles.DEFAULT_PROFILE
    user_id: Optional[int] = None
    replay: Optional[Literal["demo"]] = None
    config: Literal["full", "no_tools"] = "full"
    history: List[dict] = Field(default_factory=list, description="Previous turns [{role, content}] (text)")


def _verdict_from(trace: List[dict]) -> Optional[str]:
    """Structured verdict for the UI and the benchmark: the one of the best checked itinerary."""
    for t in reversed(trace):
        if t["tool"] == "check_journey" and t.get("ok"):
            its = t["result"].get("itineraries") or []
            order = {"passe": 0, "risque": 1, "bloque": 2}
            best = min((i.get("verdict") for i in its if i.get("verdict")), key=lambda v: order.get(v, 3), default=None)
            return best
    return None


def _sources_from(trace: List[dict]) -> List[dict]:
    seen, out = set(), []
    for t in trace:
        r = t.get("result") or {}
        cands = [(r.get("source"), r.get("fetched_at") or r.get("lifts_fetched_at"))]
        for it in r.get("itineraries") or []:
            for s in it.get("steps", []):
                cands += [(c.get("source"), c.get("fetched_at")) for c in s.get("checks", [])]
        for src, at in cands:
            if src and (src, at) not in seen:
                seen.add((src, at))
                out.append({"source": src, "fetched_at": at, "age_min": _age_min(at)})
    return out


def _log_run(body: AgentIn, trace, answer, verdict, latency_ms, usage) -> Optional[int]:
    if not db.enabled():
        return None
    try:
        with db.conn().cursor() as cur:
            cur.execute(
                """INSERT INTO agent_runs (config, question, tools_called, cited_rows, answer, verdict,
                                           confidence, latency_ms, cost_usd, mode)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s) RETURNING id""",
                (body.config, body.message,
                 json.dumps([{"tool": t["tool"], "input": t["input"], "ok": t["ok"]} for t in trace]),
                 json.dumps({"sources": _sources_from(trace), "usage": usage}), answer, verdict, None,
                 latency_ms, None, "recorded" if body.replay == "demo" else "live"))
            return cur.fetchone()[0]
    except Exception:
        log.exception("agent_runs insert failed")
        return None


def run_agent(body: AgentIn) -> dict:
    if body.profile not in profiles.PROFILES:
        raise HTTPException(400, f"profile must be one of: {', '.join(profiles.PROFILES)}")
    client = anthropic_client()
    use_tools = body.config == "full"
    messages: List[dict] = [m for m in body.history if m.get("role") in ("user", "assistant")
                            and isinstance(m.get("content"), str)][-6:]
    messages.append({"role": "user", "content": body.message})
    trace: List[dict] = []
    usage = {"input_tokens": 0, "output_tokens": 0}
    t0 = time.monotonic()
    answer = ""
    for _ in range(MAX_TURNS):
        # Thinking is always on with current Opus models: low effort keeps a spoken answer fast,
        # and max_tokens leaves room for both the thinking and the answer.
        kwargs = dict(model=MODEL, max_tokens=4096, system=system_prompt(body.profile, body.replay, use_tools),
                      messages=messages, output_config={"effort": "low"})
        if use_tools:
            kwargs["tools"] = TOOLS
        resp = client.messages.create(**kwargs)
        usage["input_tokens"] += getattr(resp.usage, "input_tokens", 0) or 0
        usage["output_tokens"] += getattr(resp.usage, "output_tokens", 0) or 0
        texts = [b.text for b in resp.content if b.type == "text"]
        calls = [b for b in resp.content if b.type == "tool_use"]
        if resp.stop_reason != "tool_use" or not calls:
            answer = "\n".join(texts).strip() or (
                "I can't answer that question." if resp.stop_reason == "refusal"
                else "I couldn't put an answer together. Try again with the departure and arrival.")
            break
        messages.append({"role": "assistant", "content": resp.content})
        results = []
        for call in calls:
            args = dict(call.input or {})
            if call.name in ("check_journey", "lift_status"):
                args["replay"] = body.replay  # the demo stays replayable, whatever the model says
            if call.name == "save_report":
                args["user_id"] = body.user_id
            t_call = time.monotonic()
            try:
                result, ok = _IMPL[call.name](**args), True
            except ToolError as e:
                result, ok = {"error": str(e)}, False
            except Exception as e:  # a failing source must not bring the agent down
                log.exception("tool %s failed", call.name)
                result, ok = {"error": f"{type(e).__name__}: {e}"}, False
            trace.append({"tool": call.name, "input": call.input, "ok": ok, "result": result,
                          "ms": round((time.monotonic() - t_call) * 1000)})
            results.append({"type": "tool_result", "tool_use_id": call.id, "is_error": not ok,
                            "content": json.dumps(result, ensure_ascii=False, default=str)[:20000]})
        messages.append({"role": "user", "content": results})
    else:
        answer = "I couldn't reach a conclusion in time. Try again with the departure and arrival."
    latency_ms = round((time.monotonic() - t0) * 1000)
    verdict = _verdict_from(trace) if use_tools else None
    run_id = _log_run(body, trace, answer, verdict, latency_ms, usage)
    return {"answer": answer, "verdict": verdict, "sources": _sources_from(trace),
            "tools_called": [{k: t[k] for k in ("tool", "input", "ok", "ms")} for t in trace],
            "itineraries": next((t["result"].get("itineraries") for t in reversed(trace)
                                 if t["tool"] == "check_journey" and t["ok"]), None),
            "profile": body.profile, "config": body.config, "model": MODEL, "latency_ms": latency_ms,
            "usage": usage, "mode": "recorded" if body.replay == "demo" else "live", "run_id": run_id}


@router.post("/api/agent")
def api_agent(body: AgentIn):
    return run_agent(body)
