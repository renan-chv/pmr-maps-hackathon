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
