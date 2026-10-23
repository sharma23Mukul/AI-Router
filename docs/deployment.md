# Deploy OptiRoute for the demo

The frontend is a static site. The free Render backend sleeps when idle and loses local files on restart. This version saves committed SQLite snapshots in Cloud Firestore to retain chats, cache, workflows, and connected models. It is for **one Render backend instance** and a small college demo. A new deployment starts with an empty database; existing local chats are not uploaded automatically.

## 1. Verify Firestore

In your Firebase project, create or verify a Firestore database named `(default)` in Native mode under **Build → Firestore Database**. Choose a location suitable for your backend and confirm the current quotas and billing requirements in the Firebase console before enabling snapshot persistence.

The database was created in Production mode, which denies browser access to this server-side data. Keep these rules in **Firestore Database → Rules**. Firebase Admin SDK bypasses client rules:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if false;
    }
  }
}
```

In **Project settings → Service accounts → Firebase Admin SDK**, generate a service-account private key. Keep the JSON file private and never add it to GitHub. Paste its **entire JSON content** into Render's secret environment variable `FIREBASE_SERVICE_ACCOUNT_JSON`.

## 2. Push the code

Inspect `git status` and `git diff`, then commit and push to GitHub. Render builds from the pushed branch. The root `.gitignore` excludes `.env` files, service-account files, local SQLite data, and the downloaded ONNX model.

## 3. Render backend web service

Create a **Python 3** web service from the GitHub repository, branch `main`, with Root Directory `backend`. The free 512 MB instance is the intended demo target. Set Python to the version in `backend/.python-version` (currently 3.12.14).

Build command:

```sh
python -m pip install -r requirements.txt && python scripts/preload_embeddings.py
```

Start command:

```sh
python -m uvicorn optiroute.main:app --host 0.0.0.0 --port $PORT
```

Health check path: `/health`.

Backend environment variables:

- `FIREBASE_PROJECT_ID`: your Firebase project ID.
- `FIREBASE_SERVICE_ACCOUNT_JSON`: complete private service-account JSON from step 1.
- `OPTIROUTE_FIRESTORE_PERSISTENCE=1`
- `WORKFLOW_ENCRYPTION_KEY`: one Fernet key, kept permanently in Render. Changing it makes previously connected provider API keys unreadable.

Generate a key locally:

```sh
python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
```

No persistent disk or `OPTIROUTE_DATA_DIR` setting is needed for this free configuration. The Firestore database and service account must exist before the backend starts; startup fails if storage cannot be reached rather than silently starting with missing chats.

## 4. Render frontend static site

Create a Render Static Site from the same repository. Set Root Directory `frontend`, build command `npm ci && npm run build`, and publish directory `dist`. Use Node 24.12.0 or a compatible Node 24 release, as specified in `frontend/.node-version`. Set your own `VITE_FIREBASE_*` values using `frontend/.env.example` as a template, plus `VITE_API_BASE_URL` to the backend HTTPS origin without a trailing slash. Set these before building; Vite embeds them into the browser bundle.

Add a rewrite rule: source `/*`, destination `/index.html`, action `Rewrite`.

In Firebase Authentication, enable Email/Password and Google sign-in and add the frontend Render hostname to **Authorized domains**.

## 5. Verify before the presentation

Open the backend `/health` endpoint and the frontend URL. Sign in, connect a model, send a short prompt, retry with a heavier model, and check chat history and semantic cache. Restart or redeploy the backend, then sign in again and verify that all records remain. A browser refresh alone should not delete them.

The free service can sleep after inactivity, so the first request after a pause may be slow. The embedding model is downloaded during the build. External model providers can still fail, and free Render memory limits can still cause a crash; rehearse the exact demo prompts on the deployed site.
