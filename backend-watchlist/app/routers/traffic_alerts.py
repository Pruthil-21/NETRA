"""Congestion alerts -- density/flow threshold breaches. See
services/traffic_alerts_service.py and schema.sql's traffic_alerts table
for why this is a separate model from the watchlist-match `alerts` above,
though delivery reuses the same WS channel (see alerts_stream.py's `kind`
discriminator).
"""
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from psycopg2.extras import RealDictCursor

from ..auth import require_permission
from ..database import get_db
from ..schemas import TrafficAlertOut, TrafficAlertStatusUpdate
from ..services import audit_service, traffic_alerts_service

router = APIRouter(prefix="/traffic-alerts", tags=["traffic-alerts"])


@router.get("", response_model=list[TrafficAlertOut])
def get_traffic_alerts(
    status: Optional[Literal["NEW", "ACKNOWLEDGED", "DISMISSED"]] = Query(None),
    alert_type: Optional[Literal["density", "flow"]] = Query(None),
    db: RealDictCursor = Depends(get_db),
    user=Depends(require_permission("view_analytics")),
):
    district = user.get("scope_value") if user.get("scope_type") == "district" else None
    return traffic_alerts_service.list_traffic_alerts(db, status=status, alert_type=alert_type, district=district)


@router.patch("/{alert_id}", response_model=TrafficAlertOut)
def update_traffic_alert_status(
    alert_id: int,
    body: TrafficAlertStatusUpdate,
    db: RealDictCursor = Depends(get_db),
    # acknowledge_alerts is defined in the RBAC seed but enforced nowhere
    # else in this codebase (the watchlist-alert PATCH route gates on
    # require_role("officer") instead) -- this is its first real use.
    user=Depends(require_permission("acknowledge_alerts")),
):
    actor = user.get("badge_number", user.get("sub"))
    alert = traffic_alerts_service.update_status(db, alert_id, body.status, actor)
    if alert is None:
        raise HTTPException(status_code=404, detail="Traffic alert not found")
    audit_service.log(db, actor, f"alert_{body.status.lower()}", "traffic_alert", alert_id)
    return alert
