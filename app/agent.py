"""Chantier E – Agent PMR Maps : Claude + nos propres routes comme outils.

POST /api/agent  {"message": "...", "profile": "electrique", "replay": "demo"?, "config": "full"|"no_tools"}

L'agent n'invente rien : chaque outil appelle une route de l'app (/api/journey, /api/lifts,
/api/places, /api/reports) dans le même processus, et renvoie la source et l'heure de la donnée.
Le prompt système l'oblige à citer la source et la fraîcheur de chaque fait.

config="no_tools" = Claude seul (baseline du benchmark). Chaque appel est enregistré dans agent_runs.
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

MODEL = os.getenv("AGENT_MODEL", "claude-opus-5-5")  # claude-haiku-5-5 si la latence est trop forte
MAX_TURNS = 6
PARIS = ZoneInfo("Europe/Paris")
FIXTURES = Path(__file__).resolve().parent.parent / "static" / "fixtures"

_client = None   # anthropic.Anthropic, créé à la demande (lit ANTHROPIC_API_KEY)
_internal = None  # client HTTP vers nos propres routes, dans le même processus


def anthropic_client():
    global _client
    if _client is None:
        if not os.getenv("ANTHROPIC_API_KEY"):
            raise HTTPException(503, "ANTHROPIC_API_KEY manquante : agent indisponible")
        import anthropic
        _client = anthropic.Anthropic()
    return _client


def api():
    """Appelle nos routes sans passer par le réseau (pas de startup, pas de poller en double)."""
    global _internal
    if _internal is None:
        from fastapi.testclient import TestClient
        from .main import app  # import tardif : main importe ce module
        _internal = TestClient(app, raise_server_exceptions=False)
    return _internal


# --- Petits utilitaires -----------------------------------------------------

def _norm(s: Optional[str]) -> str:
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower()
    return " ".join(s.replace("-", " ").replace("'", " ").split())


def _age_min(iso: Optional[str]) -> Optional[int]:
    """Âge d'une donnée en minutes (pour que l'agent dise « info d'il y a 2 h »)."""
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
        raise ToolError(f"{path} a répondu {r.status_code} : {detail}")
    return r.json()


class ToolError(Exception):
    pass


# --- Outils -----------------------------------------------------------------

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
        "mode": "relevé enregistré (démo)" if replay == "demo" else "direct",
    }


def lift_status(station: str, replay: Optional[str] = None) -> dict:
    if replay == "demo":
        snap = json.loads((FIXTURES / "lifts_demo.json").read_text())
        rows, fetched_at, src = snap["rows"], snap.get("fetched_at"), "IDFM, relevé enregistré (démo)"
    else:
        feats = _get("/api/lifts")
        rows = [dict(f["properties"], liftstatus=f["properties"].get("status"), zdcname=f["properties"].get("station"),
                     liftsituation=f["properties"].get("situation"), liftreason=f["properties"].get("reason"),
                     liftdirection=f["properties"].get("direction"), liftstateupdate=f["properties"].get("source_update"))
                for f in feats.get("features", [])]
        fetched_at, src = (feats.get("meta") or {}).get("fetched_at"), "IDFM, état des ascenseurs"
    q = _norm(station)
    match = [r for r in rows if q and (q in _norm(r.get("zdcname")) or _norm(r.get("zdcname")) in q)]
    if not match:
        return {"station": station, "found": False, "source": src, "fetched_at": fetched_at,
                "note": "Aucun ascenseur IDFM trouvé pour ce nom. Ne pas conclure que la gare est accessible."}
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
            "note": "IDFM met à jour l'état ~3 fois par jour : au-delà de quelques heures, dire « à vérifier »."}


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
            "legend": "wheelchair: true = accessible, partial = avec difficulté, false = non, unknown = fiche incomplète",
            "source": "Acceslibre (data.gouv.fr)", "fetched_at": meta.get("fetched_at"), "stale": meta.get("stale")}


def save_report(lat: float, lon: float, categorie: str, gravite: str, temporaire: bool, description: str,
                user_id: Optional[int] = None) -> dict:
    body = {"lat": lat, "lon": lon, "categorie": categorie, "gravite": gravite, "temporaire": temporaire,
            "description": description, "user_id": user_id, "target_type": "manual", "target_id": None,
            "confiance": 0.5, "source": "agent"}
    r = api().post("/api/reports", json=body)
    if r.status_code == 404:
        raise ToolError("Le service de signalements (chantier B) n'est pas encore en ligne : signalement NON enregistré.")
    if r.status_code >= 400:
        raise ToolError(f"/api/reports a répondu {r.status_code} : {r.text[:200]}")
    return {"saved": True, "report": r.json(), "note": "Niveau de confiance 2 tant que personne ne confirme."}


PROFILE_ENUM = list(profiles.PROFILES)
TOOLS = [
    {"name": "check_journey",
     "description": "Calcule et vérifie un trajet en transports en Île-de-France pour un profil de mobilité : "
                    "verdict (passe/risque/bloque) par étape, contrôles (ascenseurs, chantiers, escaliers, "
                    "signalements) avec source et heure, plan B, et ce que propose Navitia seul. "
                    "À utiliser pour toute question « est-ce que je peux aller de A à B ».",
     "input_schema": {"type": "object", "properties": {
         "origin": {"type": "string", "description": "Départ : adresse, lieu ou gare (ex. « Gare de Lyon, Paris »)"},
         "destination": {"type": "string", "description": "Arrivée : adresse, lieu ou gare"},
         "profile": {"type": "string", "enum": PROFILE_ENUM}},
         "required": ["origin", "destination", "profile"]}},
    {"name": "lift_status",
     "description": "État actuel des ascenseurs d'une gare ou station (IDFM) : en service, en panne, inconnu, "
                    "avec l'heure de publication et la fiabilité historique (part du temps en service).",
     "input_schema": {"type": "object", "properties": {
         "station": {"type": "string", "description": "Nom de la gare ou station, ex. « Châtelet - Les Halles »"}},
         "required": ["station"]}},
    {"name": "find_places",
     "description": "Lieux recensés dans Acceslibre (restaurants, commerces…) autour d'une adresse, avec le verdict "
                    "fauteuil (entrée, porte, marches) et les toilettes adaptées.",
     "input_schema": {"type": "object", "properties": {
         "near": {"type": "string", "description": "Adresse ou lieu autour duquel chercher"},
         "name": {"type": "string", "description": "Optionnel : nom du lieu recherché"},
         "kind": {"type": "string", "enum": ["food", "shop"], "description": "Optionnel : food = restauration"},
         "radius_m": {"type": "integer", "description": "Rayon en mètres (100 à 600, 300 par défaut)"}},
         "required": ["near"]}},
    {"name": "save_report",
     "description": "Enregistre un signalement d'obstacle décrit par l'utilisateur (escalier, travaux, ascenseur "
                    "en panne…). Ne l'utiliser que si l'utilisateur signale explicitement un obstacle ET qu'on "
                    "connaît sa position.",
     "input_schema": {"type": "object", "properties": {
         "lat": {"type": "number"}, "lon": {"type": "number"},
         "categorie": {"type": "string", "enum": ["escalier", "marche", "travaux", "trottoir_encombre",
                                                  "trottoir_etroit", "bordure_haute", "pente", "ascenseur_panne",
                                                  "escalator_panne", "rampe", "autre"]},
         "gravite": {"type": "string", "enum": ["bloquant", "genant", "info"]},
         "temporaire": {"type": "boolean"},
         "description": {"type": "string", "description": "Une phrase courte en français"}},
         "required": ["lat", "lon", "categorie", "gravite", "temporaire", "description"]}},
]
_IMPL = {"check_journey": check_journey, "lift_status": lift_status,
         "find_places": find_places, "save_report": save_report}


def system_prompt(profile: str, replay: Optional[str], tools: bool) -> str:
    now = datetime.now(PARIS).strftime("%A %d/%m/%Y %H:%M")
    base = (
        f"Tu es l'assistant de PMR Maps. Nous sommes le {now} (heure de Paris). "
        f"Profil de l'utilisateur : {profiles.PROFILES.get(profile, profile)} (code « {profile} »), "
        "sauf s'il en indique un autre dans sa question. "
        "Tu réponds en français, à l'oral (la réponse est lue à voix haute) : phrases courtes, pas de tableau, "
        "pas de markdown, 6 phrases maximum.\n"
        "Structure : 1) le verdict en premier (« Ça passe », « C'est risqué », « Bloqué à … »), "
        "2) l'étape à risque et pourquoi, 3) le plan B s'il existe, "
        "4) les sources avec leur heure, par exemple « ascenseurs : IDFM, info de 9 h 30 ».\n"
    )
    if not tools:
        return base + "Tu n'as accès à aucune donnée en direct."
    rules = (
        "Règles :\n"
        "- Tu ne dis jamais qu'un lieu ou un trajet est accessible sans un outil qui le confirme. "
        "Si l'info manque, dis « je ne sais pas » et ce qu'il faudrait vérifier.\n"
        "- Chaque fait cite sa source et son heure. Si une donnée a plus de 3 heures (champ age_min ou "
        "lifts_age_min > 180), dis « info de <heure>, à vérifier ».\n"
        "- Les données sont celles de maintenant. Si la question porte sur plus tard (demain 10 h…), dis-le : "
        "l'état peut changer d'ici là ; appuie-toi sur la fiabilité historique des ascenseurs, avec le chiffre "
        "donné par l'outil (champ reliability, ex. « en service 88 % du temps sur 11 jours »), et propose de revérifier avant de partir.\n"
        "- Niveaux de confiance : 5 officiel en direct, 4 signalement confirmé, 3 officiel fixe, 2 un seul "
        "signalement, 1 inconnu (jamais présenté comme accessible).\n"
        "- Compare avec ce que propose une appli classique (baseline_navitia_seul) quand ça change le verdict.\n"
        "- Une seule question de trajet = un appel à check_journey ; utilise lift_status pour détailler une gare.\n"
    )
    if replay == "demo":
        rules += ("- MODE DÉMO : les données viennent d'un relevé réel enregistré le 22/10/2026 vers 11 h. "
                  "Dis-le une fois (« relevé de 11 h »). Le trajet de démo est fixé par le serveur.\n")
    return base + rules


# --- Route ------------------------------------------------------------------

class AgentIn(BaseModel):
    message: str = Field(..., min_length=2, max_length=2000)
    profile: str = profiles.DEFAULT_PROFILE
    user_id: Optional[int] = None
    replay: Optional[Literal["demo"]] = None
    config: Literal["full", "no_tools"] = "full"
    history: List[dict] = Field(default_factory=list, description="Tours précédents [{role, content}] (texte)")


def _verdict_from(trace: List[dict]) -> Optional[str]:
    """Verdict structuré pour l'UI et le benchmark : celui du meilleur itinéraire vérifié."""
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
        raise HTTPException(400, f"profile doit être l'un de : {', '.join(profiles.PROFILES)}")
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
                "Je ne peux pas répondre à cette question." if resp.stop_reason == "refusal"
                else "Je n'ai pas réussi à formuler une réponse. Réessayez en précisant le départ et l'arrivée.")
            break
        messages.append({"role": "assistant", "content": resp.content})
        results = []
        for call in calls:
            args = dict(call.input or {})
            if call.name in ("check_journey", "lift_status"):
                args["replay"] = body.replay  # la démo reste rejouable, quoi que dise le modèle
            if call.name == "save_report":
                args["user_id"] = body.user_id
            t_call = time.monotonic()
            try:
                result, ok = _IMPL[call.name](**args), True
            except ToolError as e:
                result, ok = {"error": str(e)}, False
            except Exception as e:  # une source qui tombe ne doit pas faire tomber l'agent
                log.exception("tool %s failed", call.name)
                result, ok = {"error": f"{type(e).__name__}: {e}"}, False
            trace.append({"tool": call.name, "input": call.input, "ok": ok, "result": result,
                          "ms": round((time.monotonic() - t_call) * 1000)})
            results.append({"type": "tool_result", "tool_use_id": call.id, "is_error": not ok,
                            "content": json.dumps(result, ensure_ascii=False, default=str)[:20000]})
        messages.append({"role": "user", "content": results})
    else:
        answer = "Je n'ai pas réussi à conclure à temps. Réessayez en précisant le départ et l'arrivée."
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
