from fastapi import FastAPI

from app.db import get_conn

app = FastAPI()

@app.get("/health")
def health():
    return {"status": "ok"}

@app.get("/cameras")
def list_cameras():
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("""
            SELECT id, name, dept, ST_Y(location::geometry) AS lat,
                   ST_X(location::geometry) AS lng, camera_type, ownership,
                   connectivity_status, storage_type, retention_days,
                   health_status, rtsp_url
            FROM cameras
        """)
        cols = [c.name for c in cur.description]
        return [dict(zip(cols, row)) for row in cur.fetchall()]
