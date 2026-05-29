# Git Workflow

Use this checklist for day-to-day changes and before opening a pull request.

## Repository State

- Default branch: `main`
- Remote origin: `git@github.com:packetloss404/PacketChat.git`
- Feature work lands on short-lived branches (for example `codex/<topic>`) and merges into `main` via pull request.

## Ignored Secrets And Generated Files

Do not commit local secrets or generated state:

- `.env` and `.env.*`
- `secrets/`
- private key and certificate files such as `*.pem`, `*.key`, and `*.crt`
- `node_modules/`, `.next/`, `dist/`, `build/`, `out/`, `.turbo/`, `.vercel/`, and `*.tsbuildinfo`
- local Compose/runtime data such as `postgres-data/`, `redis-data/`, `minio-data/`, and `backups/`
- logs such as `*.log` and `npm-debug.log*`

Keep `.env.example` tracked so operators can create their own `.env` without exposing credentials.

## Start A Change

Branch off an up-to-date `main`:

```shell
git checkout main
git pull --ff-only origin main
git checkout -b codex/<short-topic>
```

## Pre-Commit Verification

Run the lightweight static checks before committing:

```shell
npm install
npm run verify
```

Run the production dependency audit before release branches or pilot/prod rollouts:

```shell
npm run audit:prod
```

As of the May 2026 local hardening pass this audit gates high-severity production advisories and may still print a moderate Next.js/PostCSS advisory. Keep that visible locally until those dependencies can be upgraded without taking on a framework migration.

For Docker or deployment changes, validate the Compose file and application image targets:

```shell
npm run compose:check
```

This requires a root `.env` file. For local validation from a fresh checkout, copy `.env.example` to `.env` first and replace secrets before running the stack.

If the local Compose stack is running and migrated, run the smoke check too:

```shell
npm run smoke
```

For a full local readiness pass from a fresh checkout, use:

```shell
npm run compose:up
npm run compose:migrate
npm run smoke
```

## Commit And Push

Review what will be committed:

```shell
git status --short
git diff -- . ':!package-lock.json'
```

Stage and commit with a conventional-style message:

```shell
git add .
git status --short
git commit -m "feat: short description of the change"
```

Push the branch and open a pull request against `main`:

```shell
git push -u origin codex/<short-topic>
```

Keep `main` releasable: merge only after `npm run verify` passes and the relevant smoke/readiness checks in `docs/smoke-test.md` and `docs/release-readiness.md` are green for the change.
