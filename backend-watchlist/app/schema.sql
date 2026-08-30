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
