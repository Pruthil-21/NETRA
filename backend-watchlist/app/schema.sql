CREATE TABLE watchlist (
    id            SERIAL PRIMARY KEY,
    plate_number  TEXT NOT NULL,
    reason        TEXT NOT NULL,
    dept_flagged  TEXT NOT NULL,
    priority      TEXT NOT NULL DEFAULT 'medium',
    date_added    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Every ANPR plate read, independent of watchlist status — required for
-- "where has this plate been seen" search regardless of match. Insert-only,
-- same evidentiary reasoning as alerts.
--
-- scenario_run_id / source support scripted/replayed detection sources (e.g.
-- the prerecorded vehicle-trace demo clip) alongside live ml-anpr detections:
-- both are NULL for normal live traffic, which is unaffected by either column
-- or by the dedup index below.
CREATE TABLE detections (
    id               SERIAL PRIMARY KEY,
    plate_number     TEXT NOT NULL,
    camera_id        INTEGER NOT NULL,
    detected_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    confidence       REAL,
    scenario_run_id  TEXT,
    source           TEXT
);

CREATE INDEX idx_detections_plate ON detections (plate_number);
CREATE INDEX idx_detections_camera ON detections (camera_id);
CREATE INDEX idx_detections_detected_at ON detections (detected_at);
CREATE INDEX idx_detections_scenario_run ON detections (scenario_run_id);

-- One confirmed sighting per camera per scenario run — suppresses repeats
-- from a looping replay clip without deleting or updating anything (a repeat
-- POST for the same run/camera/plate is a no-op, not a new row). Only
-- applies to scripted runs (scenario_run_id IS NOT NULL); live ml-anpr
-- detections (scenario_run_id NULL) are never deduped by this index.
CREATE UNIQUE INDEX IF NOT EXISTS idx_detections_scenario_dedup
    ON detections (scenario_run_id, camera_id, plate_number)
    WHERE scenario_run_id IS NOT NULL;

CREATE TABLE alerts (
    id            SERIAL PRIMARY KEY,
    camera_id     INTEGER NOT NULL,
    plate_number  TEXT NOT NULL,
    watchlist_id  INTEGER REFERENCES watchlist(id),
    detection_id  INTEGER REFERENCES detections(id),
    matched_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    status        TEXT NOT NULL DEFAULT 'NEW'
);

CREATE INDEX idx_watchlist_plate ON watchlist (plate_number);
CREATE INDEX idx_alerts_plate ON alerts (plate_number);
CREATE INDEX idx_alerts_status ON alerts (status);

-- alerts.status is set once at INSERT and never UPDATEd again — the append-only
-- guarantee for evidentiary chain-of-custody. Every later transition is a new
-- row here; callers read the current status via a join on the latest row.
CREATE TABLE alert_status_history (
    id          SERIAL PRIMARY KEY,
    alert_id    INTEGER NOT NULL REFERENCES alerts(id),
    status      TEXT NOT NULL,
    changed_by  TEXT,
    changed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_alert_status_history_alert ON alert_status_history (alert_id);

-- Shared across backend-registry and backend-watchlist (same Postgres instance).
-- Declared identically, behind IF NOT EXISTS, in both services' schema.sql so
-- either one can run first with zero cross-folder migration coordination.
-- Insert/select only — never updated or deleted.
CREATE TABLE IF NOT EXISTS audit_logs (
    id            SERIAL PRIMARY KEY,
    user_id       TEXT,
    action        TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id   INTEGER,
    timestamp     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_resource ON audit_logs (resource_type, resource_id);

ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS badge_number TEXT;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS reason_code TEXT;

-- Client-supplied idempotency key: a live ml-anpr detection that times out
-- and gets retried is the same real-world event twice, not two sightings.
-- Additive only -- older callers that omit event_id are completely
-- unaffected (NULL, no dedup), exactly like the scenario_run_id dedup below.
ALTER TABLE detections ADD COLUMN IF NOT EXISTS event_id UUID;

-- One row per event_id -- a repeat POST with the same event_id (a client
-- retry after a timeout, not knowing whether the first attempt landed) is a
-- no-op that returns the already-recorded detection instead of inserting a
-- duplicate. Independent of, and takes priority over, the scenario_run_id
-- dedup above -- the two are for different source types and a caller sends
-- at most one of them in practice.
CREATE UNIQUE INDEX IF NOT EXISTS idx_detections_event_id_dedup
    ON detections (event_id)
    WHERE event_id IS NOT NULL;

-- Supports the density-map query (time-range filter + GROUP BY camera_id):
-- leading on detected_at lets the range scan happen first, with camera_id
-- covering the grouping without a separate heap lookup per row. At the
-- 100k+ camera scale this deployment is headed toward, that matters far
-- more than it would at demo scale.
CREATE INDEX IF NOT EXISTS idx_detections_detected_at_camera
    ON detections (detected_at, camera_id);

-- Derived, non-evidentiary daily rollup of detections, for cross-camera
-- "where was this plate seen today" queries -- NOT a replacement for the
-- insert-only detections table above, which remains the evidentiary
-- record. One row per camera_id + plate_number + IST calendar day;
-- detection_times accumulates every sighting's exact timestamp, no
-- cooldown or de-duplication (ml-anpr's own tracker already suppresses
-- same-camera re-sends within 45s upstream).
CREATE TABLE vehicle_daily_sightings (
    id              BIGSERIAL PRIMARY KEY,
    camera_id       INTEGER NOT NULL,
    plate_number    TEXT NOT NULL,
    sighting_date   DATE NOT NULL,
    detection_times TIMESTAMPTZ[] NOT NULL DEFAULT '{}',
    UNIQUE (camera_id, plate_number, sighting_date)
);

CREATE INDEX idx_vehicle_daily_sightings_plate
    ON vehicle_daily_sightings (plate_number, sighting_date);

-- Congestion alerts (traffic-analysis Phase 3) -- a density/flow threshold
-- breach, not a plate match, so this is deliberately its own table rather
-- than forced into `alerts` above (which is keyed to watchlist_id/
-- detection_id and carries a 1:1 plate-hit chain-of-custody model this
-- doesn't need). A single `status` column with acknowledged_by/at is
-- enough here -- no separate append-only history table, since the
-- separation-of-duty workflow `alert_status_history` exists for doesn't
-- apply to a density/corridor reading.
--
-- Exactly one of camera_id (a density breach) or
-- from_camera_id/to_camera_id (a flow/corridor breach) is set, matching
-- which of camera_density_counts/camera_flow_pairs produced the reading --
-- see traffic_alerts_service.evaluate_and_broadcast.
CREATE TABLE IF NOT EXISTS traffic_alerts (
    id               SERIAL PRIMARY KEY,
    alert_type       TEXT NOT NULL CHECK (alert_type IN ('density', 'flow')),
    camera_id        INTEGER,
    from_camera_id   INTEGER,
    to_camera_id     INTEGER,
    metric_value     REAL NOT NULL,
    threshold_value  REAL NOT NULL,
    district         TEXT,
    status           TEXT NOT NULL DEFAULT 'NEW' CHECK (status IN ('NEW', 'ACKNOWLEDGED', 'DISMISSED')),
    triggered_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    acknowledged_by  TEXT,
    acknowledged_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_traffic_alerts_status ON traffic_alerts (status);
CREATE INDEX IF NOT EXISTS idx_traffic_alerts_district ON traffic_alerts (district);
-- The evaluation loop's cooldown check (skip re-firing for a camera/corridor
-- that already has an unresolved alert) filters on these plus status/type,
-- run every 5 minutes -- worth a real index rather than a sequential scan.
CREATE INDEX IF NOT EXISTS idx_traffic_alerts_camera_open
    ON traffic_alerts (camera_id, alert_type, status);
CREATE INDEX IF NOT EXISTS idx_traffic_alerts_corridor_open
    ON traffic_alerts (from_camera_id, to_camera_id, alert_type, status);

-- Road-following path for a Flow-layer corridor between two cameras (see
-- route_geometry_service.py) -- without this the Map page drew a straight
-- line between two lat/longs, which cuts through buildings/parks/water
-- with no regard for the actual road network. Computed via OSRM at most
-- ONCE per camera pair, ever, and cached here permanently: two fixed
-- points' shortest road path doesn't change over this project's lifetime,
-- so this table is what keeps real call volume against OSRM's public demo
-- server (rate-limited, best-effort) far under its 1 req/sec policy
-- regardless of how many officers view the layer.
CREATE TABLE IF NOT EXISTS flow_route_cache (
    from_camera_id   INTEGER NOT NULL,
    to_camera_id     INTEGER NOT NULL,
    geometry         JSONB NOT NULL,
    distance_meters  REAL,
    duration_seconds REAL,
    computed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (from_camera_id, to_camera_id)
);
