import jwt
import pytest
from app.config import settings
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
