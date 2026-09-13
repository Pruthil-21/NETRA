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

-- Backs cameras_service.get_camera_by_stream_id -- looked up on every
-- inbound recording-health webhook event (see recording_webhooks.py). At
-- 100k+ cameras this runs far more often than any admin-facing query on
-- this table, so it needs its own index rather than relying on the primary
-- key; partial (stream_id IS NOT NULL) since manually-added cameras with no
-- stream mapping are never looked up this way and would otherwise bloat it
-- for nothing.
CREATE INDEX IF NOT EXISTS idx_cameras_stream_id ON cameras (stream_id) WHERE stream_id IS NOT NULL;

CREATE TABLE areas (
    id          SERIAL PRIMARY KEY,
    name        TEXT NOT NULL,
    district    TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (district, name)
);

ALTER TABLE cameras ADD COLUMN area_id INTEGER REFERENCES areas(id);

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

-- Self-service profile photo -- a URL, not an upload: this codebase has no
-- file-storage/upload pipeline anywhere (camera rtsp_url/hls_url are also
-- plain URL strings), so an officer sets/pastes a URL rather than the app
-- hosting the image itself.
ALTER TABLE officers ADD COLUMN IF NOT EXISTS photo_url TEXT;

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

-- Dynamic RBAC (v2 spec, Phase A): roles/duties become admin-manageable data
-- instead of a fixed 5-row seed. parent_role_id lets a new role inherit an
-- existing one's duties as a starting point (Section 2.2); is_system flags
-- the 5 originally-seeded roles so they're never hard-deletable, only
-- editable/deactivatable (protects the demo baseline); is_active supports
-- "deactivate, don't delete" for a role still held by anyone.
ALTER TABLE roles ADD COLUMN IF NOT EXISTS parent_role_id INTEGER REFERENCES roles(id);
ALTER TABLE roles ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE roles ADD COLUMN IF NOT EXISTS is_system BOOLEAN NOT NULL DEFAULT false;

-- A duty bundles permissions into one named, reusable unit (D365's "assign
-- only duties to roles" guidance -- Section 2.1). DIGDHRISHTI has no separate
-- Privilege layer, so a duty's permissions are plain VALID_PERMISSIONS
-- strings, validated in rbac_service, not a DB-level FK/CHECK.
CREATE TABLE IF NOT EXISTS duties (
    id           SERIAL PRIMARY KEY,
    name         TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    description  TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS duty_permissions (
    duty_id    INTEGER NOT NULL REFERENCES duties(id) ON DELETE CASCADE,
    permission TEXT NOT NULL,
    PRIMARY KEY (duty_id, permission)
);

-- A role's primary composition path -- role_permissions (existing table)
-- stays for the rare "assign a permission directly to a role" edge case,
-- mirroring D365 allowing (but discouraging) direct privilege assignment.
-- A role's effective permission set is the union of both.
CREATE TABLE IF NOT EXISTS role_duties (
    role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    duty_id INTEGER NOT NULL REFERENCES duties(id) ON DELETE CASCADE,
    PRIMARY KEY (role_id, duty_id)
);

-- Multi-role support (Section 3.3): an officer can hold several
-- simultaneously-active postings ("Station Officer at Station A *and*
-- Traffic Officer for a highway corridor"), matching D365's "sum total
-- access" rule. Removes the one-active-posting-per-officer constraint the
-- original plan's own Self-Review flagged as a gap. expires_at supports
-- genuinely temporary duty attachments that auto-expire.
DROP INDEX IF EXISTS idx_postings_one_active_per_officer;
ALTER TABLE postings ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

-- People lifecycle (v2 spec, Phase B). status matches D365's "no role, no
-- privileges" rule: a freshly-registered officer is 'pending' with zero
-- postings, not absent -- they can log in and see an empty shell, not an
-- error. last_login_at is a persisted mirror of what auth_service.get_last_login
-- already derives from audit_logs (kept for the admin profile endpoint's
-- convenience -- a single indexed column instead of a MAX() scan);
-- failed_login_count/locked_until back the account-lockout policy below.
ALTER TABLE officers ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'pending', 'suspended', 'deactivated'));
ALTER TABLE officers ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;
ALTER TABLE officers ADD COLUMN IF NOT EXISTS failed_login_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE officers ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ;

-- One row per public self-registration submission (spec Section 3.2).
-- officer_id is set at submission time (the officer row itself is created
-- immediately, status='pending') -- this table is the admin-facing queue
-- and review trail, not the source of truth for the account itself.
-- Designed to extend to "request additional access" later (a logged-in
-- officer requesting a second role) without a schema change: that request
-- would just be another row here, with officer_id pointing at an existing,
-- already-active officer instead of a brand-new one.
CREATE TABLE IF NOT EXISTS registration_requests (
    id               SERIAL PRIMARY KEY,
    officer_id       INTEGER NOT NULL REFERENCES officers(id) ON DELETE CASCADE,
    department       TEXT,
    contact_info     TEXT,
    status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    reviewed_by      TEXT,
    reviewed_at      TIMESTAMPTZ,
    rejection_reason TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_registration_requests_status ON registration_requests (status, created_at);

-- Backs force-logout (spec Section 3.6): JWTs are stateless by default, so
-- revoking one before its natural expiry needs a server-side record to
-- check against. id is generated in application code (uuid.uuid4()), not a
-- DB default -- same pattern synthetic_detection_events.event_id already
-- uses for a caller-supplied UUID. A session with no matching row (every
-- token issued before this feature existed) is treated as never-revoked --
-- see auth.get_current_user.
CREATE TABLE IF NOT EXISTS sessions (
    id           UUID PRIMARY KEY,
    officer_id   INTEGER NOT NULL REFERENCES officers(id) ON DELETE CASCADE,
    issued_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked      BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS idx_sessions_officer ON sessions (officer_id);

-- Admin power tools (v2 spec, Phase C). Generic import/export engine
-- (Section 3.7): one job row per staged/executed CSV/XLSX/JSON transfer,
-- covering any entity_type -- never a one-off table per importer. Staging
-- (validate every row before committing anything) is why this carries its
-- own per-row result payload rather than writing straight into the target
-- table; "re-submit only the failed rows" reads failed_rows_payload back
-- out rather than requiring the whole original file again.
CREATE TABLE IF NOT EXISTS import_export_jobs (
    id                   SERIAL PRIMARY KEY,
    entity_type          TEXT NOT NULL,
    direction            TEXT NOT NULL CHECK (direction IN ('import', 'export')),
    format               TEXT NOT NULL CHECK (format IN ('csv', 'json')),
    status               TEXT NOT NULL DEFAULT 'staged'
        CHECK (status IN ('staged', 'committed', 'failed')),
    total_rows           INTEGER NOT NULL DEFAULT 0,
    success_rows         INTEGER NOT NULL DEFAULT 0,
    failed_rows          INTEGER NOT NULL DEFAULT 0,
    row_results          JSONB,
    failed_rows_payload  JSONB,
    run_by               TEXT,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_import_export_jobs_entity ON import_export_jobs (entity_type, created_at);

-- Minimal in-app notification log (v2 spec, Phase D): role granted/revoked,
-- registration approved/rejected, an SoD conflict blocked an assignment.
-- Not email/SMS -- just what makes the approval queue and audit log feel
-- like one connected system instead of two disconnected features.
CREATE TABLE IF NOT EXISTS notifications (
    id         SERIAL PRIMARY KEY,
    officer_id INTEGER NOT NULL REFERENCES officers(id) ON DELETE CASCADE,
    type       TEXT NOT NULL,
    message    TEXT NOT NULL,
    read       BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notifications_officer ON notifications (officer_id, created_at DESC);

-- Draft/Publish for role edits (v2 spec, Phase D, Section 2.4/3.1): a
-- staged change to a role's duty/permission composition that doesn't take
-- effect until explicitly published, so a half-finished edit never breaks
-- live access for everyone currently holding that role. One pending draft
-- per role -- a second PUT replaces the first, it never stacks. Posting
-- assignment (Task 4) stays immediate/unstaged; this only ever applies to
-- editing a role's *definition*.
CREATE TABLE IF NOT EXISTS role_drafts (
    role_id           INTEGER PRIMARY KEY REFERENCES roles(id) ON DELETE CASCADE,
    draft_duty_ids    JSONB NOT NULL DEFAULT '[]',
    draft_permissions JSONB NOT NULL DEFAULT '[]',
    created_by        TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Self-service email 2FA / password reset. Mandatory from registration
-- onward (see RegisterRequest.email) -- every new officer verifies an
-- email via OTP before their account activates. An officer seeded before
-- this feature existed can still have NULL here; nothing besides 2FA and
-- self-service reset depends on it.
ALTER TABLE officers ADD COLUMN IF NOT EXISTS email TEXT;

-- Mandatory from registration onward (see RegisterRequest.contact_info) --
-- previously only ever landed in registration_requests.contact_info (a
-- workflow table for the admin-approval fast track), never copied onto
-- the officer's own permanent record, so it was never actually retrievable
-- once registration finished -- not stored, and so never displayable on
-- the profile page either. An officer seeded before this existed can still
-- have NULL here.
ALTER TABLE officers ADD COLUMN IF NOT EXISTS contact_info TEXT;

-- One row per OTP ever issued (never updated in place except to mark it
-- consumed) -- purpose distinguishes a login code from a password-reset
-- code so one can never be replayed as the other. code_hash, never the raw
-- code, same reasoning as officers.password_hash.
CREATE TABLE IF NOT EXISTS email_otps (
    id            SERIAL PRIMARY KEY,
    officer_id    INTEGER NOT NULL REFERENCES officers(id) ON DELETE CASCADE,
    purpose       TEXT NOT NULL CHECK (purpose IN ('login_2fa', 'password_reset', 'email_verification')),
    code_hash     TEXT NOT NULL,
    expires_at    TIMESTAMPTZ NOT NULL,
    consumed_at   TIMESTAMPTZ,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_otps_officer_purpose ON email_otps (officer_id, purpose, created_at DESC);

-- "Remember this device" for login 2FA: a long random token (device_token_hash
-- stores only its hash, same reasoning as the OTP code above) a trusted
-- browser presents on a future login to skip the OTP step entirely. Deleting
-- a row (or letting it expire) is the only way to revoke it -- there's no
-- separate "logged in" state to track here, unlike sessions.
CREATE TABLE IF NOT EXISTS trusted_devices (
    id                SERIAL PRIMARY KEY,
    officer_id        INTEGER NOT NULL REFERENCES officers(id) ON DELETE CASCADE,
    device_token_hash TEXT NOT NULL UNIQUE,
    expires_at        TIMESTAMPTZ NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_trusted_devices_officer ON trusted_devices (officer_id);

-- Inbound recording-health events from the DIGDHRISHTI continuous-recording
-- service (streaming/recording -- Dhruv's project; see
-- app/routers/recording_webhooks.py and recordings_service.py's module
-- docstring for the outbound half of this integration). event_id UNIQUE is
-- the idempotency guarantee it explicitly asked for: it retries failed
-- deliveries, so a retried event_id must be a no-op, not a duplicate row --
-- same pattern synthetic_detection_events.event_id already uses. stream_id
-- is the recording service's own camera path (matches cameras.stream_id),
-- not the registry's numeric camera id, since the recorder only knows the
-- path it's ingesting from.
CREATE TABLE IF NOT EXISTS recording_health_events (
    id          BIGSERIAL PRIMARY KEY,
    event_id    TEXT NOT NULL UNIQUE,
    stream_id   TEXT NOT NULL,
    status      TEXT NOT NULL,
    message     TEXT,
    occurred_at TIMESTAMPTZ,
    payload     JSONB,
    received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_recording_health_events_received_at ON recording_health_events (received_at);
CREATE INDEX IF NOT EXISTS idx_recording_health_events_stream ON recording_health_events (stream_id);

-- Data Console (registry-side import/export, phase 1): the filter payload
-- a job's export was run with, kept alongside its row_results so the job
-- history panel can show *what* was exported, not just how many rows.
ALTER TABLE import_export_jobs ADD COLUMN IF NOT EXISTS filters JSONB;

-- Widen the format check to admit XLSX (real serialization added this
-- phase -- previously 'format' was a label only, every job stored JSON
-- regardless of what was requested). Dropped and recreated by its
-- Postgres-assigned default name rather than IF NOT EXISTS, which CHECK
-- constraints don't support for an in-place modification.
ALTER TABLE import_export_jobs DROP CONSTRAINT IF EXISTS import_export_jobs_format_check;
ALTER TABLE import_export_jobs ADD CONSTRAINT import_export_jobs_format_check
    CHECK (format IN ('csv', 'json', 'xlsx'));

-- Web Push subscriptions -- shared across backend-registry and
-- backend-watchlist (same Postgres instance), same convention audit_logs
-- above uses: declared identically, behind IF NOT EXISTS, in both
-- services' schema.sql so either one can run first with zero cross-folder
-- migration coordination. badge_number, not a FK to officers(id), since
-- either service needs to write/read this without depending on the
-- other's ownership of the officers table.
CREATE TABLE IF NOT EXISTS push_subscriptions (
    id           SERIAL PRIMARY KEY,
    badge_number TEXT NOT NULL,
    endpoint     TEXT NOT NULL,
    p256dh_key   TEXT NOT NULL,
    auth_key     TEXT NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (badge_number, endpoint)
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_badge ON push_subscriptions (badge_number);

-- Rename circles -> areas (the concept was named "circle" by mistake early
-- on; renamed everywhere in code, this is the matching data migration for
-- an existing database that already ran the old CREATE TABLE circles above
-- as its own fresh install). Guarded so it's a no-op on a database that
-- either never had the old names or has already been migrated.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'circles') THEN
        ALTER TABLE circles RENAME TO areas;
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.columns WHERE table_name = 'cameras' AND column_name = 'circle_id'
    ) THEN
        ALTER TABLE cameras RENAME COLUMN circle_id TO area_id;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cameras_circle_id_fkey') THEN
        ALTER TABLE cameras RENAME CONSTRAINT cameras_circle_id_fkey TO cameras_area_id_fkey;
    END IF;
    -- Cosmetic only (Postgres doesn't auto-rename these when a table is
    -- renamed) -- kept in step so a fresh look at \d areas doesn't still
    -- say "circles_..." everywhere.
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'circles_pkey') THEN
        ALTER TABLE areas RENAME CONSTRAINT circles_pkey TO areas_pkey;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'circles_district_name_key') THEN
        ALTER INDEX circles_district_name_key RENAME TO areas_district_name_key;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'circles_id_seq') THEN
        ALTER SEQUENCE circles_id_seq RENAME TO areas_id_seq;
    END IF;
END $$;

-- Same rename for the manage_circles permission string already seeded into
-- existing role/duty grants -- role_permissions.permission and
-- duty_permissions.permission are free-text, not a foreign key to a
-- permissions catalog, so a code-level rename alone wouldn't update rows
-- an admin already granted.
UPDATE role_permissions SET permission = 'manage_areas' WHERE permission = 'manage_circles';
UPDATE duty_permissions SET permission = 'manage_areas' WHERE permission = 'manage_circles';

-- District -> Taluka -> Village reference hierarchy (Government of India's
-- Local Government Directory -- lgdirectory.gov.in -- the dataset every
-- Indian e-governance system has been mandated to key location data off
-- since a 2016 Cabinet Secretariat order). Read-only reference data, seeded
-- once by scripts/seed_locations.py from app/data/gujarat_locations.json --
-- never created/edited/deleted through the app itself. "Area" (the table
-- above) is the user-managed layer that sits on top of a real village/town
-- instead of a free-text district string, which is what this whole
-- hierarchy exists to fix: at Gujarat-wide scale (34 districts, ~270
-- talukas, ~19,000 villages) a free-text district column can't be searched,
-- paginated, or trusted not to typo-duplicate.
CREATE TABLE IF NOT EXISTS districts (
    id         SERIAL PRIMARY KEY,
    name       TEXT NOT NULL UNIQUE,
    lgd_code   TEXT UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS talukas (
    id          SERIAL PRIMARY KEY,
    name        TEXT NOT NULL,
    district_id INTEGER NOT NULL REFERENCES districts(id) ON DELETE CASCADE,
    lgd_code    TEXT UNIQUE,
    -- true for the 2 talukas (Rah, Dharnidhar, under Vav-Tharad) that don't
    -- exist in the source LGD dump at all -- a real taluka split newer than
    -- the dataset's 2022 retrieval date, added here without guessed village
    -- data rather than silently omitted. Surfaced in the admin UI so a
    -- reviewer knows to fill these in later, not left to look like any
    -- other empty-of-villages taluka.
    no_lgd_data BOOLEAN NOT NULL DEFAULT false,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (district_id, name)
);

CREATE INDEX IF NOT EXISTS idx_talukas_district ON talukas (district_id);

CREATE TABLE IF NOT EXISTS villages (
    id         SERIAL PRIMARY KEY,
    name       TEXT NOT NULL,
    taluka_id  INTEGER NOT NULL REFERENCES talukas(id) ON DELETE CASCADE,
    lgd_code   TEXT UNIQUE,
    -- LGD's "Village Status" -- distinguishes an actual revenue village from
    -- a census town/municipal body, shown as a badge in the picker so
    -- officers can tell "Ahmedabad (city)" apart from a same-named village
    -- elsewhere in the same taluka.
    is_urban   BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (taluka_id, name)
);

CREATE INDEX IF NOT EXISTS idx_villages_taluka ON villages (taluka_id);

-- Backs the type-to-search village picker (areasService-style UX) at
-- 19,000+ rows -- a trigram GIN index keeps "contains" search (not just
-- prefix, which a plain btree would give) fast at this scale.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_villages_name_trgm ON villages USING GIN (name gin_trgm_ops);

ALTER TABLE areas ADD COLUMN IF NOT EXISTS village_id INTEGER REFERENCES villages(id);
CREATE INDEX IF NOT EXISTS idx_areas_village ON areas (village_id);

-- Backfills existing areas.district free text -> the real village row it
-- actually belongs to, then retires the free-text column -- mirrors the
-- circle->area rename's own guarded-DO-block migration style above. Only a
-- handful of areas existed pre-migration, so this hand-verified mapping
-- covers all of them: most map straight to their district's headquarter
-- town of the same name; "Petlad, Gujarat" and "Viramgam, Ahmedabad" were
-- never real district names to begin with (Petlad is a town in Anand
-- district, Viramgam a town in Ahmedabad district) -- exactly the
-- free-text-district problem this migration exists to fix. No-ops until
-- scripts/seed_locations.py has actually populated the villages table.
DO $$
DECLARE
    mapping RECORD;
    v_id INTEGER;
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'areas' AND column_name = 'district')
       AND EXISTS (SELECT 1 FROM villages LIMIT 1) THEN
        FOR mapping IN
            SELECT * FROM (VALUES
                ('Ahmedabad', 'Ahmedabad'),
                ('Anand', 'Anand'),
                ('Junagadh', 'Junagadh'),
                ('Petlad, Gujarat', 'Petlad'),
                ('Vadodara', 'Vadodara'),
                ('Viramgam, Ahmedabad', 'Viramgam (Rural)')
            ) AS m(old_district, village_name)
        LOOP
            SELECT v.id INTO v_id FROM villages v WHERE v.name = mapping.village_name LIMIT 1;
            IF v_id IS NOT NULL THEN
                UPDATE areas SET village_id = v_id WHERE district = mapping.old_district AND village_id IS NULL;
            END IF;
        END LOOP;

        -- Only retire the free-text column once every existing row was
        -- successfully mapped -- if some area's district string didn't
        -- match anything above, district stays in place (and village_id
        -- stays nullable) rather than silently dropping unmapped data.
        IF NOT EXISTS (SELECT 1 FROM areas WHERE village_id IS NULL) THEN
            ALTER TABLE areas ALTER COLUMN village_id SET NOT NULL;
            ALTER TABLE areas DROP COLUMN IF EXISTS district;
            IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'areas_district_name_key') THEN
                ALTER TABLE areas DROP CONSTRAINT areas_district_name_key;
            END IF;
            IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'areas_village_name_key') THEN
                ALTER TABLE areas ADD CONSTRAINT areas_village_name_key UNIQUE (village_id, name);
            END IF;
        END IF;
    END IF;
END $$;

-- Manual Plate Lookup feature: an officer-uploaded clip/image or a marked
-- Archive clip has no real registered camera, but detections/alerts both
-- require a real camera_id (NOT NULL). Rather than build a parallel result
-- path, seed_virtual_cameras.py creates one of these per district and every
-- such job dispatches against it, so the entire existing detections/alerts/
-- map-trace/push pipeline needs zero new code. Same convention as
-- is_synthetic above: excluded from real camera counts/lists/analytics by
-- default everywhere that already filters on is_synthetic, plus a few
-- aggregate sites that had no filter at all (see reports_service.get_summary,
-- detections_service's camera density/flow queries).
ALTER TABLE cameras ADD COLUMN IF NOT EXISTS is_virtual_capture BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_cameras_virtual_capture ON cameras (is_virtual_capture) WHERE is_virtual_capture;
