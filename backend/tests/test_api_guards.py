"""HTTP regressions for authentication and completion preconditions."""

from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient
import pytest

from optiroute.config import get_config
from optiroute.main import app


@pytest.mark.parametrize("path", ["/api/v1/dashboard/overview", "/api/v1/cache", "/api/v1/chats", "/api/v1/policies"])
def test_protected_endpoints_require_authentication(path):
    with TestClient(app) as client:
        assert client.get(path).status_code == 401


def test_health_is_public():
    with TestClient(app) as client:
        assert client.get("/health").json() == {"status": "ok"}


def test_completion_requires_authentication():
    with TestClient(app) as client:
        response = client.post("/v1/chat/completions", json={
            "model": "auto", "messages": [{"role": "user", "content": "hello"}]
        })
        assert response.status_code == 401


def test_completion_requires_connected_model(authenticated_client):
    with patch("optiroute.main.call_model_with_continuation", new_callable=AsyncMock) as provider:
        response = authenticated_client.post("/v1/chat/completions", json={
            "model": "auto", "messages": [{"role": "user", "content": "hello"}]
        })
        assert response.status_code == 400
        assert "Add a model" in response.json()["detail"]
        provider.assert_not_called()


def test_completion_rejects_empty_prompt(authenticated_client):
    with patch("optiroute.main.config_for_user", new_callable=AsyncMock,
               return_value=(get_config(), True)), \
         patch("optiroute.main.call_model_with_continuation", new_callable=AsyncMock) as provider:
        response = authenticated_client.post("/v1/chat/completions", json={
            "model": "auto", "messages": [{"role": "user", "content": " "}]
        })
        assert response.status_code == 400
        assert "user prompt" in response.json()["detail"]
        provider.assert_not_called()
