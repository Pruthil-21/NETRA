from fastapi import Depends, FastAPI, HTTPException

from .auth import get_current_user, require_role
from .db import get_conn
from .logging_config import configure_logging, logger
from .schemas import (
    CameraBulkResult,
    CameraCreate,
    CameraOut,
    CameraUpdate,
    CameraUptimeReport,
    ReportSummary,
)
from .services import audit_service, cameras_service, reports_service

configure_logging()

app = FastAPI()

# Browser clients (frontend-dashboard, frontend-map) send an Authorization
# header. The header format is "Authorization: Bearer <token>" where token is
# a self-contained signed JWT (from backend-auth, or Cognito, depending on
# deployment). The HS256 shared secret is in environment variable AUTH_SECRET.
#
# For now, the token is validated in get_current_user() by verifying the
# signature; later, it will also check a central revocation list (once
# backend-auth is ready). The current user's role is stored in the token's
# "role" claim (e.g. "viewer", "officer", "admin").


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/cameras")
def list_cameras(user=Depends(get_current_user)):
    with get_conn() as conn:
        cameras = cameras_service.list_cameras(conn)
        return cameras


@app.get("/cameras/{camera_id}")
def get_camera(camera_id: int, user=Depends(get_current_user)):
    with get_conn() as conn:
        camera = cameras_service.get_camera(conn, camera_id)
        if camera is None:
            raise HTTPException(status_code=404, detail="Camera not found")
        return camera


@app.post("/cameras", status_code=201, response_model=CameraOut)
def create_camera(camera: CameraCreate, user=Depends(require_role("officer"))):
    with get_conn() as conn:
        result = cameras_service.create_camera(conn, camera.model_dump(exclude_unset=True))
        return result


@app.post("/cameras/bulk", response_model=list[CameraBulkResult])
def create_cameras_bulk(cameras: list[dict], user=Depends(require_role("officer"))):
    results = []
    for camera_data in cameras:
        with get_conn() as conn:
            try:
                camera = cameras_service.create_camera(conn, camera_data)
                results.append(
                    CameraBulkResult(
                        camera_id=camera["id"],
                        success=True,
                    )
                )
            except Exception as e:
                results.append(
                    CameraBulkResult(
                        camera_id=None,
                        success=False,
                        reason=str(e),
                    )
                )
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
        if not cameras_service.delete_camera(conn, camera_id):
            raise HTTPException(status_code=404, detail="Camera not found")
