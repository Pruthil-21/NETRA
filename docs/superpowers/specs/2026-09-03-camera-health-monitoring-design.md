# Camera Health Monitoring (SNMP Handoff) — Design

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement the plan derived from this spec.

**Goal:** Add backend support for Dhruv's streaming team's SNMP camera-health monitor (`netra-snmp-monitor`, currently mock/simulated): a stable per-camera `monitor_id`, a polled health-history record, and the latest health status surfaced on the existing camera/map API — as a fully independent signal from this branch's existing playback/reachability tracking (`camera_status_history`), never overwriting it. Per the handoff's own "we will not modify backend, database, frontend, or your branches" boundary, this is entirely backend-registry's responsibility.

**Base branch:** `feature/anpr-detection` (not `main` — that branch does not yet have this branch's `camera_status_history`/uptime-tracking work, which this design must coexist with, not main's leaner schema). This spec was revised after re-verifying the actual current schema on this branch directly (see "Verified facts" below) — an earlier draft was researched against a different, already-merged branch and got two things wrong (`httpx`'s presence, and the existence of `camera_status_history`) which are corrected here.

**Architecture:** Two independent, shippable-together pieces. (A) A one-time backfill script assigns `monitor_id` and reconciles curated location data for the current 30-camera Organizer import. (B) An in-process async background poller fetches the monitor's bulk device-health endpoint on an interval and records history into a **new, separate** table; `GET /cameras` surfaces the latest reading per camera via an indexed lookup — the same "join to an append-only history table for the current value" shape as `backend-watchlist/app/services/alerts_service.py`'s `_SELECT_WITH_CURRENT_STATUS` (a cross-service pattern reference, not shared code — backend-registry and backend-watchlist are separate services).

**Tech Stack:** FastAPI + psycopg (existing), `httpx.AsyncClient` for outbound polling, PostgreSQL (existing instance, additive schema only).

**Spec:** This document. No separate external spec — the requirements are Dhruv's handoff message plus the additional requirements confirmed across two rounds of review.

## Verified facts (this branch, `feature/anpr-detection`, re-checked directly)

- `cameras` table (`backend-registry/app/schema.sql:3-25`) is a single flat `CREATE TABLE`, no prior `ALTER TABLE ADD COLUMN` on it anywhere in the file. Includes `connectivity_status TEXT NOT NULL DEFAULT 'unknown'` and `health_status TEXT NOT NULL DEFAULT 'unknown'`.
- **`camera_status_history` already exists** (`schema.sql:34-41`): `id, camera_id, connectivity_status, changed_at`. Written **only** by `cameras_service.update_camera()` (`cameras_service.py:59-100`), and only when a `PUT /cameras/{id}` body's `connectivity_status` differs from the stored value — i.e. purely reactive to an explicit API call, never touched by any server-side scheduler (none exists on this branch). The frontend's own 20-second reachability poll (`CameraRegistryContext.tsx`, `HEALTH_CHECK_INTERVAL_MS`) is what drives those PUT calls. Read by `GET /cameras/{id}/uptime` only.
- `GET /cameras` / `GET /cameras/{id}` (`cameras_service.py:5-34`) return exactly: `id, name, dept, lat, long, camera_type, ownership, connectivity_status, storage_type, retention_days, health_status, rtsp_url, stream_id, hls_url` — a plain `SELECT`, no JOIN to `camera_status_history` or anything else.
- `backend-registry/requirements.txt` on this branch does **not** include `httpx` (it's only in `requirements-dev.txt`, for `TestClient`). Must be added to `requirements.txt` for the runtime poller to use it.
- No `lifespan`, `on_event`, `BackgroundTasks`, or any async task/scheduler pattern exists anywhere in `backend-registry/app/` on this branch. This design introduces that pattern fresh.
- `netra-snmp-monitor` is not defined in this branch's `docker-compose.yml` (owned/run by the streaming team, reached over the shared Docker network by hostname).

## Global Constraints

- **`camera_status_history` and `camera_health_history` are two disjoint signals, never merged.** `camera_status_history` (existing) is the frontend-reported playback/reachability signal, written only via `PUT /cameras/{id}`. `camera_health_history` (new, this design) is the SNMP device-health signal, written only by the new background poller. Neither code path ever calls the other's write path. `cameras.connectivity_status` and `cameras.health_status` are never written by anything in this design — the poller only ever writes to the new table and to `cameras.monitor_id`/`location_confidence` (new columns). This is what lets "camera device unreachable" (SNMP: `reachable = false`) be distinguished from "device reachable but stream unavailable" (playback: `connectivity_status = 'offline'`).
- **`monitor_id` is the durable join going forward, never the camera serial primary key.** The current `cam01..cam30` → camera id `1..30` mapping is positional and verified against the archived Organizer manifest, but is valid *only* for this current import. A future re-import of the Organizer camera set must not assume id continuity; it must re-derive `monitor_id` from the Organizer's own source identifier. Stated explicitly in the backfill script's own docstring, not left implicit.
- **`snmp_mode`/`snmp_state` are preserved verbatim, everywhere.** Every history row and the `GET /cameras` latest-health fields carry the monitor's own `snmp_mode`/`snmp_state` values (currently always `"mock"`/`"simulated"`) unmodified. No code path infers, overrides, or strips these — a consumer must always be able to tell mock/simulated data from a future real SNMPv3 poll from these two fields alone.
- **The monitor is never publicly reachable.** No `ports:` mapping, no Cloudflare tunnel, no code path in this repo exposes `netra-snmp-monitor` outside the existing shared Docker network. `backend-registry` reaches it only via `SNMP_MONITOR_BASE_URL` (env-configurable, defaults to the in-network hostname).
- **`location_confidence = "unknown"` must never read as a verified position.** Any consumer of `GET /cameras` must be able to see, from the response alone, that an `"unknown"`-confidence camera's `lat`/`long` is the Gujarat-center fallback, not a real observed location.
- **Additive only.** No existing column, index, or response field is removed or repurposed. The legacy `GET /cameras` response keeps its exact existing field set plus the new fields.
- **Operational data, not evidentiary data.** Unlike `detections`/`alerts` (append-only, kept forever, evidentiary chain-of-custody, in the sister `backend-watchlist` service), `camera_health_history` is diagnostic telemetry with no legal-retention requirement — it may be pruned by straight deletion, not moved to an archive table.

---

## A. Camera location + monitor_id backfill

**One script**, `backend-registry/scripts/reconcile_organizer_cameras.py`, since both concerns key off the same 30 rows:

- `ALTER TABLE cameras ADD COLUMN IF NOT EXISTS monitor_id TEXT;`
- `ALTER TABLE cameras ADD COLUMN IF NOT EXISTS location_confidence TEXT;` (`'landmark' | 'city' | 'unknown'`)
- `CREATE UNIQUE INDEX IF NOT EXISTS idx_cameras_monitor_id ON cameras (monitor_id) WHERE monitor_id IS NOT NULL;`

The script hardcodes the 30 entries transcribed from `frontend-map/lib/organizerCameraCoords.ts` (kept in sync manually — a comment points back to the source file so a future edit there is a signal to re-run this) and, for `camera_id` 1..30:

```python
UPDATE cameras
SET location = ST_SetSRID(ST_MakePoint(%(long)s, %(lat)s), 4326),
    location_confidence = %(confidence)s,
    monitor_id = %(monitor_id)s
WHERE id = %(camera_id)s
```

`monitor_id` is `f"cam{camera_id:02d}"`. Idempotent — re-running applies the same values. The docstring states the Global Constraints' durable-join caveat verbatim, so it travels with the code, not just this design doc.

**Verified against Dhruv's own confirmation:** `cam01` → Organizer camera 1 ("01 Chiman Bhai Bridge") → registry id 1, `cam02` → "02 Janpath" → id 2, `cam03` → "03 O.N.G.C. Office" → id 3, ... `cam30` → id 30, cross-checked against the archived Organizer manifest.

## B. Schema

```sql
CREATE TABLE IF NOT EXISTS camera_health_history (
    id                  SERIAL PRIMARY KEY,
    monitor_id          TEXT NOT NULL,
    status              TEXT NOT NULL,
    reachable           BOOLEAN NOT NULL,
    snmp_mode           TEXT NOT NULL,
    snmp_state          TEXT NOT NULL,
    cpu_percent         REAL,
    memory_percent      REAL,
    network_mbps        REAL,
    temperature_celsius REAL,
    checked_at          TIMESTAMPTZ NOT NULL,  -- the monitor's own last_checked_at
    recorded_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_camera_health_history_monitor_checked
    ON camera_health_history (monitor_id, checked_at DESC);
```

Insert-only, and structurally separate from `camera_status_history` (see Global Constraints — these are two different tables for two different signals, not two views onto one). "Latest health per camera" is computed via this index (`ORDER BY checked_at DESC LIMIT 1` per `monitor_id`, driven by a `LATERAL` join from `cameras`) — no separate denormalized "latest" table.

## C. Poller

In-process `asyncio` background task, started and stopped via FastAPI's `lifespan` context manager (confirmed: `main.py` currently has zero lifespan/startup/shutdown/background-task infrastructure — this introduces the pattern fresh, using the modern `lifespan=` argument, not the deprecated `@app.on_event`).

Add `httpx` to `backend-registry/requirements.txt` (confirmed absent from runtime deps; only present in `requirements-dev.txt` today).

```python
SNMP_MONITOR_BASE_URL = os.environ.get("SNMP_MONITOR_BASE_URL", "http://netra-snmp-monitor:9116")
SNMP_POLL_INTERVAL_SECONDS = int(os.environ.get("SNMP_POLL_INTERVAL_SECONDS", "45"))
SNMP_HTTP_TIMEOUT_SECONDS = 5.0  # bounded -- a hung monitor must never stall the poll loop indefinitely

@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.snmp_http_client = httpx.AsyncClient(
        base_url=SNMP_MONITOR_BASE_URL, timeout=SNMP_HTTP_TIMEOUT_SECONDS,
    )
    app.state.health_poll_task = asyncio.create_task(
        poll_camera_health_loop(app.state.snmp_http_client)
    )
    yield
    app.state.health_poll_task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await app.state.health_poll_task
    await app.state.snmp_http_client.aclose()

app = FastAPI(lifespan=lifespan)
```

```python
async def poll_camera_health_loop(client: httpx.AsyncClient):
    while True:
        try:
            await poll_camera_health_once(client)
        except Exception:
            logger.exception("SNMP health poll cycle failed")
        await asyncio.sleep(SNMP_POLL_INTERVAL_SECONDS)

async def poll_camera_health_once(client: httpx.AsyncClient):
    with get_conn() as conn:
        monitor_ids = camera_health_service.list_assigned_monitor_ids(conn)
    if not monitor_ids:
        return  # no cameras assigned yet -- clean no-op, the common case today

    resp = await client.get("/v1/devices")  # one bulk call for all 30, not 30 round-trips
    resp.raise_for_status()
    devices = resp.json()

    with get_conn() as conn:
        for device in devices:
            if device.get("id") not in monitor_ids:
                continue
            try:
                camera_health_service.record_health(conn, device)
            except Exception:
                logger.exception("Failed to record health for device %s", device.get("id"))
                # one bad/malformed device must not lose the other 29
```

`poll_camera_health_once` is the directly-unit-testable seam (mock `client.get`, assert history rows / no-op / partial-failure behavior — no need to test the infinite loop itself).

**Open item for the implementer:** Dhruv's handoff only shows the single-device example response (`GET /v1/devices/{camera_id}`), not the bulk `GET /v1/devices` envelope shape. This design assumes `resp.json()` is a bare JSON array of device objects (each shaped like the single-device example). Confirm this against the actual mock monitor before writing `poll_camera_health_once`'s parsing — if it's wrapped (e.g. `{"devices": [...]}`), adjust the one line that extracts the list; nothing else in this design depends on which it is.

`GET /v1/devices/{camera_id}` (singular) is deliberately unused by this design — no on-demand single-camera refresh is built here (YAGNI; the bulk sweep every interval is sufficient for 30 cameras). It remains available for a future feature if one is ever needed.

**Clean shutdown:** the lifespan's `yield` point cancels the loop task and awaits its `CancelledError`, then closes the `httpx.AsyncClient` — no dangling task, no leaked connection, on every app shutdown (including test teardown, since `TestClient` exercises the lifespan).

## D. API surface

`cameras_service.py`'s camera-listing queries (`list_cameras`, `get_camera`) gain a `LATERAL` join to the latest `camera_health_history` row per `monitor_id`, and the response gains:

```
monitor_status, monitor_reachable, monitor_snmp_mode, monitor_snmp_state,
monitor_cpu_percent, monitor_memory_percent, monitor_network_mbps, monitor_temperature_celsius,
monitor_checked_at
```

plus the already-existing-as-of-part-A `location_confidence`. All `monitor_*` fields are `null` when the camera has no `monitor_id` or no history row yet. `monitor_snmp_mode`/`monitor_snmp_state` pass through exactly what the monitor reported (currently always `"mock"`/`"simulated"`) — never overridden. `location_confidence` is included in the same response so a consumer can gate on it directly (`"unknown"` → treat `lat`/`long` as an estimate, not a verified position) without a second lookup.

Field names are deliberately namespaced (`monitor_*`) and drawn from a **separate table** to stay fully independent of the camera's own pre-existing `connectivity_status`/`health_status` (written only via `PUT /cameras/{id}`, driven by the frontend's playback/reachability poll) — see Global Constraints. `GET /cameras/{id}/uptime` (existing, reads `camera_status_history`) is untouched by this design; an implementer should not confuse its "uptime windows" (playback reachability over time) with this feature's `camera_health_history` (device-level SNMP telemetry) — the names are similar, the data and write paths are completely separate.

## E. Retention

At 30 cameras × one poll per 45s, `camera_health_history` grows by roughly 57,600 rows/day. This is operational telemetry, not evidentiary data (see Global Constraints), so retention is a straight `DELETE`, not an archive-table move.

**Decision:** default retention window of 30 days (`SNMP_HEALTH_HISTORY_RETENTION_DAYS`, env-configurable). A standalone script, `backend-registry/scripts/prune_camera_health_history.py --days N`, is a small, self-contained operational CLI (argparse, prints the count removed, meant to be run by hand or wired into a cron/CI schedule — this plan does not add scheduling infrastructure itself). Not run automatically by the poller itself — an explicit, auditable, separately-invoked operation.

## Testing

TDD throughout:

- **Backfill script:** idempotency (re-running produces the same 30 rows unchanged), correct `location`/`location_confidence`/`monitor_id` per camera id, the unique-index constraint holding.
- **Poller (`poll_camera_health_once`):** a mocked bulk response records history rows only for devices whose id is an assigned `monitor_id`; a device present in the response but not assigned is ignored; zero assigned `monitor_id`s is a clean no-op with no HTTP call made at all; one malformed device in the response doesn't prevent the other devices' rows from being recorded; an HTTP failure (timeout, 5xx) is caught and logged, never raised out of the loop.
- **Lifespan:** the background task is actually cancelled and the `httpx.AsyncClient` actually closed on app shutdown (assert via `TestClient`'s context-manager exit).
- **API (`GET /cameras`):** `monitor_*` fields are `null` for a camera with no `monitor_id`; populated correctly after a history row exists; `location_confidence` round-trips; the existing response shape gains only new fields, no existing field changes. A test that a `PUT /cameras/{id}` connectivity-status change never touches `camera_health_history`, and a poller cycle never touches `camera_status_history`/`cameras.connectivity_status`/`cameras.health_status` — the isolation the Global Constraints require, made concrete.
- **Pruning script:** rows older than the cutoff are deleted, rows newer are kept, `--days` is respected.
