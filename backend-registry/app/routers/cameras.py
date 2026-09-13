"""Camera registry CRUD, pagination/scale-demo surface, uptime, SNMP health,
recordings, and the synthetic-detection ingestion endpoint used by the
scale-demo load test."""
import psycopg
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import ValidationError

from ..auth import (
    get_current_user,
    has_permission,
    require_internal_key,
    require_permission,
    require_scale_demo_enabled,
)
from ..config import settings
from ..db import get_conn
from ..logging_config import logger
from ..rbac_scope import (
    effective_district_scopes,
    guard_dept_in_scope,
    resolve_district_scoped,
)
from ..schemas import (
    CameraBulkResult,
    CameraCreate,
    CameraOut,
    CameraUpdate,
    CameraUptimeReport,
    SyntheticDetectionEventAccepted,
    SyntheticDetectionEventIn,
    TestStreamIn,
    TestStreamOut,
)
from ..services import (
    areas_service,
    audit_service,
    cameras_service,
    push_service,
    recording_health_events_service,
    recordings_service,
    snmp_service,
    stream_health_service,
    synthetic_events_service,
)

router = APIRouter(tags=["cameras"])


@router.get("/cameras")
def list_cameras(
    user=Depends(get_current_user),
    include_synthetic: bool = False,
    cursor: int | None = None,
    limit: int | None = None,
    min_lat: float | None = None,
    max_lat: float | None = None,
    min_long: float | None = None,
    max_long: float | None = None,
):
    # include_synthetic is the scale-demo surface -- gated behind the
    # environment kill-switch and manage_cameras (Super Admin/District
    # Command only, not every officer), so an ordinary officer can neither
    # see nor flood the synthetic registry. Real-camera pagination (cursor/
    # limit with include_synthetic left false) stays open to anyone
    # authenticated, same as today.
    if include_synthetic:
        require_scale_demo_enabled()
        if not has_permission(user, "manage_cameras"):
            raise HTTPException(status_code=403, detail="Insufficient permissions")

    with get_conn() as conn:
        # scope_type is only present on RBAC-issued tokens; legacy hand-crafted
        # tokens have no such claim and see every (real) camera, matching this
        # endpoint's behavior before pagination was added. A multi-posted
        # officer's effective jurisdiction is the union of every active
        # posting's district (spec Section 3.3) -- effective_district_scopes
        # resolves that; resolve_district_scoped applies it to the
        # single-district-filter cameras_service functions below.
        dept_scopes = effective_district_scopes(user)

        # No pagination/synthetic params at all -> today's exact legacy behavior:
        # every real camera, as a bare list, no envelope. This is the path
        # CameraRegistryContext.tsx's fetchRegistryCameras() always takes.
        if cursor is None and limit is None and not include_synthetic:
            return resolve_district_scoped(
                dept_scopes,
                lambda: cameras_service.list_cameras(conn, None),
                lambda d: cameras_service.list_cameras(conn, d),
            )

        bbox = None
        if None not in (min_lat, max_lat, min_long, max_long):
            bbox = (min_lat, max_lat, min_long, max_long)

        # Cursor pagination (the scale-demo surface) doesn't compose across
        # several districts' independent cursors -- a genuinely multi-posted
        # officer gets their first/primary district here rather than a true
        # cross-district merge; [] (no jurisdiction at all) short-circuits
        # to an empty page instead of silently falling back to unfiltered.
        # Every path past this point always returns list_cameras_page's
        # {"cameras": [...], "next_cursor": ...} envelope.
        if dept_scopes == []:
            return {"cameras": [], "next_cursor": None}
        page_dept = dept_scopes[0] if dept_scopes else None

        return cameras_service.list_cameras_page(
            conn,
            cursor=cursor,
            limit=limit or 100,
            include_synthetic=include_synthetic,
            dept=page_dept,
            bbox=bbox,
        )


@router.get("/cameras/summary")
def camera_summary(
    user=Depends(get_current_user),
    group_by: str | None = None,
    min_lat: float | None = None,
    max_lat: float | None = None,
    min_long: float | None = None,
    max_long: float | None = None,
):
    require_scale_demo_enabled()
    with get_conn() as conn:
        if group_by == "district":
            bbox = None
            if None not in (min_lat, max_lat, min_long, max_long):
                bbox = (min_lat, max_lat, min_long, max_long)
            return {"districts": cameras_service.get_district_summary(conn, bbox)}
        return cameras_service.get_summary(conn)


@router.get("/cameras/{camera_id}", response_model=CameraOut)
def get_camera(camera_id: int, user=Depends(get_current_user)):
    with get_conn() as conn:
        return _require_camera_in_scope(conn, camera_id, user)


def _validate_area_for_dept(conn, area_id: int | None, dept: str) -> None:
    """Shared cross-district guard: a camera's area_id (when set) must
    belong to an area whose district matches the camera's own dept --
    otherwise the camera ends up "in" an area that lives in a different
    district, which is the exact corrupted state the global constraint
    forbids. Raises HTTPException(404/400) same as the inline checks this
    replaces in create_camera/update_camera; also used by the bulk-import
    loop below."""
    if area_id is None:
        return
    area = areas_service.get_area(conn, area_id)
    if area is None:
        raise HTTPException(status_code=404, detail="Area not found")
    if area["district"] != dept:
        raise HTTPException(status_code=400, detail="Area belongs to a different district than this camera")


@router.post("/cameras", response_model=CameraOut, status_code=201)
def create_camera(camera: CameraCreate, user=Depends(require_permission("manage_cameras"))):
    with get_conn() as conn:
        guard_dept_in_scope(conn, user, camera.dept, "camera")
        _validate_area_for_dept(conn, camera.area_id, camera.dept)
        created = cameras_service.create_camera(conn, camera.model_dump())
        audit_service.log(conn, user.get("badge_number", user.get("sub")), "create", "camera", created["id"])
        return created


@router.post("/cameras/bulk", response_model=list[CameraBulkResult])
def create_cameras_bulk(cameras: list[dict], user=Depends(require_permission("manage_cameras"))):
    """Validates and inserts each row independently -- one bad row reports an
    error for its own index instead of failing the whole batch."""
    results = []
    with get_conn() as conn:
        for index, raw in enumerate(cameras):
            try:
                validated = CameraCreate(**raw)
            except ValidationError as e:
                reason = "; ".join(
                    f"{'.'.join(str(loc) for loc in err['loc'])}: {err['msg']}" for err in e.errors()
                )
                results.append(CameraBulkResult(index=index, status="error", reason=reason))
                continue

            try:
                guard_dept_in_scope(conn, user, validated.dept, "camera")
                _validate_area_for_dept(conn, validated.area_id, validated.dept)
            except HTTPException as e:
                results.append(CameraBulkResult(index=index, status="error", reason=str(e.detail)))
                continue

            try:
                created = cameras_service.create_camera(conn, validated.model_dump())
            except psycopg.Error as e:
                conn.rollback()
                results.append(CameraBulkResult(index=index, status="error", reason=str(e)))
                continue

            audit_service.log(conn, user.get("badge_number", user.get("sub")), "create", "camera", created["id"])
            results.append(CameraBulkResult(index=index, status="created", camera=created))
    return results


@router.put("/cameras/{camera_id}", response_model=CameraOut)
def update_camera(camera_id: int, camera: CameraUpdate, user=Depends(require_permission("manage_cameras"))):
    with get_conn() as conn:
        fields = camera.model_dump(exclude_unset=True)
        # Every edit -- not just ones touching area_id/dept -- first confirms
        # the camera itself is in the officer's own jurisdiction; a
        # district-scoped officer must not be able to rename/reconfigure a
        # camera outside their district just because dept/area_id weren't
        # part of this particular PUT.
        existing = _require_camera_in_scope(conn, camera_id, user, audit_denial=True)

        if "area_id" in fields or "dept" in fields:
            effective_area_id = fields.get("area_id", existing.get("area_id"))
            effective_dept = fields.get("dept", existing["dept"])
            if "dept" in fields and effective_dept != existing["dept"]:
                # Reassigning a camera INTO a different district is itself a
                # cross-district write -- the new dept must also be within
                # the officer's own scope, not just the camera's current one.
                guard_dept_in_scope(conn, user, effective_dept, "camera", camera_id)
            _validate_area_for_dept(conn, effective_area_id, effective_dept)

        updated, connectivity_changed = cameras_service.update_camera(conn, camera_id, fields)
        if updated is None:
            raise HTTPException(status_code=404, detail="Camera not found")

        non_connectivity_fields = {k for k in fields if k != "connectivity_status"}
        if non_connectivity_fields:
            audit_service.log(conn, user.get("badge_number", user.get("sub")), "update", "camera", camera_id)
        if connectivity_changed:
            logger.info(f"camera {camera_id} connectivity changed to '{updated['connectivity_status']}'")
            if updated["connectivity_status"] == "offline":
                push_service.send_to_badges(
                    conn, push_service.recipients_for_scope(conn, updated["dept"]),
                    {
                        "title": "Camera offline",
                        "body": f"{updated['name']} ({updated['dept']}) went offline",
                        "url": "/admin",
                    },
                )

        return updated


@router.get("/cameras/{camera_id}/uptime", response_model=CameraUptimeReport)
def camera_uptime(camera_id: int, user=Depends(get_current_user)):
    with get_conn() as conn:
        camera = cameras_service.get_camera(conn, camera_id)
        if camera is None:
            raise HTTPException(status_code=404, detail="Camera not found")
        windows = cameras_service.get_uptime_windows(conn, camera_id)
        return {
            "camera_id": camera_id,
            "current_status": camera["connectivity_status"],
            "windows": windows,
        }


@router.get("/snmp/devices")
def snmp_devices(user=Depends(get_current_user)):
    return snmp_service.get_devices()


@router.get("/cameras/{camera_id}/health")
def camera_snmp_health(camera_id: int, user=Depends(get_current_user)):
    device = snmp_service.get_device_for_camera(camera_id)
    if device is None:
        raise HTTPException(status_code=404, detail="No SNMP health data available for this camera")
    return device


def _hls_url_for(hls_url: str | None, stream_id: str | None) -> str | None:
    return hls_url or (f"{settings.mediamtx_hls_url}/stream/{stream_id}/index.m3u8" if stream_id else None)


@router.get("/cameras/{camera_id}/live-check")
def camera_live_check(camera_id: int, user=Depends(get_current_user)):
    """Real reachability for this camera's HLS stream -- a server-to-server
    request, so it isn't subject to the browser CORS blind spot the old
    client-side no-cors probe had (see stream_health_service.py). Only
    covers HLS: WebRTC/WHEP reachability stays a client-side check, since
    the camera it applies to today is only reachable over Tailscale from an
    officer's own browser, not from this server."""
    with get_conn() as conn:
        camera = cameras_service.get_camera(conn, camera_id)
    if camera is None:
        raise HTTPException(status_code=404, detail="Camera not found")
    url = _hls_url_for(camera["hls_url"], camera["stream_id"])
    if not url:
        return {"reachable": False}
    return {"reachable": stream_health_service.check_hls_reachable(url)}


@router.post("/cameras/test-stream", response_model=TestStreamOut)
def test_stream(body: TestStreamIn, user=Depends(get_current_user)):
    """Same reachability check as live-check above, but for a stream_id/
    hls_url that isn't attached to any camera row yet -- backs the Add
    Camera modal's "Test Connection" button, so an officer finds out a
    video address doesn't resolve before saving instead of after, when it
    would otherwise just show up as "Feed unavailable" in the grid."""
    url = _hls_url_for(body.hls_url, body.stream_id)
    if not url:
        return {"reachable": False}
    return {"reachable": stream_health_service.check_hls_reachable(url)}


def _require_camera_in_scope(conn, camera_id: int, user: dict, *, audit_denial: bool = False) -> dict:
    """404 for a camera that doesn't exist, 403 for one outside the
    officer's own jurisdiction. Shared by the read-only recordings
    endpoints below (Dhruv's recording-service integration explicitly
    asked for "login and camera RBAC" before proxying through) and now by
    get/update/delete camera too, closing what was a pre-existing gap on
    those.

    audit_denial=True additionally logs a denied cross-district WRITE
    attempt as its own audit_logs entry (AWS CloudTrail's AccessDenied
    convention) -- left off by default for the read-only call sites below,
    where a scope miss is common/low-signal (e.g. a stale bookmark), not
    the deliberate action a failed create/update/delete represents."""
    camera = cameras_service.get_camera(conn, camera_id)
    if camera is None:
        raise HTTPException(status_code=404, detail="Camera not found")
    dept_scopes = effective_district_scopes(user)
    if dept_scopes is not None and camera["dept"] not in dept_scopes:
        if audit_denial:
            audit_service.log(
                conn, user.get("badge_number", user.get("sub")), "access_denied_scope", "camera", camera_id,
                reason_code=f"camera in {camera['dept']}, scoped to {', '.join(dept_scopes) or 'none'}",
            )
        raise HTTPException(status_code=403, detail="Camera outside your jurisdiction")
    return camera


def _actor_id(user: dict) -> str:
    return str(user.get("badge_number") or user.get("sub") or "unknown")


@router.get("/cameras/{camera_id}/recordings")
def camera_recordings(
    camera_id: int,
    start: str | None = None,
    end: str | None = None,
    user=Depends(get_current_user),
):
    with get_conn() as conn:
        camera = _require_camera_in_scope(conn, camera_id, user)
        if not camera["stream_id"]:
            # No stream_id is a configuration gap on our own camera row, not
            # the recording service itself being down -- still surfaced as
            # service_reachable: False since there's nothing to check "no
            # footage" against either way, and the officer-facing distinction
            # that matters is the same either way: "not our fault, don't
            # bother retrying," not "recheck this camera's history."
            return {"available": False, "segments": [], "service_reachable": False}
        return recordings_service.list_recordings(camera["stream_id"], _actor_id(user), start, end)


@router.get("/internal/cameras/{camera_id}/recording-clip-url")
def internal_recording_clip_url(
    camera_id: int,
    start: str,
    end: str,
    _=Depends(require_internal_key),
):
    """Service-to-service only (Manual Plate Lookup's archive-clip dispatch,
    see backend-watchlist's anpr_jobs_service.dispatch_to_ml_anpr) -- mints a
    FRESH clip URL right before handing it to ml-anpr, since the recording
    service's own URLs carry a ~15-minute token. No officer/RBAC scope check
    here: the internal key is the trust boundary, exactly like POST
    /detections; the officer-facing scope check already happened once, at
    job submission time (see routers/anpr_jobs.py)."""
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute("SELECT stream_id FROM cameras WHERE id = %s", (camera_id,))
        row = cur.fetchone()
    if row is None or not row[0]:
        return {"url": None}
    result = recordings_service.list_recordings(row[0], "anpr-job-dispatch", start, end)
    segments = result.get("segments") or []
    return {"url": segments[0]["url"] if segments else None}


@router.get("/cameras/{camera_id}/recordings/health")
def camera_recording_health(camera_id: int, user=Depends(get_current_user)):
    with get_conn() as conn:
        camera = _require_camera_in_scope(conn, camera_id, user)
        health = camera["stream_id"] and recordings_service.recording_health(camera["stream_id"], _actor_id(user))
        if not health:
            raise HTTPException(status_code=404, detail="No recording health data available for this camera")
        return health


@router.get("/cameras/{camera_id}/recordings/health-events")
def camera_recording_health_events(camera_id: int, limit: int = 20, user=Depends(get_current_user)):
    """The live health surface's snapshot -- our own recording_health_events
    table (populated by routers/recording_webhooks.py's inbound sink), not
    a call out to the recording service. Pair with the /recordings/health-stream
    WebSocket for live updates after this initial paint."""
    with get_conn() as conn:
        camera = _require_camera_in_scope(conn, camera_id, user)
        if not camera["stream_id"]:
            return []
        return recording_health_events_service.list_recent(conn, camera["stream_id"], min(max(limit, 1), 100))


@router.delete("/cameras/{camera_id}", status_code=204)
def delete_camera(camera_id: int, user=Depends(require_permission("manage_cameras"))):
    with get_conn() as conn:
        _require_camera_in_scope(conn, camera_id, user, audit_denial=True)
        deleted = cameras_service.delete_camera(conn, camera_id)
        if not deleted:
            raise HTTPException(status_code=404, detail="Camera not found")
        audit_service.log(conn, user.get("badge_number", user.get("sub")), "delete", "camera", camera_id)


@router.post("/synthetic/detections", response_model=SyntheticDetectionEventAccepted, status_code=202)
def receive_synthetic_detection(
    body: SyntheticDetectionEventIn, background_tasks: BackgroundTasks, user=Depends(get_current_user)
):
    require_scale_demo_enabled()
    if not has_permission(user, "manage_cameras"):
        raise HTTPException(status_code=403, detail="Insufficient permissions")

    def _write():
        # Runs after the 202 has already gone out -- the client can't be told
        # about a failure here, so a broad catch is intentional (a pool
        # timeout, a bad payload, anything) rather than picking one exception
        # type to handle and letting the rest crash the background task
        # silently. No retry (out of scope) -- this just makes the failure
        # observable instead of a silently dropped event.
        try:
            with get_conn() as conn:
                synthetic_events_service.record_event(conn, body.event_id, body.camera_id, body.edge_node_id, body.payload)
        except Exception:  # noqa: BLE001 -- deliberate catch-all, see comment above
            logger.error(f"failed to write synthetic detection event {body.event_id}", exc_info=True)

    background_tasks.add_task(_write)
    return {"event_id": body.event_id, "status": "accepted"}
