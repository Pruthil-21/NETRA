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
    -- Playback identity, decoupled from `id` on purpose: `id` is this registry's
    -- own SERIAL and isn't guaranteed to match the id a camera is known by on
    -- whatever MediaMTX/stream source publishes it (e.g. the event organizer's
    -- own camera ids, or a standalone test rig on a separate tunnel).
    -- stream_id resolves to `{MEDIAMTX_HLS_URL}/stream/{stream_id}/index.m3u8`;
    -- hls_url is a fully-qualified playlist URL for a camera on a different
    -- MediaMTX instance/tunnel, and takes priority over stream_id when both are set.
    stream_id           TEXT,
    hls_url             TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_cameras_location ON cameras USING GIST (location);

-- Mirrors backend-watchlist's alert_status_history: append-only, one row per
-- real connectivity transition. Written by cameras_service.update_camera()
-- only when the new status differs from the current one -- repeated PUTs
-- reporting the same status (e.g. a health-check poll that found nothing
-- changed) write nothing here.
CREATE TABLE IF NOT EXISTS camera_status_history (
    id                  SERIAL PRIMARY KEY,
    camera_id           INTEGER NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
    connectivity_status TEXT NOT NULL,
    changed_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_camera_status_history_camera ON camera_status_history (camera_id, changed_at);

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
