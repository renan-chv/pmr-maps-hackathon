"""Optional PostgreSQL layer. Everything works without DATABASE_URL (in-memory only)."""
from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import List, Tuple

log = logging.getLogger("db")
DATABASE_URL = os.getenv("DATABASE_URL")
_conn = None


def enabled() -> bool:
    return bool(DATABASE_URL)


def conn():
    global _conn
    if not enabled():
        return None
    if _conn is None or _conn.closed:
        import psycopg
        _conn = psycopg.connect(DATABASE_URL, autocommit=True)
    return _conn


def init_schema() -> None:
    if not enabled():
        log.info("DATABASE_URL not set: running without PostgreSQL")
        return
    sql = (Path(__file__).resolve().parent.parent / "sql" / "schema.sql").read_text()
    with conn().cursor() as cur:
        cur.execute(sql)
    log.info("schema ready")


def save_lift_history(rows: List[Tuple[dict, str]]) -> None:
    if not enabled() or not rows:
        return
    with conn().cursor() as cur:
        cur.executemany(
            """INSERT INTO lift_status_history
               (liftid, zdcid, zdcname, status, reason, source_updated_at, fetched_at)
               VALUES (%s, %s, %s, %s, %s, %s, %s)""",
            [
                (r["liftid"], r.get("zdcid"), r.get("zdcname"), r.get("liftstatus"),
                 r.get("liftreason"), r.get("liftstateupdate"), fetched_at)
                for r, fetched_at in rows
            ],
        )
