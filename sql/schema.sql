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

-- Restaurants and shops, last known version per source row (see app/places.py).
CREATE TABLE IF NOT EXISTS places (
    source            TEXT NOT NULL,   -- provider key
    source_id         TEXT NOT NULL,
    name              TEXT,
    category          TEXT,            -- restaurant / cafe / food_shop / shop / other
    lon DOUBLE PRECISION, lat DOUBLE PRECISION,
    address           TEXT,
    access            JSONB,           -- level, step_free, steps, ramp, door_width_cm, toilets, parking, notes
    url               TEXT,
    source_updated_at TEXT,            -- date of the accessibility info at the source
    fetched_at        TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (source, source_id)
);
CREATE INDEX IF NOT EXISTS places_geo_idx ON places (lat, lon);

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
