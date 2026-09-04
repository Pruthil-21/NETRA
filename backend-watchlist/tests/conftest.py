import jwt
import pytest
from app.config import settings
from app.main import app
from fastapi.testclient import TestClient


@pytest.fixture
def client():
    return TestClient(app)


def make_token(role: str, sub: str = "test-officer"):
    return jwt.encode({"sub": sub, "role": role}, settings.jwt_secret, algorithm="HS256")


@pytest.fixture
def officer_headers():
    return {"Authorization": f"Bearer {make_token('officer')}"}


@pytest.fixture
def second_officer_headers():
    return {"Authorization": f"Bearer {make_token('officer', sub='second-test-officer')}"}


@pytest.fixture
def internal_headers():
    return {"X-Internal-Key": settings.internal_service_key}


@pytest.fixture
def scoping_test_cameras():
    """Guaranteed cleanup for cameras a scoping test creates in the shared
    cameras table, even if an assertion fails first."""
    from tests.test_detections import _delete_test_camera

    created_ids: list[int] = []
    yield created_ids
    for camera_id in created_ids:
        _delete_test_camera(camera_id)
