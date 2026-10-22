"""Polls the lift status every POLL_SECONDS, keeps history and detects state changes.

Without DATABASE_URL, history lives in memory (lost on restart).
With DATABASE_URL, every change is written to lift_status_history.
"""
from __future__ import annotations

import asyncio
import logging
import os
from collections import deque
from typing import Deque, Dict, Optional

from . import db, sources

log = logging.getLogger("poller")
POLL_SECONDS = int(os.getenv("POLL_SECONDS", "900"))

_last: Dict[str, dict] = {}
alerts: Deque[dict] = deque(maxlen=200)
state = {"last_poll": None, "polls": 0, "last_error": None}


def _key_fields(row: dict) -> tuple:
    return (row.get("liftstatus"), row.get("liftreason"))


def poll_once() -> int:
    data = sources.lifts(force=True)
    fetched_at = data["fetched_at"]
    first_run = not _last
    changes = 0
    history_rows = []
    for row in data["rows"]:
        lid = row["liftid"]
        prev = _last.get(lid)
        if prev is None or _key_fields(prev) != _key_fields(row):
            history_rows.append((row, fetched_at))
            if prev is not None:
                changes += 1
                alerts.appendleft({
                    "detected_at": fetched_at,
                    "liftid": lid,
                    "zdcid": row.get("zdcid"),
                    "station": row.get("zdcname"),
                    "situation": row.get("liftsituation"),
                    "from": prev.get("liftstatus"),
                    "to": row.get("liftstatus"),
                    "reason": row.get("liftreason"),
                    "source_update": row.get("liftstateupdate"),
                    "lon": (row.get("centroidzdc") or {}).get("lon"),
                    "lat": (row.get("centroidzdc") or {}).get("lat"),
                })
        _last[lid] = row
    db.save_lift_history(history_rows)
    state["last_poll"] = fetched_at
    state["polls"] += 1
    state["last_error"] = None
    log.info("poll ok: %d lifts, %d changes (first_run=%s)", len(data["rows"]), changes, first_run)
    return changes


async def run_forever() -> None:
    while True:
        try:
            await asyncio.to_thread(poll_once)
        except Exception as e:  # keep polling even if one call fails
            state["last_error"] = str(e)
            log.exception("poll failed")
        await asyncio.sleep(POLL_SECONDS)


def previous(liftid: str) -> Optional[dict]:
    return _last.get(liftid)
