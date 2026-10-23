"""In-memory stand-in for the few SQL statements of the account and moderation routes.

Lets the route logic (status codes, tokens, flags, hiding, author hash) be tested without PostgreSQL.
The SQL itself is tested against a real database in tests/test_app_store.py when TEST_DATABASE_URL is set.
Any statement this fake does not know fails loudly, so a new query cannot silently pass.
"""
from datetime import datetime, timezone
from types import SimpleNamespace


class FakeDB:
    def __init__(self):
        self.users, self.reports, self.flags, self.settings = {}, {}, [], {}
        self._ids = {"u": 0, "r": 0}

    def _next(self, k):
        self._ids[k] += 1
        return self._ids[k]

    def cursor(self):
        return FakeCursor(self)

    def visible(self, hide_after):
        return [r for r in self.reports.values()
                if sum(f["report_id"] == r["id"] for f in self.flags) < hide_after]


class FakeCursor:
    def __init__(self, db):
        self.db, self._rows, self.description = db, [], None

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def fetchone(self):
        return self._rows[0] if self._rows else None

    def fetchall(self):
        return list(self._rows)

    def _result(self, rows, cols=None):
        self._rows = rows
        self.description = [SimpleNamespace(name=c) for c in cols] if cols else None

    def execute(self, sql, params=()):
        q, p, db = " ".join(sql.split()), list(params or ()), self.db
        if q.startswith("INSERT INTO user_profile"):
            uid = db._next("u")
            db.users[uid] = {"id": uid, "display_name": p[0], "profile": p[1], "token_hash": p[2]}
            return self._result([(uid,)])
        if q.startswith("SELECT token_hash FROM user_profile WHERE id"):
            u = db.users.get(p[0])
            return self._result([(u["token_hash"],)] if u else [])
        if q.startswith("SELECT 1 FROM user_profile WHERE id"):
            return self._result([(1,)] if p[0] in db.users else [])
        if q.startswith("INSERT INTO user_reports"):
            rid = db._next("r")
            keys = ("user_id", "target_type", "target_id", "message", "lon", "lat", "categorie", "temporaire",
                    "gravite", "confiance", "photo_thumb")
            db.reports[rid] = {"id": rid, **dict(zip(keys, p)), "is_demo": False, "confirmations": 1,
                               "created_at": datetime.now(timezone.utc)}
            return self._result([(rid,)])
        if q.startswith("DELETE FROM user_reports WHERE user_id"):
            gone = {i for i, r in db.reports.items() if r["user_id"] == p[0]}
            db.reports = {i: r for i, r in db.reports.items() if i not in gone}
            db.flags = [f for f in db.flags if f["report_id"] not in gone]  # ON DELETE CASCADE
            return self._result([])
        if q.startswith("DELETE FROM report_flags WHERE user_id"):
            db.flags = [f for f in db.flags if f["user_id"] != p[0]]
            return self._result([])
        if q.startswith("DELETE FROM saved_trips WHERE user_id"):
            return self._result([])
        if q.startswith("DELETE FROM user_profile WHERE id"):
            db.users.pop(p[0], None)
            return self._result([])
        if q.startswith("SELECT 1 FROM user_reports WHERE id"):
            return self._result([(1,)] if p[0] in db.reports else [])
        if q.startswith("INSERT INTO app_settings"):
            db.settings.setdefault("author_salt", p[0])
            return self._result([])
        if q.startswith("SELECT value FROM app_settings WHERE key = 'author_salt'"):
            return self._result([(db.settings["author_salt"],)])
        if q.startswith("INSERT INTO report_flags"):  # ON CONFLICT (report_id, client_key) DO NOTHING
            rid, uid, who, reason = p
            if not any(f["report_id"] == rid and f["client_key"] == who for f in db.flags):
                db.flags.append({"report_id": rid, "user_id": uid, "client_key": who, "reason": reason})
            return self._result([])
        if q.startswith("SELECT count(*) FROM report_flags WHERE report_id"):
            return self._result([(sum(f["report_id"] == p[0] for f in db.flags),)])
        if q.startswith("SELECT r.id, r.lon, r.lat, r.categorie, r.gravite"):  # GET /api/reports
            x1, x2, y1, y2, hide, limit = p
            assert "r.photo_thumb," not in q, "the map list must not carry the photos themselves"
            cols = ["id", "lon", "lat", "categorie", "gravite", "temporaire", "message", "created_at", "is_demo",
                    "confirmations", "has_photo", "user_id"]
            rows = [tuple((r["photo_thumb"] is not None) if c == "has_photo" else r[c] for c in cols) for r in db.visible(hide)
                    if x1 <= r["lon"] <= x2 and y1 <= r["lat"] <= y2][:limit]
            return self._result(rows, cols)
        if q.startswith("SELECT r.photo_thumb FROM user_reports r WHERE r.id"):  # GET /api/reports/{id}/thumb
            rid, hide = p
            r = next((x for x in db.visible(hide) if x["id"] == rid), None)
            return self._result([(r["photo_thumb"],)] if r else [])
        if q.startswith("SELECT r.id, r.lon, r.lat, r.categorie, r.temporaire"):  # main._reports
            hide = p[-1]
            box = p[:-1]
            cols = ["id", "lon", "lat", "categorie", "temporaire", "confirmations", "created_at", "target_type",
                    "target_id", "message"]
            rows = [tuple(r[c] for c in cols) for r in db.visible(hide)
                    if not box or (box[0] <= r["lon"] <= box[1] and box[2] <= r["lat"] <= box[3])]
            return self._result(rows, cols)
        raise AssertionError(f"FakeDB does not know this statement: {q[:120]}")


def install(monkeypatch, db_module):
    """Point app.db at a fresh FakeDB; returns it."""
    fake = FakeDB()
    monkeypatch.setattr(db_module, "DATABASE_URL", "fake://")
    monkeypatch.setattr(db_module, "conn", lambda: fake)
    return fake
