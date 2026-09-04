# Changelog

All notable PacketChat changes are tracked here.

## Unreleased

### Added

- User-owned project workspaces now surface reusable instructions, default-model readiness, linked chat counts, and workspace search.
- Knowledge search now includes a retrieval debugger with matched terms, score breakdown, source metadata, freshness, embedding status, and citations.
- Provider governance now surfaces enabled/disabled routes, default route state, synced model bindings, capability metadata, and pricing coverage.
- Admin release-readiness pages now cover usage governance, audit logs, operations health, pending approval steps, and approval queue monitoring.
- Agent runs now expose persisted run history with run status, step/event traces, provider/model usage, token counts, estimated cost, and approval decisions.
- Local cost estimation now covers the Claude Opus 4 and Claude Sonnet 4 model families in the `apps/web/src/lib/usage.ts` pricing table.
- Tested runtime foundations for deferred backlog items: a multi-step agent loop with step/token/time/payload budgets, tool-call/result step modeling, and approval-resume logic (`apps/web/src/lib/agent-runtime/`); artifact parsing, XSS sanitization, persistence mapping, and chat-attachment bounded context (`apps/web/src/lib/artifacts/`, `apps/web/src/lib/chat-files/`); and a worker queue registry with enqueue helpers plus cleanup-retention and provider-sync orchestration (`packages/jobs/src/queues.ts`, `apps/worker/src/`). These are unit-tested modules; the cleanup-retention and provider-sync orchestration has since been wired into the worker (see the two entries below), while the agent-loop, artifact, and chat-file modules remain unwired.
- Invite and password-reset emails are delivered. `EMAIL_PROVIDER` picks the transport: `manual` (the default and unchanged behaviour — nothing is sent and the admin is handed the link), `smtp` (`SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_REJECT_UNAUTHORIZED`), or `resend` (`RESEND_API_KEY`). The token is committed before the send and the link is returned whatever the send does, so a dead relay costs a copy-paste rather than the invite. Every send is bounded by `EMAIL_SEND_TIMEOUT_MS` (10s default), because a relay that accepts the connection and then stops answering would otherwise hang the admin request. A configured provider that cannot send reports `failed`, never `manual`, in the API response, on `/admin/users`, and in the audit event; the failure text is stripped of the SMTP password, the Resend key, and the link itself. There is no retry queue — re-issue the invite or reset to try again. Links are built from `APP_BASE_URL`. Invites and resets are the only mail PacketChat sends. Configuration is in `docs/deployment.md`.
- The `provider-sync` worker queue now executes real model discovery. A `sync-provider` job is enqueued when an admin creates a provider account and when an admin runs a model sync from `/admin/providers`; the worker lists models through the provider adapters and upserts `model_catalog` and `model_account_bindings`. Existing bindings keep their `enabled` state and capability overrides, and a model the provider stopped reporting is left alone rather than disabled by a background job — retiring a model stays an explicit admin action. A queue error at either producer is logged and does not fail the request.
- The `cleanup` worker queue now executes, on a daily schedule the worker registers on boot (`daily-cleanup`, `15 3 * * *`, worker container timezone). Retention windows are job failures 30 days, terminal agent runs 90 days, and orphan attachments 7 days; each pass claims at most 5000 rows per target and logs the selected targets, deleted counts, and cutoffs. Deleting an orphan attachment row does not remove its object from MinIO, and the first scheduled run after upgrading deletes whatever backlog a deployment has already accumulated — back up Postgres before the worker restart that carries this change. Cadence, the manual trigger, and known limitations are in `docs/runbooks/worker-queues.md`.
- The `agent-run` worker queue now executes. `POST /api/agents/{agentId}/runs` with `{"async": true}` (or `Prefer: respond-async`) enqueues a `run-agent` job instead of running detached inside `web`, so an asynchronous run survives a web restart and gets BullMQ retries. Synchronous runs are unchanged. If the enqueue fails, the run still executes in `web` rather than failing the caller, and is durable only until that process ends. Exactly one executor ever owns a run: ownership is a single conditional update out of `queued`, so a retry or a redelivered job cannot repeat a run's paid provider calls, and a retry of a run that already failed does not re-execute it. Runs stay capped at 15 minutes, and `GET /api/agents/{agentId}/runs/{runId}` still reconciles anything stranded past 20 minutes. Known limitation: that reconcile ages a run which never started from its creation time, so an async run left queued for 20 minutes — a worker outage, or a deep backlog — is marked `timed_out` by the next status poll, is not executed afterwards, and leaves its conversation without an assistant message. Keep `worker` consuming the queue, or use synchronous runs. The full list is in `docs/runbooks/worker-queues.md`.
- **Migration `0006`:** `agent_runs` gains nullable `resolved_provider_account_id` and `resolved_model`, recording the provider account and model a run was resolved against. Both are resolved per request and nothing else persisted them, so a worker that re-resolved them could execute a run against a different model than the caller asked for. The columns are nullable with no default and no foreign key: the change is catalog-only and safe to apply to a live database. Runs created before this migration keep NULLs and the worker refuses them rather than guessing at a binding.
- **Breaking (queue payload):** `AgentRunJob.ownerUserId` is now `resourceOwnerUserId` and carries the **agent's** owner rather than the caller. The executor resolves knowledge bases and child agents against it, and an agent shared through `agent_permissions` is run by someone who owns neither; the caller remains on the run row as `agent_runs.owner_user_id`. Nothing produced `agent-run` jobs before this change, so no in-flight payload can be affected.

### Removed

- **Breaking:** per-user BYOK is gone. Provider accounts are now app-wide: `provider_accounts.scope` and `owner_user_id` and `users.byok_enabled` are dropped by `0004_app_wide_provider_accounts.sql`, existing per-user accounts are promoted to shared ones, and only the most recently updated default survives the collapse of the per-user partition. Provider accounts are created and managed by admins from the new admin providers console.
- **Breaking:** break-glass emergency admin access is gone. `POST /api/auth/break-glass/login`, the login-form break-glass toggle and its audit acknowledgement, the short-lived break-glass sessions and `BREAK_GLASS_ACCESS_TOKEN_TTL_SECONDS` are all removed, and `0003_drop_break_glass.sql` drops `users.is_break_glass`. Existing break-glass accounts are demoted to ordinary admins rather than deleted, so operators do not lose the account they can still reach. Keep a second ordinary admin for recovery.

### Fixed

- Protected pages no longer render before the client-side auth guard redirects. The middleware only checks that a refresh cookie exists, so a stale cookie previously let a page paint before bouncing to `/login`.
- The chat model settings panel no longer opens on its own when no model is configured. A notice under the composer explains what is missing and opens the panel when clicked, and send-time validation messages are now visible on an empty chat instead of being set but never rendered.
- The loading spinner no longer stretches to the full content width. `.ui-state > :first-child { flex: 1 }` outranked the spinner's own sizing because `LoadingBlock` leads with the spinner, turning a 16px ring into a page-wide rotating bar that read as a diagonal line during every data load.
- PWA splash and icon background colours realigned with `--bg` (`#0a0b10`); both had drifted while claiming in comments to match it.

### Security

- `npm run audit:prod` passes again with no production advisories. Next.js moved to 15.5.24 and sharp to 0.35.4, clearing four high-severity libvips CVEs (CVE-2026-33327, CVE-2026-33328, CVE-2026-35590, CVE-2026-35591). PostCSS is held at `^8.5.26` through an override because Next 15 pins `8.4.31` exactly and the only upstream fix is Next 16, a major upgrade deliberately deferred. Verified with `npm run verify`, a production build, and a runtime smoke test of the App Router, middleware redirect, auth cookie handling and API authorisation.

### Changed

- Worker now fails loudly on unsupported jobs: each queue handler validates the job name. `provider-sync` and `cleanup` now execute and rethrow on failure, so a failed job is retried and recorded in `job_failures` instead of completing as a success that did nothing. The `agent-run` queue rejected every job it received at the time of that change; it was wired later in this same cycle and now executes runs (see the Added entry above).
- **Breaking (queue payload):** `CleanupJob.target` no longer accepts `agent-runs`. The value is now `completed-runs`, matching the worker's `CleanupTarget`. Cleanup only ever deletes runs already in a terminal status, so `agent-runs` overstated its reach; no producer used the old value. The worker asserts at compile time that the queue's targets and the worker's targets remain the same set, so renaming one side without the other now fails the build.

- Current docs now treat approvals, agent run history, audit, operations, model governance, and usage governance as wired V1 surfaces while keeping scheduled runs, evaluations, and true multi-step loops outside V1.
- Default Anthropic model suggestions in the providers and agents UIs now point at `claude-opus-4-8`. Provider health probes intentionally stay on a low-cost model.

## 0.1.0 - 2026-05-13

### Added

- Single-pass augmented agent runs with file search, file context, artifact instructions, calculator, URL fetch, HTTPS OpenAPI actions, and bounded same-owner pre-run agent context.
- Agent ACL sharing with viewer / runner / editor / owner roles, including chat handoff for published runnable agents.
- Prompt-to-chat handoff and `/chat?conversation=<id>` transcript restoration.
- Local production audit script: `npm run audit:prod`.
- Focused regression tests for agent access, HTTP security helpers, provider URL validation, and provider stream error handling.

### Changed

- Tightened the product language around current agents: PacketChat now describes them as single-pass augmented agents rather than full multi-step tool-loop agents.
- Hardened provider runtime behavior: custom provider base URLs are validated, hosted providers cannot target private/local networks, OpenAI-compatible local endpoints remain supported, redirects are blocked, and enabled model bindings are enforced at runtime.
- Reduced agent run event write amplification by summarizing provider text deltas.
- Chat-launched agent runs now persist user and assistant messages into the conversation transcript.
- Upgraded Next.js to the patched 15.5 line for the high-severity production audit gate.

### Fixed

- Viewer access no longer allows running shared agents with the owner’s provider account and knowledge context.
- Forced password-reset users can no longer receive normal login sessions before changing their password.
- Invite acceptance, password-reset completion, and bootstrap setup now use safer transactional locking / atomic token consumption.
- OpenAI-compatible provider stream error chunks are surfaced instead of being silently ignored.

### Known Remaining Work

- `npm run audit:prod` passes the high-severity gate but still reports a moderate Next.js/PostCSS install-graph advisory.
- MCP tools, code interpreter, rendered artifacts, chat file attachments, scheduled runs, evaluations, approvals, and true multi-step tool loops are not V1 runtime features yet.
