# NETRA API Contract v0.1

(Draft this together in the Day 1 kickoff — this is a starting skeleton only.)

## Model 1 — Registry 

Camera object:
`{ id, name, dept, lat, long, camera_type, ownership, connectivity_status, storage_type, retention_days, health_status, rtsp_url }`

- `GET /cameras`
- `GET /cameras/:id`
- `POST /cameras`
- `PUT /cameras/:id`
- `DELETE /cameras/:id`

## Model 2 — Watchlist & Alerts 

Watchlist entry:
`{ id, plate_number, reason, dept_flagged, date_added, priority }`

- `GET /watchlist`
- `POST /watchlist`

Alert:
`{ id, camera_id, plate_number, matched_at, status }`

- `GET /alerts`
- `POST /alerts` (created internally when ANPR match is found)

## Streaming feed metadata 

`{ camera_id, hls_url, webrtc_url }`
