"""Manual Plate Lookup — an officer submits a video/image upload or marks an
Archive camera+timestamp range; it's dispatched to ml-anpr's on-demand
endpoint and the resulting plate (if any) flows through the ordinary
detections/alerts pipeline via a per-district virtual capture camera. See
services/anpr_jobs_service.py for the job lifecycle and dispatch logic.
"""
from datetime import datetime

from fastapi import (
    APIRouter,
    BackgroundTasks,
    Depends,
    File,
    Form,
    HTTPException,
    UploadFile,
)
from fastapi.responses import FileResponse
from psycopg2.extras import RealDictCursor

from ..auth import has_permission, require_internal_key, require_permission
from ..database import get_db
from ..rbac_scope import effective_district_scopes
from ..schemas import AnprJobCallback, AnprJobOut, ArchiveClipJobIn
from ..services import anpr_jobs_service, audit_service, push_service

router = APIRouter(prefix="/anpr-jobs", tags=["anpr-jobs"])


def _actor(user: dict) -> str:
    return user.get("badge_number", user.get("sub"))


def _guard_district_in_scope(user: dict, district: str) -> None:
    dept_scopes = effective_district_scopes(user)
    if dept_scopes is not None and district not in dept_scopes:
        raise HTTPException(status_code=403, detail="That district is outside your jurisdiction")


def _district_exists(db: RealDictCursor, district: str) -> bool:
    db.execute("SELECT 1 FROM districts WHERE name = %s", (district,))
    return db.fetchone() is not None


@router.post("/upload", response_model=AnprJobOut, status_code=201)
def submit_upload_job(
    background_tasks: BackgroundTasks,
    input_type: str = Form(...),
    district: str = Form(...),
    file: UploadFile = File(...),
    recorded_at: str | None = Form(None),
    db: RealDictCursor = Depends(get_db),
    user=Depends(require_permission("run_anpr_lookup")),
):
    if input_type not in ("upload_video", "upload_image"):
        raise HTTPException(status_code=400, detail="input_type must be upload_video or upload_image")
    if not _district_exists(db, district):
        raise HTTPException(status_code=400, detail="district must be a valid Gujarat district")
    _guard_district_in_scope(user, district)

    parsed_recorded_at = None
    if recorded_at:
        try:
            parsed_recorded_at = datetime.fromisoformat(recorded_at.replace("Z", "+00:00"))
        except ValueError:
            raise HTTPException(status_code=400, detail="recorded_at must be a valid ISO 8601 timestamp")

    actor = _actor(user)
    # Insert first (with no file yet) to get a real id -- the upload is
    # streamed to disk under uploads/anpr_jobs/{job_id}/, so the id has to
    # exist before the first byte is written.
    job = anpr_jobs_service.create_job(
        db, input_type=input_type, submitted_by=actor, district=district, recorded_at=parsed_recorded_at
    )

    try:
        saved = anpr_jobs_service.save_upload_streaming(file, job["id"], input_type)
    except anpr_jobs_service.UploadRejected as exc:
        anpr_jobs_service.update_job_status(db, job["id"], status="failed", error_message=str(exc))
        raise HTTPException(status_code=400, detail=str(exc))

    db.execute(
        "UPDATE anpr_jobs SET stored_file_path = %s, original_filename = %s, "
        "file_size_bytes = %s, file_sha256 = %s, updated_at = now() WHERE id = %s RETURNING *",
        (saved["path"], file.filename, saved["size_bytes"], saved["sha256"], job["id"]),
    )
    job = db.fetchone()

    audit_service.log(db, actor, "create", "anpr_job", job["id"])
    background_tasks.add_task(anpr_jobs_service.dispatch_to_ml_anpr, job["id"])
    return job


@router.post("/archive-clip", response_model=AnprJobOut, status_code=201)
def submit_archive_clip_job(
    body: ArchiveClipJobIn,
    background_tasks: BackgroundTasks,
    db: RealDictCursor = Depends(get_db),
    user=Depends(require_permission("run_anpr_lookup")),
):
    camera = anpr_jobs_service.resolve_camera_for_archive_clip(db, body.source_camera_id)
    if camera is None:
        raise HTTPException(status_code=404, detail="Camera not found")
    district = camera["dept"]
    _guard_district_in_scope(user, district)

    actor = _actor(user)
    job = anpr_jobs_service.create_job(
        db,
        input_type="archive_clip",
        submitted_by=actor,
        district=district,
        source_camera_id=body.source_camera_id,
        clip_start=body.clip_start,
        clip_end=body.clip_end,
    )
    audit_service.log(db, actor, "create", "anpr_job", job["id"])
    background_tasks.add_task(anpr_jobs_service.dispatch_to_ml_anpr, job["id"])
    return job


@router.get("", response_model=list[AnprJobOut])
def list_jobs(
    db: RealDictCursor = Depends(get_db),
    user=Depends(require_permission("run_anpr_lookup")),
):
    return anpr_jobs_service.list_jobs(
        db,
        submitted_by=_actor(user),
        dept_scopes=effective_district_scopes(user),
        can_view_others=has_permission(user, "view_analytics"),
    )


@router.get("/{job_id}", response_model=AnprJobOut)
def get_job(
    job_id: int,
    db: RealDictCursor = Depends(get_db),
    user=Depends(require_permission("run_anpr_lookup")),
):
    job = anpr_jobs_service.get_job(db, job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    actor = _actor(user)
    if not anpr_jobs_service.is_job_visible(
        job, submitted_by=actor, dept_scopes=effective_district_scopes(user),
        can_view_others=has_permission(user, "view_analytics"),
    ):
        raise HTTPException(status_code=404, detail="Job not found")
    audit_service.log(db, actor, "view", "anpr_job", job_id)
    job["results"] = anpr_jobs_service.list_job_results(db, job_id, job["input_type"])
    return job


@router.get("/{job_id}/file")
def download_job_file(
    job_id: int,
    db: RealDictCursor = Depends(get_db),
    _=Depends(require_internal_key),
):
    """Serves an uploaded clip/image's bytes -- internal-key gated, same
    trust boundary as POST /detections and the completion callback. ml-anpr
    runs on its own host/tunnel, so the local disk path stored_file_path
    resolves to is meaningless to it; this is what dispatch_to_ml_anpr's
    file_url actually points ml-anpr at, mirroring how archive_clip jobs
    already hand it a real fetchable clip_url instead of an internal path."""
    job = anpr_jobs_service.get_job(db, job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    resolved = anpr_jobs_service.resolve_stored_file(job)
    if resolved is None:
        raise HTTPException(status_code=404, detail="No stored file for this job")
    path, content_type = resolved
    return FileResponse(path, media_type=content_type, filename=job.get("original_filename") or None)


@router.patch("/{job_id}", response_model=AnprJobOut)
def complete_job(
    job_id: int,
    body: AnprJobCallback,
    db: RealDictCursor = Depends(get_db),
    _=Depends(require_internal_key),
):
    """ml-anpr's completion callback -- internal-key gated, same as POST
    /detections. Not an officer-facing route: no permission/scope check,
    the shared internal key is the entire trust boundary here. A photo/clip
    can report several plates (body.results); the one denormalized onto the
    job row itself (nearest for a photo, earliest for a clip -- see
    anpr_jobs_service.pick_primary_result) drives the job list headline and
    push text, while the full ordered set is fetched separately by
    GET /anpr-jobs/{id}."""
    existing = anpr_jobs_service.get_job(db, job_id)
    if existing is None:
        raise HTTPException(status_code=404, detail="Job not found")

    if body.results:
        anpr_jobs_service.add_job_results(db, job_id, [r.model_dump() for r in body.results])
    results = anpr_jobs_service.list_job_results(db, job_id, existing["input_type"])
    primary = anpr_jobs_service.pick_primary_result(results)

    job = anpr_jobs_service.update_job_status(
        db, job_id, status=body.status,
        detection_id=primary["detection_id"] if primary else None,
        plate_number=primary["plate_number"] if primary else None,
        error_message=body.error_message,
    )
    audit_service.log(db, "ml-anpr", body.status, "anpr_job", job_id)

    # Reaches only the officer who submitted this job -- not a district-wide
    # broadcast like a watchlist alert, since a lookup job is that one
    # officer's own request. push_service no-ops if VAPID isn't configured,
    # same graceful-degrade posture as every other alert-worthy event.
    title = "Plate lookup complete" if job["status"] == "completed" else "Plate lookup failed"
    if job["status"] == "completed":
        body_text = (
            f"{len(results)} plate{'s' if len(results) != 1 else ''} found"
            if results else "Completed -- no plate was found"
        )
    else:
        body_text = job["error_message"] or "The submission couldn't be processed"
    push_service.send_to_badges(
        db, [job["submitted_by"]],
        {"title": title, "body": body_text, "url": f"/plate-lookup/{job_id}"},
    )
    job["results"] = results
    return job
