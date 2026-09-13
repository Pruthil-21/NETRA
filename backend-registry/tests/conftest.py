import jwt
import pytest
from app.config import settings
from app.db import get_conn
from app.main import app
from app.services import email_service
from app.services.rbac_service import VALID_PERMISSIONS
from fastapi.testclient import TestClient


@pytest.fixture(autouse=True)
def captured_otps(monkeypatch):
    """Every real OTP send (login 2FA, self-service password reset,
    registration-email verification) goes through
    email_service.send_otp_email -- monkeypatched here, for every test in
    this suite, to capture (to, code, purpose) instead of calling Resend
    for real.

    autouse: without this, any test that logs in as an officer whose email
    happens to be set -- including one left behind by an earlier test
    sharing this same dev-time Postgres DB -- 503s trying to reach Resend
    (email_service.EmailSendError, converted to a hard 503 in auth.py by
    design: a caller mid-2FA needs to know a code never actually reached
    the officer). In CI, where RESEND_API_KEY is never set at all, that
    503 fires unconditionally on every such login. Neither is a real bug
    in the app; it's tests making a real network call they were never
    meant to.

    A test that needs the actual code back (to drive a verify-otp call)
    requests this fixture directly and reads its returned list, the same
    way test_email_2fa.py and test_registration_approval.py already did
    with their own now-removed local copies of this exact fixture."""
    sent: list[tuple[str, str, str]] = []

    def fake_send_otp_email(to, code, purpose):
        sent.append((to, code, purpose))

    monkeypatch.setattr(email_service, "send_otp_email", fake_send_otp_email)
    return sent


@pytest.fixture
def client():
    # Must be used as a context manager -- Starlette's TestClient only fires
    # @app.on_event("startup") handlers this way, which is what lets
    # recording_health_stream.manager capture the running event loop during
    # tests (see main.py), exactly as it would under real uvicorn. Same fix
    # backend-watchlist's own client fixture already carries.
    with TestClient(app) as c:
        yield c


def make_token(role: str, sub: str = "test-user", permissions: list[str] | None = None):
    payload = {"sub": sub, "role": role}
    if permissions is not None:
        payload["permissions"] = permissions
    return jwt.encode(payload, settings.jwt_secret, algorithm="HS256")


@pytest.fixture
def officer_headers():
    # Explicit, full permission grant -- auth.py no longer trusts a bare
    # {"role": "officer"} token with no permissions claim at all (that was
    # a real, live-exploitable auth bypass; see require_permission/
    # has_permission). Granting every VALID_PERMISSIONS entry here keeps
    # this fixture meaning what it always meant ("an officer who can do
    # anything the app supports") for the ~24 existing tests using it,
    # without any of them needing to know or care about specific permission
    # strings themselves.
    return {"Authorization": f"Bearer {make_token('officer', permissions=sorted(VALID_PERMISSIONS))}"}


@pytest.fixture
def viewer_headers():
    return {"Authorization": f"Bearer {make_token('viewer')}"}


@pytest.fixture
def synthetic_test_cameras(synthetic_test_edge_nodes):
    """Guaranteed cleanup for synthetic cameras a test creates -- deletes only
    rows whose id was appended to the yielded list, never a blanket
    is_synthetic delete (which would wipe a live demo's full 80,000-row seed
    if the suite happened to run while it was loaded). Usage:
        def test_x(synthetic_test_cameras):
            cam_id = ...insert a synthetic camera, get its id back...
            synthetic_test_cameras.append(cam_id)
            ...assertions...
    This runs during pytest's fixture teardown, so cleanup happens even if
    an assertion above raises -- unlike a bare cleanup() call at the bottom
    of the test function, which is skipped the moment an earlier assert fails.

    Depends on synthetic_test_edge_nodes to ensure proper teardown ordering:
    cameras (which reference edge_nodes via FK) are deleted first, then edge_nodes."""
    created_ids: list[int] = []
    yield created_ids
    if created_ids:
        with get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute("DELETE FROM cameras WHERE id = ANY(%s)", (created_ids,))
            conn.commit()


@pytest.fixture
def synthetic_test_edge_nodes():
    """Same guarantee as synthetic_test_cameras, for edge_nodes rows."""
    created_ids: list[int] = []
    yield created_ids
    if created_ids:
        with get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute("DELETE FROM edge_nodes WHERE id = ANY(%s)", (created_ids,))
            conn.commit()


@pytest.fixture
def gap_analysis_test_cameras():
    """Guaranteed cleanup for cameras created by gap-analysis tests -- these
    are ordinary (is_synthetic=false) cameras, i.e. REAL rows that would
    otherwise show up in GET /cameras, on the operational map, and in
    district summaries the moment they're committed. A bare end-of-function
    DELETE (the old pattern) is skipped the instant an earlier assert raises,
    permanently leaking a fabricated camera into the live registry -- exactly
    the hazard synthetic_test_cameras' docstring above warns about, just with
    real rather than synthetic rows. This fixture runs its DELETE during
    pytest's fixture teardown instead, so cleanup happens even when an
    assertion above raises. Usage:
        def test_x(gap_analysis_test_cameras):
            cam_id = ...insert a camera, get its id back...
            gap_analysis_test_cameras.append(cam_id)
            ...assertions...
    Deletes camera_status_history rows for these cameras first (FK on
    camera_id), then the cameras themselves."""
    created_ids: list[int] = []
    yield created_ids
    if created_ids:
        with get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute("DELETE FROM camera_status_history WHERE camera_id = ANY(%s)", (created_ids,))
                cur.execute("DELETE FROM cameras WHERE id = ANY(%s)", (created_ids,))
            conn.commit()


@pytest.fixture
def gap_analysis_test_targets():
    """Same guarantee as gap_analysis_test_cameras, for coverage_targets rows
    created by gap-analysis / coverage-targets tests. Lower stakes than real
    cameras (coverage_targets isn't exposed on the operational map), but the
    same shape of hazard from a bare end-of-function DELETE."""
    created_ids: list[int] = []
    yield created_ids
    if created_ids:
        with get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute("DELETE FROM coverage_targets WHERE id = ANY(%s)", (created_ids,))
            conn.commit()


@pytest.fixture
def police_station_test_rows():
    """Guaranteed cleanup for police_stations rows a test creates, even if
    an assertion fails first."""
    created_ids: list[int] = []
    yield created_ids
    if created_ids:
        with get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute("DELETE FROM police_stations WHERE id = ANY(%s)", (created_ids,))
            conn.commit()


@pytest.fixture
def area_test_rows():
    """Guaranteed cleanup for areas rows a test creates, even if an
    assertion fails first. Must run after any camera FK'ing to these rows
    is deleted -- tests that assign a camera to an area append that
    camera's id to gap_analysis_test_cameras (or synthetic_test_cameras),
    not this fixture, so ordering is handled by pytest tearing down
    fixtures in reverse dependency order."""
    created_ids: list[int] = []
    yield created_ids
    if created_ids:
        with get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute("DELETE FROM areas WHERE id = ANY(%s)", (created_ids,))
            conn.commit()


def _village_id_for_district(district_name: str) -> int:
    """Resolves a village_id whose district is exactly `district_name` --
    lets every test that used to POST /areas with a flat "district" string
    keep expressing the same district-scoping intent now that Area requires
    a real village_id. A real seeded district (Anand, Vadodara, Ahmedabad,
    ...) gets its own dedicated "<district> Test Taluka" / "<district> Test
    Village" rather than reusing one of its real seeded villages, so test
    runs never collide with real reference data; a district name a test
    invents purely to be "some other district" (e.g. "Traffic Police",
    "Some Other District") gets a throwaway district too. Idempotent --
    get-or-create at every level, safe to call repeatedly across a run or
    across runs against the same dev DB."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT id FROM districts WHERE name = %s", (district_name,))
            row = cur.fetchone()
            if row is None:
                cur.execute("INSERT INTO districts (name) VALUES (%s) RETURNING id", (district_name,))
                row = cur.fetchone()
            district_id = row[0]

            taluka_name = f"{district_name} Test Taluka"
            cur.execute("SELECT id FROM talukas WHERE district_id = %s AND name = %s", (district_id, taluka_name))
            row = cur.fetchone()
            if row is None:
                cur.execute(
                    "INSERT INTO talukas (name, district_id) VALUES (%s, %s) RETURNING id",
                    (taluka_name, district_id),
                )
                row = cur.fetchone()
            taluka_id = row[0]

            village_name = f"{district_name} Test Village"
            cur.execute("SELECT id FROM villages WHERE taluka_id = %s AND name = %s", (taluka_id, village_name))
            row = cur.fetchone()
            if row is None:
                cur.execute(
                    "INSERT INTO villages (name, taluka_id) VALUES (%s, %s) RETURNING id",
                    (village_name, taluka_id),
                )
                row = cur.fetchone()
            village_id = row[0]
        conn.commit()
    return village_id


@pytest.fixture
def village_for_district():
    """Callable fixture: village_for_district("Anand") -> a real village_id
    whose district is "Anand" -- see _village_id_for_district above."""
    return _village_id_for_district


@pytest.fixture
def data_job_test_rows():
    """Guaranteed cleanup for import_export_jobs rows a test creates, even
    if an assertion fails first -- this table had no such fixture before
    (every existing Data Console/import-export test left its jobs behind
    permanently), which is exactly what let ordinary test runs quietly
    accumulate well over a hundred junk rows in the shared dev database."""
    created_ids: list[int] = []
    yield created_ids
    if created_ids:
        with get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute("DELETE FROM import_export_jobs WHERE id = ANY(%s)", (created_ids,))
            conn.commit()
