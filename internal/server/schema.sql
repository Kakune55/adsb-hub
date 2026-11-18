CREATE TABLE IF NOT EXISTS receivers (
    id text PRIMARY KEY,
    name text NOT NULL
);

CREATE TABLE IF NOT EXISTS receiver_status (
    receiver_id text NOT NULL REFERENCES receivers(id),
    event_id text NOT NULL,
    source text NOT NULL CHECK (source IN ('receiver', 'stats', 'status')),
    sampled_at timestamptz NOT NULL,
    collected_at timestamptz NOT NULL,
    lat double precision,
    lon double precision,
    gain_db double precision,
    signal_dbfs double precision,
    noise_dbfs double precision,
    messages_per_second double precision,
    uptime_seconds double precision,
    aircraft_with_pos integer,
    aircraft_without_pos integer,
    bad_tuner boolean,
    raw jsonb,
    ingested_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (receiver_id, event_id)
);
CREATE INDEX IF NOT EXISTS receiver_status_latest_idx
    ON receiver_status (receiver_id, source, sampled_at DESC, collected_at DESC, event_id DESC);

CREATE TABLE IF NOT EXISTS position_points (
    receiver_id text NOT NULL REFERENCES receivers(id),
    event_id text NOT NULL,
    hex text NOT NULL,
    flight text,
    lat double precision NOT NULL,
    lon double precision NOT NULL,
    alt_baro integer,
    on_ground boolean,
    gs double precision,
    track double precision,
    position_at timestamptz NOT NULL,
    position_at_approximate boolean NOT NULL,
    ingested_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (receiver_id, event_id)
);
CREATE INDEX IF NOT EXISTS position_points_track_idx
    ON position_points (receiver_id, hex, position_at);
CREATE INDEX IF NOT EXISTS position_points_live_idx
    ON position_points (position_at);
