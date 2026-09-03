# Vehicle Daily Sighting Log — Design Spec

## Context

A teammate proposed a daily vehicle-sighting log: one row per
`camera_id + plate_number + date`, accumulating a list of every timestamp
that plate was seen at that camera that day. The stated goal is to support
cross-camera questions an officer might ask — where was this plate seen
today, which cameras, how many times, in what order — without scanning the
full evidentiary `detections` table by hand.

The original proposal described this as *mutable per-day rows*, updated in
place on repeat sightings. The existing `detections` table in
backend-watchlist is deliberately insert-only/append-only — one row per
sighting, never updated — for evidentiary chain-of-custody reasons,
and alerts, vehicle-trace, and reports already depend on that per-sighting
granularity. This spec resolves that tension by treating the new table as
an **additional, derived, non-evidentiary summary table populated alongside
`detections`**, never a replacement for it. `detections` is untouched by
this feature.

## Decisions

- **No cooldown / de-dup at this layer.** Every individual detection POST
  appends its own timestamp, unconditionally — including rapid consecutive
  frame-level reads. This was an explicit reversal of the original
  proposal's frame-level cooldown concept.
  - Confirmed as the right call by P6's separate handoff: ml-anpr's
    `VehicleTracker` now suppresses re-sending the same plate at the same
    camera within a 45-second window upstream, specifically to avoid
    generating a second "new-looking" event when its own tracking loses and
    re-picks-up a vehicle blocked from view for a few seconds. That is the
    exact duplicate-adjacent-sighting problem the original cooldown
    proposal was trying to catch — it is now handled before the event ever
    reaches our backend, so duplicating that logic here would be redundant.
  - This backend logs whatever arrives; if two genuinely distinct detection
    events happen to arrive milliseconds apart, both are logged.
- **Day boundary = IST calendar date.** Not UTC, not server-local time.
- **Enforcement point = this backend (summary-table write path), not
  ml-anpr.** ml-anpr's job is to send detections; grouping into daily rows
  is a backend-watchlist concern.
- **Pure aggregate row — no back-references to individual `detections`
  ids.** A summary row is fully identified by
  `(camera_id, plate_number, sighting_date)`; if a consumer needs the
  original detection's detail (confidence, exact frame), that is answerable
  by querying `detections` directly for matching `camera_id`,
  `plate_number`, and a `detected_at` that falls on that date — no stored
  FK array is needed, and one would risk drifting out of sync with
  `detection_times` since they'd have to be maintained as two parallel
  arrays.
- **Storage and write-path only, no new API endpoint yet.** The write path
  (the upsert-on-detection logic) is the part with real design risk
  (concurrency, day-boundary correctness). The query side is a single
  `SELECT ... WHERE plate_number = $1 AND sighting_date BETWEEN ...` once
  the table exists and holds real data — building that endpoint now would
  mean guessing at a query contract before there's a real consumer or a
  clear sense of what shape (single plate over days? all plates at one
  camera? a date range?) officers or other teammates actually need. This is
  an explicit, deliberate scope cut, expected to be a fast follow-up once
  the table has real data in it.

## Schema

New table, additive only:

```sql
CREATE TABLE vehicle_daily_sightings (
    id BIGSERIAL PRIMARY KEY,
    camera_id INT NOT NULL REFERENCES cameras(id),
    plate_number TEXT NOT NULL,
    sighting_date DATE NOT NULL,
    detection_times TIMESTAMPTZ[] NOT NULL DEFAULT '{}',
    UNIQUE (camera_id, plate_number, sighting_date)
);
CREATE INDEX idx_vehicle_daily_sightings_plate
    ON vehicle_daily_sightings (plate_number, sighting_date);
```

`detection_times` holds the exact `detected_at` value of every sighting
that landed on that camera+plate+day — full timestamp precision, nothing
rounded or bucketed. Only the day-level grouping (`sighting_date`) is
derived; every individual entry in the array is kept exact.

The `UNIQUE (camera_id, plate_number, sighting_date)` constraint is both
what makes "one row per camera+plate+day" hold and the upsert target below.

## Write path

Lives in `detections_service.record_detection`, in the same DB transaction
as the raw `detections` insert, and runs **only when a raw `detections` row
was genuinely newly inserted** (`is_duplicate == False` from the
event_id-idempotency check already in place) — a retried `event_id` must
not append a second timestamp for a sighting that never actually happened
twice.

```sql
INSERT INTO vehicle_daily_sightings
    (camera_id, plate_number, sighting_date, detection_times)
VALUES
    (%s, %s, (%s AT TIME ZONE 'Asia/Kolkata')::date, ARRAY[%s]::timestamptz[])
ON CONFLICT (camera_id, plate_number, sighting_date)
DO UPDATE SET detection_times =
    vehicle_daily_sightings.detection_times || EXCLUDED.detection_times
```

Both `%s` placeholders for the timestamp are the same value: the recorded
detection's `detected_at`. The day boundary is computed in SQL via
`AT TIME ZONE 'Asia/Kolkata'` on the already-`TIMESTAMPTZ` `detected_at` —
not in Python, not off server-local time — so it is correct regardless of
what timezone the app server or DB host happens to be running in.

Postgres's `ON CONFLICT ... DO UPDATE` takes a row lock on the conflicting
row, so concurrent rapid-fire detections for the same camera+plate+day
append safely with no additional locking logic needed.

## Error handling

None beyond what the existing transaction already provides: this insert
runs inside the same transaction as the `detections` insert it follows, so
a failure here rolls back the whole detection-recording operation — a
sighting is never partially recorded (raw row present, summary row
missing, or vice versa).

## Testing

- Two detections, same camera + plate + day → one summary row,
  `detection_times` has 2 entries, both exact.
- Two detections, same camera + plate, one at 23:59 IST and one at 00:01
  IST → two separate summary rows (day-boundary correctness across
  midnight IST, not midnight UTC).
- Retried `event_id` (duplicate per existing idempotency logic) → no new
  timestamp appended, row unchanged.
- Two different cameras, same plate, same day → two separate summary rows
  (per-camera granularity preserved, not merged across cameras).
- Existing `detections`-table and idempotency tests untouched and still
  passing (proves this is additive, not a replacement for or modification
  of the evidentiary table).

## Retention

Out of scope for this spec — `vehicle_daily_sightings` is a new table with
no existing retention policy to reconcile against; if one is needed, it
should be decided when the query endpoint (the next follow-up) is
designed, once real usage patterns are known.
