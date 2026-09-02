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

-- RBAC: Role (function) x Jurisdiction (scope).
-- 5 of the proposed 13 functional roles, enough to demonstrate hierarchy +
-- scoping + separation-of-duty + audit logging. hierarchy_level is for
-- display/scope-inheritance only -- permissions are an explicit per-role
-- set below, never auto-inherited from level (deliberate: a senior role
-- doesn't automatically get a junior role's day-to-day operational screens).
CREATE TABLE IF NOT EXISTS roles (
    id                 SERIAL PRIMARY KEY,
    name               TEXT NOT NULL UNIQUE,
    display_name       TEXT NOT NULL,
    hierarchy_level    INTEGER,
    can_delegate_admin BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS role_permissions (
    role_id    INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    permission TEXT NOT NULL,
    PRIMARY KEY (role_id, permission)
);

CREATE TABLE IF NOT EXISTS officers (
    id            SERIAL PRIMARY KEY,
    badge_number  TEXT NOT NULL UNIQUE,
    name          TEXT NOT NULL,
    rank          TEXT,
    password_hash TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The headline feature (spec Section 6): permissions attach to a Posting,
-- not an Officer. Reassigning a transferred officer means ending their old
-- posting and inserting a new one -- never editing permissions in place.
-- scope_value matches cameras.dept for scope_type='district'; NULL for
-- scope_type='platform' (state/platform-wide roles see everything).
CREATE TABLE IF NOT EXISTS postings (
    id           SERIAL PRIMARY KEY,
    officer_id   INTEGER NOT NULL REFERENCES officers(id) ON DELETE CASCADE,
    role_id      INTEGER NOT NULL REFERENCES roles(id),
    scope_type   TEXT NOT NULL CHECK (scope_type IN ('platform', 'district')),
    scope_value  TEXT,
    is_active    BOOLEAN NOT NULL DEFAULT true,
    assigned_by  TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at     TIMESTAMPTZ
);

-- One active posting per officer at a time -- this demo's simplification of
-- NIST Core RBAC's "activate one role per session" (see plan Architecture).
CREATE UNIQUE INDEX IF NOT EXISTS idx_postings_one_active_per_officer
    ON postings (officer_id) WHERE is_active;

CREATE INDEX IF NOT EXISTS idx_postings_officer ON postings (officer_id);

ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS badge_number TEXT;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS reason_code TEXT;
