# Release Runbook

1. Confirm CI is green for the commit being released. CI runs `npm run prod:check` plus a Docker Compose gate that renders the Compose config and builds the `web`, `worker`, and `migrate` image targets from `.env.example`.
2. Run `npm run prod:check` locally if the release contains dependency, build, or operational changes.
3. Run `npm run compose:check` locally when the release contains Dockerfile, Compose, dependency, or deployment-script changes.
4. Build immutable images with a version tag.
5. Back up Postgres and MinIO.
6. Pull images on the host.
7. Run the migration job once.
8. Restart `web` and `worker`. The worker re-registers the daily retention cleanup schedule on every boot; confirm it logged `Cleanup schedule registered`.
9. Check `/api/readyz`.
10. Run the smoke-test checklist in `docs/smoke-test.md`.
11. Keep the previous image tag available for rollback.

Never run migrations concurrently from both `web` and `worker`.

The first release that carries scheduled retention cleanup deletes whatever backlog the deployment has accumulated on its first 03:15 pass. Do not skip step 5 for that release. See `docs/runbooks/worker-queues.md`.

The CI Compose gate does not start containers, apply migrations, seed an admin, or call `npm run smoke`; keep those deployment-specific readiness checks in the release smoke pass.
