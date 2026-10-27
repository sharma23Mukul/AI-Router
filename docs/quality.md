# Validation and follow-up

The repository migration was validated locally on Windows with Python 3.13.1 and Node 24.12.0. CI additionally targets the Python 3.12 version specified in `backend/.python-version`.

- Backend: 56 tests passed; one live-provider check is skipped unless explicitly enabled.
- Frontend: lint exits successfully with React warnings; the production build succeeds with a large-bundle warning.
- Compatible dependency updates were applied through `npm audit fix`. The resulting audit still reports eight findings (four high and four low), through Firebase's Firestore/gRPC dependencies and nested KaTeX dependencies. Forced automatic fixes propose major downgrades, so they were not applied. These findings remain open; this is not a clean dependency security audit.

Offline tests use temporary SQLite databases, a fake Firestore client, and deterministic embedding vectors. They verify persistence and cache control flow, not live embedding quality. They do not establish that Firebase sign-in, provider calls, or deployed Firestore restore work in a real account. Follow the deployment smoke checks before a demo.

## Next engineering priorities

- Resolve remaining transitive dependency advisories with compatible upstream releases or targeted, tested dependency changes.
- Address React lint warnings in the authentication utilities and Playground.
- Split frontend routes into lazy-loaded bundles and optimize large landing-page images.
- Add browser-level coverage for sign-in, provider connections, chat, retries, and cancellation.
- Before horizontal scaling, replace SQLite snapshots and in-memory jobs with shared durable services.

Original phase-numbered tests have been updated and renamed by behavior. Earlier assumptions about anonymous API access, model IDs, and cross-user seed data are preserved in Git history rather than used as current test contracts.
