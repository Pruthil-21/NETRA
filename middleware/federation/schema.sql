CREATE TABLE IF NOT EXISTS fed_sources (
 id text PRIMARY KEY, config jsonb NOT NULL, enabled boolean NOT NULL DEFAULT true,
 status text NOT NULL DEFAULT 'initializing', next_due timestamptz NOT NULL DEFAULT now(),
 queued_until timestamptz, last_attempt timestamptz, last_success timestamptz, last_full timestamptz,
 duration_ms double precision, changed bigint NOT NULL DEFAULT 0, camera_count bigint NOT NULL DEFAULT 0,
 failures integer NOT NULL DEFAULT 0, total_failures bigint NOT NULL DEFAULT 0, error_code text,
 checkpoint text, etag text, modified text, run_id uuid, state jsonb NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS fed_cameras (
 id text PRIMARY KEY, source_id text NOT NULL REFERENCES fed_sources(id), payload jsonb NOT NULL,
 active boolean NOT NULL DEFAULT true, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fed_cameras_active ON fed_cameras(id) WHERE active;
CREATE INDEX IF NOT EXISTS fed_cameras_source ON fed_cameras(source_id, id) WHERE active;
CREATE TABLE IF NOT EXISTS fed_stage (
 run_id uuid NOT NULL, id text NOT NULL, payload jsonb, deleted boolean NOT NULL DEFAULT false,
 PRIMARY KEY(run_id, id)
);
CREATE TABLE IF NOT EXISTS fed_mappings (
 camera_id text PRIMARY KEY REFERENCES fed_cameras(id), registry_camera_id bigint NOT NULL CHECK(registry_camera_id > 0),
 actor text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fed_mapping_registry ON fed_mappings(registry_camera_id);
CREATE TABLE IF NOT EXISTS fed_mapping_audit (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, camera_id text NOT NULL,
 registry_camera_id bigint NOT NULL, actor text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
