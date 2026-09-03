-- One-time migration for any Postgres volume initialized before this table
-- existed in schema.sql. Fresh volumes get this automatically via
-- docker-entrypoint-initdb.d; existing volumes must run this file manually:
--   docker exec netra-db-1 psql -U netra -d netra -f /path/to/this/file.sql
-- (or paste its contents into psql directly).
CREATE TABLE IF NOT EXISTS vehicle_daily_sightings (
    id              BIGSERIAL PRIMARY KEY,
    camera_id       INTEGER NOT NULL,
    plate_number    TEXT NOT NULL,
    sighting_date   DATE NOT NULL,
    detection_times TIMESTAMPTZ[] NOT NULL DEFAULT '{}',
    UNIQUE (camera_id, plate_number, sighting_date)
);

CREATE INDEX IF NOT EXISTS idx_vehicle_daily_sightings_plate
    ON vehicle_daily_sightings (plate_number, sighting_date);
