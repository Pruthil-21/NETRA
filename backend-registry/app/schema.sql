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

-- Scale demo: edge nodes + synthetic-camera flag + an isolated detection-events
-- table for load-testing ingestion throughput. Additive only -- every
-- existing cameras row gets is_synthetic=false via the DEFAULT below, and
-- GET /cameras' existing behavior (no pagination/include_synthetic params)
-- is unchanged by anything in this file.
CREATE TABLE IF NOT EXISTS edge_nodes (
    id            SERIAL PRIMARY KEY,
    name          TEXT NOT NULL,
    district      TEXT NOT NULL,
    is_synthetic  BOOLEAN NOT NULL DEFAULT false,
    -- Tags which seed_synthetic_scale.py invocation created this row --
    -- what makes the seed script's own reset-before-insert idempotent, and
    -- lets a specific run's rows be identified/cleaned independently of any
    -- other synthetic data that happens to exist.
    scale_run_id  UUID,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_edge_nodes_district ON edge_nodes (district);
CREATE INDEX IF NOT EXISTS idx_edge_nodes_scale_run ON edge_nodes (scale_run_id);

ALTER TABLE cameras ADD COLUMN IF NOT EXISTS is_synthetic BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE cameras ADD COLUMN IF NOT EXISTS edge_node_id INTEGER REFERENCES edge_nodes(id);
ALTER TABLE cameras ADD COLUMN IF NOT EXISTS scale_run_id UUID;
CREATE INDEX IF NOT EXISTS idx_cameras_scale_run ON cameras (scale_run_id);

-- Requirement: indexes on camera id (already the PK), edge node, district,
-- connectivity status, and health status. The composite (is_synthetic, id)
-- index is what makes cursor pagination over "just the synthetic set" fast
-- at 80,000 rows -- WHERE is_synthetic = true AND id > $cursor ORDER BY id.
CREATE INDEX IF NOT EXISTS idx_cameras_edge_node ON cameras (edge_node_id);
CREATE INDEX IF NOT EXISTS idx_cameras_dept ON cameras (dept);
CREATE INDEX IF NOT EXISTS idx_cameras_connectivity_status ON cameras (connectivity_status);
CREATE INDEX IF NOT EXISTS idx_cameras_health_status ON cameras (health_status);
CREATE INDEX IF NOT EXISTS idx_cameras_synthetic_id ON cameras (is_synthetic, id);

-- A fully separate table from backend-watchlist's real `detections` --
-- deliberately not shared, so a synthetic load-test event can never collide
-- with a real watchlist plate and fire a fake alert. Purely for proving the
-- ingestion path (async accept + idempotent) scales; carries no alert-matching
-- logic and calls into no other service. event_id UNIQUE is the idempotency
-- guarantee: a retried POST with the same event_id is a no-op, not a new row.
-- (A single UNIQUE index on event_id alone -- not partitioned by time --
-- because PostgreSQL requires a partitioned table's unique index to include
-- the partition key, which would only give per-partition idempotency; time
-- management here is a separate archive table instead, moved into by a
-- maintenance script, not native partitioning.)
CREATE TABLE IF NOT EXISTS synthetic_detection_events (
    id           BIGSERIAL PRIMARY KEY,
    event_id     UUID NOT NULL UNIQUE,
    camera_id    INTEGER NOT NULL,
    edge_node_id INTEGER,
    payload      JSONB,
    received_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_synthetic_events_received_at ON synthetic_detection_events (received_at);
CREATE INDEX IF NOT EXISTS idx_synthetic_events_camera ON synthetic_detection_events (camera_id);

CREATE TABLE IF NOT EXISTS synthetic_detection_events_archive (
    LIKE synthetic_detection_events INCLUDING ALL
);

-- Admin-managed checkpoints/junctions that should have camera coverage --
-- compared against real cameras in gap_analysis_service.compute_uncovered_zones.
-- Same GEOGRAPHY type as cameras.location so both sides of a distance query
-- are directly comparable.
CREATE TABLE IF NOT EXISTS coverage_targets (
    id         SERIAL PRIMARY KEY,
    name       TEXT NOT NULL,
    location   GEOGRAPHY(POINT, 4326) NOT NULL,
    district   TEXT NOT NULL,
    priority   TEXT NOT NULL DEFAULT 'medium',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_coverage_targets_location ON coverage_targets USING GIST (location);

-- Admin-managed police station locations, shown as map pins and used for
-- nearest-station alert enrichment (see backend-watchlist's alerts_service).
CREATE TABLE IF NOT EXISTS police_stations (
    id         SERIAL PRIMARY KEY,
    name       TEXT NOT NULL,
    location   GEOGRAPHY(POINT, 4326) NOT NULL,
    district   TEXT NOT NULL,
    contact    TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_police_stations_location ON police_stations USING GIST (location);
