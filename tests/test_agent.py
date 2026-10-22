"""Tests de l'agent sans appeler Claude : un faux client rejoue des réponses du modèle."""
from types import SimpleNamespace as NS

from fastapi.testclient import TestClient

from app import agent
from app.main import app


class FakeClaude:
    """Renvoie les réponses scriptées dans l'ordre et garde les requêtes reçues."""

    def __init__(self, script):
        self.script, self.requests = list(script), []
        self.messages = self

    def create(self, **kwargs):
        self.requests.append(kwargs)
        return self.script.pop(0)


def tool_use(name, **inp):
    return NS(stop_reason="tool_use", usage=NS(input_tokens=10, output_tokens=5),
              content=[NS(type="tool_use", id=f"tu_{name}", name=name, input=inp)])


def text(t):
    return NS(stop_reason="end_turn", usage=NS(input_tokens=10, output_tokens=5), content=[NS(type="text", text=t)])


def run(monkeypatch, script, **body):
    fake = FakeClaude(script)
    monkeypatch.setattr(agent, "_client", fake)
    r = TestClient(app).post("/api/agent", json=body)
    return r, fake


def test_demo_journey_is_checked_and_cited(monkeypatch):
    r, fake = run(monkeypatch, [
        tool_use("check_journey", origin="Rue de Rivoli", destination="La Défense", profile="electrique"),
        text("Blocked at Esplanade de la Défense. Sources: IDFM, snapshot from 11 am."),
    ], message="I'm going to La Défense in a power wheelchair, can I make it?", profile="electrique", replay="demo")
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["tools_called"][0]["tool"] == "check_journey" and out["tools_called"][0]["ok"]
    assert out["verdict"] in ("passe", "risque", "bloque")
    assert out["mode"] == "recorded" and out["itineraries"]
    assert any(s["source"] for s in out["sources"])
    # the tool result sent back to the model carries the snapshot time and the demo mode
    tool_result = fake.requests[1]["messages"][-1]["content"][0]["content"]
    assert "lifts_fetched_at" in tool_result and "demo" in tool_result
    assert "DEMO MODE" in fake.requests[0]["system"]


def test_lift_status_demo_finds_outage(monkeypatch):
    res = agent.lift_status("Esplanade de la Défense", replay="demo")
    assert res["found"] and res["fetched_at"]
    assert res["not_available"] >= 1


def test_unknown_station_is_not_called_accessible():
    res = agent.lift_status("Gare imaginaire du Nord-Ouest", replay="demo")
    assert res["found"] is False and "Do not conclude" in res["note"]


def test_tool_error_is_returned_to_model_not_crash(monkeypatch):
    r, fake = run(monkeypatch, [
        tool_use("save_report", lat=48.85, lon=2.35, categorie="escalier", gravite="bloquant",
                 temporaire=False, description="Three steps"),
        text("I couldn't save the report."),
    ], message="There are three steps in front of the bakery")
    out = r.json()
    assert r.status_code == 200 and out["tools_called"][0]["ok"] is False
    assert fake.requests[1]["messages"][-1]["content"][0]["is_error"] is True


def test_no_tools_baseline(monkeypatch):
    r, fake = run(monkeypatch, [text("Probably yes.")], message="Is Gare de Lyon accessible?",
                  config="no_tools")
    assert r.status_code == 200 and "tools" not in fake.requests[0]
    assert r.json()["verdict"] is None


def test_bad_profile(monkeypatch):
    r, _ = run(monkeypatch, [], message="test", profile="trottinette")
    assert r.status_code in (400, 422)
