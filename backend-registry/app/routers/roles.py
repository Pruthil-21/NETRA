"""Dynamic role management (v2 spec, Phase A): the legacy name-keyed
list/edit-permissions pair (list_roles/update_role_permissions) stays for
the existing "edit an existing role's permission list" UI; the rest of this
file is the newer id-keyed capability covering creating a brand-new role,
composing it from duties, cloning, draft/diff/publish, and
deactivate-vs-delete. See routers/duties.py for duty CRUD itself."""
from fastapi import APIRouter, Depends, HTTPException

from ..auth import require_permission
from ..db import get_conn
from ..schemas import (
    EffectivePermissionsOut,
    RoleCloneRequest,
    RoleCreate,
    RoleDiffOut,
    RoleDraftOut,
    RoleDraftUpdate,
    RoleDutiesUpdate,
    RoleOut,
    RolePermissionsOut,
    RolePermissionsUpdate,
)
from ..services import audit_service, rbac_service

router = APIRouter(prefix="/admin/roles", tags=["roles"])


@router.get("", response_model=list[RolePermissionsOut])
def list_roles(user=Depends(require_permission("manage_roles"))):
    with get_conn() as conn:
        return rbac_service.list_roles_with_permissions(conn)


@router.put("/{role_name}/permissions", response_model=RolePermissionsOut)
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


def _role_to_out(conn, role: dict) -> dict:
    return {
        **role,
        "duty_ids": rbac_service.get_role_duty_ids(conn, role["id"]),
        "permissions": rbac_service.role_permissions(conn, role["id"]),
    }


@router.get("/{role_id}/effective-permissions", response_model=EffectivePermissionsOut)
def get_effective_role_permissions(role_id: int, user=Depends(require_permission("manage_roles"))):
    with get_conn() as conn:
        role = rbac_service.get_role(conn, role_id)
        if role is None:
            raise HTTPException(status_code=404, detail="Role not found")
        return {"role_id": role_id, "permissions": rbac_service.effective_role_permissions(conn, role_id)}


@router.post("", response_model=RoleOut, status_code=201)
def create_role_v2(body: RoleCreate, user=Depends(require_permission("manage_roles"))):
    with get_conn() as conn:
        if rbac_service.get_role_by_name(conn, body.name) is not None:
            raise HTTPException(status_code=409, detail=f"Role '{body.name}' already exists")
        unknown = set(body.permissions) - rbac_service.VALID_PERMISSIONS
        if unknown:
            raise HTTPException(status_code=400, detail=f"Unknown permission(s): {', '.join(sorted(unknown))}")
        if body.parent_role_id is not None and rbac_service.get_role(conn, body.parent_role_id) is None:
            raise HTTPException(status_code=404, detail="Parent role not found")
        for duty_id in body.duty_ids:
            if rbac_service.get_duty(conn, duty_id) is None:
                raise HTTPException(status_code=404, detail=f"Duty {duty_id} not found")

        role = rbac_service.create_role(
            conn, body.name, body.display_name, body.hierarchy_level, body.can_delegate_admin,
            parent_role_id=body.parent_role_id, duty_ids=body.duty_ids, permissions=body.permissions,
        )
        audit_service.log(conn, user.get("badge_number", user.get("sub")), "create_role", "role", role["id"])
        return _role_to_out(conn, role)


@router.post("/{role_id}/clone", response_model=RoleOut, status_code=201)
def clone_role(role_id: int, body: RoleCloneRequest, user=Depends(require_permission("manage_roles"))):
    with get_conn() as conn:
        if rbac_service.get_role(conn, role_id) is None:
            raise HTTPException(status_code=404, detail="Role not found")
        if rbac_service.get_role_by_name(conn, body.name) is not None:
            raise HTTPException(status_code=409, detail=f"Role '{body.name}' already exists")
        clone = rbac_service.clone_role(conn, role_id, body.name, body.display_name)
        audit_service.log(conn, user.get("badge_number", user.get("sub")), "clone_role", "role", clone["id"])
        return _role_to_out(conn, clone)


@router.put("/{role_id}/duties", response_model=RoleOut)
def update_role_duties(role_id: int, body: RoleDutiesUpdate, user=Depends(require_permission("manage_roles"))):
    with get_conn() as conn:
        role = rbac_service.get_role(conn, role_id)
        if role is None:
            raise HTTPException(status_code=404, detail="Role not found")
        for duty_id in body.duty_ids:
            if rbac_service.get_duty(conn, duty_id) is None:
                raise HTTPException(status_code=404, detail=f"Duty {duty_id} not found")
        rbac_service.set_role_duties(conn, role_id, body.duty_ids)
        audit_service.log(conn, user.get("badge_number", user.get("sub")), "edit_role_duties", "role", role_id)
        return _role_to_out(conn, rbac_service.get_role(conn, role_id))


@router.put("/{role_id}/draft", response_model=RoleDraftOut)
def save_role_draft(role_id: int, body: RoleDraftUpdate, user=Depends(require_permission("manage_roles"))):
    """Draft/Publish (spec Sections 2.4/3.1): stages this role's next duty/
    permission composition without touching what's live -- distinct from
    PUT /admin/roles/{id}/duties above, which applies immediately. Review
    the diff (GET .../diff) before POST .../publish makes it live."""
    with get_conn() as conn:
        if rbac_service.get_role(conn, role_id) is None:
            raise HTTPException(status_code=404, detail="Role not found")
        unknown = set(body.permissions) - rbac_service.VALID_PERMISSIONS
        if unknown:
            raise HTTPException(status_code=400, detail=f"Unknown permission(s): {', '.join(sorted(unknown))}")
        for duty_id in body.duty_ids:
            if rbac_service.get_duty(conn, duty_id) is None:
                raise HTTPException(status_code=404, detail=f"Duty {duty_id} not found")
        return rbac_service.save_role_draft(
            conn, role_id, body.duty_ids, body.permissions, user.get("badge_number", user.get("sub"))
        )


@router.get("/{role_id}/diff", response_model=RoleDiffOut)
def get_role_diff(role_id: int, user=Depends(require_permission("manage_roles"))):
    with get_conn() as conn:
        if rbac_service.get_role(conn, role_id) is None:
            raise HTTPException(status_code=404, detail="Role not found")
        return rbac_service.diff_role_draft(conn, role_id)


@router.post("/{role_id}/publish", response_model=RoleOut)
def publish_role(role_id: int, user=Depends(require_permission("manage_roles"))):
    with get_conn() as conn:
        if rbac_service.get_role(conn, role_id) is None:
            raise HTTPException(status_code=404, detail="Role not found")
        published = rbac_service.publish_role_draft(conn, role_id)
        if published is None:
            raise HTTPException(status_code=400, detail="No pending draft to publish")
        audit_service.log(conn, user.get("badge_number", user.get("sub")), "publish_role", "role", role_id)
        return _role_to_out(conn, published)


@router.post("/{role_id}/deactivate", response_model=RoleOut)
def deactivate_role(role_id: int, user=Depends(require_permission("manage_roles"))):
    with get_conn() as conn:
        if rbac_service.get_role(conn, role_id) is None:
            raise HTTPException(status_code=404, detail="Role not found")
        role = rbac_service.deactivate_role(conn, role_id)
        audit_service.log(conn, user.get("badge_number", user.get("sub")), "deactivate_role", "role", role_id)
        return _role_to_out(conn, role)


@router.post("/{role_id}/reactivate", response_model=RoleOut)
def reactivate_role(role_id: int, user=Depends(require_permission("manage_roles"))):
    with get_conn() as conn:
        if rbac_service.get_role(conn, role_id) is None:
            raise HTTPException(status_code=404, detail="Role not found")
        role = rbac_service.reactivate_role(conn, role_id)
        audit_service.log(conn, user.get("badge_number", user.get("sub")), "reactivate_role", "role", role_id)
        return _role_to_out(conn, role)


@router.delete("/{role_id}", status_code=204)
def delete_role_v2(role_id: int, user=Depends(require_permission("manage_roles"))):
    with get_conn() as conn:
        try:
            deleted = rbac_service.delete_role(conn, role_id)
        except rbac_service.RoleInUseError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        if not deleted:
            raise HTTPException(status_code=404, detail="Role not found")
        audit_service.log(conn, user.get("badge_number", user.get("sub")), "delete_role", "role", role_id)
