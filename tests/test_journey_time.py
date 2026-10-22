"""Departure / arrival time: validation at the boundary and the params sent to Navitia (no network)."""
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app import main

NOW = datetime(2026, 10, 22, 14, 5, tzinfo=main.PARIS_TZ)


def test_parse_when_none_or_blank_means_now():
    assert main._parse_when(None, NOW) is None
    assert main._parse_when("  ", NOW) is None


def test_parse_when_local_paris_time():
    t = main._parse_when("2026-10-22T18:30", NOW)
    assert (t.hour, t.minute, t.utcoffset()) == (18, 30, timedelta(hours=2))


def test_parse_when_converts_other_offsets_to_paris():
    t = main._parse_when("2026-10-22T16:30:00+00:00", NOW)
    assert t.strftime("%H:%M") == "18:30"


@pytest.mark.parametrize("bad", ["tomorrow", "22/10/2026 18:30", "2026-13-01T10:00", "2026-10-22T25:00"])
def test_parse_when_rejects_bad_format(bad):
    with pytest.raises(HTTPException) as e:
        main._parse_when(bad, NOW)
    assert e.value.status_code == 400


def test_parse_when_tolerates_a_few_minutes_in_the_past():
    assert main._parse_when("2026-10-22T14:00", NOW) is not None
    with pytest.raises(HTTPException) as e:
        main._parse_when("2026-10-22T13:00", NOW)
    assert e.value.status_code == 400 and "past" in e.value.detail


def test_parse_when_rejects_more_than_30_days_ahead():
    assert main._parse_when("2026-11-20T10:00", NOW) is not None
    with pytest.raises(HTTPException) as e:
        main._parse_when("2026-11-22T10:00", NOW)
    assert e.value.status_code == 400


def test_time_note_only_for_a_later_trip():
    assert main._time_note(None, NOW) is None
    assert main._time_note(NOW + timedelta(minutes=5), NOW) is None
    note = main._time_note(datetime(2026, 10, 22, 18, 30, tzinfo=main.PARIS_TZ), NOW)
    assert note == "Elevator status is from now (14:05); it may change by 18:30."
    assert "on Fri 23 Oct" in main._time_note(datetime(2026, 10, 23, 9, 0, tzinfo=main.PARIS_TZ), NOW)


class FakeResp:
    status_code = 200
    text = ""

    def json(self):
        return {"journeys": []}


def capture_params(monkeypatch):
    calls = []
    monkeypatch.setattr(main.httpx, "get", lambda url, **kw: calls.append(dict(kw["params"])) or FakeResp())
    return calls


A, B = {"lon": 2.35, "lat": 48.85}, {"lon": 2.37, "lat": 48.84}


def test_navitia_without_time_plans_from_now(monkeypatch):
    calls = capture_params(monkeypatch)
    main._navitia(A, B)
    assert "datetime" not in calls[0] and "datetime_represents" not in calls[0]


def test_navitia_depart_at(monkeypatch):
    calls = capture_params(monkeypatch)
    main._navitia(A, B, when=datetime(2026, 10, 22, 18, 30, tzinfo=main.PARIS_TZ))
    assert calls[0]["datetime"] == "20261022T183000" and calls[0]["datetime_represents"] == "departure"
    assert calls[0]["wheelchair"] == "true"


def test_navitia_arrive_by_in_paris_time(monkeypatch):
    calls = capture_params(monkeypatch)
    # A UTC instant is sent as Paris wall-clock time; plan B keeps its forbidden stops.
    main._navitia(A, B, ["stop_area:X"], when=datetime(2026, 10, 23, 5, 0, tzinfo=timezone.utc), arrive=True)
    assert calls[0]["datetime"] == "20261023T070000" and calls[0]["datetime_represents"] == "arrival"
    assert calls[0]["forbidden_uris[]"] == "stop_area:X"


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(main, "PRIM_API_KEY", "test")
    monkeypatch.setattr(main, "_resolve", lambda q: {"label": q, "lon": 2.35, "lat": 48.85})
    monkeypatch.setattr(main.sources, "lifts", lambda: {"rows": [], "fetched_at": "2026-10-22T12:05:00Z"})
    return TestClient(main.app)


def test_api_journey_rejects_bad_when(client):
    r = client.get("/api/journey", params={"from": "a", "to": "b", "when": "soon"})
    assert r.status_code == 400
    r = client.get("/api/journey", params={"from": "a", "to": "b", "when": "2020-01-01T10:00"})
    assert r.status_code == 400 and "past" in r.json()["detail"]


def test_api_journey_passes_time_to_main_and_plan_b(client, monkeypatch):
    seen = []
    monkeypatch.setattr(main, "_navitia", lambda a, b, forbidden=(), when=None, arrive=False:
                        seen.append((tuple(forbidden), when, arrive)) or [{"sections": []}])
    monkeypatch.setattr(main, "_check_all", lambda js, *a, prefix="it", **k: [{"id": f"{prefix}1", "verdict": "bloque"}])
    monkeypatch.setattr(main.verify, "blocking_stop_areas", lambda it: ["stop_area:X"])
    monkeypatch.setattr(main.verify, "pick_plan_b", lambda its: its)
    when = (datetime.now(main.PARIS_TZ) + timedelta(days=1)).replace(hour=9, minute=0, second=0, microsecond=0)
    r = client.get("/api/journey", params={"from": "a", "to": "b", "when": when.strftime("%Y-%m-%dT%H:%M"), "arrive": "true"})
    assert r.status_code == 200, r.text
    assert len(seen) == 2 and seen[1][0] == ("stop_area:X",)
    assert all(w == when and arr is True for _, w, arr in seen)
    d = r.json()
    assert d["when"] == when.strftime("%Y-%m-%dT%H:%M") and d["arrive"] is True
    assert d["time_note"].startswith("Elevator status is from now (")


def test_api_journey_leave_now_has_no_note(client, monkeypatch):
    seen = []
    monkeypatch.setattr(main, "_navitia", lambda a, b, forbidden=(), when=None, arrive=False: seen.append(when) or [])
    d = client.get("/api/journey", params={"from": "a", "to": "b"}).json()
    assert seen == [None] and d["when"] is None and d["arrive"] is False and d["time_note"] is None


def test_replay_demo_ignores_the_time(monkeypatch):
    monkeypatch.setattr(main, "_navitia", lambda *a, **k: pytest.fail("demo must not call Navitia"))
    r = TestClient(main.app).get("/api/journey", params={"from": "demo", "to": "demo", "replay": "demo",
                                                          "when": "not a date"})
    assert r.status_code == 200
    d = r.json()
    assert d["replay"] == "demo" and d["itineraries"] and d["when"] is None and d["time_note"] is None
