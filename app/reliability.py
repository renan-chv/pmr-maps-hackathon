"""Lift reliability from the Dispotrains archive (history of every IDF lift, last ~10 days).

Dispotrains (dispotrains.membrives.fr, E. Membrives) records each state change of the IDFM lifts.
Its elevator id is our `privateelevatorid`, e.g. ASC:RATP:137025-SY-ASC-ELEV2_(MHA).
States are listed newest first, with begin/end timestamps.
"""
from __future__ import annotations

import json
import logging
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, time, timedelta
from pathlib import Path
from typing import Dict, Iterable, Optional
from urllib.parse import quote
from zoneinfo import ZoneInfo

import httpx

from .sources import cached

log = logging.getLogger("reliability")
DISPOTRAINS = "https://dispotrains.membrives.fr/app/Elevator/{id}"
SOURCE = "Dispotrains (historique des états IDFM)"
_pool = ThreadPoolExecutor(max_workers=8)
_client = httpx.Client(timeout=httpx.Timeout(6, connect=4), headers={"User-Agent": "pmr-maps-hackathon"})


SERVICE_START_H, SERVICE_END_H = 6, 21  # lifts are often switched off at night: only daytime counts (estimate)
PARIS = ZoneInfo("Europe/Paris")
MIN_OUTAGE_S = 600


def _daytime_overlap_s(a: datetime, b: datetime) -> float:
    """Seconds of [a, b] that fall between SERVICE_START_H and SERVICE_END_H, Paris time."""
    a, b = a.astimezone(PARIS), b.astimezone(PARIS)
    total, day = 0.0, a.date()
    while day <= b.date():
        lo = datetime.combine(day, time(SERVICE_START_H), PARIS)
        hi = datetime.combine(day, time(SERVICE_END_H), PARIS)
        total += max(0.0, (min(b, hi) - max(a, lo)).total_seconds())
        day += timedelta(days=1)
    return total


def parse(data: dict, now: Optional[datetime] = None) -> Optional[dict]:
    """Share of daytime in service over the recorded window, or None when the archive has nothing.

    Dispotrains' own Total/Broken count the night shutdowns as failures, so they are not used.
    """
    states = sorted((s for s in data.get("States") or [] if s.get("begin") and s.get("end")),
                    key=lambda s: datetime.fromisoformat(s["begin"]), reverse=True)
    if not states:
        return None
    now = now or datetime.now(PARIS)
    start = min(datetime.fromisoformat(s["begin"]) for s in states)
    window = _daytime_overlap_s(start, now)
    if window <= 0:
        return None
    broken, outages = 0.0, 0
    for s in states:
        if s.get("state") != "Hors-service":
            continue
        end = now if s is states[0] else datetime.fromisoformat(s["end"])  # latest state: still out of order
        lost = _daytime_overlap_s(datetime.fromisoformat(s["begin"]), min(end, now))
        broken += lost
        outages += lost >= MIN_OUTAGE_S
    return {
        "availability": round(max(0.0, 1 - broken / window), 3),
        "window_days": round((now - start).total_seconds() / 86400, 1),
        "outages": outages,
        "source": SOURCE,
    }


def _fetch(private_id: str) -> Optional[dict]:
    def load():
        r = _client.get(DISPOTRAINS.format(id=quote(private_id, safe=":()_-")))
        r.raise_for_status()
        return parse(r.json())

    try:
        return cached(f"reliability:{private_id}", 6 * 3600, load)
    except Exception as e:  # the archive is a bonus: a failure must never break a journey
        log.warning("Dispotrains unavailable for %s: %s", private_id, e)
        return None


def for_lifts(rows: Iterable[dict]) -> Dict[str, dict]:
    """Reliability keyed by IDFM liftid, for the given lift rows (fetched in parallel)."""
    rows = [r for r in rows if r.get("privateelevatorid") and r.get("liftid")]
    results = _pool.map(lambda r: (r["liftid"], _fetch(r["privateelevatorid"])), rows)
    return {liftid: rel for liftid, rel in results if rel}


def load_fixture(path: Path) -> Dict[str, dict]:
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        return {}
