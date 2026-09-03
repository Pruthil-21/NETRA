"""Lookups against restricted government databases: VAHAN (MoRTH vehicle
registry), eGujCop (Gujarat Police crime/FIR records), and SARTHI (MoRTH
driving license registry).

None of these have public APIs. Real access to any of them requires a
formal application to the relevant department and is granted only to
approved entities (insurance companies, banks, law enforcement) --
eGujCop specifically requires direct authorization from Gujarat Police,
since its records are police-internal. Not something we have yet, and
not something a hackathon team can obtain in the project's timeframe.

This module exists so the rest of the system (manual lookup endpoints,
alert enrichment) is wired up and ready: the day real credentials exist
for any one of these, only that lookup function's body + its env vars
need to change -- no caller needs to change, since they already handle
the "not_configured" shape.

Deliberately excludes AFIS/NAFIS (fingerprint identification) -- those
need physical biometric scanner hardware and person-level fingerprint
capture, which is out of scope for a plate-detection pipeline.

Never raises -- callers (routers, alert enrichment) can call any of
these unconditionally without a try/except.
"""
import os

VAHAN_API_URL = os.environ.get("VAHAN_API_URL", "")
VAHAN_API_KEY = os.environ.get("VAHAN_API_KEY", "")

EGUJCOP_API_URL = os.environ.get("EGUJCOP_API_URL", "")
EGUJCOP_API_KEY = os.environ.get("EGUJCOP_API_KEY", "")

SARATHI_API_URL = os.environ.get("SARATHI_API_URL", "")
SARATHI_API_KEY = os.environ.get("SARATHI_API_KEY", "")


def lookup_vahan(plate_number: str) -> dict:
    """Vehicle registration + ownership details, by plate number."""
    if not VAHAN_API_URL or not VAHAN_API_KEY:
        return {
            "status": "not_configured",
            "plate_number": plate_number,
            "owner_name": None,
            "vehicle_model": None,
            "registration_date": None,
        }

    # Real call goes here once VAHAN_API_URL/VAHAN_API_KEY are set.
    # Deliberately not implemented against a guessed request/response
    # shape -- MoRTH's real API contract isn't available to test against
    # yet. Implement and test this against the real docs once access is
    # actually granted, not before.
    return {
        "status": "not_implemented",
        "plate_number": plate_number,
        "owner_name": None,
        "vehicle_model": None,
        "registration_date": None,
    }


def lookup_egujcop(plate_number: str) -> dict:
    """Gujarat Police crime/FIR records linked to a plate number -- e.g. is
    this vehicle flagged in an open case or reported stolen. Separate from
    VAHAN (which is ownership/registration only, not crime history)."""
    if not EGUJCOP_API_URL or not EGUJCOP_API_KEY:
        return {
            "status": "not_configured",
            "plate_number": plate_number,
            "has_open_case": None,
            "case_ids": None,
        }

    # Real call goes here once EGUJCOP_API_URL/EGUJCOP_API_KEY are set --
    # not implemented against a guessed shape, since eGujCop has no
    # published API contract to test against (police-internal system).
    return {
        "status": "not_implemented",
        "plate_number": plate_number,
        "has_open_case": None,
        "case_ids": None,
    }


def lookup_vehicle(plate_number: str) -> dict:
    """Combined plate-keyed government lookup -- both VAHAN and eGujCop
    take a plate number, so a single "look up this plate" action in the UI
    can show both at once instead of two separate searches."""
    return {
        "vahan": lookup_vahan(plate_number),
        "egujcop": lookup_egujcop(plate_number),
    }


def lookup_sarathi(dl_number: str) -> dict:
    """Driving license holder details, by DL number -- SARTHI, not VAHAN.
    Keyed on a driving license number, not a plate number: ml-anpr only
    ever captures plate reads, never a DL number, so this can't be tied to
    a camera detection or an alert the way VAHAN/eGujCop are -- it's a
    standalone manual lookup an officer types a DL number into directly."""
    if not SARATHI_API_URL or not SARATHI_API_KEY:
        return {
            "status": "not_configured",
            "dl_number": dl_number,
            "holder_name": None,
            "license_class": None,
            "issue_date": None,
        }

    # Real call goes here once SARATHI_API_URL/SARATHI_API_KEY are set --
    # not implemented against a guessed shape, same reasoning as VAHAN above.
    return {
        "status": "not_implemented",
        "dl_number": dl_number,
        "holder_name": None,
        "license_class": None,
        "issue_date": None,
    }
