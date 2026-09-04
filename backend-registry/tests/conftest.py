import jwt
import pytest
from app.config import settings
from app.db import get_conn
from app.main import app
from fastapi.testclient import TestClient


@pytest.fixture
def client():
    return TestClient(app)


def make_token(role: str, sub: str = "test-user"):
    return jwt.encode({"sub": sub, "role": role}, settings.jwt_secret, algorithm="HS256")


@pytest.fixture
def officer_headers():
    return {"Authorization": f"Bearer {make_token('officer')}"}


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
