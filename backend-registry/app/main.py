from datetime import datetime

import psycopg
from fastapi import BackgroundTasks, Depends, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import ValidationError

from .auth import (
    get_current_user,
    has_permission,
    require_permission,
    require_scale_demo_enabled,
)
from .db import get_conn
from .logging_config import configure_logging, logger
from .schemas import (
    AuditLogsPage,
    CameraBulkResult,
    CameraCreate,
    CameraOut,
    CameraUpdate,
    CameraUptimeReport,
    ChangePasswordRequest,
    CircleCreate,
    CircleOut,
    CircleUpdate,
    CoverageTargetCreate,
    CoverageTargetOut,
    CoverageTargetUpdate,
    GapAnalysisReport,
    LoginRequest,
    LoginResponse,
    MeResponse,
    OfficerOut,
    PoliceStationCreate,
    PoliceStationOut,
    PoliceStationUpdate,
    PasswordResetRequest,
    PostingCreate,
    PostingOut,
    ProfilePhotoUpdate,
    ReportSummary,
    RolePermissionsOut,
    RolePermissionsUpdate,
    SyntheticDetectionEventAccepted,
    SyntheticDetectionEventIn,
)
from .services import (
    admin_service,
    audit_logs_service,
    audit_service,
    auth_service,
    cameras_service,
    circles_service,
    coverage_targets_service,
    gap_analysis_service,
    police_stations_service,
    rbac_service,
    recordings_service,
    reports_service,
    snmp_service,
    synthetic_events_service,
)

configure_logging()

app = FastAPI()

# Browser clients (frontend-dashboard, frontend-map) send an Authorization
# header cross-origin, which forces a CORS preflight (OPTIONS) -- without this,
# FastAPI has no route for OPTIONS and rejects it with 405 before the real
# request is ever sent.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/auth/login", response_model=LoginResponse)
def login(body: LoginRequest):
    with get_conn() as conn:
        officer = auth_service.get_officer_by_badge(conn, body.badge_number)
        password_hash = officer["password_hash"] if officer else auth_service.DUMMY_PASSWORD_HASH
        password_ok = auth_service.verify_password(body.password, password_hash)
        if officer is None or not password_ok:
            raise HTTPException(status_code=401, detail="Invalid badge number or password")

        posting = auth_service.get_active_posting(conn, officer["id"])
        if posting is None:
            raise HTTPException(status_code=401, detail="Officer has no active posting")

        token = auth_service.issue_token(conn, officer, posting)
        audit_service.log(conn, officer["badge_number"], "login", "officer", officer["id"], badge_number=officer["badge_number"])
        return {"token": token}


@app.get("/auth/me", response_model=MeResponse)
def me(user=Depends(get_current_user)):
    response = {
        "badge_number": user.get("badge_number", user.get("sub", "")),
        "name": user.get("name", ""),
        "role": user.get("role", ""),
        "rank": None,
        "photo_url": None,
        "last_login": None,
        "scope_type": user.get("scope_type", "platform"),
        "scope_value": user.get("scope_value"),
        "permissions": user.get("permissions", []),
    }
    # A real RBAC-issued token's `sub` is the officer's numeric id (see
    # auth_service.issue_token) -- a legacy hand-crafted token (role:
    # "officer"/"admin", every existing test fixture and the demo JWT) has no
    # matching officers row, so profile fields beyond the JWT's own claims
    # just stay at their defaults above rather than erroring.
    officer_id = user.get("sub")
    if officer_id and str(officer_id).isdigit():
        with get_conn() as conn:
            officer = auth_service.get_officer_by_id(conn, int(officer_id))
            if officer is not None:
                response["rank"] = officer["rank"]
                response["photo_url"] = officer["photo_url"]
                response["last_login"] = auth_service.get_last_login(conn, officer["id"])
    return response


@app.post("/auth/change-password", status_code=204)
def change_password(body: ChangePasswordRequest, user=Depends(get_current_user)):
    officer_id = user.get("sub")
    if not officer_id or not str(officer_id).isdigit():
        raise HTTPException(status_code=400, detail="This session has no officer account to update")
    with get_conn() as conn:
        officer = auth_service.get_officer_by_id(conn, int(officer_id))
        if officer is None or not auth_service.verify_password(body.current_password, officer["password_hash"]):
            raise HTTPException(status_code=401, detail="Current password is incorrect")
        auth_service.set_password(conn, officer["id"], auth_service.hash_password(body.new_password))
        audit_service.log(conn, officer["badge_number"], "change_password", "officer", officer["id"], badge_number=officer["badge_number"])


@app.put("/auth/me/photo", response_model=MeResponse)
def update_my_photo(body: ProfilePhotoUpdate, user=Depends(get_current_user)):
    officer_id = user.get("sub")
    if not officer_id or not str(officer_id).isdigit():
        raise HTTPException(status_code=400, detail="This session has no officer account to update")
    with get_conn() as conn:
        officer = auth_service.get_officer_by_id(conn, int(officer_id))
        if officer is None:
            raise HTTPException(status_code=404, detail="Officer not found")
        auth_service.set_photo_url(conn, officer["id"], body.photo_url)
        return me(user)


@app.get("/admin/officers", response_model=list[OfficerOut])
def list_officers(user=Depends(require_permission("manage_users_roles"))):
    with get_conn() as conn:
        return admin_service.list_officers(conn)


# Deliberately gated on its own permission (reset_officer_passwords), not
# manage_users_roles -- district_command holds manage_users_roles for
# reassigning postings within its own district, but resetting an officer's
# password bypasses their current credential entirely (no current_password
# check, unlike self-service POST /auth/change-password) and must stay
# platform-wide-admin-only by default, the same way manage_roles was split
# out from manage_users_roles for role-definition edits.
@app.post("/admin/officers/{officer_id}/reset-password", status_code=204)
def reset_officer_password(
    officer_id: int, body: PasswordResetRequest, user=Depends(require_permission("reset_officer_passwords"))
):
    with get_conn() as conn:
        officer = auth_service.get_officer_by_id(conn, officer_id)
        if officer is None:
            raise HTTPException(status_code=404, detail="Officer not found")
        auth_service.set_password(conn, officer["id"], auth_service.hash_password(body.new_password))
        audit_service.log(conn, user.get("badge_number", user.get("sub")), "reset_password", "officer", officer["id"])


@app.get("/admin/postings", response_model=list[PostingOut])
def list_postings(user=Depends(require_permission("manage_users_roles"))):
    with get_conn() as conn:
        return admin_service.list_postings(conn)


@app.post("/admin/postings", response_model=PostingOut, status_code=201)
def create_posting(body: PostingCreate, user=Depends(require_permission("manage_users_roles"))):
    with get_conn() as conn:
        role = rbac_service.get_role_by_name(conn, body.role_name)
        if role is None:
            raise HTTPException(status_code=404, detail=f"Unknown role '{body.role_name}'")

        # Delegated admin (spec Section 6): a platform-wide actor (Super Admin)
        # can assign anything. A district-scoped actor with can_delegate_admin
        # (District Command) can only assign roles below their own level, and
        # only within their own scope_value -- never Super Admin's platform-wide
        # reach, and never another district's.
        actor_scope_type = user.get("scope_type")
        actor_scope_value = user.get("scope_value")
        if actor_scope_type != "platform":
            if body.scope_type != "district" or body.scope_value != actor_scope_value:
                raise HTTPException(status_code=403, detail="Cannot assign outside your own jurisdiction")
            if role["name"] in ("super_admin", "district_command"):
                raise HTTPException(status_code=403, detail="Cannot assign a role at or above your own")

        posting = admin_service.reassign_posting(
            conn, body.officer_id, role["id"], body.scope_type, body.scope_value,
            assigned_by=user.get("badge_number", user.get("sub", "")),
        )
        audit_service.log(conn, user.get("badge_number", user.get("sub")), "reassign_posting", "posting", posting["id"])
        return posting


@app.get("/admin/roles", response_model=list[RolePermissionsOut])
def list_roles(user=Depends(require_permission("manage_roles"))):
    with get_conn() as conn:
        return rbac_service.list_roles_with_permissions(conn)


@app.put("/admin/roles/{role_name}/permissions", response_model=RolePermissionsOut)
def update_role_permissions(
    role_name: str, body: RolePermissionsUpdate, user=Depends(require_permission("manage_roles"))
):
    with get_conn() as conn:
        role = rbac_service.get_role_by_name(conn, role_name)
        if role is None:
            raise HTTPException(status_code=404, detail=f"Unknown role '{role_name}'")

        unknown = set(body.permissions) - rbac_service.VALID_PERMISSIONS
        if unknown:
            raise HTTPException(status_code=400, detail=f"Unknown permission(s): {', '.join(sorted(unknown))}")

        if role["name"] == "super_admin" and "manage_roles" not in body.permissions:
            raise HTTPException(status_code=400, detail="Cannot remove manage_roles from super_admin")

        permissions = rbac_service.set_role_permissions(conn, role["id"], body.permissions)
        audit_service.log(
            conn, user.get("badge_number", user.get("sub")), "edit_role_permissions",
            "role", role["id"], reason_code=body.reason_code,
        )
        return {**role, "permissions": permissions}


@app.get("/cameras")
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
        # endpoint's behavior before pagination was added.
        dept = user.get("scope_value") if user.get("scope_type") == "district" else None

        # No pagination/synthetic params at all -> today's exact legacy behavior:
        # every real camera, as a bare list, no envelope. This is the path
        # CameraRegistryContext.tsx's fetchRegistryCameras() always takes.
        if cursor is None and limit is None and not include_synthetic:
            return cameras_service.list_cameras(conn, dept)

        bbox = None
        if None not in (min_lat, max_lat, min_long, max_long):
            bbox = (min_lat, max_lat, min_long, max_long)

        return cameras_service.list_cameras_page(
            conn,
            cursor=cursor,
            limit=limit or 100,
            include_synthetic=include_synthetic,
            dept=dept,
            bbox=bbox,
        )


@app.get("/cameras/summary")
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


@app.get("/cameras/{camera_id}", response_model=CameraOut)
def get_camera(camera_id: int, user=Depends(get_current_user)):
    with get_conn() as conn:
        camera = cameras_service.get_camera(conn, camera_id)
        if camera is None:
            raise HTTPException(status_code=404, detail="Camera not found")
        return camera


def _validate_circle_for_dept(conn, circle_id: int | None, dept: str) -> None:
    """Shared cross-district guard: a camera's circle_id (when set) must
    belong to a circle whose district matches the camera's own dept --
    otherwise the camera ends up "in" a circle that lives in a different
    district, which is the exact corrupted state the global constraint
    forbids. Raises HTTPException(404/400) same as the inline checks this
    replaces in create_camera/update_camera; also used by the bulk-import
    loop below."""
    if circle_id is None:
        return
    circle = circles_service.get_circle(conn, circle_id)
    if circle is None:
        raise HTTPException(status_code=404, detail="Circle not found")
    if circle["district"] != dept:
        raise HTTPException(status_code=400, detail="Circle belongs to a different district than this camera")


@app.post("/cameras", response_model=CameraOut, status_code=201)
def create_camera(camera: CameraCreate, user=Depends(require_permission("manage_cameras"))):
    with get_conn() as conn:
        _validate_circle_for_dept(conn, camera.circle_id, camera.dept)
        created = cameras_service.create_camera(conn, camera.model_dump())
        audit_service.log(conn, user.get("badge_number", user.get("sub")), "create", "camera", created["id"])
        return created


@app.post("/cameras/bulk", response_model=list[CameraBulkResult])
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
                _validate_circle_for_dept(conn, validated.circle_id, validated.dept)
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


@app.get("/coverage-targets", response_model=list[CoverageTargetOut])
def list_coverage_targets(user=Depends(get_current_user)):
    with get_conn() as conn:
        return coverage_targets_service.list_targets(conn)


@app.get("/coverage-targets/{target_id}", response_model=CoverageTargetOut)
def get_coverage_target(target_id: int, user=Depends(get_current_user)):
    with get_conn() as conn:
        target = coverage_targets_service.get_target(conn, target_id)
        if target is None:
            raise HTTPException(status_code=404, detail="Coverage target not found")
        return target


@app.post("/coverage-targets", response_model=CoverageTargetOut, status_code=201)
def create_coverage_target(body: CoverageTargetCreate, user=Depends(require_permission("manage_cameras"))):
    with get_conn() as conn:
        created = coverage_targets_service.create_target(conn, body.model_dump())
        audit_service.log(conn, user.get("badge_number", user.get("sub")), "create", "coverage_target", created["id"])
        return created


@app.put("/coverage-targets/{target_id}", response_model=CoverageTargetOut)
def update_coverage_target(target_id: int, body: CoverageTargetUpdate, user=Depends(require_permission("manage_cameras"))):
    with get_conn() as conn:
        updated = coverage_targets_service.update_target(conn, target_id, body.model_dump(exclude_unset=True))
        if updated is None:
            raise HTTPException(status_code=404, detail="Coverage target not found")
        audit_service.log(conn, user.get("badge_number", user.get("sub")), "update", "coverage_target", target_id)
        return updated


@app.delete("/coverage-targets/{target_id}", status_code=204)
def delete_coverage_target(target_id: int, user=Depends(require_permission("manage_cameras"))):
    with get_conn() as conn:
        deleted = coverage_targets_service.delete_target(conn, target_id)
        if not deleted:
            raise HTTPException(status_code=404, detail="Coverage target not found")
        audit_service.log(conn, user.get("badge_number", user.get("sub")), "delete", "coverage_target", target_id)


@app.get("/reports/gap-analysis", response_model=GapAnalysisReport)
def gap_analysis_report(
    threshold_m: int = 100,
    age_threshold_days: int = 1095,
    user=Depends(get_current_user),
):
    with get_conn() as conn:
        try:
            uncovered = gap_analysis_service.compute_uncovered_zones(conn, threshold_m)
        except psycopg.Error:
            conn.rollback()
            logger.error("gap-analysis: uncovered-zones computation failed", exc_info=True)
            uncovered = []
        try:
            ageing = gap_analysis_service.compute_ageing_infrastructure(conn, age_threshold_days)
        except psycopg.Error:
            conn.rollback()
            logger.error("gap-analysis: ageing-infrastructure computation failed", exc_info=True)
            ageing = []
        return {"uncovered_zones": uncovered, "ageing_infrastructure": ageing}


@app.get("/audit-logs", response_model=AuditLogsPage)
def list_audit_logs(
    badge_number: str | None = None,
    resource_type: str | None = None,
    date_from: datetime | None = Query(None, alias="from"),
    date_to: datetime | None = Query(None, alias="to"),
    cursor: int | None = None,
    limit: int = Query(50, ge=1, le=200),
    user=Depends(require_permission("view_audit_logs")),
):
    district = user.get("scope_value") if user.get("scope_type") == "district" else None
    with get_conn() as conn:
        logs, next_cursor = audit_logs_service.list_logs(
            conn, badge_number, resource_type, date_from, date_to, district, cursor, limit
        )
        return {"logs": logs, "next_cursor": next_cursor}


@app.get("/police-stations", response_model=list[PoliceStationOut])
def list_police_stations(user=Depends(get_current_user)):
    with get_conn() as conn:
        return police_stations_service.list_stations(conn)


@app.get("/police-stations/{station_id}", response_model=PoliceStationOut)
def get_police_station(station_id: int, user=Depends(get_current_user)):
    with get_conn() as conn:
        station = police_stations_service.get_station(conn, station_id)
        if station is None:
            raise HTTPException(status_code=404, detail="Police station not found")
        return station


@app.post("/police-stations", response_model=PoliceStationOut, status_code=201)
def create_police_station(body: PoliceStationCreate, user=Depends(require_permission("manage_stations"))):
    with get_conn() as conn:
        created = police_stations_service.create_station(conn, body.model_dump())
        audit_service.log(conn, user.get("badge_number", user.get("sub")), "create", "police_station", created["id"])
        return created


@app.put("/police-stations/{station_id}", response_model=PoliceStationOut)
def update_police_station(station_id: int, body: PoliceStationUpdate, user=Depends(require_permission("manage_stations"))):
    with get_conn() as conn:
        updated = police_stations_service.update_station(conn, station_id, body.model_dump(exclude_unset=True))
        if updated is None:
            raise HTTPException(status_code=404, detail="Police station not found")
        audit_service.log(conn, user.get("badge_number", user.get("sub")), "update", "police_station", station_id)
        return updated


@app.delete("/police-stations/{station_id}", status_code=204)
def delete_police_station(station_id: int, user=Depends(require_permission("manage_stations"))):
    with get_conn() as conn:
        deleted = police_stations_service.delete_station(conn, station_id)
        if not deleted:
            raise HTTPException(status_code=404, detail="Police station not found")
        audit_service.log(conn, user.get("badge_number", user.get("sub")), "delete", "police_station", station_id)


def _guard_circle_district(user: dict, district: str):
    """District-scoped users may only create/edit/delete circles in their
    own district -- same cross-district guard create_posting already
    applies for postings."""
    if user.get("scope_type") == "district" and district != user.get("scope_value"):
        raise HTTPException(status_code=403, detail="Cannot manage circles outside your own district")


@app.get("/circles", response_model=list[CircleOut])
def list_circles(user=Depends(get_current_user)):
    with get_conn() as conn:
        district = user.get("scope_value") if user.get("scope_type") == "district" else None
        return circles_service.list_circles(conn, district)


@app.get("/circles/{circle_id}", response_model=CircleOut)
def get_circle(circle_id: int, user=Depends(get_current_user)):
    with get_conn() as conn:
        circle = circles_service.get_circle(conn, circle_id)
        if circle is None:
            raise HTTPException(status_code=404, detail="Circle not found")
        return circle


@app.post("/circles", response_model=CircleOut, status_code=201)
def create_circle(body: CircleCreate, user=Depends(require_permission("manage_circles"))):
    _guard_circle_district(user, body.district)
    with get_conn() as conn:
        try:
            created = circles_service.create_circle(conn, body.model_dump())
        except circles_service.DuplicateCircleError as exc:
            raise HTTPException(status_code=409, detail=str(exc))
        audit_service.log(conn, user.get("badge_number", user.get("sub")), "create", "circle", created["id"])
        return created


@app.put("/circles/{circle_id}", response_model=CircleOut)
def update_circle(circle_id: int, body: CircleUpdate, user=Depends(require_permission("manage_circles"))):
    with get_conn() as conn:
        existing = circles_service.get_circle(conn, circle_id)
        if existing is None:
            raise HTTPException(status_code=404, detail="Circle not found")
        _guard_circle_district(user, existing["district"])
        if body.district is not None:
            _guard_circle_district(user, body.district)
            if body.district != existing["district"] and circles_service.camera_count_for_circle(conn, circle_id) > 0:
                raise HTTPException(
                    status_code=400,
                    detail="Cannot change district of a circle that still has cameras assigned",
                )
        try:
            updated = circles_service.update_circle(conn, circle_id, body.model_dump(exclude_unset=True))
        except circles_service.DuplicateCircleError as exc:
            raise HTTPException(status_code=409, detail=str(exc))
        audit_service.log(conn, user.get("badge_number", user.get("sub")), "update", "circle", circle_id)
        return updated


@app.delete("/circles/{circle_id}", status_code=204)
def delete_circle(circle_id: int, user=Depends(require_permission("manage_circles"))):
    with get_conn() as conn:
        existing = circles_service.get_circle(conn, circle_id)
        if existing is None:
            raise HTTPException(status_code=404, detail="Circle not found")
        _guard_circle_district(user, existing["district"])
        try:
            deleted = circles_service.delete_circle(conn, circle_id)
        except circles_service.CircleInUseError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        if not deleted:
            raise HTTPException(status_code=404, detail="Circle not found")
        audit_service.log(conn, user.get("badge_number", user.get("sub")), "delete", "circle", circle_id)


@app.get("/reports/summary", response_model=ReportSummary)
def reports_summary(user=Depends(get_current_user)):
    with get_conn() as conn:
        summary = reports_service.get_summary(conn)
        return summary


@app.put("/cameras/{camera_id}", response_model=CameraOut)
def update_camera(camera_id: int, camera: CameraUpdate, user=Depends(require_permission("manage_cameras"))):
    with get_conn() as conn:
        fields = camera.model_dump(exclude_unset=True)
        if "circle_id" in fields or "dept" in fields:
            existing = cameras_service.get_camera(conn, camera_id)
            if existing is None:
                raise HTTPException(status_code=404, detail="Camera not found")
            effective_circle_id = fields.get("circle_id", existing.get("circle_id"))
            effective_dept = fields.get("dept", existing["dept"])
            _validate_circle_for_dept(conn, effective_circle_id, effective_dept)

        updated, connectivity_changed = cameras_service.update_camera(conn, camera_id, fields)
        if updated is None:
            raise HTTPException(status_code=404, detail="Camera not found")

        non_connectivity_fields = {k for k in fields if k != "connectivity_status"}
        if non_connectivity_fields:
            audit_service.log(conn, user.get("badge_number", user.get("sub")), "update", "camera", camera_id)
        if connectivity_changed:
            logger.info(f"camera {camera_id} connectivity changed to '{updated['connectivity_status']}'")

        return updated


@app.get("/cameras/{camera_id}/uptime", response_model=CameraUptimeReport)
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


@app.get("/snmp/devices")
def snmp_devices(user=Depends(get_current_user)):
    return snmp_service.get_devices()


@app.get("/cameras/{camera_id}/health")
def camera_snmp_health(camera_id: int, user=Depends(get_current_user)):
    device = snmp_service.get_device_for_camera(camera_id)
    if device is None:
        raise HTTPException(status_code=404, detail="No SNMP health data available for this camera")
    return device


@app.get("/cameras/{camera_id}/recordings")
def camera_recordings(camera_id: int, user=Depends(get_current_user)):
    with get_conn() as conn:
        camera = cameras_service.get_camera(conn, camera_id)
        if camera is None:
            raise HTTPException(status_code=404, detail="Camera not found")
        if not camera["stream_id"]:
            return {"available": False, "segments": []}
        return recordings_service.list_recordings(camera["stream_id"])


@app.delete("/cameras/{camera_id}", status_code=204)
def delete_camera(camera_id: int, user=Depends(require_permission("manage_cameras"))):
    with get_conn() as conn:
        deleted = cameras_service.delete_camera(conn, camera_id)
        if not deleted:
            raise HTTPException(status_code=404, detail="Camera not found")
        audit_service.log(conn, user.get("badge_number", user.get("sub")), "delete", "camera", camera_id)


@app.post("/synthetic/detections", response_model=SyntheticDetectionEventAccepted, status_code=202)
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
