# Worker Queues Runbook

The `worker` service consumes four BullMQ queues backed by `REDIS_URL`. Three do real work; one is deliberately inert.

| Queue | Job name | Producer | Behavior |
| --- | --- | --- | --- |
| `file-ingestion` | `ingest-file` | knowledge document upload | Downloads the object, extracts text, chunks it, and writes `knowledge_chunks`. |
| `provider-sync` | `sync-provider` | `POST /api/providers` (account created) and `POST /api/providers/{providerId}/models` (admin model sync) | Lists models from the provider and upserts `model_catalog` and `model_account_bindings`. |
| `cleanup` | `run-cleanup` | the worker's own daily scheduler | Deletes rows past their retention window. |
| `agent-run` | `run-agent` | none | Intentionally not wired. Agent runs execute synchronously in `web`. The handler throws `agent-run async execution is not enabled in this build` so a stray job fails visibly instead of disappearing. |

Every handler validates the job name and rejects anything it does not recognize.

## Provider Sync

A `sync-provider` job is enqueued after an admin creates a provider account, and after an admin runs a model sync from `/admin/providers`. Both producers are wrapped so a queue error is logged as a warning and does not fail the request; the account is still created and the manual refresh still succeeds.

The worker refuses accounts whose `status` is not `enabled`, so the model-sync route skips the enqueue for disabled accounts rather than queueing a job that can only fail.

Sync writes are conservative on purpose:

- `enabled` and `capability_overrides` on an existing binding are never touched, so operator choices survive a resync.
- Bindings for models the provider stopped reporting are counted but left alone. One listing call cannot distinguish a retired model from a degraded provider response. Retiring a model stays an explicit admin action through the model sync in `/admin/providers`, which does disable what is missing.
- A provider without a model-listing endpoint is a supported configuration, not a failure: the job logs `Provider model discovery unsupported` and writes nothing.

Failures rethrow, so the job is retried and then recorded in `job_failures`.

## Retention Policy

| Target | Table | What is deleted | Default window |
| --- | --- | --- | --- |
| `job-failures` | `job_failures` | every row older than the cutoff | 30 days |
| `completed-runs` | `agent_runs` | runs whose `status` is `completed`, `failed`, `cancelled`, or `timed_out`, and whose `created_at` and `coalesce(ended_at, created_at)` are both past the cutoff | 90 days |
| `orphan-attachments` | `attachments` | rows with no `conversation_id`, no `message_id`, no `knowledge_documents` row pointing at them, and a status other than `processing` | 7 days |

The windows live in `DEFAULT_RETENTION` in `apps/worker/src/cleanup.ts`. They are not environment variables; changing them is a code change and a redeploy. A one-off job can override the window for the targets it selects with `olderThanDays`.

The `completed-runs` status filter is re-applied inside the delete, so a stale id list can never remove a live run. The `orphan-attachments` predicate is re-applied too, so an attachment adopted between the list and the delete survives.

Each pass claims at most 5000 rows per target and deletes them in batches of 500. A large backlog therefore drains over several runs instead of one long-locking statement.

## The Daily Schedule

Cleanup runs at `15 3 * * *` — 03:15 daily in the worker container's timezone, which is UTC in the shipped image unless you set `TZ` — with target `all`.

The worker registers the schedule on every boot with `Queue.upsertJobScheduler` under the key `daily-cleanup`. Because the key is fixed, restarts and multiple worker replicas do not stack duplicate schedules, and a changed pattern takes effect at the next worker boot.

Registration failure does not stop the worker: file ingestion and provider sync still run. Look for these lines:

- `Cleanup schedule registered` — boot succeeded.
- `Cleanup schedule registration failed` — logged at error level. There is no schedule until the next boot retries the upsert; trigger cleanup by hand in the meantime.
- `Cleanup job completed` — one pass finished, with the selected `targets`, the per-target `deleted` counts, and the `cutoffs` used.

## Trigger A Cleanup By Hand

There is no admin UI and no npm script for this yet. Enqueue the job from the running worker container:

```shell
docker compose --env-file .env -f infrastructure/compose/docker-compose.yml exec worker \
  node --input-type=module -e "import { enqueueCleanupJob } from '@packetchat/jobs'; await enqueueCleanupJob({ target: 'all' }); process.exit(0);"
```

`process.exit(0)` is required; the Redis connection stays open otherwise.

To sweep one target, or to use a window other than the default:

```shell
docker compose --env-file .env -f infrastructure/compose/docker-compose.yml exec worker \
  node --input-type=module -e "import { enqueueCleanupJob } from '@packetchat/jobs'; await enqueueCleanupJob({ target: 'job-failures', olderThanDays: 90 }); process.exit(0);"
```

Rules the job enforces before deleting anything:

- `target` must be `job-failures`, `completed-runs`, `orphan-attachments`, or `all`. Anything else fails the job rather than quietly cleaning nothing.
- `olderThanDays` must be a whole number of at least 1. Zero, negative, and fractional values fail before the first query, because a cutoff at or after now would sweep live rows.
- `olderThanDays` overrides the window of every target the job selected, and only those.

## When A Job Fails

All three working queues retry 3 times with exponential backoff starting at 5 seconds. After the final attempt the failure is written to `job_failures` with the queue name, job name, error message, and payload, and appears in the job-failure rollup on `/admin/operations`.

Cleanup deletes are idempotent, so a retry after a partial pass is safe: an already-deleted id matches nothing.

## First Run After Upgrading

No deployment has run cleanup before. The first 03:15 pass after this change deploys will find every `job_failures` row older than 30 days and every terminal `agent_runs` row older than 90 days that the deployment has accumulated.

Back up Postgres before the worker restart that carries this change — `npm run backup:postgres`, or the manual commands in `docs/runbooks/backup-restore.md`. The per-target 5000-row cap means the backlog drains over several runs rather than in one.

## Known Limitations

- Orphan attachment cleanup deletes the MinIO object before the row. The row carries the only copy of `bucket`/`object_key`, so removing it first would strand the object unidentifiably. If the object delete fails the row is kept and logged at warn level, and the next run retries it — expect `Cleanup left an attachment row in place` in the worker log when object storage is unavailable.
- `model_account_bindings` has no unique constraint on `(provider_account_id, model_catalog_id)`. Two provider-sync jobs for the same account that overlap — creating an account and immediately running a model sync, for example — can both read an empty binding set and both insert. If `/providers` lists a model twice for one account, delete the extra binding.
- The queue's Redis connection retries forever and queues commands while offline, so with Redis unreachable an enqueue can block instead of failing fast. The create-provider and model-sync requests can hang until the proxy times out even though their database writes already committed. After a Redis outage, check `/admin/providers` for duplicate accounts created by a retried request.
- The model-sync route refreshes models synchronously and also enqueues a background sync, so a manual refresh makes two model-listing calls to the provider a few seconds apart. The background job cannot undo the route's work, but it does double the outbound calls on a rate-limited provider.
