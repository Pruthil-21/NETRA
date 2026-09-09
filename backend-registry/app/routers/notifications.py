"""An officer's own in-app notifications (role granted/revoked, registration
approved/rejected, etc.) -- see services/notifications_service.py for what
writes them."""
from fastapi import APIRouter, Depends, HTTPException

from ..auth import get_current_user
from ..db import get_conn
from ..schemas import NotificationOut
from ..services import notifications_service

router = APIRouter(prefix="/notifications", tags=["notifications"])


@router.get("", response_model=list[NotificationOut])
def list_my_notifications(unread_only: bool = False, user=Depends(get_current_user)):
    officer_id = user.get("sub")
    if not officer_id or not str(officer_id).isdigit():
        return []
    with get_conn() as conn:
        return notifications_service.list_for_officer(conn, int(officer_id), unread_only)


@router.post("/{notification_id}/read", status_code=204)
def mark_notification_read(notification_id: int, user=Depends(get_current_user)):
    officer_id = user.get("sub")
    if not officer_id or not str(officer_id).isdigit():
        raise HTTPException(status_code=400, detail="This session has no officer account")
    with get_conn() as conn:
        if not notifications_service.mark_read(conn, int(officer_id), notification_id):
            raise HTTPException(status_code=404, detail="Notification not found")
