# Backlog

## Multi-Step Agent Runtime

PacketChat currently supports synchronous single-pass augmented agent runs with persisted run steps/events, run history, usage summaries, and human approval checkpoints. True multi-step tool loops remain out of V1 until planning and execution contracts are explicit across repeated model/tool turns.

Remaining acceptance notes:

- Built-in tools and future external tools execute as explicit tool-call / tool-result steps, not only pre-run context.
- Runs enforce step, token, timeout, and payload budgets across the full loop.
- Multi-step continuations resume after approved checkpoints instead of ending at the current single-pass boundary.
- Tests cover loop limits, tool failure recovery, approval-resume paths, and transcript persistence.

## Queue-Durable Agent Runs

Agent runs can now be started detached: `POST /api/agents/{agentId}/runs` with `{"async": true}` (or `Prefer: respond-async`) returns `202` with a run id immediately and the run continues after the response, so it survives the caller closing the tab and is not capped by the gateway's request timeout. Callers poll `GET /api/agents/{agentId}/runs/{runId}`, which reconciles runs stranded past 20 minutes to `timed_out`.

Execution is now queue-durable. `executeRun` lives in `@packetchat/agent-runtime`, the route enqueues a `run-agent` job, and the worker rebuilds the run from `agent_runs` plus the agent version it pinned. The run row records the provider account and model it was resolved against (`resolved_provider_account_id`, `resolved_model`), so the worker never re-resolves a binding the caller did not ask for. Ownership is taken by a single conditional update out of `queued`, so a BullMQ retry or a redelivered stalled job cannot execute the same run twice. When the enqueue fails, `web` falls back to executing the run in its own process behind the same claim.

Remaining acceptance notes:

- Cancellation works across process boundaries: a caller can stop a run the worker owns, not only one running in the process that answered them.
- The approval-resume path resumes a `waiting_input` run through the queue rather than only within the process that paused it.
- A worker that dies mid-run still leaves the run stranded until reconcile-on-read; a heartbeat or a visibility timeout would shorten that from 20 minutes.
- The in-process fallback is not durable. A run that took it is lost on a `web` restart, exactly as every async run was before.
- A queued run is aged from `created_at` by the 20-minute reconcile in the single-run GET, so queue time counts against the same window as execution time. A worker outage or a deep backlog therefore lets a caller's own status poll mark its still-valid run `timed_out`; the claim then refuses it, the worker completes the job as skipped, and nothing writes the assistant message, so the conversation keeps the question and never gets an answer. A queued run needs its own clock, and the reconcile should write the outcome message that both executing paths write.
- A published spec can carry a non-uuid `providerAccountId` — the draft writer only checks that it is a string — which now fails run creation with an unhandled `500` and no run row, because `0006` made it a `uuid` column. Validate it where the draft is written, and shape the insert failure as a `400`.

## Artifacts and Chat Files

Artifact instructions and chat file pickers exist, but rendered artifacts and chat-attached file runtime context are not complete runtime features.

Acceptance notes:

- Parse artifact blocks from chat / agent output and persist artifact metadata.
- Render safe Mermaid / HTML / SVG previews with clear sandboxing rules.
- Persist generated artifacts and associate them with the originating conversation or agent run.
- Upload chat files into a server-backed attachment flow and make selected files available as bounded context.
- Tests cover artifact parsing, unsafe output handling, attachment ownership, and context clipping.

## Worker Queues and Runtime Jobs

Provider sync and cleanup were wired on 2026-08-31. Both handlers now drive their DI-ready logic modules through real database adapters, provider sync has producers on provider-account create and admin model sync, and cleanup runs on a worker-registered daily schedule with concrete retention windows. Agent run was wired on 2026-09-04: asynchronous runs are enqueued by the runs route and executed by the worker, and the risks that came with it are listed under "Queue-Durable Agent Runs" above.

Acceptance notes:

- Done: Provider sync jobs execute real model discovery or are removed from operator-facing docs. `apps/worker/src/provider-sync-deps.ts` lists models through the provider adapters and upserts `model_catalog` / `model_account_bindings`; the handler rethrows on failure so the job retries and is recorded in `job_failures`.
- Done: Agent run jobs either execute asynchronously with persisted status or remain synchronous-only with no dead queue path. The `agent-run` handler executes real runs through `@packetchat/agent-runtime`; status, steps, events, and usage are persisted as they are on the synchronous path, and there is no longer a queue that only rejects.
- Done: Cleanup jobs have concrete retention targets and observable outcomes. Job failures 30 days, terminal agent runs 90 days, orphan attachments 7 days, swept daily at 03:15; each pass logs the selected targets, per-target deleted counts, and cutoffs. Operator detail is in `docs/runbooks/worker-queues.md`.
- Done: Unsupported job names fail loudly instead of logging success-like no-ops. Every handler calls `assertKnownJobName`, and an unknown cleanup target or an out-of-range `olderThanDays` fails the job before any delete rather than cleaning nothing quietly.

Follow-ups opened by the wiring:

- `model_account_bindings` has no unique constraint on `(provider_account_id, model_catalog_id)`. Two overlapping provider-sync jobs for one account can both read an empty binding set and both insert, duplicating every binding. Account creation and a manual model sync can now overlap, so this is reachable.
- Enqueue calls can block instead of failing when Redis is unreachable. The queue connection retries forever with the offline queue enabled, so `POST /api/providers` and the model-sync route can hang past their commit until the proxy times out, and an operator retry creates a duplicate provider account. Bound the enqueue with a timeout, or build the queue connection with `enableOfflineQueue: false`.
- Orphan-attachment cleanup deletes the `attachments` row but nothing removes the object from MinIO. `CleanupDeps` has no hook for blob deletion, and the daily schedule means the leak now accrues on a timer rather than never.
- `apps/worker/package.json` does not declare `@packetchat/auth`, which `provider-sync-deps.ts` imports for `decryptJsonSecret`. It resolves only through npm workspace hoisting, and wiring provider sync makes that undeclared dependency load-bearing at runtime for the first time.
- The model-sync route refreshes models synchronously and also enqueues a background sync, doubling outbound provider list calls per manual refresh. Worth reconsidering whether account creation alone should be the trigger.
- The Dockerfile rewrites worker `dist` imports with per-file `sed` lines, and this change added five more. Any future relative import in a worker source silently ships a container that dies on `ERR_MODULE_NOT_FOUND`, and `npm run verify` does not catch it. `moduleResolution: NodeNext` for the worker build, or one generic rewrite over `apps/worker/dist`, would remove the class of failure.

## Production Dependency Audit

`npm run audit:prod` passes with no production advisories as of 2026-08-27. Next.js is on 15.5.24 and sharp on 0.35.4; PostCSS is pinned to `^8.5.26` by a root `overrides` entry because Next 15 depends on `8.4.31` exactly and npm's only offered fix is Next 16.

The Next 16 upgrade remains deferred. It is a major version and the App Router, middleware, auth cookie, SSE chat, and agent-run flows all need verification against it.

Acceptance notes:

- Upgrade to Next 16 and confirm `npm run audit:prod` stays clean without the PostCSS override, then remove that override.
- Run `npm run audit:prod`, `npm run verify`, `npm run build`, and authenticated smoke coverage after the upgrade.
- Revisit folding audit enforcement into `prod:check` once the upgrade lands, since the gate is currently green and regressions would otherwise go unnoticed.

## MCP Tools

MCP tool support is intentionally deferred from V1 runtime scope. Before enabling it, PacketChat needs server-side MCP connection storage, per-user or owner-scoped credentials, tool allowlists, request/response auditing, timeout and size limits, and run-step persistence for tool calls and results.

Acceptance notes:

- Agents can attach only explicitly allowed MCP servers and tools.
- Tool credentials are encrypted and never exposed to the browser after save.
- Tool execution is bounded by timeout, payload size, and run step limits.
- Agent run events show each tool call, result, failure, and skipped call.
- Tests cover denied tools, revoked credentials, timeout behavior, and successful execution.

## Code Interpreter

Code interpreter support is intentionally deferred from V1 runtime scope. Before enabling it, PacketChat needs an isolated execution sandbox, per-run working directories, explicit file input/output handling, CPU and memory limits, network policy, artifact persistence, and cleanup jobs.

Acceptance notes:

- Code execution runs in a disposable sandbox with no host filesystem access.
- Network access is disabled by default and configurable only by an admin.
- Generated files are attached to the run as artifacts with size limits.
- Long-running or oversized executions fail clearly and leave audit events.
- Tests cover sandbox isolation, file artifacts, timeout behavior, and cleanup.

## Portfolio audit backlog — 2026-07-17

_Findings from a 2026-07-17 code audit. The worker-queue wiring items were actioned on 2026-08-31; the rest are preserved for later._

### Done

- **[low/M]** provider-sync worker throws 'not enabled' instead of executing (index.ts:249)
  - Done 2026-08-31: `createProviderSyncDeps()` (apps/worker/src/provider-sync-deps.ts) feeds `runProviderSync()`, with producers on `POST /api/providers` and `POST /api/providers/{providerId}/models`. `runProviderSync` reports failure instead of throwing, so the handler rethrows on `!ok` and the job retries and lands in `job_failures`.
- **[low/M]** cleanup worker throws 'not enabled' (index.ts:272)
  - Done 2026-08-31: `createCleanupDeps()` (apps/worker/src/cleanup-deps.ts) feeds `runCleanup()` through `runCleanupJob()`, and the worker upserts a daily `run-cleanup` schedule at 03:15 on every boot. Retention: job failures 30 days, terminal agent runs 90 days, orphan attachments 7 days.
- **[low/M]** agent-run worker throws 'not enabled' instead of executing (index.ts:281)
  - Done 2026-09-04: `createAgentRunJobDeps()` (apps/worker/src/agent-run-deps.ts) feeds `runAgentRunJob()` (apps/worker/src/agent-run.ts), with the producer on `POST /api/agents/{agentId}/runs` when the caller asks for an async run. The handler throws on everything that stops a run executing, so the job lands in `job_failures` and retries; the one quiet outcome is a run another executor already claimed. Migration `0006` persists the resolved provider account and model on the run row so the worker executes the binding the caller was promised.
- **[low/L]** Rollup: wire the three unwired workers to their sibling logic modules
  - Done 2026-08-31 for provider-sync and cleanup, and 2026-09-04 for agent-run. `CleanupJob.target` was renamed from `agent-runs` to `completed-runs` so the queue payload matches `CleanupTarget`, and the worker carries a compile-time assertion that the two unions stay the same set. Remaining risks are listed under "Worker Queues and Runtime Jobs" above.

### Later / deferred

- **[noise/M]** License Key activation UI is a stub, validation service not connected
  - Fix: Needs an external license-validation backend not yet built (README.md:106). UI accepts+stores input; connect a POST validate endpoint when the service exists. Deliberate.
- **[low/M]** Plugin marketplace / install is UI-only, persists to localStorage
  - Fix: apps/web/src/app/plugins/marketplace/page.tsx stores interest/install in localStorage (MARKETPLACE_KEY). Deliberate per README ('no notification backend'); needs a plugins API + notification backend to persist server-side.
- **[low/L]** MCP runtime is local-draft only; chat/agents do not consume MCP entries
  - Fix: Explicitly deferred from V1 (BACKLOG 'MCP Tools' section) with a security-first prerequisite list: server-side connection storage, encrypted owner-scoped creds, tool allowlists, timeout/size limits, run-step auditing. Draft toggles in packagechat.mcp.connections localStorage. Substantial design work.

### Known limitations (deliberate — not planned)

- Cloud sync UI is a localStorage draft, backend not wired
