"""Manual driving-license lookup for officers (SARTHI integration --
currently a placeholder, see services/govt_lookup_service.py). Keyed on
a DL number, not a plate number -- ml-anpr never captures a DL number
from camera footage, so this is a standalone utility an officer uses
directly, not something tied to a plate detection or alert.
"""
from fastapi import APIRouter, Depends

from ..auth import require_role
from ..services import govt_lookup_service

router = APIRouter(prefix="/license-lookup", tags=["license-lookup"])


@router.get("/{dl_number}")
def get_license_lookup(dl_number: str, user=Depends(require_role("officer"))):
    return govt_lookup_service.lookup_sarathi(dl_number)
