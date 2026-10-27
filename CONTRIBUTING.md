# Contributing

Follow the root README to configure the backend and frontend independently. Keep API code in `backend/optiroute`, routing logic in its `engine` package, UI code in `frontend/src`, and documentation in `docs/`.

## Before submitting a change

1. Install backend development dependencies with `python -m pip install -r requirements-dev.txt` from `backend/`.
2. Run `python -m pytest` from `backend/`.
3. Run `npm ci`, `npm run lint`, and `npm run build` from `frontend/` with the Node version in `.node-version`.
4. Add focused regression coverage for behavior changes. Use temporary databases and mocked external services; routine tests must not spend provider credits or modify a real Firebase project.
5. Keep `frontend/package-lock.json` synchronized with `package.json`, and document configuration changes in `.env.example` and `docs/deployment.md`.

Live provider checks must be explicitly opted into. Offline tests do not verify provider access, Firebase login, model downloads, or deployed Firestore persistence. Never commit secrets, database snapshots, generated model weights, or dependency folders.

To run the live check, set `OPTIROUTE_RUN_LIVE_TESTS=1` and the provider key named by the light-tier model in `backend/config.yaml`, then run `python -m pytest -m live` from `backend/`. This sends a real provider request and may consume credits. See [validation notes](docs/quality.md) for known limitations and remaining checks.

Use descriptive commits such as `feat(routing): rank connected models by workload` or `fix(cache): isolate cached answers by user`. Separate behavior changes from unrelated formatting changes.
