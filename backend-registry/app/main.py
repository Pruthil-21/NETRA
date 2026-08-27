from fastapi import Depends, FastAPI, HTTPException

from .auth import get_current_user, require_role
from .db import get_conn
from .schemas import CameraCreate, CameraOut, CameraUpdate
from .services import audit_service, cameras_service

app = FastAPI()


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
