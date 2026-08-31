# Backup And Restore Runbook

## Backup

Back up these assets:

- Postgres database
- MinIO buckets
- `.env` and secret material, stored encrypted outside the host
- deployed image tag/version

Minimum acceptable cadence for pilot use:

- Postgres: daily dump
- MinIO: daily sync/snapshot
- Secrets: after every rotation/change

The worker deletes rows on a daily retention schedule — job failures after 30 days, terminal agent runs after 90, orphan attachments after 7. The daily Postgres dump is what stands between an over-aggressive retention change and permanent loss, so keep the cadence above once cleanup is running. See `docs/runbooks/worker-queues.md`.

For the local Docker Compose stack, write non-destructive backup artifacts to `backups/`:

```shell
npm run backup
```

Target individual stores when needed:

```shell
npm run backup:postgres
npm run backup:minio
```

The Postgres backup uses `pg_dump -Fc` from the running `postgres` service. The MinIO backup streams a tar archive of `/data` from the running `minio` service. Override paths with `PACKETCHAT_ENV_FILE`, `PACKETCHAT_COMPOSE_FILE`, or `PACKETCHAT_BACKUP_DIR`.

Check the newest local backup artifacts without restoring anything:

```shell
npm run restore:check
```

Check explicit artifacts:

```shell
node scripts/restore-check.mjs --postgres backups/2026-04-24T00-00-00-000Z-postgres.dump --minio backups/2026-04-24T00-00-00-000Z-minio-data.tar
```

`restore:check` is read-only. It verifies the Postgres custom dump header, verifies the MinIO tar header, and, when local tools are available, runs `pg_restore --list` and `tar -tf` to confirm catalogs can be enumerated. Use `--skip-list` to avoid optional local tool checks.

Equivalent manual commands:

```shell
docker compose --env-file .env -f infrastructure/compose/docker-compose.yml exec -T postgres pg_dump -U packetchat -d packetchat -Fc > backups/postgres.dump
docker compose --env-file .env -f infrastructure/compose/docker-compose.yml exec -T minio tar -C /data -cf - . > backups/minio-data.tar
```

These commands do not remove containers, volumes, buckets, or database objects.

## Restore Drill

1. Start a clean isolated host or VM.
2. Restore `.env` and secret material.
3. Restore Postgres.
4. Restore MinIO buckets.
5. Start PacketChat with the same image tag.
6. Run `npm run restore:check` against the copied backup artifacts before restoring them into the isolated host.
7. Run readiness checks.
8. Verify admin login.
9. Verify a normal user login.
10. Verify old conversations load.
11. Verify an uploaded attachment downloads.
12. Verify a knowledge document can be retrieved.
13. Run `npm run smoke` with `PACKETCHAT_SMOKE_EMAIL` and `PACKETCHAT_SMOKE_PASSWORD` set for a restored user.

If the restore was used during a real incident, rotate admin and provider credentials after recovery.

## Non-Destructive Restore Verification

For routine operations, do not restore into the production compose project or delete volumes as a verification shortcut. A safe restore verification is either:

- Artifact check only: run `npm run restore:check` on the newest or explicitly selected artifacts.
- Full drill: restore into an isolated host, VM, or separate compose project name with copied secrets and copied backup artifacts, then run readiness and smoke checks there.

Avoid `docker compose down -v`, bucket deletion, or database drops in production during backup verification.
