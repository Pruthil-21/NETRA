import psycopg
from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import ValidationError

from .auth import get_current_user, require_permission, require_role, require_scale_demo_enabled
from .db import get_conn
from .logging_config import configure_logging, logger
from .schemas import (
    CameraBulkResult,
    CameraCreate,
    CameraOut,
    CameraUpdate,
    CameraUptimeReport,
    LoginRequest,
    LoginResponse,
    MeResponse,
    OfficerOut,
    PostingCreate,
    PostingOut,
    ReportSummary,
    RolePermissionsOut,
    RolePermissionsUpdate,
)
from .services import (
    admin_service,
    audit_service,
    auth_service,
    cameras_service,
    rbac_service,
    reports_service,
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
    return {
        "badge_number": user.get("badge_number", user.get("sub", "")),
        "name": user.get("name", ""),
        "role": user.get("role", ""),
        "scope_type": user.get("scope_type", "platform"),
        "scope_value": user.get("scope_value"),
        "permissions": user.get("permissions", []),
    }


@app.get("/admin/officers", response_model=list[OfficerOut])
def list_officers(user=Depends(require_permission("manage_users_roles"))):
    with get_conn() as conn:
        return admin_service.list_officers(conn)


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
        if "manage_cameras" not in user.get("permissions", []) and user.get("role") not in ("officer", "admin"):
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


@app.get("/cameras/{camera_id}", response_model=CameraOut)
def get_camera(camera_id: int, user=Depends(get_current_user)):
    with get_conn() as conn:
        camera = cameras_service.get_camera(conn, camera_id)
        if camera is None:
            raise HTTPException(status_code=404, detail="Camera not found")
        return camera


@app.post("/cameras", response_model=CameraOut, status_code=201)
def create_camera(camera: CameraCreate, user=Depends(require_permission("manage_cameras"))):
    with get_conn() as conn:
        created = cameras_service.create_camera(conn, camera.model_dump())
        audit_service.log(conn, user.get("badge_number", user.get("sub")), "create", "camera", created["id"])
        return created


@app.post("/cameras/bulk", response_model=list[CameraBulkResult])
def create_cameras_bulk(cameras: list[dict], user=Depends(require_role("officer"))):
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
                created = cameras_service.create_camera(conn, validated.model_dump())
            except psycopg.Error as e:
                conn.rollback()
                results.append(CameraBulkResult(index=index, status="error", reason=str(e)))
                continue

            audit_service.log(conn, user.get("badge_number", user.get("sub")), "create", "camera", created["id"])
            results.append(CameraBulkResult(index=index, status="created", camera=created))
    return results


@app.get("/reports/summary", response_model=ReportSummary)
def reports_summary(user=Depends(get_current_user)):
    with get_conn() as conn:
        summary = reports_service.get_summary(conn)
        return summary


@app.put("/cameras/{camera_id}", response_model=CameraOut)
def update_camera(camera_id: int, camera: CameraUpdate, user=Depends(require_permission("manage_cameras"))):
    with get_conn() as conn:
        fields = camera.model_dump(exclude_unset=True)
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


@app.delete("/cameras/{camera_id}", status_code=204)
def delete_camera(camera_id: int, user=Depends(require_permission("manage_cameras"))):
    with get_conn() as conn:
        deleted = cameras_service.delete_camera(conn, camera_id)
        if not deleted:
            raise HTTPException(status_code=404, detail="Camera not found")
        audit_service.log(conn, user.get("badge_number", user.get("sub")), "delete", "camera", camera_id)
