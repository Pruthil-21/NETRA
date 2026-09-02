import psycopg
from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import ValidationError

from .auth import get_current_user, require_role
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
    ReportSummary,
)
from .services import audit_service, auth_service, cameras_service, rbac_service, reports_service

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
        if officer is None or not auth_service.verify_password(body.password, officer["password_hash"]):
            raise HTTPException(status_code=401, detail="Invalid badge number or password")

        posting = auth_service.get_active_posting(conn, officer["id"])
        if posting is None:
            raise HTTPException(status_code=401, detail="Officer has no active posting")

        token = auth_service.issue_token(conn, officer, posting)
        audit_service.log(conn, officer["badge_number"], "login", "officer", officer["id"], badge_number=officer["badge_number"])
        return {"token": token}


@app.get("/cameras", response_model=list[CameraOut])
def list_cameras(user=Depends(get_current_user)):
    with get_conn() as conn:
        cameras = cameras_service.list_cameras(conn)
        return cameras


@app.get("/cameras/{camera_id}", response_model=CameraOut)
def get_camera(camera_id: int, user=Depends(get_current_user)):
    with get_conn() as conn:
        camera = cameras_service.get_camera(conn, camera_id)
        if camera is None:
            raise HTTPException(status_code=404, detail="Camera not found")
        return camera


@app.post("/cameras", response_model=CameraOut, status_code=201)
def create_camera(camera: CameraCreate, user=Depends(require_role("officer"))):
    with get_conn() as conn:
        created = cameras_service.create_camera(conn, camera.model_dump())
        audit_service.log(conn, user.get("sub"), "create", "camera", created["id"])
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

            audit_service.log(conn, user.get("sub"), "create", "camera", created["id"])
            results.append(CameraBulkResult(index=index, status="created", camera=created))
    return results


@app.get("/reports/summary", response_model=ReportSummary)
def reports_summary(user=Depends(get_current_user)):
    with get_conn() as conn:
        summary = reports_service.get_summary(conn)
        return summary


@app.put("/cameras/{camera_id}", response_model=CameraOut)
def update_camera(camera_id: int, camera: CameraUpdate, user=Depends(require_role("officer"))):
    with get_conn() as conn:
        fields = camera.model_dump(exclude_unset=True)
        updated, connectivity_changed = cameras_service.update_camera(conn, camera_id, fields)
        if updated is None:
            raise HTTPException(status_code=404, detail="Camera not found")

        non_connectivity_fields = {k for k in fields if k != "connectivity_status"}
        if non_connectivity_fields:
            audit_service.log(conn, user.get("sub"), "update", "camera", camera_id)
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
def delete_camera(camera_id: int, user=Depends(require_role("officer"))):
    with get_conn() as conn:
        deleted = cameras_service.delete_camera(conn, camera_id)
        if not deleted:
            raise HTTPException(status_code=404, detail="Camera not found")
        audit_service.log(conn, user.get("sub"), "delete", "camera", camera_id)
