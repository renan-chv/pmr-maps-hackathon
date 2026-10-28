"""Call limits on the routes that cost money (Claude) or write shared data (reports, users).

In memory, per process: right on Aiven (one process); on Vercel each instance counts on its own, so the
limits there are looser. The spending cap set on the Anthropic key stays the hard ceiling.
"""
from __future__ import annotations

import os
import time
from collections import defaultdict, deque
from datetime import datetime, timezone
from typing import Deque, Dict, Optional, Tuple

from fastapi import HTTPException, Request

# (calls, window in seconds) per client. Env vars let us tighten them at launch without a deploy of code.
RULES: Dict[str, Tuple[int, int]] = {
    "agent": (int(os.getenv("AGENT_PER_HOUR", "10")), 3600),
    "analyze": (int(os.getenv("REPORTS_ANALYZE_LIMIT", "30")), 600),
    "report": (int(os.getenv("REPORTS_PER_HOUR", "10")), 3600),
    "confirm": (30, 3600),
    "user": (2, 86400),  # one person, one or two profiles a day (a new phone, a reset): more is abuse
    "flag": (20, 3600),
    "delete_user": (10, 3600),
}
# Whole app, per UTC day: each agent answer costs about 3 cents, so 50 a day is at most about 1.50 EUR.
AGENT_DAILY_LIMIT = int(os.getenv("AGENT_DAILY_LIMIT", "50"))

_calls: Dict[Tuple[str, str], Deque[float]] = defaultdict(deque)
_day: Dict[str, object] = {"date": None, "agent": 0}


def client_key(request: Request) -> str:
    """The caller's IP as our proxy saw it.

    The client can put anything at the start of X-Forwarded-For; the proxy in front of us appends the real
    address at the end, so the last entry is the one to trust (X-Real-IP first when the platform sets it).
    """
    real = request.headers.get("x-real-ip", "").strip()
    if real:
        return real
    fwd = [p.strip() for p in request.headers.get("x-forwarded-for", "").split(",") if p.strip()]
    if fwd:
        return fwd[-1]
    return request.client.host if request.client else "?"


def allow(rule: str, key: str, now: Optional[float] = None) -> bool:
    """Count one call of `key` under `rule`; False when the client is over its limit (the call is not counted)."""
    limit, window = RULES[rule]
    now = time.monotonic() if now is None else now
    calls = _calls[(rule, key)]
    while calls and now - calls[0] > window:
        calls.popleft()
    if len(calls) >= limit:
        return False
    calls.append(now)
    return True


def check(rule: str, request: Request, message: str) -> None:
    if not allow(rule, client_key(request)):
        raise HTTPException(429, message)


def agent_budget(today: Optional[str] = None) -> None:
    """One more agent answer today for the whole app, or 429 once the daily cap is reached."""
    today = today or datetime.now(timezone.utc).strftime("%Y-%m-%d")
    if _day["date"] != today:
        _day.update(date=today, agent=0)
    if int(_day["agent"]) >= AGENT_DAILY_LIMIT:
        raise HTTPException(429, "L'assistant a répondu à beaucoup de questions aujourd'hui. "
                                 "Les trajets et la carte marchent toujours ; l'assistant revient demain.")
    _day["agent"] = int(_day["agent"]) + 1


def reset() -> None:
    """For tests."""
    _calls.clear()
    _day.update(date=None, agent=0)
