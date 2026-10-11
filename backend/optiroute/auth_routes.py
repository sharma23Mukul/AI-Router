"""
Authentication routes for OptiRoute — Firebase-based.

Provides POST /api/auth/sync which is called by the frontend immediately
after every Firebase login or signup.  It creates or claims the USER row
in SQLite keyed by firebase_uid.
"""

import uuid
from fastapi import APIRouter, Depends
from pydantic import BaseModel
from typing import Optional

from optiroute.auth import get_current_user
from optiroute import database as db

auth_router = APIRouter(prefix="/api/auth", tags=["auth"])


class SyncRequest(BaseModel):
    organization_name: Optional[str] = None


@auth_router.post("/sync")
async def sync_user(
    request: SyncRequest = SyncRequest(),
    current_user: dict = Depends(get_current_user),
):
    """
    Create or claim a USER row after Firebase login/signup.

    Logic:
    1. If a user with this firebase_uid already exists → return it.
    2. If a placeholder user (firebase_uid IS NULL) exists → claim it
       by setting its firebase_uid and email.
    3. Otherwise → create a brand-new user with an empty dashboard.
    """
    firebase_uid = current_user["uid"]
    email = current_user["email"]
    org_name = request.organization_name or email.split("@")[0]

    # 1. Already synced?
    existing = await db.get_user_by_firebase_uid(firebase_uid)
    if existing:
        return {
            "client_id": existing["client_id"],
            "email": existing["email"],
            "organization_name": existing["organization_name"],
            "firebase_uid": existing["firebase_uid"],
        }

    # 2. Claim the placeholder row (first user gets the demo data)
    placeholder = await db.get_unclaimed_placeholder_user()
    if placeholder:
        await db.claim_user(placeholder["client_id"], firebase_uid, email)
        return {
            "client_id": placeholder["client_id"],
            "email": email,
            "organization_name": placeholder["organization_name"],
            "firebase_uid": firebase_uid,
        }

    # 3. Brand-new user
    client_id = str(uuid.uuid4())
    await db.create_user(client_id, email, firebase_uid, org_name)

    # Create a default workflow so the dashboard isn't completely empty
    workflow_id = f"wf-{client_id[:8]}"
    await db.create_workflow(workflow_id, client_id, "Default Workflow")

    return {
        "client_id": client_id,
        "email": email,
        "organization_name": org_name,
        "firebase_uid": firebase_uid,
    }
