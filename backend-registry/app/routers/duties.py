"""Duty CRUD -- a duty is a named bundle of permissions a role can be
composed from (see routers/roles.py's create_role_v2/update_role_duties)."""
from fastapi import APIRouter, Depends, HTTPException

from ..auth import require_permission
from ..db import get_conn
from ..schemas import DutyCreate, DutyOut, DutyUpdate
from ..services import audit_service, rbac_service

router = APIRouter(prefix="/admin/duties", tags=["duties"])


@router.get("", response_model=list[DutyOut])
def list_duties(user=Depends(require_permission("manage_roles"))):
    with get_conn() as conn:
        return rbac_service.list_duties(conn)


@router.post("", response_model=DutyOut, status_code=201)
def create_duty(body: DutyCreate, user=Depends(require_permission("manage_roles"))):
    with get_conn() as conn:
        if rbac_service.get_duty_by_name(conn, body.name) is not None:
            raise HTTPException(status_code=409, detail=f"Duty '{body.name}' already exists")
        try:
            duty = rbac_service.create_duty(conn, body.name, body.display_name, body.description, body.permissions)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        audit_service.log(conn, user.get("badge_number", user.get("sub")), "create_duty", "duty", duty["id"])
        return duty


@router.put("/{duty_id}", response_model=DutyOut)
def update_duty(duty_id: int, body: DutyUpdate, user=Depends(require_permission("manage_roles"))):
    with get_conn() as conn:
        if rbac_service.get_duty(conn, duty_id) is None:
            raise HTTPException(status_code=404, detail="Duty not found")
        try:
            duty = rbac_service.update_duty(
                conn, duty_id, display_name=body.display_name, description=body.description,
                permissions=body.permissions,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        audit_service.log(conn, user.get("badge_number", user.get("sub")), "edit_duty", "duty", duty_id)
        return duty


@router.delete("/{duty_id}", status_code=204)
def delete_duty(duty_id: int, user=Depends(require_permission("manage_roles"))):
    with get_conn() as conn:
        try:
            deleted = rbac_service.delete_duty(conn, duty_id)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        if not deleted:
            raise HTTPException(status_code=404, detail="Duty not found")
        audit_service.log(conn, user.get("badge_number", user.get("sub")), "delete_duty", "duty", duty_id)
