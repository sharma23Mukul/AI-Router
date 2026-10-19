"""
Phase 9 tests — verify dashboard API endpoints.
"""

import sys
from pathlib import Path
import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from optiroute.main import app

def test_api_overview(authenticated_client):
    client = authenticated_client
    resp = client.get("/api/v1/dashboard/overview")
    assert resp.status_code == 200
    data = resp.json()
    assert "total_requests" in data
    assert "cost_saved" in data

def test_api_policies(authenticated_client):
    client = authenticated_client
    resp = client.get("/api/v1/policies")
    assert resp.status_code == 200
    assert isinstance(resp.json(), list)

def test_api_cache(authenticated_client):
    client = authenticated_client
    resp = client.get("/api/v1/cache")
    assert resp.status_code == 200
    assert isinstance(resp.json(), list)

def test_api_budgets(authenticated_client):
    client = authenticated_client
    resp = client.get("/api/v1/budgets")
    assert resp.status_code == 200
    assert isinstance(resp.json(), list)
