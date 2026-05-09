# Release Runbook

1. Confirm CI is green for the commit being released.
2. Run `npm run prod:check` locally if the release contains dependency, build, or operational changes.
3. Build immutable images with a version tag.
4. Back up Postgres and MinIO.
5. Pull images on the host.
6. Run the migration job once.
7. Restart `web` and `worker`.
8. Check `/api/readyz`.
9. Run the smoke-test checklist in `docs/smoke-test.md`.
10. Keep the previous image tag available for rollback.

Never run migrations concurrently from both `web` and `worker`.
