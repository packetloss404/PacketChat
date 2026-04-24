# Release Runbook

1. Build immutable images with a version tag.
2. Back up Postgres and MinIO.
3. Pull images on the host.
4. Run the migration job once.
5. Restart `web` and `worker`.
6. Check `/api/readyz`.
7. Run the smoke-test checklist in `docs/smoke-test.md`.
8. Keep the previous image tag available for rollback.

Never run migrations concurrently from both `web` and `worker`.
