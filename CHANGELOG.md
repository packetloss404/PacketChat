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
- Tested runtime foundations for deferred backlog items: a multi-step agent loop with step/token/time/payload budgets, tool-call/result step modeling, and approval-resume logic (`apps/web/src/lib/agent-runtime/`); artifact parsing, XSS sanitization, persistence mapping, and chat-attachment bounded context (`apps/web/src/lib/artifacts/`, `apps/web/src/lib/chat-files/`); and a worker queue registry with enqueue helpers plus cleanup-retention and provider-sync orchestration (`packages/jobs/src/queues.ts`, `apps/worker/src/`). These are unit-tested modules not yet wired into the live request path.

### Changed

- Worker now fails loudly on unsupported jobs: each queue handler validates the job name, and the provider-sync, agent-run, and cleanup queues reject jobs instead of logging success-like no-ops until their async execution is wired.

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
