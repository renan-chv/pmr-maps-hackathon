"""Call limits on the routes that cost money or write shared data."""
import pytest
from fastapi import HTTPException
from starlette.requests import Request

from app import limits


def req(headers=(), host="10.0.0.1"):
    return Request({"type": "http", "headers": [(k.lower().encode(), v.encode()) for k, v in headers],
                    "client": (host, 1234)})


def test_client_key_trusts_the_proxy_end_of_forwarded_for():
    # The client wrote "1.1.1.1" itself; the proxy appended the real address at the end.
    assert limits.client_key(req([("X-Forwarded-For", "1.1.1.1, 203.0.113.7")])) == "203.0.113.7"
    assert limits.client_key(req([("X-Real-IP", "198.51.100.2"), ("X-Forwarded-For", "1.1.1.1")])) == "198.51.100.2"
    assert limits.client_key(req()) == "10.0.0.1"


def test_spoofing_forwarded_for_does_not_reset_the_count(monkeypatch):
    monkeypatch.setitem(limits.RULES, "report", (2, 3600))
    ok = [limits.allow("report", limits.client_key(req([("X-Forwarded-For", f"9.9.9.{i}, 203.0.113.7")])), now=0.0)
          for i in range(3)]
    assert ok == [True, True, False]


def test_window_slides(monkeypatch):
    monkeypatch.setitem(limits.RULES, "agent", (1, 3600))
    assert limits.allow("agent", "a", now=0.0)
    assert not limits.allow("agent", "a", now=10.0)
    assert limits.allow("agent", "b", now=10.0)  # another person is not affected
    assert limits.allow("agent", "a", now=3601.0)


def test_agent_daily_budget_resets_the_next_day(monkeypatch):
    monkeypatch.setattr(limits, "AGENT_DAILY_LIMIT", 2)
    limits.agent_budget("2026-10-22")
    limits.agent_budget("2026-10-22")
    with pytest.raises(HTTPException) as e:
        limits.agent_budget("2026-10-22")
    assert e.value.status_code == 429 and "tomorrow" in e.value.detail
    limits.agent_budget("2026-10-23")


def test_agent_route_answers_429_before_calling_claude(monkeypatch):
    from fastapi.testclient import TestClient
    from app import agent, main
    monkeypatch.setitem(limits.RULES, "agent", (0, 3600))
    monkeypatch.setattr(agent, "run_agent", lambda body: pytest.fail("Claude must not be called"))
    r = TestClient(main.app).post("/api/agent", json={"message": "Is the lift at Bastille working?"})
    assert r.status_code == 429
