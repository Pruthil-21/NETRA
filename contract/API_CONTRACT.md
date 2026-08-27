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
- `POST /cameras/bulk` — officer role. Body is a bare JSON array of camera
  objects (same fields as `POST /cameras`). Never fails the whole batch on
  one bad row — always `200`, body is an array of per-row results, same
  order/length as the request:
  `{ index, status: "created" | "error", camera: Camera | null, reason: string | null }`
  `camera` is the full created object on success (so the caller doesn't need
  a follow-up `GET`); `reason` is a human-readable validation/DB error on
  failure.
- `GET /reports/summary` — any authenticated role. Gap-analysis numbers for
  the pitch deck, no manual row-counting:
  `{ total_cameras, cameras_by_department, cameras_by_connectivity_status, cameras_by_health_status, alerts_last_24h, detections_last_24h }`
  The `*_by_*` fields are `{ [value]: count }` maps. `alerts_last_24h` /
  `detections_last_24h` read backend-watchlist's tables directly (same
  Postgres instance) and come back `null` instead of erroring if that
  service's schema isn't applied yet in this environment.

## Model 2 — Watchlist & Alerts 

Watchlist entry:
`{ id, plate_number, reason, dept_flagged, date_added, priority }`

- `GET /watchlist`
- `POST /watchlist`

Alert:
`{ id, camera_id, plate_number, watchlist_id, detection_id, matched_at, status }`

- `GET /alerts` — officer role.
- `PATCH /alerts/:id` — officer role. Appends a status transition
  (`ACKNOWLEDGED` | `DISMISSED` | `ESCALATED`); `alerts` rows are never
  mutated in place (evidentiary chain-of-custody) — history lives in
  `alert_status_history`, this endpoint returns the alert with its
  current (latest) status.
- There is no `POST /alerts` — alerts are created only as a side effect of
  `POST /detections` below (a watchlist match). This changed from the v0.1
  draft below: ANPR used to post detections here directly.

Detection:
`{ id, plate_number, camera_id, detected_at, confidence }`

- `GET /detections` — officer role. Search the full vehicle-sighting
  history, independent of watchlist status.
  Query params (all optional, combine as AND): `plate_number`, `camera_id`,
  `from` (ISO datetime, inclusive), `to` (ISO datetime, inclusive). Results
  ordered by `detected_at` ascending — for a timeline/route view.
- `POST /detections` — internal-service only (`X-Internal-Key`). The single
  endpoint ml-anpr calls for **every** confirmed plate read, not just
  watchlist matches. Always records the sighting; if the plate matches the
  watchlist, also creates the linked `Alert` in the same request (so ml-anpr
  never calls two endpoints for one event).
  Response `201`: `{ detection: Detection, alert: Alert | null }` —
  `alert` is `null` when the plate did not match the watchlist (the normal/
  expected case for most detections).

### ANPR Detection (P5 → P6)

Sent by `ml-anpr/detect_plate.py` whenever a plate is confirmed across
multiple frames of a live feed.

**Endpoint:** `POST /detections` (was `POST /alerts` in the v0.1 draft above
— ml-anpr's `ALERT_API_URL` needs to move to `.../detections`, matching the
`# CONFIRM WITH P6 BEFORE DEMO` note in `detect_plate.py`)

Detection payload: `{ camera_id, plate_number, confidence }`

- `camera_id`: integer, must match an existing id in the `cameras` table (Model 1 registry)
- `plate_number`: string, uppercase, alphanumeric only
- `confidence`: float, optional — the OCR confidence score
  (`confirmed["confidence"]` in `detect_plate.py`'s `PlateConfirmationTracker`).
  Send it if available; backend-watchlist stores it for the detection history.

**Auth:** `X-Internal-Key` header (shared secret between ml-anpr and backend-watchlist — service-to-service, not a user JWT)

**Response:**
- `201` + `{ detection, alert }` — `alert` is non-null only when the plate matched the watchlist

**Known limitation:** live webcam feeds (`livecam`) are currently mapped to
a placeholder `camera_id` for testing, since the webcam isn't a real
registered camera in Model 1's registry yet. Simulated CCTV loop feeds
(`camera1`, etc.) should map to their real registry camera_id once P1's
seed data and P3's stream naming are cross-referenced.

## Streaming feed metadata 

`{ camera_id, hls_url, webrtc_url }`
