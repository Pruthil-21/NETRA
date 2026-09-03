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
CREATE TABLE detections (
    id            SERIAL PRIMARY KEY,
    plate_number  TEXT NOT NULL,
    camera_id     INTEGER NOT NULL,
    detected_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    confidence    REAL
);

CREATE INDEX idx_detections_plate ON detections (plate_number);
CREATE INDEX idx_detections_camera ON detections (camera_id);
CREATE INDEX idx_detections_detected_at ON detections (detected_at);

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
