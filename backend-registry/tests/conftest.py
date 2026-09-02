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
def synthetic_test_cameras():
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
    of the test function, which is skipped the moment an earlier assert fails."""
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
