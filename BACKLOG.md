# Backlog

## Multi-Step Agent Runtime

PacketChat currently supports synchronous single-pass augmented agent runs with persisted run steps/events, run history, usage summaries, and human approval checkpoints. True multi-step tool loops remain out of V1 until planning and execution contracts are explicit across repeated model/tool turns.

Remaining acceptance notes:

- Built-in tools and future external tools execute as explicit tool-call / tool-result steps, not only pre-run context.
- Runs enforce step, token, timeout, and payload budgets across the full loop.
- Multi-step continuations resume after approved checkpoints instead of ending at the current single-pass boundary.
- Tests cover loop limits, tool failure recovery, approval-resume paths, and transcript persistence.

## Artifacts and Chat Files

Artifact instructions and chat file pickers exist, but rendered artifacts and chat-attached file runtime context are not complete runtime features.

Acceptance notes:

- Parse artifact blocks from chat / agent output and persist artifact metadata.
- Render safe Mermaid / HTML / SVG previews with clear sandboxing rules.
- Persist generated artifacts and associate them with the originating conversation or agent run.
- Upload chat files into a server-backed attachment flow and make selected files available as bounded context.
- Tests cover artifact parsing, unsafe output handling, attachment ownership, and context clipping.

## Worker Queues and Runtime Jobs

Provider sync and cleanup were wired on 2026-08-31. Both handlers now drive their DI-ready logic modules through real database adapters, provider sync has producers on provider-account create and admin model sync, and cleanup runs on a worker-registered daily schedule with concrete retention windows. Agent run is unchanged and remains synchronous-only by design.

Acceptance notes:

- Done: Provider sync jobs execute real model discovery or are removed from operator-facing docs. `apps/worker/src/provider-sync-deps.ts` lists models through the provider adapters and upserts `model_catalog` / `model_account_bindings`; the handler rethrows on failure so the job retries and is recorded in `job_failures`.
- Agent run jobs either execute asynchronously with persisted status or remain synchronous-only with no dead queue path.
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
- **[low/L]** Rollup: wire the three unwired workers to their sibling logic modules
  - Done 2026-08-31 for provider-sync and cleanup. agent-run was not touched and stays synchronous-only by design. `CleanupJob.target` was renamed from `agent-runs` to `completed-runs` so the queue payload matches `CleanupTarget`, and the worker carries a compile-time assertion that the two unions stay the same set. Remaining risks are listed under "Worker Queues and Runtime Jobs" above.

### Later / deferred

- **[noise/M]** License Key activation UI is a stub, validation service not connected
  - Fix: Needs an external license-validation backend not yet built (README.md:106). UI accepts+stores input; connect a POST validate endpoint when the service exists. Deliberate.
- **[low/M]** Plugin marketplace / install is UI-only, persists to localStorage
  - Fix: apps/web/src/app/plugins/marketplace/page.tsx stores interest/install in localStorage (MARKETPLACE_KEY). Deliberate per README ('no notification backend'); needs a plugins API + notification backend to persist server-side.
- **[low/L]** MCP runtime is local-draft only; chat/agents do not consume MCP entries
  - Fix: Explicitly deferred from V1 (BACKLOG 'MCP Tools' section) with a security-first prerequisite list: server-side connection storage, encrypted owner-scoped creds, tool allowlists, timeout/size limits, run-step auditing. Draft toggles in packagechat.mcp.connections localStorage. Substantial design work.

### Known limitations (deliberate — not planned)

- agent-run worker throws 'not enabled' (index.ts:263)
- Cloud sync UI is a localStorage draft, backend not wired
