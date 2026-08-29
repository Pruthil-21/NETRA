import psycopg
from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import ValidationError

from .auth import get_current_user, require_role
from .db import get_conn
from .schemas import (
    CameraBulkResult,
    CameraCreate,
    CameraOut,
    CameraUpdate,
    ReportSummary,
)
from .services import audit_service, cameras_service, reports_service

app = FastAPI()

# Browser clients (frontend-dashboard, frontend-map) send an Authorization
# header cross-origin, which forces a CORS preflight (OPTIONS) — without this,
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


@app.get("/cameras", response_model=list[CameraOut])
def list_cameras(user=Depends(get_current_user)):
    with get_conn() as conn:
        cameras = cameras_service.list_cameras(conn)
        audit_service.log(conn, user.get("sub"), "view", "camera")
        return cameras


@app.get("/cameras/{camera_id}", response_model=CameraOut)
def get_camera(camera_id: int, user=Depends(get_current_user)):
    with get_conn() as conn:
        camera = cameras_service.get_camera(conn, camera_id)
        if camera is None:
            raise HTTPException(status_code=404, detail="Camera not found")
        audit_service.log(conn, user.get("sub"), "view", "camera", camera_id)
        return camera


@app.post("/cameras", response_model=CameraOut, status_code=201)
def create_camera(camera: CameraCreate, user=Depends(require_role("officer"))):
    with get_conn() as conn:
        created = cameras_service.create_camera(conn, camera.model_dump())
        audit_service.log(conn, user.get("sub"), "create", "camera", created["id"])
        return created


@app.post("/cameras/bulk", response_model=list[CameraBulkResult])
def create_cameras_bulk(cameras: list[dict], user=Depends(require_role("officer"))):
    """Validates and inserts each row independently — one bad row reports an
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
        audit_service.log(conn, user.get("sub"), "view", "report")
        return summary


@app.put("/cameras/{camera_id}", response_model=CameraOut)
def update_camera(camera_id: int, camera: CameraUpdate, user=Depends(require_role("officer"))):
    with get_conn() as conn:
        updated = cameras_service.update_camera(conn, camera_id, camera.model_dump(exclude_unset=True))
        if updated is None:
            raise HTTPException(status_code=404, detail="Camera not found")
        audit_service.log(conn, user.get("sub"), "update", "camera", camera_id)
        return updated


@app.delete("/cameras/{camera_id}", status_code=204)
def delete_camera(camera_id: int, user=Depends(require_role("officer"))):
    with get_conn() as conn:
        deleted = cameras_service.delete_camera(conn, camera_id)
        if not deleted:
            raise HTTPException(status_code=404, detail="Camera not found")
        audit_service.log(conn, user.get("sub"), "delete", "camera", camera_id)
