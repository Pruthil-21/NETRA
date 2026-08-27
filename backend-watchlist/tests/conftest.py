import jwt
import pytest
from fastapi.testclient import TestClient

from app.config import settings
from app.main import app


@pytest.fixture
def client():
    return TestClient(app)


def make_token(role: str, sub: str = "test-officer"):
    return jwt.encode({"sub": sub, "role": role}, settings.jwt_secret, algorithm="HS256")


@pytest.fixture
def officer_headers():
    return {"Authorization": f"Bearer {make_token('officer')}"}


@pytest.fixture
def internal_headers():
    return {"X-Internal-Key": settings.internal_service_key}
