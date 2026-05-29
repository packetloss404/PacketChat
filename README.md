# PacketChat

PacketChat is a privately deployed, multi-user AI workspace. V1 targets local JWT auth, admin-managed provider keys, optional per-user BYOK, private user-owned chats / projects / prompts / knowledge / agents, and a Docker Compose deployment.

The frontend is a v3 LibreChat-style shell — three columns (left rail, main, collapsible right rail), monochrome dark theme with a light-mode toggle, route-aware header pill, and an account popover.

## Current Scope

- Single deployment. V1 includes user-owned project workspaces, but not multi-tenant org / team workspaces.
- Local users with admin-created accounts, invite links, and admin-triggered reset links.
- Self-service password change for the signed-in user (POST `/api/auth/change-password`), accessible from the account popover.
- Forced password-reset accounts cannot mint normal sessions until the password is changed.
- Break-glass admin path for emergency access, gated by an audit-acknowledgement checkbox on the login form.
- Admin-managed global provider accounts plus optional per-user BYOK, surfaced through `/providers`. Settings → API Keys links there instead of storing local provider keys.
- Admin release-readiness surfaces for usage governance, audit events, operations health, pending approvals, and persisted agent run history.
- Runtime provider adapters for OpenAI-compatible, Azure OpenAI, Anthropic, Perplexity, and MiniMax. Google is not a V1 runtime provider yet; any Google labels in the Models UI are forward-looking/custom-model metadata only.
- Custom provider base URLs are validated before save and again before runtime use. Local OpenAI-compatible endpoints are allowed for tools such as Ollama / LM Studio / vLLM; hosted providers must not target loopback, private, link-local, or reserved network addresses.
- Postgres, Redis, and MinIO as durable / runtime dependencies.

## Quick Start

1. Copy `.env.example` to `.env` and replace secrets.
2. Run `npm install`.
3. Run `npm run compose:up`.
4. Run `npm run compose:migrate`.
5. Open `http://localhost:3000` and complete bootstrap.
6. Run `npm run smoke` to verify readiness; set `PACKETCHAT_SMOKE_EMAIL` and `PACKETCHAT_SMOKE_PASSWORD` to include authenticated checks. Set `PACKETCHAT_SMOKE_REQUIRE_AUTH=1` for release smoke runs.

See `docs/local-run.md` for local operator commands, API examples, health checks, BYOK toggles, migrations, and stack shutdown.

## Git Workflow

This repository is on branch `main` with origin `git@github.com:packetloss404/PacketChat.git`.

- Keep `.env`, `.env.*`, `secrets/`, local data directories, backups, build outputs, logs, `node_modules/`, and `*.tsbuildinfo` out of git.
- Keep `.env.example` tracked as the non-secret configuration template.
- Before committing, run `npm run verify` (typecheck, JS syntax/workspace lint, and tests). For local production readiness checks, run `npm run audit:prod`, `npm run prod:check`, and `npm run compose:check` when Docker is available; `audit:prod` gates high-severity production advisories and may still print lower-severity dependency advisories. If the Compose stack is running, also run `npm run smoke`.

See `docs/git-workflow.md` for the branch, commit, and pull-request workflow.

## UI Routes

| Route | What it does | Wired? |
| --- | --- | --- |
| `/` | Welcome dashboard with quick actions, system status (`/api/healthz`), Resume-last-chat | ✅ |
| `/login` | Local password login, invite acceptance, password-reset completion, break-glass with audit ack | ✅ |
| `/chat` | Empty-state greet + pill composer; transcript with turn copy / inline edit / bookmark; SSE streaming for normal chat; `?conversation=<id>` restores transcripts; `?prompt=<id>` opens a prompt in the composer; `?agent=<id>` runs published single-pass augmented agents with chat persistence; per-message timestamps; speech-recognition mic when supported | ✅ |
| `/agents` | Library grid with deterministic avatars + Create / Browse / Search / Sort / Pin; Create modal (scratch or template); builder with provider/model/parameters, file search, file context, artifact instructions, OpenAPI actions, pre-run agent context, supported tools, ACL sharing, manual runs, and persisted run history with steps/events/usage for published single-pass augmented agents | ✅ |
| `/providers` | Provider account governance — global/admin and user BYOK accounts, enable/disable/default route controls, connection test, model sync, synced binding counts, pricing/capability status, and disabled-route guardrails. Runtime provider IDs are limited to OpenAI-compatible, Azure OpenAI, Anthropic, Perplexity, and MiniMax. | ✅ |
| `/projects` | User-owned project workspaces with reusable instructions, default-model readiness, linked chat counts, create/edit/delete, and workspace search | ✅ |
| `/prompts` | Prompt Library — Add prompt modal, Browse-templates modal that creates real prompts, search + tag filter + Title / Recently-updated sort, list/grid views, star favorites (localStorage), Use in chat opens the body in the chat composer | ✅ |
| `/knowledge` | Knowledge bases — create, edit, archive, delete; drag-drop file upload with type-filtered accept; documents list with rename / delete; reembed with detailed counts; Enter-to-search retrieval plus per-result debug details for score, matched terms, source, freshness, and embedding metadata | ✅ |
| `/plugins` | Pending integrations — `Perplexity Search`, `Deep Research`, `GPT Image Editor`, `PDF Summarizer`, `Voice Mode` — each with a Join-waitlist email modal (prefilled from `/api/auth/me`), plus a Request-a-plugin form. All persisted to localStorage. | ✅ (UX) |
| `/plugins/marketplace` | Coming-soon splash with orbital SVG art and three teaser agent cards (`Save interest`) | ✅ (UX, local only) |
| `/approvals` | User approval queue for pending agent action checkpoints, approve/reject decisions, and recent safe action activity | ✅ |
| `/admin/users` | Admin-only user management, invite links, password reset links, BYOK toggles | ✅ |
| `/admin/usage` | Usage governance with daily/user/provider/model totals, recent records, estimated/unknown-cost flags, monthly run-rate projection, and chargeback warnings | ✅ |
| `/admin/audit` | Admin audit log with actor/action/outcome/target/IP/user-agent/metadata filters and action summaries | ✅ |
| `/admin/operations` | Operations health for provider accounts, model bindings, knowledge ingestion, seven-day agent runs, job failures, and recent provider audit signals | ✅ |
| `/admin/approvals` | Admin shortcut into the actionable approval queue for pending agent approval steps across users and agents | ✅ |
| `/settings` | Account & Data (server-backed storage status / local preference backup / provider-account link / License Key), Preferences (General / Appearance / Keyboard Shortcuts / Text-to-speech / Voice Input), Advanced (MCP drafts / local internal prompt draft / Extensions / Proxy & Org ID drafts) | ✅ (mixed wired + draft UI) |
| `/not-found`, `/global-error` | Themed error surfaces | ✅ |

## Account popover

Click the avatar / display name in the left-rail footer to open the account drop-up:

- **Manage sync status** — placeholder, marked coming-soon.
- **Change password** — opens a modal that calls `POST /api/auth/change-password`, verifies the current password, applies the policy, and revokes all other sessions while keeping the current one alive.
- **API Keys** — link to `/settings` → API Keys.
- **Help & Information** — placeholder toast.
- **packetloss404 GitHub** — opens `https://github.com/packetloss404`.
- Footer: Fifty Eleven LLC ©, Contact / Privacy / Terms / FAQs / Docs (placeholder anchors), region chip, light/dark theme toggle that flips a `.light` class on `<html>`.

The settings gear (next to the popover trigger) routes to `/settings`.

## Right-rail drawers

The 48-px right rail expands a 320-px panel when an icon is selected. Each drawer reads/writes localStorage so values survive reloads:

- **Prompts** — link to `/prompts`.
- **Memories** — local listing + add-memory textarea (`packetchat.memories`), empty by default.
- **Parameters** — temperature, top-p, max output tokens, system prompt + Reset (`packetchat.parameters`).
- **Attach Files** — drop zone + file list with sizes; uploads not yet sent through the chat API.
- **Bookmarks** — reads `packetchat.chat.bookmarks` written by the chat-turn bookmark button.
- **MCP Drafts** — local draft toggles per MCP server (`packetchat.mcp.connections`); runtime MCP is not wired.

`Esc` closes the drawer.

## Wiring status — what's stubbed vs wired

**Wired:**

- All auth endpoints: login, refresh, logout, invite accept, password reset complete, change password, /me.
- All conversation, project, prompt, knowledge base, agent, agent draft, agent publish, agent run, approval, admin user, admin usage, admin audit, admin operations, and admin approval endpoints.
- SSE streaming chat at `POST /api/chat`.
- Agent publish, ACL sharing, and synchronous single-pass augmented agent runs, including file search, file context injection, artifact-format instructions, calculator, hardened URL fetch, HTTPS OpenAPI actions, bounded same-owner pre-run agent context, provider streaming, run steps/events/usage, approval checkpoints, user/admin approval queues, and chat-launched run transcript persistence. Viewers can inspect shared agents, while runners/editors/owners can run them. Scheduled runs, evaluations, and true multi-step tool loops are outside V1.
- Runtime model use is checked against enabled model bindings for chat and agent runs.
- Provider-account toggles persist via the existing `providers.updateAccount` path (account-level granularity; the backend has no per-binding toggle yet).
- Speech Synthesis voice picker enumerates real `window.speechSynthesis` voices; chat reply playback is not wired yet.
- Theme toggle, font-size slider, and most preferences in `/settings` write through to `localStorage` under `packetchat.settings.<section>.<key>`.

**Stubbed (UI-complete, backend pending):**

- Cloud sync — local-backup export works; cloud connect is gated to a future Fifty Eleven LLC account flow.
- License Key activation — accepts input but the validation service isn't connected.
- Plugin install / waitlist — interest and requests persist locally only; no notification backend.
- Internal prompts, proxy values, and MCP server entries — stored as local drafts only; chat and agents do not consume them yet.
- Marketplace install — UI only.
- File attachments in chat — picked file shows but isn't uploaded.
- Custom models — saved to localStorage; there is no backend endpoint for registering them.
- Per-binding model toggle — not exposed by the backend; account-level toggle is what fires.
- Code interpreter and MCP tools — visible in the builder as unavailable until their runtimes are configured.

## Deployment Notes

- Only the `web` service should be exposed to your reverse proxy.
- Postgres, Redis, and MinIO stay private on the Compose network.
- Use immutable image tags for pilot / prod.
- Treat Compose as the supported V1 deployment shape. Kubernetes, multi-region HA, external managed databases, SSO, email-delivered invites/password resets, and Google provider runtime support are not included in the V1 promise.
- Run a restore drill before calling a deployment production-ready.
- Use `npm run backup`, `npm run backup:postgres`, or `npm run backup:minio` for local Compose backup artifacts before upgrades.

See `docs/deployment.md`, `docs/local-run.md`, `docs/smoke-test.md`, and `docs/runbooks/backup-restore.md`.

## Front-end conventions

- Dark monochrome tokens in `apps/web/src/app/globals.css` (`--bg`, `--ink`, `--line`, etc.) plus a `.light` override.
- Canonical breakpoints at **720**, **960**, and **1200 px**. Below 720 the rails collapse and a mobile topbar overlays the left rail.
- Focus-visible outlines, `prefers-reduced-motion` honoured, `forced-colors` fallbacks for Windows High Contrast, themed `<dialog>` backdrops.
- Page shells are wrapped in `.sheet > .sheet__inner` for consistent padding + scroll behaviour.
- Icons are inline SVGs in `apps/web/src/components/icons.tsx`.
- Pages persist user-scoped UI state under `packetchat.*` localStorage keys.
