"""Chantier B – community reports.

Validation tests always run. Database tests need a throwaway PostgreSQL:
    TEST_DATABASE_URL=postgresql://user:pass@localhost:5432/pmr_test pytest tests/test_reports.py
(they create the tables if needed and only touch rows they insert).
"""
import os
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from app import db, main, reports

client = TestClient(main.app)  # no `with`: startup (poller, warm-up) is not needed here
SQUARE = (2.2504, 48.8874)  # Esplanade de La Défense
REPORT = {"categorie": "escalier", "temporaire": False, "gravite": "bloquant", "confiance": 0.9,
          "description": "Escalier sans rampe", "lat": SQUARE[1], "lon": SQUARE[0]}


# --- Validation (no database) -----------------------------------------------

@pytest.mark.parametrize("change, field", [
    ({"categorie": "licorne"}, "categorie"),
    ({"gravite": "grave"}, "gravite"),
    ({"lat": 43.3}, "lat"),
    ({"lon": 5.4}, "lon"),
    ({"confiance": 1.5}, "confiance"),
    ({"target_type": "toit"}, "target_type"),
    ({"user_id": "abc"}, "user_id"),
    ({"photo_thumb": "https://example.com/x.jpg"}, "photo_thumb"),
    ({"photo_thumb": "data:image/jpeg;base64," + "A" * (300 * 1024)}, "photo_thumb"),
    ({"description": "x" * 501}, "description"),
])
def test_bad_report_is_400(change, field):
    r = client.post("/api/reports", json={**REPORT, **change})
    assert r.status_code == 400
    assert field in r.json()["detail"]


def test_missing_fields_are_400():
    r = client.post("/api/reports", json={"categorie": "escalier"})
    assert r.status_code == 400 and "gravite" in r.json()["detail"] and "lat" in r.json()["detail"]
    assert client.post("/api/reports", json=[1, 2]).status_code == 400


def test_bad_profile_and_bbox_are_400():
    assert client.post("/api/users", json={"display_name": "Léa", "profile": "trottinette"}).status_code == 400
    assert client.get("/api/reports?bbox=1,2,3").status_code == 400
    assert client.get("/api/reports?bbox=2.26,48.89,2.24,48.88").status_code == 400


def test_optional_fields_can_be_missing():
    r = reports.NewReport.model_validate({"categorie": "travaux", "gravite": "genant", "lat": 48.86, "lon": 2.35,
                                          "user_id": "", "target_id": None, "description": None})
    assert r.user_id is None and r.photo_thumb is None and r.description == "" and r.temporaire is False
    assert reports.NewReport.model_validate({**REPORT, "user_id": "12"}).user_id == 12


def test_without_database_routes_answer_503(monkeypatch):
    monkeypatch.setattr(db, "DATABASE_URL", None)
    assert client.post("/api/users", json={"display_name": "Léa"}).status_code == 503
    assert client.post("/api/reports", json=REPORT).status_code == 503
    assert client.get("/api/reports?bbox=2.24,48.88,2.26,48.89").status_code == 503


def test_confidence_rule():
    now = datetime(2026, 10, 22, 12, tzinfo=timezone.utc)
    fresh = now - timedelta(hours=2)
    assert reports.confidence({"confirmations": 2, "created_at": fresh}, now) == 4
    assert reports.confidence({"confirmations": 1, "created_at": fresh}, now) == 2
    assert reports.confidence({"confirmations": 3, "created_at": now - timedelta(hours=30)}, now) == 2
    assert reports.confidence({"confirmations": 1, "temporaire": True, "created_at": now - timedelta(hours=50)}, now) == 1
    assert reports.confidence({"confirmations": 1, "temporaire": False, "created_at": now - timedelta(days=9)}, now) == 2


# --- With a database ----------------------------------------------------------

TEST_DB = os.getenv("TEST_DATABASE_URL")


@pytest.fixture
def database(monkeypatch):
    if not TEST_DB:
        pytest.skip("TEST_DATABASE_URL not set")
    monkeypatch.setattr(db, "DATABASE_URL", TEST_DB)
    monkeypatch.setattr(db, "_conn", None)
    db.init_schema()
    created = []
    yield created
    with db.conn().cursor() as cur:
        cur.execute("DELETE FROM user_reports WHERE id = ANY(%s)", ([i for k, i in created if k == "r"],))
        cur.execute("DELETE FROM user_profile WHERE id = ANY(%s)", ([i for k, i in created if k == "u"],))
    db.conn().close()


def test_full_flow(database):
    u = client.post("/api/users", json={"display_name": "Test", "profile": "manuel"})
    assert u.status_code == 200
    uid = u.json()["id"]
    database.append(("u", uid))

    thumb = "data:image/jpeg;base64,/9j/4AAQSkZJRg=="
    r = client.post("/api/reports", json={**REPORT, "user_id": str(uid), "target_type": "photo", "photo_thumb": thumb})
    assert r.status_code == 200
    rid = r.json()["id"]
    database.append(("r", rid))

    feats = client.get("/api/reports?bbox=2.24,48.88,2.26,48.89").json()["features"]
    f = next(f for f in feats if f["properties"]["id"] == rid)
    assert f["geometry"]["coordinates"] == [SQUARE[0], SQUARE[1]]
    p = f["properties"]
    assert (p["categorie"], p["gravite"], p["description"], p["photo_thumb"]) == ("escalier", "bloquant", "Escalier sans rampe", thumb)
    assert p["is_demo"] is False and p["confirmations"] == 1 and p["confidence"] == 2 and p["created_at"]

    assert client.post(f"/api/reports/{rid}/confirm", json={"user_id": str(uid)}).json() == {"confirmations": 2}
    p = next(f for f in client.get("/api/reports?bbox=2.24,48.88,2.26,48.89").json()["features"]
             if f["properties"]["id"] == rid)["properties"]
    assert p["confirmations"] == 2 and p["confidence"] == 4

    # outside the box: not returned
    assert all(f["properties"]["id"] != rid for f in client.get("/api/reports?bbox=2.30,48.85,2.31,48.86").json()["features"])
    # the journey engine reads the description from `message`
    seen = next(x for x in main._reports() if x["id"] == rid)
    assert seen["description"] == "Escalier sans rampe" and seen["categorie"] == "escalier"


def test_lift_report_from_station_sheet(database):
    """Exact body sent by « Signaler une panne » (static/app.js reportLift), anonymous user."""
    r = client.post("/api/reports", json={
        "categorie": "ascenseur_panne", "temporaire": True, "gravite": "bloquant", "confiance": 1,
        "description": "Ascenseur en panne : Quai direction La Défense", "user_id": None,
        "lat": 48.8919, "lon": 2.2378, "target_type": "lift", "target_id": "33847f22-e286-4df8-b743-da81a3b8e059"})
    assert r.status_code == 200
    database.append(("r", r.json()["id"]))


def test_unknown_user_is_kept_anonymous(database):
    r = client.post("/api/reports", json={**REPORT, "user_id": "99999999"})
    assert r.status_code == 200
    database.append(("r", r.json()["id"]))
    with db.conn().cursor() as cur:
        cur.execute("SELECT user_id FROM user_reports WHERE id = %s", (r.json()["id"],))
        assert cur.fetchone()[0] is None


def test_confirm_unknown_report_is_404(database):
    assert client.post("/api/reports/99999999/confirm", json={}).status_code == 404


# --- B2: photo analysis (Claude is mocked: no key, no cost) ----------------------

import base64  # noqa: E402

JPEG = base64.b64encode(b"\xff\xd8\xff\xe0" + b"\x00" * 64).decode()


@pytest.fixture(autouse=False)
def fresh_limit(monkeypatch):
    monkeypatch.setattr(reports, "_recent_calls", reports.defaultdict(reports.deque))


def test_analyze_returns_claude_card(monkeypatch, fresh_limit):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test")
    seen = {}

    def fake(b64, media_type):
        seen.update(b64=b64, media_type=media_type)
        return reports.Fiche(categorie="escalier", temporaire=False, gravite="bloquant",
                             description="Trois marches sans rampe", confiance=0.92)

    monkeypatch.setattr(reports, "analyser", fake)
    r = client.post("/api/reports/analyze", json={"image_base64": JPEG, "lat": 48.88, "lon": 2.25})
    assert r.status_code == 200
    d = r.json()
    assert {k: d[k] for k in ("categorie", "temporaire", "gravite", "description", "confiance")} == {
        "categorie": "escalier", "temporaire": False, "gravite": "bloquant",
        "description": "Trois marches sans rampe", "confiance": 0.92}
    assert d["analyse"] == "ok" and isinstance(d["latency_ms"], int)
    assert seen == {"b64": JPEG, "media_type": "image/jpeg"}


def test_analyze_error_gives_empty_card(monkeypatch, fresh_limit):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test")

    def boom(*_):
        raise RuntimeError("overloaded")

    monkeypatch.setattr(reports, "analyser", boom)
    d = client.post("/api/reports/analyze", json={"image_base64": "data:image/jpeg;base64," + JPEG}).json()
    assert (d["categorie"], d["temporaire"], d["gravite"], d["description"], d["confiance"], d["analyse"]) == (
        "autre", False, "info", "", 0, "erreur")


def test_analyze_without_key_gives_empty_card(monkeypatch, fresh_limit):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    d = client.post("/api/reports/analyze", json={"image_base64": JPEG}).json()
    assert d["categorie"] == "autre" and d["analyse"] == "indisponible"


@pytest.mark.parametrize("body", [
    {}, {"image_base64": 12}, {"image_base64": "pas du base64 !"},
    {"image_base64": base64.b64encode(b"GIF89a....").decode()},
    {"image_base64": JPEG, "lat": 43.3, "lon": 5.4},
])
def test_analyze_bad_input_is_400(body, fresh_limit):
    assert client.post("/api/reports/analyze", json=body).status_code == 400


def test_analyze_is_rate_limited(monkeypatch, fresh_limit):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.setattr(reports, "ANALYZE_PER_10_MIN", 2)
    codes = [client.post("/api/reports/analyze", json={"image_base64": JPEG}).status_code for _ in range(3)]
    assert codes == [200, 200, 429]


def test_card_is_cleaned():
    f = reports.Fiche.model_validate({"categorie": "licorne", "temporaire": True, "gravite": "grave",
                                      "description": "  trop   long " + "x" * 300, "confiance": 3})
    assert f.categorie == "autre" and f.gravite == "info" and f.confiance == 1 and len(f.description) <= 160


def test_analyser_reads_the_tool_call(monkeypatch):
    """analyser() sends the photo with the `fiche` tool (auto: forcing a tool is refused by current models)."""
    import sys
    import types

    calls = {}

    class Messages:
        def create(self, **kw):
            calls.update(kw)
            block = types.SimpleNamespace(type="tool_use", name="fiche", input={
                "categorie": "travaux", "temporaire": True, "gravite": "genant",
                "description": "Palissade sur le trottoir", "confiance": 0.8})
            return types.SimpleNamespace(content=[block], stop_reason="tool_use")

    fake = types.SimpleNamespace(Anthropic=lambda **kw: types.SimpleNamespace(messages=Messages()))
    monkeypatch.setitem(sys.modules, "anthropic", fake)
    f = reports.analyser(JPEG, "image/jpeg")
    assert f.categorie == "travaux" and f.temporaire is True and f.confiance == 0.8
    assert calls["tool_choice"] == {"type": "auto"} and calls["tools"][0]["strict"] is True
    img = calls["messages"][0]["content"][0]
    assert img["source"] == {"type": "base64", "media_type": "image/jpeg", "data": JPEG}
