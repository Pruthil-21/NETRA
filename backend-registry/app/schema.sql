CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE cameras (
    id                  SERIAL PRIMARY KEY,
    name                TEXT NOT NULL,
    dept                TEXT NOT NULL,
    location            GEOGRAPHY(POINT, 4326) NOT NULL,
    camera_type         TEXT NOT NULL,
    ownership           TEXT NOT NULL,
    connectivity_status TEXT NOT NULL DEFAULT 'unknown',
    storage_type        TEXT NOT NULL,
    retention_days      INTEGER NOT NULL,
    health_status       TEXT NOT NULL DEFAULT 'unknown',
    rtsp_url            TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_cameras_location ON cameras USING GIST (location);

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
