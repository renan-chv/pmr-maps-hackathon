-- Idempotent schema, run at startup when DATABASE_URL is set.

-- One row per observed state change of a lift (first poll stores the baseline).
CREATE TABLE IF NOT EXISTS lift_status_history (
    id                BIGSERIAL PRIMARY KEY,
    liftid            TEXT NOT NULL,
    zdcid             TEXT,
    zdcname           TEXT,
    status            TEXT,          -- available / notavailable / unknown
    reason            TEXT,          -- e.g. liftFailure
    source_updated_at TEXT,          -- liftstateupdate as published by IDFM
    fetched_at        TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS lift_status_history_lift_idx ON lift_status_history (liftid, fetched_at DESC);

-- Fictional demo user only (no real personal data).
CREATE TABLE IF NOT EXISTS user_profile (
    id            SERIAL PRIMARY KEY,
    display_name  TEXT NOT NULL,
    wheelchair    TEXT,              -- manual / electric
    width_cm      INT,
    max_steps     INT DEFAULT 0,
    is_demo       BOOLEAN DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS saved_trips (
    id          SERIAL PRIMARY KEY,
    user_id     INT REFERENCES user_profile(id),
    label       TEXT,
    from_label  TEXT, from_lon DOUBLE PRECISION, from_lat DOUBLE PRECISION,
    to_label    TEXT, to_lon DOUBLE PRECISION, to_lat DOUBLE PRECISION,
    zdcids      TEXT[],              -- stations the trip depends on
    is_demo     BOOLEAN DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS user_reports (
    id          SERIAL PRIMARY KEY,
    user_id     INT REFERENCES user_profile(id),
    target_type TEXT,                -- lift / place / works
    target_id   TEXT,
    message     TEXT,
    lon DOUBLE PRECISION, lat DOUBLE PRECISION,
    created_at  TIMESTAMPTZ DEFAULT now(),
    is_demo     BOOLEAN DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS agent_runs (
    id           BIGSERIAL PRIMARY KEY,
    created_at   TIMESTAMPTZ DEFAULT now(),
    config       TEXT,               -- baseline / no_freshness / full
    question     TEXT,
    tools_called JSONB,
    cited_rows   JSONB,
    answer       TEXT,
    verdict      TEXT,               -- oui / non / incertain
    confidence   REAL,
    latency_ms   INT,
    cost_usd     REAL,
    mode         TEXT DEFAULT 'live' -- live / recorded
);

-- Community reports (chantier B). The description stays in user_reports.message (read by the journey engine).
ALTER TABLE user_profile ADD COLUMN IF NOT EXISTS profile TEXT;
ALTER TABLE user_reports ADD COLUMN IF NOT EXISTS categorie TEXT;
ALTER TABLE user_reports ADD COLUMN IF NOT EXISTS temporaire BOOLEAN;
ALTER TABLE user_reports ADD COLUMN IF NOT EXISTS gravite TEXT;
ALTER TABLE user_reports ADD COLUMN IF NOT EXISTS confiance REAL;
ALTER TABLE user_reports ADD COLUMN IF NOT EXISTS confirmations INT DEFAULT 1;
ALTER TABLE user_reports ADD COLUMN IF NOT EXISTS photo_thumb TEXT;
CREATE INDEX IF NOT EXISTS user_reports_lonlat_idx ON user_reports (lon, lat);

-- Accounts (App Store guideline 5.1.1(v)): POST /api/users returns a secret token once; only its SHA-256 hash is
-- kept, and DELETE /api/users/{id} needs the token. Profiles created before this have no hash.
ALTER TABLE user_profile ADD COLUMN IF NOT EXISTS token_hash TEXT;
CREATE INDEX IF NOT EXISTS user_reports_user_idx ON user_reports (user_id);

-- Moderation (App Store guideline 1.2): one row per person flagging a report. A report flagged by 2 different
-- people is hidden from GET /api/reports and from the journey engine. client_key is "user:<id>" when the
-- flag came with that profile's token, else a salted hash of the IP ("ip:…"): one flag per person.
CREATE TABLE IF NOT EXISTS report_flags (
    id          BIGSERIAL PRIMARY KEY,
    report_id   INT NOT NULL REFERENCES user_reports(id) ON DELETE CASCADE,
    user_id     INT REFERENCES user_profile(id) ON DELETE SET NULL,
    client_key  TEXT NOT NULL,
    reason      TEXT,
    created_at  TIMESTAMPTZ DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS report_flags_once_idx ON report_flags (report_id, client_key);
CREATE INDEX IF NOT EXISTS report_flags_user_idx ON report_flags (user_id);

-- Server-side settings, e.g. the secret salt of the report author hashes (created on first use).
CREATE TABLE IF NOT EXISTS app_settings (
    key    TEXT PRIMARY KEY,
    value  TEXT NOT NULL
);
