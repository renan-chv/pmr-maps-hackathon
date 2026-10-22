"""E3 : l'agent avec nos données contre Claude seul, sur des questions dont on connaît la réponse.

Les deux configurations passent par la même route POST /api/agent (déployée sur Aiven) :
  - "no_tools" : Claude seul, sans aucune donnée (baseline « sans données ») ;
  - "full"     : Claude + nos outils (trajets vérifiés, état des ascenseurs, lieux, signalements).
Toutes les questions tournent en mode démo (replay=demo) : la vérité terrain vient du relevé IDFM
enregistré le 22/10 vers 11h (static/fixtures/lifts_demo.json), donc le résultat est reproductible.
Chaque appel est aussi enregistré par le serveur dans la table agent_runs (PostgreSQL Aiven).

Usage : python -m bench.agent_bench --base https://<app>.aiven.app
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import httpx

# (question, profil, vérité) ; vérité "non" = en panne ou bloqué, "oui" = ça marche / ça passe
QUESTIONS = [
    ("L'ascenseur de la ligne 1 à Esplanade de la Défense fonctionne-t-il en ce moment ?", "manuel", "non"),
    ("Est-ce que les ascenseurs de la ligne 2 à Jaurès sont en service ?", "manuel", "non"),
    ("Je suis en fauteuil, je peux prendre l'ascenseur à Pont de Sèvres aujourd'hui ?", "manuel", "non"),
    ("L'ascenseur de la gare de Champigny (RER A) marche-t-il ?", "manuel", "non"),
    ("Les ascenseurs de Châtelet - Les Halles fonctionnent-ils en ce moment ?", "manuel", "oui"),
    ("Je peux utiliser l'ascenseur à Bibliothèque François Mitterrand en fauteuil ?", "manuel", "oui"),
    ("Les ascenseurs de Barbès - Rochechouart sont-ils en service ?", "manuel", "oui"),
    ("L'ascenseur de Pyramides marche-t-il aujourd'hui ?", "manuel", "oui"),
    ("Je suis en fauteuil manuel, je vais de la rue de Rivoli à l'esplanade de la Défense en métro ligne 1, "
     "est-ce que ça passe ?", "manuel", "non"),
    ("En fauteuil électrique, je vais de Châtelet à l'esplanade de la Défense par la ligne 1, ça passe ?",
     "electrique", "non"),
    ("Je suis malvoyant, je vais de Châtelet à l'esplanade de la Défense par la ligne 1, est-ce que je peux y aller ?",
     "malvoyant", "oui"),
]

NEG = re.compile(r"en panne|hors service|hors-service|bloqu|ne fonctionne pas|ne marche pas|pas en service|"
                 r"aucun ascenseur en service|ne passe pas", re.I)
# "aucun n'est signalé en panne", "pas en panne" say the lift works: removed before looking for a breakdown
NOT_BROKEN = re.compile(r"aucun[^.]{0,40}en panne|pas en panne|ni en panne", re.I)
POS = re.compile(r"fonctionne|en service|ça passe|ca passe|vous pouvez|accessible|pas de probl|risqu", re.I)
UNSURE = re.compile(r"je ne sais pas|je ne peux pas|je n'ai pas|je n'ai aucune|aucune donnée|pas de donnée|"
                    r"pas d'information|pas accès|impossible de savoir", re.I)
CITES = re.compile(r"IDFM|Île-de-France Mobilités|Acceslibre|Navitia|Dispotrains|relevé", re.I)
HOUR = re.compile(r"\b\d{1,2} ?h(?: ?\d{2})?\b")
PRICE_IN, PRICE_OUT = 4.0, 20.0  # $ par million de tokens, claude-opus-5-5


def verdict_of(answer: str) -> str:
    """Polarité de la réponse, lue sur les deux premières phrases (le verdict est demandé en premier).

    « Je ne peux pas confirmer » l'emporte : une réponse prudente sans données n'est pas une bonne réponse.
    « Risqué » sans blocage compte comme « ça passe, avec prudence » (le trajet reste faisable).
    """
    head = " ".join(re.split(r"(?<=[.!?])\s+", answer.strip().replace("**", ""))[:2])
    if UNSURE.search(head):
        return "incertain"
    if NEG.search(NOT_BROKEN.sub("", head)):
        return "non"
    if POS.search(head):
        return "oui"
    return "incertain"


def regrade(path: Path) -> dict:
    """Re-score saved answers with the current rules (no new call to Claude)."""
    d = json.loads(path.read_text())
    for r in d["runs"]:
        if "error" in r:
            continue
        r["predicted"] = verdict_of(r["answer"])
        r["correct"] = r["predicted"] == r["truth"]
        r["false_accessible"] = r["truth"] == "non" and r["predicted"] == "oui"
        r["cites_source"] = bool(CITES.search(r["answer"]) and HOUR.search(r["answer"]))
    return d


def config_stats(rows: list, cfg: str) -> dict:
    rs = [r for r in rows if r["config"] == cfg and "error" not in r]
    n = len(rs) or 1
    return {"answered": len(rs), "accuracy": round(sum(r["correct"] for r in rs) / n, 2),
            "false_accessible": sum(r["false_accessible"] for r in rs),
            "uncertain": sum(r["predicted"] == "incertain" for r in rs),
            "cites_source_and_time": round(sum(r["cites_source"] for r in rs) / n, 2),
            "median_latency_s": sorted(r["latency_s"] for r in rs)[len(rs) // 2] if rs else None,
            "cost_usd": round(sum(r["cost_usd"] for r in rs), 3)}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base")
    ap.add_argument("--regrade", type=Path, help="re-score a saved result file, no API call")
    args = ap.parse_args()
    if args.regrade:
        d = regrade(args.regrade)
        d["summary"]["claude_seul"] = config_stats(d["runs"], "no_tools")
        d["summary"]["agent_avec_donnees"] = config_stats(d["runs"], "full")
        args.regrade.write_text(json.dumps(d, ensure_ascii=False, indent=1))
        for r in d["runs"]:
            print(f"[{r['config']}] {r['predicted']:9} (vérité {r['truth']}) {'OK ' if r['correct'] else 'NON'} {r['question'][:60]}")
        print(json.dumps({k: d["summary"][k] for k in ("claude_seul", "agent_avec_donnees")}, ensure_ascii=False, indent=1))
        return 0
    if not args.base:
        ap.error("--base est requis sans --regrade")
    client = httpx.Client(timeout=180)
    rows = []
    started = datetime.now(timezone.utc)
    for config in ("no_tools", "full"):
        for q, profile, truth in QUESTIONS:
            t0 = time.monotonic()
            try:
                r = client.post(f"{args.base}/api/agent", json={"message": q, "profile": profile,
                                                                "replay": "demo", "config": config})
                r.raise_for_status()
                d = r.json()
            except Exception as e:
                print(f"[{config}] erreur : {q[:50]}… {e}", file=sys.stderr)
                rows.append({"config": config, "question": q, "truth": truth, "error": str(e)})
                continue
            ans = d.get("answer") or ""
            pred = verdict_of(ans)
            usage = d.get("usage") or {}
            cost = (usage.get("input_tokens", 0) * PRICE_IN + usage.get("output_tokens", 0) * PRICE_OUT) / 1e6
            row = {"config": config, "question": q, "profile": profile, "truth": truth, "predicted": pred,
                   "correct": pred == truth, "false_accessible": truth == "non" and pred == "oui",
                   "cites_source": bool(CITES.search(ans) and HOUR.search(ans)),
                   "tools": [t["tool"] for t in d.get("tools_called") or []],
                   "latency_s": round(d.get("latency_ms", (time.monotonic() - t0) * 1000) / 1000, 1),
                   "cost_usd": round(cost, 4), "run_id": d.get("run_id"), "answer": ans}
            rows.append(row)
            print(f"[{config}] {pred:9} (vérité {truth}) {'OK ' if row['correct'] else 'NON'} "
                  f"{row['latency_s']}s ${row['cost_usd']} {q[:60]}")

    def stats(cfg):
        return config_stats(rows, cfg)

    summary = {"run_at": started.isoformat(timespec="seconds"), "base": args.base, "questions": len(QUESTIONS),
               "mode": "scénario enregistré (replay=demo, relevé IDFM du 22/10 vers 11h)",
               "claude_seul": stats("no_tools"), "agent_avec_donnees": stats("full")}
    out = Path(__file__).resolve().parent / "results" / f"agent_bench_{started:%Y%m%d_%H%M}.json"
    out.write_text(json.dumps({"summary": summary, "runs": rows}, ensure_ascii=False, indent=1))
    print("\n" + json.dumps({k: summary[k] for k in ("claude_seul", "agent_avec_donnees")}, ensure_ascii=False, indent=1))
    print(f"Détail : {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
