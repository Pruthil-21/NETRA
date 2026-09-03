# Vehicle Daily Sighting Log Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a derived, non-evidentiary `vehicle_daily_sightings` table that accumulates every detection timestamp for a given camera+plate+IST-calendar-day, alongside the existing insert-only `detections` table, with no cooldown/de-dup at this layer.

**Architecture:** One new table, populated by one new insert appended to the existing `record_detection` write path, inside the same DB transaction as the raw `detections` insert. No new API endpoint, no schema migration framework — this codebase applies `schema.sql` only via `docker-entrypoint-initdb.d` on first volume creation, so the new table is also applied directly to the running dev database.

**Tech Stack:** FastAPI, psycopg2 (`RealDictCursor`), PostgreSQL (array column + `ON CONFLICT ... DO UPDATE` upsert), pytest with a direct psycopg2 connection for DB-state assertions (matches `backend-watchlist/tests/test_detections.py`).

**Spec:** `docs/superpowers/specs/2026-09-03-vehicle-daily-sighting-log-design.md`

## Global Constraints

- No cooldown or de-duplication at this layer — every successful detection insert appends its own timestamp to `detection_times`, unconditionally. (ml-anpr's own `VehicleTracker` already suppresses same-camera re-sends within 45s upstream; see spec.)
- `sighting_date` is the IST calendar date, computed in SQL via `AT TIME ZONE 'Asia/Kolkata'` on `detected_at` — never in Python, never off server-local time.
- `vehicle_daily_sightings.camera_id` is a bare `INTEGER`, no foreign key — matches the existing `detections.camera_id` / `alerts.camera_id` columns in this schema (cameras are owned by backend-registry, a separate service).
- No back-references to individual `detections` rows — `vehicle_daily_sightings` is a pure aggregate keyed on `(camera_id, plate_number, sighting_date)`.
- Storage and write-path only in this plan — no new API endpoint.
- This branch (`feature/anpr-detection`) has no event_id idempotency layer (that exists only on the sibling `feature/camera-scale-testing` branch), so the upsert below runs unconditionally after every successful `detections` insert — there is no duplicate-retry case to guard against here.

---

### Task 1: Add the `vehicle_daily_sightings` table

**Files:**
- Modify: `backend-watchlist/app/schema.sql`
- Test: manual verification via `psql` (no pytest for schema-only changes)

**Interfaces:**
- Produces: table `vehicle_daily_sightings(id BIGSERIAL PK, camera_id INTEGER NOT NULL, plate_number TEXT NOT NULL, sighting_date DATE NOT NULL, detection_times TIMESTAMPTZ[] NOT NULL DEFAULT '{}')`, with `UNIQUE (camera_id, plate_number, sighting_date)` and an index on `(plate_number, sighting_date)`. Task 2 upserts into this table by that unique constraint.

- [ ] **Step 1: Add the table to `schema.sql`**

Append to the end of `backend-watchlist/app/schema.sql`:

```sql

-- Derived, non-evidentiary daily rollup of detections, for cross-camera
-- "where was this plate seen today" queries -- NOT a replacement for the
-- insert-only detections table above, which remains the evidentiary
-- record. One row per camera_id + plate_number + IST calendar day;
-- detection_times accumulates every sighting's exact timestamp, no
-- cooldown or de-duplication (ml-anpr's own tracker already suppresses
-- same-camera re-sends within 45s upstream).
CREATE TABLE vehicle_daily_sightings (
    id              BIGSERIAL PRIMARY KEY,
    camera_id       INTEGER NOT NULL,
    plate_number    TEXT NOT NULL,
    sighting_date   DATE NOT NULL,
    detection_times TIMESTAMPTZ[] NOT NULL DEFAULT '{}',
    UNIQUE (camera_id, plate_number, sighting_date)
);

CREATE INDEX idx_vehicle_daily_sightings_plate
    ON vehicle_daily_sightings (plate_number, sighting_date);
```

- [ ] **Step 2: Apply the same DDL directly to the running dev database**

`schema.sql` only runs via `docker-entrypoint-initdb.d` on first volume
creation — it will NOT apply to the already-initialized `netra-db-1`
volume. Apply it directly (using `IF NOT EXISTS` here only, for safe
re-running of this exact step — `schema.sql` itself matches the existing
file's style with no `IF NOT EXISTS`, since it only ever runs once):

Run:
```bash
docker exec netra-db-1 psql -U netra -d netra -c "CREATE TABLE IF NOT EXISTS vehicle_daily_sightings (id BIGSERIAL PRIMARY KEY, camera_id INTEGER NOT NULL, plate_number TEXT NOT NULL, sighting_date DATE NOT NULL, detection_times TIMESTAMPTZ[] NOT NULL DEFAULT '{}', UNIQUE (camera_id, plate_number, sighting_date));"
docker exec netra-db-1 psql -U netra -d netra -c "CREATE INDEX IF NOT EXISTS idx_vehicle_daily_sightings_plate ON vehicle_daily_sightings (plate_number, sighting_date);"
```

- [ ] **Step 3: Verify the table exists with the right shape**

Run: `docker exec netra-db-1 psql -U netra -d netra -c "\d vehicle_daily_sightings"`
Expected: lists columns `id, camera_id, plate_number, sighting_date, detection_times` and the unique constraint on `(camera_id, plate_number, sighting_date)`.

- [ ] **Step 4: Commit**

```bash
git add backend-watchlist/app/schema.sql
git commit -m "feat(backend-watchlist): add vehicle_daily_sightings table"
```

---

### Task 2: Populate `vehicle_daily_sightings` from every recorded detection

**Files:**
- Modify: `backend-watchlist/app/services/detections_service.py`
- Test: `backend-watchlist/tests/test_vehicle_daily_sightings.py` (create)

**Interfaces:**
- Consumes: table from Task 1.
- Produces: `detections_service._upsert_daily_sighting(db: RealDictCursor, camera_id: int, plate_number: str, detected_at: datetime) -> None`, called from `record_detection` with the just-inserted row's own `camera_id`, `plate_number`, and `detected_at`. No other module calls `_upsert_daily_sighting` directly except this file's own tests.

- [ ] **Step 1: Write the failing tests**

Create `backend-watchlist/tests/test_vehicle_daily_sightings.py`:

```python
import uuid
from datetime import datetime, timezone

import psycopg2
import psycopg2.extras
from app.config import settings
from app.services import detections_service


def _direct_conn():
    conn = psycopg2.connect(settings.database_url)
    conn.autocommit = True
    return conn


def _random_plate():
    return f"GJ01AB{uuid.uuid4().hex[:4].upper()}"


def test_single_detection_creates_one_summary_row_with_one_timestamp(client, internal_headers):
    plate = _random_plate()
    resp = client.post(
        "/detections",
        json={"camera_id": 101, "plate_number": plate},
        headers=internal_headers,
    )
    assert resp.status_code == 201

    with _direct_conn() as conn, conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            "SELECT * FROM vehicle_daily_sightings WHERE camera_id = %s AND plate_number = %s",
            (101, plate),
        )
        row = cur.fetchone()
        assert row is not None
        assert len(row["detection_times"]) == 1


def test_two_detections_same_camera_plate_day_append_to_same_row(client, internal_headers):
    plate = _random_plate()
    for _ in range(2):
        resp = client.post(
            "/detections",
            json={"camera_id": 102, "plate_number": plate},
            headers=internal_headers,
        )
        assert resp.status_code == 201

    with _direct_conn() as conn, conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            "SELECT * FROM vehicle_daily_sightings WHERE camera_id = %s AND plate_number = %s",
            (102, plate),
        )
        rows = cur.fetchall()
        assert len(rows) == 1
        assert len(rows[0]["detection_times"]) == 2


def test_two_different_cameras_same_plate_same_day_create_separate_rows(client, internal_headers):
    plate = _random_plate()
    for camera_id in (103, 104):
        resp = client.post(
            "/detections",
            json={"camera_id": camera_id, "plate_number": plate},
            headers=internal_headers,
        )
        assert resp.status_code == 201

    with _direct_conn() as conn, conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            "SELECT camera_id FROM vehicle_daily_sightings WHERE plate_number = %s ORDER BY camera_id",
            (plate,),
        )
        rows = cur.fetchall()
        assert [r["camera_id"] for r in rows] == [103, 104]


def test_day_boundary_is_ist_not_utc():
    plate = _random_plate()
    with _direct_conn() as conn, conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        # 23:59 IST on 2026-09-03 == 18:29 UTC on 2026-09-03
        detections_service._upsert_daily_sighting(
            cur, 105, plate, datetime(2026, 9, 3, 18, 29, 0, tzinfo=timezone.utc)
        )
        # 00:01 IST on 2026-09-04 == 18:31 UTC on 2026-09-03
        detections_service._upsert_daily_sighting(
            cur, 105, plate, datetime(2026, 9, 3, 18, 31, 0, tzinfo=timezone.utc)
        )
        cur.execute(
            "SELECT sighting_date FROM vehicle_daily_sightings "
            "WHERE camera_id = %s AND plate_number = %s ORDER BY sighting_date",
            (105, plate),
        )
        rows = cur.fetchall()
        assert [r["sighting_date"].isoformat() for r in rows] == ["2026-09-03", "2026-09-04"]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `docker exec netra-backend-watchlist-1 pytest tests/test_vehicle_daily_sightings.py -v`
Expected: FAIL — `test_single_detection_...`, `test_two_detections_...`, and `test_two_different_cameras_...` fail because no row is ever created in `vehicle_daily_sightings` (nothing writes to it yet); `test_day_boundary_is_ist_not_utc` fails with `AttributeError: module 'app.services.detections_service' has no attribute '_upsert_daily_sighting'`.

- [ ] **Step 3: Implement `_upsert_daily_sighting` and wire it into `record_detection`**

Replace the top of `backend-watchlist/app/services/detections_service.py` (the `record_detection` function) with:

```python
"""Business logic for ANPR detections — the permanent, insert-only sighting
history. Every plate read is recorded here regardless of watchlist status;
a match additionally gets an alerts row (see alerts_service.process_detection).

Every recorded detection also appends its exact timestamp to a derived
daily-rollup row in vehicle_daily_sightings, keyed on
(camera_id, plate_number, IST calendar day) -- see _upsert_daily_sighting.
That table is non-evidentiary and never replaces the detections history
above; it exists purely to answer "where was this plate seen today"
without scanning detections by hand.
"""
from psycopg2.extras import RealDictCursor

from ..schemas import DetectionIn


def _upsert_daily_sighting(db: RealDictCursor, camera_id: int, plate_number: str, detected_at):
    db.execute(
        """
        INSERT INTO vehicle_daily_sightings
            (camera_id, plate_number, sighting_date, detection_times)
        VALUES
            (%s, %s, (%s AT TIME ZONE 'Asia/Kolkata')::date, ARRAY[%s]::timestamptz[])
        ON CONFLICT (camera_id, plate_number, sighting_date)
        DO UPDATE SET detection_times =
            vehicle_daily_sightings.detection_times || EXCLUDED.detection_times
        """,
        (camera_id, plate_number, detected_at, detected_at),
    )


def record_detection(db: RealDictCursor, detection: DetectionIn):
    db.execute(
        """
        INSERT INTO detections (plate_number, camera_id, confidence)
        VALUES (%s, %s, %s)
        RETURNING *
        """,
        (detection.plate_number, detection.camera_id, detection.confidence),
    )
    row = db.fetchone()
    _upsert_daily_sighting(db, row["camera_id"], row["plate_number"], row["detected_at"])
    return row
```

(`search_detections` below this in the same file is unchanged.)

- [ ] **Step 4: Rebuild the backend-watchlist container and run tests to verify they pass**

Run:
```bash
docker compose -p netra build backend-watchlist
docker compose -p netra up -d backend-watchlist
docker exec netra-backend-watchlist-1 pytest tests/test_vehicle_daily_sightings.py tests/test_detections.py -v
```
Expected: all `test_vehicle_daily_sightings.py` tests PASS; `test_detections.py` still PASSES unchanged (proves this is additive, not a modification of existing detection-recording behavior).

- [ ] **Step 5: Commit**

```bash
git add backend-watchlist/app/services/detections_service.py backend-watchlist/tests/test_vehicle_daily_sightings.py
git commit -m "feat(backend-watchlist): populate vehicle_daily_sightings on every detection"
```
