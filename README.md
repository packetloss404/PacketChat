# PacketChat

PacketChat is a self-hosted, multi-user AI workspace for a small private instance. V1 targets local JWT auth, admin-managed provider keys, optional per-user BYOK, private user-owned chats/projects/prompts/knowledge/agents, and a Docker Compose deployment.

## Current Scope

- Single deployment, no workspaces or teams in V1.
- Local users with admin-created accounts, invite links, and admin-triggered reset links.
- Break-glass admin path for emergency access.
- Admin-managed global provider accounts plus optional per-user BYOK toggled per user.
- Provider adapters planned for OpenAI-compatible, Azure OpenAI, Anthropic, Perplexity, and Minimax.
- Postgres, Redis, and MinIO as durable/runtime dependencies.

## Quick Start

1. Copy `.env.example` to `.env` and replace secrets.
2. Run `npm install`.
3. Run `npm run compose:up`.
4. Run `npm run compose:migrate`.
5. Open `http://localhost:3000` and complete bootstrap.
6. Run `npm run smoke` to verify readiness; set `PACKETCHAT_SMOKE_EMAIL` and `PACKETCHAT_SMOKE_PASSWORD` to include a login check.

See `docs/local-run.md` for local operator commands, API examples, health checks, BYOK toggles, migrations, and stack shutdown.

## Initial Baseline / Git Workflow

This repository is initialized on branch `main` with origin `git@github.com:packetloss404/PacketChat.git`.

- Keep `.env`, `.env.*`, `secrets/`, local data directories, backups, build outputs, logs, `node_modules/`, and `*.tsbuildinfo` out of git.
- Keep `.env.example` tracked as the non-secret configuration template.
- Before a first baseline commit, run `npm install` if dependencies are not installed, then run `npm run verify`.
- If the local Compose stack is running, also run `npm run smoke` before committing.
- Create the first commit manually with `git add .`, `git status --short`, and `git commit -m "chore: establish initial PacketChat baseline"`.

See `docs/git-workflow.md` for the checkpoint checklist and command sequence.

## Current UI Routes

- `/`: bootstrap/landing entry point.
- `/login`: local password login.
- `/chat`: authenticated chat test surface for configured provider accounts.
- `/providers`: provider account management.
- `/projects`: private project management.
- `/prompts`: private prompt management.
- `/knowledge`: knowledge base and document management.
- `/agents`: agent builder for creating agents, editing drafts, and publishing immutable versions.
- `/admin/users`: admin-only user management, password reset links, and BYOK toggles.

Agent execution remains post-agent-builder work: published versions exist, but run execution, evaluation, and scheduling are not implemented yet.

## Deployment Notes

- Only the `web` service should be exposed to your reverse proxy.
- Postgres, Redis, and MinIO stay private on the Compose network.
- Use immutable image tags for pilot/prod.
- Run a restore drill before calling a deployment production-ready.
- Use `npm run backup`, `npm run backup:postgres`, or `npm run backup:minio` for local Compose backup artifacts before upgrades.

See `docs/deployment.md`, `docs/local-run.md`, `docs/smoke-test.md`, and `docs/runbooks/backup-restore.md`.
