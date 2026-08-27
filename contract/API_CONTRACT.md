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

### ANPR Detection (P5 → P6)

Sent by `ml-anpr/detect_plate.py` whenever a plate is confirmed across
multiple frames of a live feed. Consumed by `POST /alerts`, which checks
the plate against the watchlist and returns 201 (match, alert created) or
204 (no match).

Detection payload: `{ camera_id, plate_number }`

- `camera_id`: integer, must match an existing id in the `cameras` table (Model 1 registry)
- `plate_number`: string, uppercase, alphanumeric only

**Auth:** `X-Internal-Key` header (shared secret between ml-anpr and backend-watchlist — service-to-service, not a user JWT)

**Endpoint:** `POST /alerts`

**Response:**
- `201` + `Alert` object — plate matched the watchlist
- `204` — plate is not on the watchlist (normal/expected case for most detections)

**Known limitation:** live webcam feeds (`livecam`) are currently mapped to
a placeholder `camera_id` for testing, since the webcam isn't a real
registered camera in Model 1's registry yet. Simulated CCTV loop feeds
(`camera1`, etc.) should map to their real registry camera_id once P1's
seed data and P3's stream naming are cross-referenced.

## Streaming feed metadata 

`{ camera_id, hls_url, webrtc_url }`
