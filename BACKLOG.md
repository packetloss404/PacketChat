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

The worker process is real for ingestion, but provider sync / agent run / cleanup queue behavior should either be fully implemented or made visibly unsupported.

Acceptance notes:

- Provider sync jobs execute real model discovery or are removed from operator-facing docs.
- Agent run jobs either execute asynchronously with persisted status or remain synchronous-only with no dead queue path.
- Cleanup jobs have concrete retention targets and observable outcomes.
- Unsupported job names fail loudly instead of logging success-like no-ops.

## Production Dependency Audit

`npm run audit:prod` currently gates high-severity production dependency advisories and still reports a moderate Next.js/PostCSS install-graph advisory. Keep the audit script local and visible, but do not wire stricter moderate-level audit enforcement into `prod:check` or GitHub CI until the dependency upgrade is verified against the App Router, middleware, auth cookie, SSE chat, and agent-run flows.

Acceptance notes:

- Upgrade Next.js/PostCSS to versions with no moderate-or-higher production audit findings.
- Run `npm run audit:prod`, `npm run verify`, `npm run build`, and authenticated smoke coverage after the upgrade.
- Reconsider folding stricter audit enforcement into `prod:check` after moderate-or-higher audit output is clean.

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

_Findings from a 2026-07-17 code audit, preserved for later. Not yet actioned._

### Later / deferred

- **[low/M]** provider-sync worker throws 'not enabled' instead of executing (index.ts:249)
  - Fix: Implement ProviderSyncDeps (listModels via provider API, persistModels to DB) and call runProviderSync() in the worker handler at apps/worker/src/index.ts:242-250; add a producer via enqueueProviderSyncJob on provider-account create/refresh. Logic module apps/worker/src/provider-sync.ts is DI-ready + unit-tested.
- **[low/M]** cleanup worker throws 'not enabled' (index.ts:272)
  - Fix: Wire CleanupDeps (real DB delete fns for job-failures/completed-runs/orphan-attachments) into runCleanup() at apps/worker/src/index.ts:266-272, and add a repeatable/scheduled producer via enqueueCleanupJob. Logic in apps/worker/src/cleanup.ts is DI-ready + unit-tested.
- **[low/L]** Rollup: wire the three unwired workers to their sibling logic modules
  - Fix: Covers the provider-sync + cleanup wiring above (agent-run is intentionally sync-only). Net work: implement the two Deps adapters + add producers/scheduler. No dead queue path today since no producers exist, so this is enhancement not bugfix.
- **[noise/M]** License Key activation UI is a stub, validation service not connected
  - Fix: Needs an external license-validation backend not yet built (README.md:106). UI accepts+stores input; connect a POST validate endpoint when the service exists. Deliberate.
- **[low/M]** Plugin marketplace / install is UI-only, persists to localStorage
  - Fix: apps/web/src/app/plugins/marketplace/page.tsx stores interest/install in localStorage (MARKETPLACE_KEY). Deliberate per README ('no notification backend'); needs a plugins API + notification backend to persist server-side.
- **[low/L]** MCP runtime is local-draft only; chat/agents do not consume MCP entries
  - Fix: Explicitly deferred from V1 (BACKLOG 'MCP Tools' section) with a security-first prerequisite list: server-side connection storage, encrypted owner-scoped creds, tool allowlists, timeout/size limits, run-step auditing. Draft toggles in packagechat.mcp.connections localStorage. Substantial design work.

### Known limitations (deliberate — not planned)

- agent-run worker throws 'not enabled' (index.ts:263)
- Cloud sync UI is a localStorage draft, backend not wired
