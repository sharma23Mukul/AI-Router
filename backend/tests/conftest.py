"""Offline test configuration; never use a developer's Firebase or SQLite state."""

import os

import pytest

os.environ["FIREBASE_PROJECT_ID"] = "optiroute-test"
os.environ["OPTIROUTE_FIRESTORE_PERSISTENCE"] = "0"
os.environ.pop("FIREBASE_SERVICE_ACCOUNT_JSON", None)


@pytest.fixture(autouse=True)
def isolated_database(tmp_path, monkeypatch):
    from optiroute import database as db
    from optiroute import firestore_persistence as durable

    monkeypatch.setattr(db, "_DB_DIR", tmp_path)
    monkeypatch.setattr(db, "_DB_PATH", tmp_path / "test.db")
    monkeypatch.setattr(durable, "_enabled", False)


@pytest.fixture
def authenticated_client():
    from fastapi.testclient import TestClient
    from optiroute.auth import get_current_user
    from optiroute.main import app

    async def test_user():
        return {"client_id": "user-demo", "uid": "test-uid", "email": "demo@optiroute.com"}

    app.dependency_overrides[get_current_user] = test_user
    try:
        with TestClient(app) as client:
            yield client
    finally:
        app.dependency_overrides.pop(get_current_user, None)
