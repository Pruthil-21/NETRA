# Backend Watchlist

API and logic tying the alerting pipeline together: stores the watchlist (flagged plates), receives plate detections from `ml-anpr/`, checks for matches, and creates alerts consumed by `frontend-dashboard/`.

## Database migrations

`app/schema.sql` only auto-applies to a fresh Postgres volume, via the `docker-entrypoint-initdb.d` mount in `docker-compose.yml` (Postgres runs those scripts only on first volume creation). Anyone with an existing `db_data` volume from before the `vehicle_daily_sightings` table was added must run `scripts/add_vehicle_daily_sightings.sql` against it manually.
