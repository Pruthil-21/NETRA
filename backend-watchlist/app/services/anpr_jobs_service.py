"""Manual Plate Lookup — job lifecycle, local-disk upload storage, and the
dispatch handoff to ml-anpr's on-demand endpoint.

An officer submits one of three input types (upload_video, upload_image,
archive_clip); each becomes one row in anpr_jobs (status: pending ->
processing -> completed/failed). Every job dispatches against a per-district
"virtual capture" camera (backend-registry's cameras.is_virtual_capture) so a
successful result still flows through the ordinary detections/alerts
pipeline unchanged -- this service only owns the job's own lifecycle plus
upload storage, never the detection itself.
"""
import hashlib
import os
import uuid
from pathlib import Path

import httpx
from fastapi import UploadFile
from psycopg2.extras import RealDictCursor

from ..config import settings
from ..logging_config import logger

_CANCELLABLE_STATUSES = ("pending", "processing")

_CHUNK_SIZE = 1024 * 1024  # 1 MiB

# Minimal magic-byte sniffing, no extra dependency -- this is a bounded,
# fixed allow-list (2 video containers, 2 image formats), not a general
# file-type detector, so a small hand-rolled check is appropriate here
# rather than pulling in python-magic/filetype for four signatures.
_VIDEO_SIGNATURES = (
    (4, b"ftyp"),               # MP4/MOV family (ftyp box at offset 4)
    (0, b"\x1a\x45\xdf\xa3"),   # WebM/Matroska (EBML header)
)
_IMAGE_SIGNATURES = (
    (0, b"\xff\xd8\xff"),                           # JPEG
    (0, b"\x89PNG\r\n\x1a\n"),                       # PNG
)


class UploadRejected(ValueError):
    """Raised for any client-supplied upload that fails validation -- size,
    declared type, or actual (sniffed) content. Routers translate this into
    a 400, never a 500: a bad upload is an expected, common client error."""


def _sniff_ok(header: bytes, signatures: tuple[tuple[int, bytes], ...]) -> bool:
    return any(header[offset:offset + len(magic)] == magic for offset, magic in signatures)


def _validate_declared_type(input_type: str, content_type: str | None) -> None:
    if input_type == "upload_video" and not (content_type or "").startswith("video/"):
        raise UploadRejected(f"Expected a video file, got content-type '{content_type}'")
    if input_type == "upload_image" and not (content_type or "").startswith("image/"):
        raise UploadRejected(f"Expected an image file, got content-type '{content_type}'")


def _max_bytes_for(input_type: str) -> int:
    return settings.anpr_max_video_bytes if input_type == "upload_video" else settings.anpr_max_image_bytes


def save_upload_streaming(upload_file: UploadFile, job_id: int, input_type: str) -> dict:
    """Streams the upload to disk while hashing it (SHA-256, never fully
    buffered in memory first), enforcing the size cap as bytes arrive rather
    than after the fact -- an oversized file is aborted and its partial
    write deleted, not read to completion first. Raises UploadRejected on
    any validation failure (size, declared type, sniffed content); returns
    {"path", "size_bytes", "sha256"} on success.
    """
    _validate_declared_type(input_type, upload_file.content_type)
    max_bytes = _max_bytes_for(input_type)

    job_dir = Path(settings.anpr_upload_dir) / str(job_id)
    job_dir.mkdir(parents=True, exist_ok=True)
    safe_name = os.path.basename(upload_file.filename or "upload")
    dest_path = job_dir / f"{uuid.uuid4().hex[:8]}_{safe_name}"

    hasher = hashlib.sha256()
    total = 0
    first_chunk = b""
    try:
        with open(dest_path, "wb") as out:
            while True:
                chunk = upload_file.file.read(_CHUNK_SIZE)
                if not chunk:
                    break
                if not first_chunk:
                    first_chunk = chunk
                total += len(chunk)
                if total > max_bytes:
                    raise UploadRejected(
                        f"File exceeds the {max_bytes // (1024 * 1024)}MB limit for {input_type}"
                    )
                hasher.update(chunk)
                out.write(chunk)
    except UploadRejected:
        dest_path.unlink(missing_ok=True)
        raise

    signatures = _VIDEO_SIGNATURES if input_type == "upload_video" else _IMAGE_SIGNATURES
    if not _sniff_ok(first_chunk, signatures):
        dest_path.unlink(missing_ok=True)
        raise UploadRejected("File content doesn't match a supported format for this input type")

    return {"path": str(dest_path), "size_bytes": total, "sha256": hasher.hexdigest()}


def resolve_virtual_camera_id(db: RealDictCursor, district: str) -> int | None:
    db.execute(
        "SELECT id FROM cameras WHERE dept = %s AND is_virtual_capture = true LIMIT 1",
        (district,),
    )
    row = db.fetchone()
    return row["id"] if row else None


def resolve_camera_for_archive_clip(db: RealDictCursor, camera_id: int) -> dict | None:
    """None means "not a valid archive-clip source": either the camera
    doesn't exist, or it's itself a virtual-capture placeholder (no real
    footage exists for it -- see cameras.is_virtual_capture)."""
    db.execute("SELECT dept, is_virtual_capture FROM cameras WHERE id = %s", (camera_id,))
    row = db.fetchone()
    if row is None or row["is_virtual_capture"]:
        return None
    return row


def create_job(
    db: RealDictCursor,
    *,
    input_type: str,
    submitted_by: str,
    district: str,
    stored_file_path: str | None = None,
    original_filename: str | None = None,
    file_size_bytes: int | None = None,
    file_sha256: str | None = None,
    source_camera_id: int | None = None,
    clip_start=None,
    clip_end=None,
    recorded_at=None,
) -> dict:
    db.execute(
        """
        INSERT INTO anpr_jobs (
            input_type, status, submitted_by, district, stored_file_path,
            original_filename, file_size_bytes, file_sha256, source_camera_id,
            clip_start, clip_end, recorded_at
        )
        VALUES (%s, 'pending', %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        RETURNING *
        """,
        (
            input_type, submitted_by, district, stored_file_path,
            original_filename, file_size_bytes, file_sha256, source_camera_id,
            clip_start, clip_end, recorded_at,
        ),
    )
    return db.fetchone()


def get_job(db: RealDictCursor, job_id: int) -> dict | None:
    db.execute("SELECT * FROM anpr_jobs WHERE id = %s", (job_id,))
    return db.fetchone()


def is_job_visible(job: dict, *, submitted_by: str, dept_scopes: list[str] | None, can_view_others: bool) -> bool:
    """Default visibility is "my own submissions only". An officer who also
    holds view_analytics additionally sees every job in their district scope
    (None = platform-wide, sees everything; [] = no jurisdiction, sees
    nothing beyond their own) -- mirrors alerts_service.list_alerts's
    dual-visibility shape, just single-district rather than the dual
    detecting/flagging-district rule (a job has exactly one district)."""
    if job["submitted_by"] == submitted_by:
        return True
    if not can_view_others:
        return False
    if dept_scopes is None:
        return True
    return job["district"] in dept_scopes


def list_jobs(
    db: RealDictCursor, *, submitted_by: str, dept_scopes: list[str] | None, can_view_others: bool
) -> list[dict]:
    if not can_view_others:
        db.execute("SELECT * FROM anpr_jobs WHERE submitted_by = %s ORDER BY created_at DESC", (submitted_by,))
        return db.fetchall()
    if dept_scopes is None:
        db.execute("SELECT * FROM anpr_jobs ORDER BY created_at DESC")
        return db.fetchall()
    if not dept_scopes:
        db.execute("SELECT * FROM anpr_jobs WHERE submitted_by = %s ORDER BY created_at DESC", (submitted_by,))
        return db.fetchall()
    db.execute(
        "SELECT * FROM anpr_jobs WHERE submitted_by = %s OR district = ANY(%s) ORDER BY created_at DESC",
        (submitted_by, dept_scopes),
    )
    return db.fetchall()


def update_job_status(
    db: RealDictCursor, job_id: int, *, status: str, detection_id: int | None = None,
    plate_number: str | None = None, error_message: str | None = None,
) -> dict | None:
    db.execute(
        """
        UPDATE anpr_jobs SET status = %s, detection_id = %s, plate_number = %s,
            error_message = %s, updated_at = now()
        WHERE id = %s
        RETURNING *
        """,
        (status, detection_id, plate_number, error_message, job_id),
    )
    return db.fetchone()


def mark_processing(db: RealDictCursor, job_id: int) -> None:
    db.execute("UPDATE anpr_jobs SET status = 'processing', updated_at = now() WHERE id = %s", (job_id,))


def cancel_job(db: RealDictCursor, job_id: int) -> dict | None:
    """Only from pending/processing -- a completed/failed/already-cancelled
    job has nothing left to cancel. The WHERE clause enforces this
    atomically (no separate check-then-update race): returns None either
    because the job doesn't exist or because it's already terminal, and the
    router can't tell those apart from this alone, so it re-fetches to
    report the right error either way."""
    db.execute(
        """
        UPDATE anpr_jobs SET status = 'cancelled', updated_at = now()
        WHERE id = %s AND status = ANY(%s)
        RETURNING *
        """,
        (job_id, list(_CANCELLABLE_STATUSES)),
    )
    return db.fetchone()


def add_job_results(db: RealDictCursor, job_id: int, results: list[dict]) -> list[dict]:
    """Inserts every plate ml-anpr reported for one completion callback.
    Each dict: {detection_id, plate_number, confidence?, detected_at?, box_area?}."""
    inserted = []
    for r in results:
        db.execute(
            """
            INSERT INTO anpr_job_results (job_id, detection_id, plate_number, confidence, detected_at, box_area)
            VALUES (%s, %s, %s, %s, %s, %s)
            RETURNING *
            """,
            (job_id, r.get("detection_id"), r["plate_number"], r.get("confidence"), r.get("detected_at"), r.get("box_area")),
        )
        inserted.append(db.fetchone())
    return inserted


def list_job_results(db: RealDictCursor, job_id: int, input_type: str) -> list[dict]:
    """Nearest-to-farthest (biggest box_area first) for a photo -- the only
    ordering signal available with no depth sensor; chronological (earliest
    detected_at first) for a video/clip, since that's what "which plate
    showed up when" means for footage. NULLS LAST either way so a result
    missing the sort signal doesn't silently jump to the front."""
    if input_type == "upload_image":
        db.execute(
            "SELECT * FROM anpr_job_results WHERE job_id = %s "
            "ORDER BY box_area DESC NULLS LAST, confidence DESC NULLS LAST, id ASC",
            (job_id,),
        )
    else:
        db.execute(
            "SELECT * FROM anpr_job_results WHERE job_id = %s "
            "ORDER BY detected_at ASC NULLS LAST, id ASC",
            (job_id,),
        )
    return db.fetchall()


def resolve_stored_file(job: dict) -> tuple[str, str] | None:
    """(absolute_path, content_type) for GET /anpr-jobs/{id}/file, or None
    when this job has no stored upload (an archive_clip job, or an upload
    job that hasn't finished streaming to disk yet). Content type is
    guessed from the extension -- good enough for the fixed, validated set
    of formats save_upload_streaming already accepts, no need to have
    stored it separately at upload time."""
    import mimetypes

    path = job.get("stored_file_path")
    if not path or not os.path.isfile(path):
        return None
    content_type = mimetypes.guess_type(path)[0] or "application/octet-stream"
    return path, content_type


def pick_primary_result(sorted_results: list[dict]) -> dict | None:
    """The one result denormalized onto anpr_jobs itself (job list headline,
    push notification text) -- nearest for a photo, earliest for a clip.
    `sorted_results` must already be in list_job_results' order: this is
    just "whichever sorts first"."""
    return sorted_results[0] if sorted_results else None


def _fetch_fresh_clip_url(source_camera_id: int, clip_start, clip_end) -> str | None:
    """Calls backend-registry's one internal-only endpoint for this
    (GET /internal/cameras/{id}/recording-clip-url) rather than duplicating
    RECORDING_SERVICE_KEY into this service -- that key is deliberately
    confined to backend-registry (see recordings_service.py's docstring).
    Returns None on any failure (unreachable, no segments) -- the caller
    treats that as a normal job-failure reason, not a crash."""
    response = httpx.get(
        f"{settings.registry_internal_url}/internal/cameras/{source_camera_id}/recording-clip-url",
        params={"start": clip_start.isoformat(), "end": clip_end.isoformat()},
        headers={"X-Internal-Key": settings.internal_service_key},
        timeout=10.0,
    )
    response.raise_for_status()
    return response.json().get("url")


def dispatch_to_ml_anpr(job_id: int) -> None:
    """Fire-and-forget call to ml-anpr's on-demand endpoint, meant to run
    inside a BackgroundTask (see routers/anpr_jobs.py) so the officer's
    POST returns immediately with status='pending'. Re-reads the job row
    fresh (rather than trusting a dict captured at request time) since this
    runs moments later in a separate DB connection/thread. Any failure here
    -- unconfigured URL, no virtual camera for this district, an archive
    clip with no recording available, connection refused, non-2xx -- marks
    the job 'failed' with a clear error rather than leaving it stuck in
    'pending' forever; the officer sees this on their next poll, same as
    ml-anpr later calling PATCH /anpr-jobs/{id} for a real processing
    failure."""
    from ..database import get_connection  # local import: avoid a cycle at module load

    urls = _pipeline_urls()
    if not urls:
        _fail_job(job_id, "ANPR pipeline isn't configured yet (ANPR_PIPELINE_URL unset)")
        return

    with get_connection() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as db:
            job = get_job(db, job_id)
            if job is None:
                logger.error(f"anpr_job {job_id}: vanished before dispatch")
                return
            camera_id = resolve_virtual_camera_id(db, job["district"])

    if camera_id is None:
        _fail_job(job_id, f"No capture camera is set up yet for district '{job['district']}'")
        return

    clip_url = None
    if job["input_type"] == "archive_clip":
        try:
            clip_url = _fetch_fresh_clip_url(job["source_camera_id"], job["clip_start"], job["clip_end"])
        except httpx.HTTPError as exc:
            logger.warning(f"anpr_job {job_id}: fresh clip URL fetch failed: {exc}")
        if not clip_url:
            _fail_job(job_id, "No recording is available for the marked camera/time range")
            return

    # ml-anpr runs on a different host (its own tunnel) -- a local
    # filesystem path here is meaningless to it, the same way clip_url has
    # to be a real fetchable URL rather than our internal recording-service
    # path. file_url points back at our own new download endpoint (internal-
    # key gated, same trust boundary as everything else ml-anpr calls),
    # reachable over the same public tunnel as callback_url.
    file_url = (
        f"{settings.anpr_callback_base_url}/anpr-jobs/{job_id}/file"
        if job.get("stored_file_path") else None
    )
    # The one piece ml-anpr needs to turn a frame offset into a real
    # detected_at: archive_clip always has one (clip_start, exact -- that's
    # literally what was marked in Archive); upload_video only has one if
    # the officer supplied it at upload time (recorded_at, optional -- an
    # arbitrary file has no other time anchor); upload_image never has one,
    # there's no timeline to anchor. Null here is ml-anpr's own signal to
    # omit detected_at for this job's results, same as it already must for
    # a photo -- not an error, just "provenance unknown."
    if job["input_type"] == "archive_clip":
        recording_start_time = job["clip_start"]
    elif job["input_type"] == "upload_video":
        recording_start_time = job.get("recorded_at")
    else:
        recording_start_time = None

    payload = {
        "job_id": job_id,
        "camera_id": camera_id,
        "callback_url": f"{settings.anpr_callback_base_url}/anpr-jobs/{job_id}",
        "input_type": job["input_type"],
        "file_url": file_url,
        "clip_url": clip_url,
        "recording_start_time": recording_start_time.isoformat() if recording_start_time else None,
    }
    try:
        with get_connection() as conn:
            with conn.cursor(cursor_factory=RealDictCursor) as db:
                mark_processing(db, job_id)
        response = _post_to_first_reachable_pipeline(job_id, urls, payload)
        response.raise_for_status()
    except httpx.HTTPError as exc:
        logger.warning(f"anpr_job {job_id}: dispatch to ml-anpr failed: {exc}")
        _fail_job(job_id, "Couldn't reach the ANPR pipeline -- please try again shortly")
    except Exception:  # noqa: BLE001 -- background task, must never crash silently uncaught
        logger.error(f"anpr_job {job_id}: unexpected dispatch error", exc_info=True)
        _fail_job(job_id, "Unexpected error dispatching this job -- please try again")


def _pipeline_urls() -> list[str]:
    """ml-anpr dispatch targets in priority order -- Avi's GPU-server tunnel
    first, his laptop tunnel as fallback (see config.py). Only configured,
    non-duplicate URLs are included, so an unset fallback or a fallback
    that's identical to the primary never results in a pointless second
    attempt against the same address."""
    urls = [settings.anpr_pipeline_url, settings.anpr_pipeline_fallback_url]
    seen: set[str] = set()
    result: list[str] = []
    for url in urls:
        if url and url not in seen:
            seen.add(url)
            result.append(url)
    return result


def _post_to_first_reachable_pipeline(job_id: int, urls: list[str], payload: dict) -> httpx.Response:
    """POSTs the dispatch payload to each configured pipeline URL in order,
    moving to the next only when the current one is truly unreachable
    (connection refused/timed out -- httpx.TransportError) -- a server that
    responds, even with a 4xx/5xx, is "online," and that error should
    surface as this job's real failure reason rather than triggering a
    silent retry against a different machine. Raises the last connection
    error if every configured URL was unreachable; `urls` is guaranteed
    non-empty by the caller (see the `if not urls` early-return above)."""
    last_exc: httpx.TransportError | None = None
    for i, base_url in enumerate(urls):
        try:
            return httpx.post(
                f"{base_url}/jobs/run",
                json=payload,
                headers={"X-Internal-Key": settings.internal_service_key},
                timeout=10.0,
            )
        except httpx.TransportError as exc:
            last_exc = exc
            remaining = urls[i + 1:]
            logger.warning(
                f"anpr_job {job_id}: {base_url} unreachable ({exc}); "
                + (f"trying fallback {remaining[0]}" if remaining else "no further pipeline URL configured")
            )
    raise last_exc  # every configured URL was unreachable


def _fail_job(job_id: int, error_message: str) -> None:
    from ..database import get_connection

    try:
        with get_connection() as conn:
            with conn.cursor(cursor_factory=RealDictCursor) as db:
                update_job_status(db, job_id, status="failed", error_message=error_message)
    except Exception:  # noqa: BLE001
        logger.error(f"anpr_job {job_id}: failed to record dispatch failure", exc_info=True)


def cleanup_expired_uploads(db: RealDictCursor, retention_days: int) -> int:
    """Deletes the on-disk bytes for any upload older than retention_days --
    never the anpr_jobs row itself (metadata, hash, linked detection/search
    results are the evidentiary record and are kept indefinitely, same as
    "detections are never deleted" elsewhere in this stack). Once a file is
    gone, GET /anpr-jobs/{id}/file already reports "no stored file" on its
    own (resolve_stored_file checks os.path.isfile) -- no other code needs to
    change. Idempotent and safe to re-run: a job whose file was already
    removed (or never had one) is simply skipped. Returns how many files
    were actually deleted, for the caller to log."""
    from ..services import audit_service

    db.execute(
        """
        SELECT id, stored_file_path FROM anpr_jobs
        WHERE stored_file_path IS NOT NULL AND created_at < now() - make_interval(days => %s)
        """,
        (retention_days,),
    )
    candidates = db.fetchall()

    deleted = 0
    for row in candidates:
        path = Path(row["stored_file_path"])
        if not path.is_file():
            continue
        try:
            path.unlink()
            try:
                path.parent.rmdir()  # only succeeds if now empty -- fine either way
            except OSError:
                pass
        except OSError:
            logger.warning(f"anpr_job {row['id']}: failed to delete expired upload {path}", exc_info=True)
            continue
        audit_service.log(
            db, "system", "delete_file", "anpr_job", row["id"],
            reason_code=f"retention period expired ({retention_days} days)",
        )
        deleted += 1
    return deleted


def _run_cleanup_tick() -> None:
    from ..database import get_connection

    with get_connection() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as db:
            deleted = cleanup_expired_uploads(db, settings.anpr_upload_retention_days)
    if deleted:
        logger.info(f"anpr upload cleanup: deleted {deleted} expired file(s)")


async def run_periodic_upload_cleanup():
    """Background task, one sweep every settings.anpr_cleanup_interval_seconds
    -- started from main.py's startup event, cancelled on shutdown. Same
    shape as traffic_alerts_service.run_periodic_evaluation: runs the sync DB
    work in a thread so a sweep never blocks the event loop, and one failed
    tick is logged and skipped rather than killing the loop (the next sweep
    catches up on whatever this one missed)."""
    import asyncio

    while True:
        try:
            await asyncio.to_thread(_run_cleanup_tick)
        except Exception:  # noqa: BLE001 -- one bad tick must not kill the loop; see docstring
            logger.exception("anpr upload cleanup tick failed")
        await asyncio.sleep(settings.anpr_cleanup_interval_seconds)
