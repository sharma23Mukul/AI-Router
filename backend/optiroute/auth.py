"""
Firebase Authentication helpers for OptiRoute.

Initialises the Firebase Admin SDK (project-ID only, no service-account file)
and provides a FastAPI dependency that verifies Firebase ID tokens on every
protected request.
"""

import os
import logging
import json

import firebase_admin
from firebase_admin import auth as firebase_auth, credentials
from fastapi import Header, HTTPException, Depends

logger = logging.getLogger("optiroute")

# ---------------------------------------------------------------------------
# Firebase Admin initialisation
# ---------------------------------------------------------------------------

_firebase_app = None


def _init_firebase():
    """Initialise the Firebase Admin SDK exactly once."""
    global _firebase_app
    if _firebase_app is not None:
        return

    project_id = os.environ.get("FIREBASE_PROJECT_ID")
    if not project_id:
        raise RuntimeError("FIREBASE_PROJECT_ID environment variable is not set")

    # Render needs a service-account credential to access Firestore. Keep the
    # JSON in an environment variable, never in Git. Local development can
    # continue using a gitignored file or public-key-only token verification.
    sa_path = os.path.join(os.path.dirname(__file__), "..", "firebase-adminsdk.json")
    sa_json = os.environ.get("FIREBASE_SERVICE_ACCOUNT_JSON")
    
    try:
        if sa_json:
            cred = credentials.Certificate(json.loads(sa_json))
            _firebase_app = firebase_admin.initialize_app(cred, options={"projectId": project_id})
            logger.info("Firebase Admin initialised using service account environment variable.")
        elif os.path.exists(sa_path):
            cred = credentials.Certificate(sa_path)
            _firebase_app = firebase_admin.initialize_app(cred, options={"projectId": project_id})
            logger.info("Firebase Admin initialised using service account file.")
        else:
            from google.auth.credentials import AnonymousCredentials
            # Try without credentials but bypass ADC requirement
            _firebase_app = firebase_admin.initialize_app(AnonymousCredentials(), options={"projectId": project_id})
            logger.info("Firebase Admin initialised with AnonymousCredentials (project=%s).", project_id)
    except Exception as exc:
        logger.error("Firebase Admin init failed: %s", exc)
        raise


# Eagerly initialise at import time so startup errors surface immediately.
_init_firebase()


# ---------------------------------------------------------------------------
# FastAPI dependency — verifies the Firebase ID token
# ---------------------------------------------------------------------------

async def get_current_user(authorization: str | None = Header(default=None)) -> dict:
    """
    Validate the ``Authorization: Bearer <id-token>`` header.

    Returns a dict with at least ``uid`` and ``email`` from the decoded
    Firebase token.  Raises HTTP 401 on any failure.
    """
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing or malformed Authorization header.")

    id_token = authorization.removeprefix("Bearer ").strip()

    try:
        decoded = firebase_auth.verify_id_token(id_token)
    except firebase_auth.ExpiredIdTokenError:
        raise HTTPException(status_code=401, detail="Token has expired. Please sign in again.")
    except firebase_auth.RevokedIdTokenError:
        raise HTTPException(status_code=401, detail="Token has been revoked. Please sign in again.")
    except firebase_auth.InvalidIdTokenError:
        raise HTTPException(status_code=401, detail="Invalid authentication token.")
    except Exception as exc:
        logger.warning("Firebase token verification failed: %s", exc)
        raise HTTPException(status_code=401, detail="Authentication failed.")

    uid = decoded.get("uid")
    email = decoded.get("email", "")
    name = decoded.get("name", "")

    # Load matching USER row from SQLite (Requirement: "loads the matching USER row")
    from optiroute import database as db
    import uuid

    user = await db.get_user_by_firebase_uid(uid)
    if not user:
        # If this is the first user, claim the placeholder demo data row
        placeholder = await db.get_unclaimed_placeholder_user()
        if placeholder:
            await db.claim_user(placeholder["client_id"], uid, email)
            user = await db.get_user_by_firebase_uid(uid)
        else:
            client_id = str(uuid.uuid4())
            await db.create_user(client_id, email, uid, name or email.split("@")[0])
            workflow_id = f"wf-{client_id[:8]}"
            await db.create_workflow(workflow_id, client_id, "Default Workflow")
            user = await db.get_user_by_firebase_uid(uid)

    client_id = user["client_id"] if user else f"user-{uid[:8]}"

    # Ensure a valid workflow exists for foreign key constraints
    workflows = await db.get_all_workflows(client_id)
    if not workflows:
        default_wf_id = f"wf-{client_id[:8]}"
        await db.create_workflow(default_wf_id, client_id, "Default Workflow")
        workflow_id = default_wf_id
    else:
        workflow_id = workflows[0]["workflow_id"]

    return {
        "uid": uid,
        "email": email,
        "name": name,
        "client_id": client_id,
        "workflow_id": workflow_id,
        "organization_name": user.get("organization_name", "") if user else "",
    }
