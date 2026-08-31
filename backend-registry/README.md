
# Backend Registry

FastAPI service exposing CRUD APIs for the camera registry. Backed by PostgreSQL + PostGIS for geo-queries.

Stores camera metadata for all 26 departments: location, department, camera type, ownership, connectivity/health status, storage type, retention period, and RTSP URL.

Consumed by `frontend-map/` for rendering pins and filters. Endpoint contract: `/contract/API_CONTRACT.md`.
