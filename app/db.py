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
        _ensure_schema(_conn)
    return _conn


_schema_done = False


def _ensure_schema(c) -> None:
    """Tables created on the first connection of each process: on Vercel the startup event is not guaranteed
    to run, and a fresh database (Neon) must work from the first request. schema.sql is idempotent."""
    global _schema_done
    if _schema_done:
        return
    try:
        sql = (Path(__file__).resolve().parent.parent / "sql" / "schema.sql").read_text()
        with c.cursor() as cur:
            cur.execute(sql)
        _schema_done = True
    except Exception:
        log.exception("schema check failed; the routes will report the database error")


def init_schema() -> None:
    if not enabled():
        log.info("DATABASE_URL not set: running without PostgreSQL")
        return
    conn()  # creates the tables on first connection (_ensure_schema)
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
