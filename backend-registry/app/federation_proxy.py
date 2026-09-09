"""Camera-inventory proxy for the standalone DIGDHRISHTI Federation
middleware (D:\\middleware -- Dhruv's project, kept fully independent; this
is the only file that talks to it). Mounted inside backend-registry so the
browser authenticates through our existing login/RBAC instead of a second,
separate federation login -- the federation service's own admin key never
reaches the browser, only this proxy holds it (FEDERATION_SERVICE_KEY).

Adapted from the middleware's own integration/backend_proxy.py with one
correctness fix: the original filtered a camera's visibility by comparing
against the officer's single legacy `scope_value` claim. An officer posted
to more than one district (spec Section 3.3's multi-posting jurisdiction
union) would see fewer federation cameras than their real access -- the
same class of bug main.py's own district-scoped endpoints solved with
rbac_scope.effective_district_scopes, reused here instead of a second copy
of that logic that could drift out of sync with it.
"""
import os

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from psycopg.rows import dict_row
from pydantic import BaseModel, Field

from .rbac_scope import effective_district_scopes


class MappingInput(BaseModel):
    camera_id: str = Field(min_length=1, max_length=512)
    registry_camera_id: int = Field(gt=0)


def build_router(get_current_user, has_permission, get_conn, transport=None):
    router = APIRouter(prefix="/federation", tags=["camera inventory"])

    def check(user, permission, platform=False):
        if not has_permission(user, permission):
            raise HTTPException(403, "Permission required")
        if platform and effective_district_scopes(user) is not None:
            raise HTTPException(403, "Platform permission required")

    def request(method, path, **kwargs):
        base_url = os.environ.get("FEDERATION_URL", "")
        service_key = os.environ.get("FEDERATION_SERVICE_KEY", "")
        if not base_url or not service_key:
            # A missing/blank config must 503 the same way an unreachable
            # service does below, not raise a raw KeyError -- a deployment
            # that hasn't set these up yet (the default -- see .env.example)
            # gets a clean, expected error instead of a 500.
            raise HTTPException(503, "Inventory service unavailable")
        try:
            with httpx.Client(
                base_url=base_url, timeout=10, transport=transport,
                headers={"X-Service-Key": service_key},
            ) as client:
                response = client.request(method, path, **kwargs)
            if response.status_code == 404:
                raise HTTPException(404, "Inventory camera or source not found")
            response.raise_for_status()
            return response.json()
        except httpx.HTTPError:
            raise HTTPException(503, "Inventory service unavailable")

    @router.get("/cameras")
    def cameras(
        after: str = Query("", max_length=512), limit: int = Query(100, ge=1, le=500),
        user=Depends(get_current_user),
    ):
        check(user, "view_live_feeds")
        # None = platform-wide (no filter), [] = zero jurisdiction (every
        # camera filtered out below, not a 403 -- matches how every other
        # district-scoped endpoint in this codebase treats a zero-posting
        # officer), a real list = every district this officer is actively
        # posted to, not just their single primary one.
        scopes = effective_district_scopes(user)
        page = request("GET", "/api/cameras", params={"after": after, "limit": limit})
        ids = [row["registry_camera_id"] for row in page["items"] if row["registry_camera_id"] is not None]
        with get_conn() as conn, conn.cursor(row_factory=dict_row) as cursor:
            rows = cursor.execute("SELECT id,dept FROM cameras WHERE id=ANY(%s)", (ids,)).fetchall() if ids else []
        allowed = {r["id"] for r in rows if scopes is None or r["dept"] in scopes}
        manage = scopes is None and has_permission(user, "manage_cameras")
        page["items"] = [
            r for r in page["items"] if r["registry_camera_id"] in allowed or (manage and r["registry_camera_id"] is None)
        ]
        return page

    @router.get("/sources")
    def sources(user=Depends(get_current_user)):
        check(user, "manage_cameras", True)
        return request("GET", "/api/sources")

    @router.get("/sources/{source_id}")
    def get_source(source_id: str, user=Depends(get_current_user)):
        check(user, "manage_cameras", True)
        return request("GET", "/api/sources/" + source_id)

    @router.put("/sources/{source_id}")
    def upsert_source(source_id: str, body: dict, user=Depends(get_current_user)):
        # Add-or-edit. The federation service's own Source model (see
        # middleware/federation/models.py) is the real validation authority
        # here -- we deliberately don't duplicate its whole shape (adapter-
        # specific fields, URL/login validators) in a second Pydantic model
        # that could drift out of sync; a 422 from there is passed through
        # in request()'s catch-all as 503 today, so a bad payload just gets
        # "Inventory service unavailable" rather than the real validation
        # error -- acceptable for now since this is a low-traffic admin path.
        check(user, "manage_cameras", True)
        if not source_id.replace("-", "").replace("_", "").isalnum():
            raise HTTPException(422, "Invalid source id")
        return request("PUT", "/api/sources/" + source_id, json=body)

    @router.delete("/sources/{source_id}", status_code=204)
    def delete_source(source_id: str, user=Depends(get_current_user)):
        # Never a hard delete -- disables the source (see disable_source in
        # middleware/federation/store.py), preserving its cameras/mappings
        # history. Re-adding the same id later picks the schedule back up.
        check(user, "manage_cameras", True)
        if not source_id.replace("-", "").replace("_", "").isalnum():
            raise HTTPException(422, "Invalid source id")
        request("DELETE", "/api/sources/" + source_id)

    @router.post("/sources/{source_id}/sync")
    def sync(source_id: str, user=Depends(get_current_user)):
        check(user, "manage_cameras", True)
        if not source_id.replace("-", "").replace("_", "").isalnum():
            raise HTTPException(422, "Invalid source")
        return request("POST", "/api/sources/" + source_id + "/sync")

    @router.put("/mappings")
    def mapping(body: MappingInput, user=Depends(get_current_user)):
        check(user, "manage_cameras", True)
        with get_conn() as conn:
            if not conn.execute("SELECT id FROM cameras WHERE id=%s", (body.registry_camera_id,)).fetchone():
                raise HTTPException(404, "Registry camera does not exist")
        actor = user.get("badge_number") or user.get("sub")
        if not actor:
            raise HTTPException(403, "Authenticated identity required")
        return request("PUT", "/api/mappings", json=dict(body.model_dump(), actor=str(actor)))

    return router
