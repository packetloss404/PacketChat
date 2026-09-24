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
  - Resolved 2026-09-21: the per-file `sed` chain was replaced by `scripts/fix-dist-imports.mjs`, one generic rewrite over `apps/worker/dist` and every package `dist`. This fired immediately — the Wave 5 `./resume` export was missing from the old list and crash-looped the worker with `ERR_MODULE_NOT_FOUND` until fixed. Verified by rebuilding the worker image and running the full stack.

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

## LibreChat Parity Program — 2026-09-21

_Planning pass only; no runtime changes landed with this section. Derived from four parallel audits: LibreChat functionality, LibreChat GUI/UX, PacketChat functionality inventory, and PacketChat GUI/UX assessment._

PacketChat already borrows LibreChat's three-column shell, but not its depth or its design-system discipline. Two problems compound: the chat core is thin (single-pass agents, no branching, no attachments, lexical-only retrieval), and a large share of shipped UI is non-functional placeholders that read as finished product. The program below closes both, ordered so correctness and credibility come first, then chat parity, then depth.

Confirmed focus from the owner (2026-09-21): the agent-builder-in-a-modal, the right-rail drawers, the monochrome flat look, the chat transcript style, and the Projects / Prompts / Knowledge pages are the surfaces to rework. The Settings / Plugins / Marketplace stubs are to be removed or hidden. Plan only for now.

### Decision — private-first; stay on PacketChat and execute, do not fork LibreChat (2026-09-21)

PacketChat is a privately deployed product, so the operator is the vendor. Vendor-facing surfaces — waitlists, license keys, cloud sync, marketplaces, extension installs — are category errors in that model and are cut rather than gated behind a "Labs" flag.

Forking LibreChat and porting PacketChat's custom code is rejected. LibreChat is a MERN stack (MongoDB/Mongoose, Express, React/Vite/Recoil) with a separate Python RAG service, Meilisearch and a standalone admin panel; PacketChat is Next.js + Postgres + Redis/BullMQ + MinIO. A port means rewriting every API route as an Express controller and every SQL migration as Mongoose models — giving up foreign keys, constraints and advisory locks — and then re-applying that translation on every upstream release, forever. It also swaps a lean stack for three more services to operate. Worse, most of PacketChat's custom code (admin panel, usage governance, approvals, RAG, agents, auth) is convergent with capabilities LibreChat already ships, so the port mostly recreates existing features in a datastore LibreChat does not use. PacketChat's advantages are its lean private stack and its admin-governed provider-key model; a fork trades both away for breadth we can add deliberately instead.

LibreChat remains a reference and a fallback. It is MIT, so adopting or forking it later — or contributing governance pieces upstream — stays viable precisely because we are not pre-building vendor surfaces now. Revisit the fork only if the goal becomes a public product competing on LibreChat's axis, and only if MongoDB, Meilisearch and the Python RAG service are acceptable dependencies. A public transition is gated behind a separate expansion list (organizations/multi-tenancy, SSO, deeper RBAC, rate limiting, billing, moderation, security review, docs) that is real work, not UI.

### Execution order

Four workstreams. W1 is the bulk; W2 is deletions and can proceed independently.

- **W1 — Fix the chat core.** Message tree (`parent_message_id` write/read, sibling selection) first, then real edit-and-rerun and regenerate, branching/fork, conversation rename/archive/delete/search/export, header title + model switcher, transcript and composer restyle, General-preference wiring, and the a11y fixes. Maps to Phase 1; Phase 3 model UX waits until the tree is stable.
- **W2 — Cut the stubs.** Delete the surfaces listed in Phase 0 and correct the README's wiring claims. No dependencies.
- **W3 — Wire the two cheap wins.** Header chip and General preferences (both in Phase 1).
- **W4 — Rationalize the design and component layer.** Tokens, radii, type scale, one dialog/toast/confirm, light mode, agent-editor and right-rail rework, Projects/Prompts/Knowledge rework. Maps to Phase 4.

Exit criteria for a working private V1: no dead nav entry or primary CTA; edit/regenerate/branch and conversation lifecycle survive reload; the chat surface reads as contemporary; light mode works; `npm run verify` and authenticated smoke pass.

### Guiding principles

- Cut or gate non-functional surfaces before building new ones. A smaller app that works beats a larger app that promises.
- Make the token layer real, not aspirational. New UI must consume tokens, not hardcode values.
- Establish a real message tree before touching chat visuals; branching, edit/rerun, regenerate and fork all depend on it.
- One primitive per job: one dialog, one toast system, one confirm pattern, one badge, one set of card styles.
- Keep V1 deployment honesty: no feature ships labelled unless it is wired end-to-end.

### Phase 0 — Credibility and correctness

Fix the things that are actively broken or fake. No new features.

- Fix the conditional-hook crash in chat: `lastAssistantId` (`apps/web/src/app/chat/page.tsx:832`) is declared after the `if (!hasMessages) return` early return at `:804`, so the first message changes hook count and throws on `global-error`.
- Replace undefined CSS variables that render dialogs transparent or light-on-dark: `--bg-1` / `--bd-1` / `--ink-1` (`apps/web/src/app/providers/models-client.tsx:503`, `:613`, `:863`, `:960`), `--surface-1` / `--text-1` / `--border-1` (`apps/web/src/app/agents/page.tsx:1029`), and `--surface` / `--surface-2` (`apps/web/src/components/projects-prompts/PromptsClient.tsx:585`, `:639`, `:659`). Replace with `--bg-2`, `--bg-3`, `--line-2`, `--ink`.
- Keep the header "model chip" (`apps/web/src/components/app-shell.tsx:537`) and make it the real conversation-title + model switcher in Phase 1. Do not delete it; it is the highest-value wire-up in the stub set.
- Delete the stub product surfaces from primary nav. **Decision 2026-09-21: cut, not "Labs"-gated.** A privately deployed product has no vendor to wait on, and gating a non-functional page one click away is still theatre. Cut: Plugins waitlist and requests (`apps/web/src/app/plugins/page.tsx:286`), Marketplace (`apps/web/src/app/plugins/marketplace/page.tsx`), and these Settings sections in `apps/web/src/app/settings/settings-client.tsx` — Cloud Sync (`:387`), License Key (`:468`), Text-to-speech (`:750`), Voice Input (`:847`), MCP (`:874`), Internal Prompts (`:1024`), Extensions (`:1096`), Proxy & Org ID (`:1156`). TTS, Internal Prompts and the shortcut fiction are cut rather than wired (owner decision); MCP remains a backlog item, only its user-facing draft UI is removed. This includes deleting the `Plugins` section and the `Agent Marketplace` entry from the left-rail nav in `apps/web/src/components/app-shell.tsx` (`:33-36`) and any in-app links to `/plugins` or `/plugins/marketplace`, so nothing points at a deleted route.
- Trim the Keyboard Shortcuts table (`settings-client.tsx:685`) to only the bindings that exist today (`Esc` to close/stop, `Ctrl/Cmd+Enter` to send). Delete the other eight rows until each is implemented; the table must never advertise an unimplemented key.
- Remove the Appearance accent-color selector (`settings-client.tsx:618`); keep the theme control.
- Relocate operator settings to `/admin/providers`: HTTPS-proxy / Org ID (`settings-client.tsx:1156`) and manual custom-model registration (`models-client.tsx:140`, `:373`) become real admin features. They are operator concerns; provider accounts already own base URLs and keys, and a manual model registration is genuinely useful for Azure deployment names and local models.
- Leave General preferences (`settings-client.tsx:539`) in place but wire them in Phase 1 (send-on-Enter, draft autosave, token counts, composer font size); they are currently written and never read.
- Unify the theme toggle. `app-shell.tsx:305` toggles the class on `<html>` and `<body>` without persisting; `settings-client.tsx:617` persists a different key and toggles `<html>` only. Make one persisted implementation plus a pre-hydration script to kill the dark flash.
- Remove the second, hardcoded Settings toast (`settings-client.tsx:124`) and route through the shared `ToastProvider`.
- Collapse the semantic-color duplication: hand-written `rgba(121,181,122,…)` / `rgba(196,154,58,…)` / `rgba(208,88,88,…)` (29 occurrences, e.g. `globals.css:3128`, `:3653`) must use `--ok` / `--warning` / `--danger`. Adopt the already-defined `--ink-4-accessible` (or raise `--ink-4`) for 10.5–12px labels that currently fail WCAG AA.

Acceptance notes:

- First message in a fresh conversation renders without throwing.
- No undefined `var()` references remain in app CSS/TSX.
- `npm run verify` and authenticated smoke still pass.
- Every nav entry and primary CTA reaches a wired surface; no stub surface remains in primary nav.

Wave 1 status (2026-09-21): implemented — Settings stub sections, Plugins and Marketplace pages, their nav entries, the accent selector, and the "Add custom model" CTA are removed; undefined CSS variables are replaced with real tokens in `models-client.tsx`, `agents/page.tsx` and `PromptsClient.tsx`; the chat conditional-hook crash is fixed; README overclaims are corrected; the shortcut table is trimmed to the single binding that exists (`Esc`); dead plugin CSS and dead `exact` nav plumbing are removed. Remaining Phase 0: unify the theme toggle, collapse the semantic-color duplication and adopt `--ink-4-accessible`, and relocate proxy/Org ID plus custom-model registration to `/admin/providers`.

Wave 2 status (2026-09-21): the chat core is now a real message tree. `parent_message_id` is written by chat and agent runs, conversations track `active_leaf_message_id`, the client renders the active path with branch navigation, and user edit-and-rerun plus assistant regenerate persist as sibling branches. Conversation rename/archive/delete/search/export are wired in the left rail, the header shows the live title and model via `chat-header-store.ts`, the transcript is restyled with a single scoped live region, markdown gains tables/quotes/images/nested lists, and General preferences are read and applied by chat. Theme unification and the semantic-token cleanup also landed. Remaining: the admin proxy/org-id/custom-model values have no backend endpoints, so they were documented as gaps rather than faked; agent-run conversations written before this wave use a chronological fallback; real (semantic) embeddings are still pending.

Wave 3 status (2026-09-21): assistant output is parsed into prose plus artifacts and rendered in a script-free sandboxed iframe (mermaid/react stay inert previews); chat-scoped file attachments upload without a knowledge base and inject bounded extracted-text context for one turn, with ownership enforced and orphan cleanup exempting them; the knowledge retrieval panel now shows a user-facing relevance/snippet view with internals behind a disclosure. Real semantic embeddings (pgvector) remain pending, as does moving attachment extraction off the request path.

Wave 4 status (2026-09-21): the right-rail drawers are removed (left rail plus content only), the design layer gained a real type scale and a four-value radius scale with the space/shadow/tracking tokens now in use, dead CSS was deleted, the agent builder is a full-page tabbed editor (Identity/Model/Tools/Knowledge/Instructions/Runs) instead of a modal, and the Prompts/Knowledge/Projects surfaces were reworked (card previews, master-detail knowledge, clearer project detail). The full design-system sweep is partial: some panel-internal ad-hoc spacing/shadows remain.

Wave 5 status (2026-09-21): approving an agent checkpoint resumes the run through the queue to a final answer (rejecting cancels cleanly), the duplicated SSRF/OpenAPI logic is removed, per-model-binding enable/disable is real (admin-only, runtime-honored), the agent builder can start async runs with background polling, and token/cost display is aligned (cost labelled unavailable rather than invented). The full model-driven multi-step tool loop and model presets/specs remain pending.

Wave 6 status (2026-09-21): revocable read-only conversation share links are wired (owner create/list/revoke API, a tokenised public read route, and a `/share/[token]` page that fails closed on a stale snapshot and never exposes owner/provider/run data), and the admin Audit/Operations/Usage surfaces no longer dump raw JSON, use real tables, and gained an accessible usage chart.

Program status (2026-09-21): all six waves are implemented and `npm run verify` passes (227 tests, 0 failures; the 22 skipped tests are DB/Redis integration gated on `TEST_DATABASE_URL`). Nothing is committed. Explicitly deferred: real semantic embeddings (pgvector), the model-driven multi-step tool loop, model presets/specs, MCP runtime, code interpreter, the admin proxy/org-id/custom-model backend endpoints (documented as gaps, not faked), moving attachment extraction off the request path, and the remainder of the design-system sweep (panel-internal spacing/shadows).

### Phase 1 — Chat parity (the message tree)

LibreChat's chat feel comes from message-level state and affordances; PacketChat's edit is local-only (`chat/page.tsx:608`), regenerate duplicates the user row, and `parent_message_id` exists (`packages/db/src/migrations/0001_initial.sql:201`) but is never written.

- Adopt the message tree: write `parent_message_id` on every persisted message; load a conversation as a branch tree; expose sibling selection.
- Real edit-and-rerun (new sibling, not in-place local mutation) and regenerate (new sibling, no duplicated user row).
- Conversation forking and message branching controls, matching LibreChat's scopes (visible branch / include branches / from-here).
- Conversation lifecycle UI: rename, archive, delete, and search. `apiClient.conversations.update/delete` exist (`apps/web/src/lib/api-client.ts:501`) but are never called; no search route exists.
- Conversation export (Markdown / text / JSON at minimum) server-side.
- Header becomes real: show the conversation title (the chat page already computes `headerTitle` at `chat/page.tsx:178` and only uses it as an `aria-label`) and the active model, using the revived header chip. Replace the hardcoded `routeTitles` entry (`app-shell.tsx:62`) so the header stops always reading "Chat".
- Wire the General preferences (`settings-client.tsx:539`) into the chat surface: send-on-Enter, draft autosave, token counts under messages, and the composer font-size slider as a CSS variable. Do not leave them persisted-but-unread.
- Restyle the transcript (owner-listed): user/assistant distinction with alignment and surfaces, readable avatars (the current 22px "You"/"AI" tiles at `chat/page.tsx:918` are cramped), a real markdown renderer with tables/blockquotes/images, inline citations, and an in-thread usage/context indicator.
- Drop `role="log" aria-live="polite"` from the whole transcript (`chat/page.tsx:841`) so streamed tokens are not all announced; move live-region semantics to a status element.
- Composer parity: attachment button, model/tools chips, drag-drop and paste handling, send/stop, and a parameters popover instead of the bordered in-flow `.chat-settings` card.

Acceptance notes:

- Editing, regenerating and branching a message survives reload and produces correct sibling navigation.
- A conversation can be renamed, archived, deleted, searched and exported without the API client being bypassed.
- Chat no longer mutates messages only in React state; `localStorage` bookmark-by-UUID (`chat/page.tsx:617`) is replaced by a real bookmark target or removed.
- Markdown covers tables, blockquotes, images and nested lists; citations render as sources.

### Phase 2 — Files, RAG and artifacts

- Unified chat uploader. The upload endpoint currently requires `knowledgeBaseId` (`apps/web/src/app/api/files/upload/route.ts:32`), so no chat picker can exist; add a chat-scoped attachment flow with ownership and bounded context injection (the unused `apps/web/src/lib/chat-files/context.ts` is the starting point).
- Replace the 128-dim FNV-1a hash "embeddings" (`packages/files/src/index.ts:209`) with a real embedding model and pgvector, keeping the existing ingestion worker and re-embed path.
- Parse and render artifacts. `apps/web/src/lib/artifacts/{model,parse,sanitize}.ts` are dead code; agent instructions mention artifacts (`packages/agent-runtime/src/execute.ts:29`) but output is never parsed. Add sandboxed Mermaid/HTML/SVG previews with persistence per conversation/run (this also satisfies the existing "Artifacts and Chat Files" section above).
- Reduce the knowledge "Why this result" panel (`knowledge-manager.tsx:657`) from a raw debug dump (attachmentId, objectKey, embedding version/timestamps) to an operator-facing explanation; move internals behind a details toggle.

Acceptance notes:

- Files can be attached to a chat without a knowledge base and are clipped to a token budget.
- Retrieval uses semantic vectors end-to-end; the re-embed path migrates old hash vectors.
- Artifacts parse, persist and render with a documented sandbox policy.
- Tests cover attachment ownership, context clipping, artifact unsafe-output handling, and retrieval migration.

### Phase 3 — Model UX and agent-run depth

- Model specs / presets. `model_presets` (`0001_initial.sql:152`) and project `default_model_preset_id` are dead schema; expose create/edit, set-default, and mid-conversation switching, with capability flags (vision, tools, reasoning).
- Per-binding enable/disable. The backend only toggles account `status`; add a binding-level toggle so the read-only chips in `providers-manager.tsx:553` become interactive.
- Token and cost display in-thread, driven by the existing usage records.
- Real multi-step tool loop. `packages/agent-runtime/src/execute.ts:155-339` executes every tool before a single model call; tools must run as model-chosen tool-call/tool-result steps within step/token/timeout budgets.
- Approval resume actually resumes. Approving currently runs external actions and marks the run `completed` without ever continuing the model (`apps/web/src/app/api/approvals/[approvalId]/route.ts:176`, `:307`); wire the unused `apps/web/src/lib/agent-runtime/resume.ts` (`computeResumeState`, `applyApprovalDecision`) into the queue-durable path, replacing the duplicate SSRF/OpenAPI logic in the approvals route with the shared runtime.
- Async-run UI. `{"async": true}` works at the API but the builder always calls sync (`agents/page.tsx:870`); surface run mode and status.
- Delete or wire the dead modules rather than leaving them: `lib/agent-runtime/{loop,resume,tool-steps,budget}.ts`, `lib/artifacts/*`, `lib/chat-files/context.ts`.

Acceptance notes:

- Agent runs execute repeated model/tool turns and stop on step, token, timeout and payload budgets.
- An approved checkpoint resumes the same run to a final answer.
- Presets and per-binding toggles are persisted server-side.
- No production import path is missing for any module under `apps/web/src/lib`.

### Phase 4 — Rework the owner-listed surfaces

- Agent builder out of the modal. Replace the single 440-line `<dialog class="agent-editor">` (`apps/web/src/app/agents/page.tsx:1277-1717`) with a routed or tabbed editor (Identity / Model / Tools / Knowledge / Instructions / Runs), removing the permanently-active "Uncategorized" filter (`agents/page.tsx:1090`) and the disabled Code-interpreter / MCP cards (`agents/page.tsx:1435`).
- Right-rail drawers. The panel implements only Memories / Parameters / Bookmarks (`app-shell.tsx:592-616`) and none are consumed by chat. Remove the rail, or promote Parameters into the Phase 1 composer popover, make Memories a real per-user store, and give Bookmarks a real target; do not keep localStorage dead ends.
- Projects, Prompts and Knowledge rework: project instructions and default preset must actually affect a conversation (currently inert); prompt cards must show a description/body preview (`PromptsClient.tsx:445`); Knowledge's four stacked full-width cards (`knowledge-manager.tsx:466-705`) become a working master-detail layout.
- Design-system pass (owner-listed "monochrome flat look"): make `--space-*` / `--shadow-*` / `--tracking-*` real (currently zero usages), collapse 125 `border-radius` declarations across 19 values into 3-4, add a type scale (six different "h1" sizes today), fix light mode's hardcoded dark surfaces (`globals.css:2304`, `:4544`, `settings-client.tsx:262`), and remove dead CSS blocks (`home-dashboard`, `chat-workspace`, `prow`, `arow`, `utbl`, `plist/ptile`, `pgrid/pcard`, `model-toggle`, `apikeys__*`, `.lr__search`, `.mobile-topbar`, `.skeleton`).
- One dialog, one toast, one confirm: replace hand-rolled fixed overlays (`PromptsClient.tsx:564`, `models-client.tsx:857`, `plugins/page.tsx:419`), the second Settings toast, `window.confirm` and inline confirm pairs with the shared primitives, and rename the app-wide `prompt-dialog` class.

Acceptance notes:

- No surface is reachable from primary nav that does not work.
- New UI consumes the token layer; a lint-style check or review note confirms no new raw hex/radius/shadow is introduced.
- Agent editing, project instructions, prompt previews and knowledge management are all wired to their APIs.

### Phase 5 — Sharing, admin and multi-user depth

- Conversation share links (read-only, revocable, optional continue-into-own-copy), building on the existing agent ACL model (`apps/web/src/lib/agent-access.ts`).
- Deepen RBAC toward LibreChat's permission/ACL layering if org/team workspaces are ever in scope (currently explicitly out of V1).
- Admin panel polish: replace raw `JSON.stringify` metadata (`AuditClient.tsx:30`, `OperationsClient.tsx:33`), stop rendering `StatusBadge` strings as a table (`OperationsClient.tsx:104`), and add charts to Usage instead of numbers-only tables.
- Optional deeper parity items to schedule deliberately, not by accident: MCP runtime, code interpreter, scheduled agent runs, skills/handoffs. These already have dedicated sections above or are deferred; this program does not pull them forward.

### Open questions

- Does PacketChat want LibreChat-style provider-native file attachments (vision/document) or is extracted-text context sufficient?
- Is semantic RAG a V1 promise or Phase 2+? It changes the vector-store and migration work.
- Should Settings become a focused modal (LibreChat pattern) or stay a page with tabs?
- Do we keep Projects at all, or fold them into a simpler conversation-folders model?
