# OptiRoute current project report

This source-based summary describes the FastAPI and React implementation. It replaces the former Node.js backend and classifier-training prototype; the previous implementation remains available in Git history.

## Technology stack

| Layer | Technology | Active source |
| --- | --- | --- |
| Web app | React 19, Vite 8, React Router, Tailwind CSS | `frontend/package.json`, `frontend/src/App.jsx` |
| API | Python 3.12, FastAPI, Uvicorn | `backend/requirements.txt`, `backend/optiroute/main.py` |
| Authentication | Firebase Authentication; backend verifies Firebase ID tokens | `frontend/src/utils/firebase.js`, `backend/optiroute/auth.py` |
| Persistence | SQLite through aiosqlite, optional Firestore snapshots | `backend/optiroute/database.py`, `backend/optiroute/firestore_persistence.py` |
| Provider access | User-supplied API keys encrypted with Fernet; models organized by tier | `backend/optiroute/connections.py` |
| Routing | Workload evaluation, model ranking, tier selection, fallback, continuation | `backend/optiroute/engine/`, `backend/optiroute/proxy.py` |
| Cache | Exact and semantic matching scoped to each user | `backend/optiroute/engine/cache_manager.py` |
| Response display | Markdown, tables, and KaTeX equations | `frontend/src/components/ui/MarkdownRenderer.jsx` |
| Dashboard | Per-model and weekly tier request charts | `frontend/src/components/dashboard/` |

## Current user flow

A user signs in through Firebase, connects provider models on Routing Policies, and sends a prompt from the Playground. The backend checks the user's cache, evaluates the workload, chooses a tier and model, and records the answer, request data, and chat history. The user may request a heavier model for an answer, choose which answer to continue from, and select an answer for caching. Cache and chat deletion are linked where the current UI provides that action.

## Routes and data

The frontend includes Home, Login, Signup, Playground, Overview, Routing Policies, and Semantic Cache pages. The active API is `backend/optiroute/main.py`, with authentication and model-connection routes in separate modules. It serves chat completion and retry jobs, progress polling and cancellation, cache management, chat history, dashboard data, and a health endpoint. The backend creates `backend/data/optiroute.db` on startup by default. On deployment, set `OPTIROUTE_DATA_DIR` to a persistent mounted directory.

## Deployment needs

The frontend needs a public HTTPS API URL and Firebase web configuration at build time. The backend needs `FIREBASE_PROJECT_ID`, a stable `WORKFLOW_ENCRYPTION_KEY`, and a persistence strategy: either a persistent SQLite volume or optional Firestore snapshots. Firebase Authentication must authorize the deployed frontend domain. Users must connect working provider API keys and models before generation works. See [deployment.md](deployment.md) for setup and demo checks.

## Operational boundaries

Run one backend instance. Firestore mode publishes compressed SQLite snapshots and restores them at startup; it is not a multi-writer database. Completion jobs and cancellation state are held in memory and do not survive restarts. Embedding weights are downloaded separately from source and can be preloaded during deployment.

The current module boundaries separate routing, provider calls, authentication, storage, and frontend presentation. Keep these boundaries while adding focused API modules as the main application grows; a wholesale directory rewrite is unnecessary for this migration.
