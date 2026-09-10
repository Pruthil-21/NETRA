-- Run once using a migration/owner role, never during API startup.
CREATE TABLE IF NOT EXISTS segments (
 path text NOT NULL, start_at timestamptz NOT NULL, end_at timestamptz NOT NULL,
 object_key text NOT NULL, sha256 text NOT NULL, bytes bigint NOT NULL,
 shard text NOT NULL, recovered boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(path, start_at, object_key), CHECK(end_at > start_at)
) PARTITION BY HASH(path);
CREATE TABLE IF NOT EXISTS audit (
 path text NOT NULL, id uuid NOT NULL, at timestamptz NOT NULL DEFAULT now(),
 actor text NOT NULL, action text NOT NULL, details jsonb NOT NULL,
 PRIMARY KEY(path,id)
) PARTITION BY HASH(path);
DO $$ DECLARE d date; BEGIN
 FOR i IN 0..63 LOOP
  EXECUTE format('CREATE TABLE IF NOT EXISTS segments_%s PARTITION OF segments FOR VALUES WITH (MODULUS 64, REMAINDER %s) PARTITION BY RANGE(start_at)',i,i);
  FOR d IN SELECT generate_series(current_date-1,current_date+2,interval '1 day')::date LOOP
   EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF segments_%s FOR VALUES FROM (%L) TO (%L)',
     'segments_'||i||'_'||to_char(d,'YYYYMMDD'),i,d,d+1);
  END LOOP;
  EXECUTE format('CREATE TABLE IF NOT EXISTS audit_%s PARTITION OF audit FOR VALUES WITH (MODULUS 64, REMAINDER %s)',i,i);
 END LOOP;
END $$;
CREATE INDEX IF NOT EXISTS segments_time ON segments(path,start_at,end_at);
CREATE TABLE IF NOT EXISTS camera_health (
 path text PRIMARY KEY, shard text NOT NULL, last_frame_at timestamptz,
 checked_at timestamptz NOT NULL DEFAULT now(), last_segment_at timestamptz,
 status text NOT NULL, retries integer NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS notifications (
 path text NOT NULL, state text NOT NULL, event_id uuid PRIMARY KEY,
 payload jsonb NOT NULL, attempts integer NOT NULL DEFAULT 0,
 due_at timestamptz NOT NULL DEFAULT now(), delivered_at timestamptz
);
-- Provision distinct least-privilege runtime roles externally.
-- Audit runtime permissions: SELECT, INSERT only. Deny UPDATE, DELETE, TRUNCATE.
ALTER TABLE camera_health ADD COLUMN IF NOT EXISTS assigned_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE camera_health ADD COLUMN IF NOT EXISTS bucket integer NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS health_bucket_path ON camera_health(bucket,path);
CREATE INDEX IF NOT EXISTS notifications_due ON notifications(due_at) WHERE delivered_at IS NULL;

CREATE TABLE IF NOT EXISTS health_states (path text PRIMARY KEY,state text NOT NULL);
