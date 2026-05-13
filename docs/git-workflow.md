# Initial Baseline / Git Workflow

Use this checklist after `git init` and before creating the first repository checkpoint.

## Repository State

- Current branch: `main`
- Remote origin: `git@github.com:packetloss404/PacketChat.git`
- Commit state: no baseline commit has been created yet.

## Ignored Secrets And Generated Files

Do not commit local secrets or generated state:

- `.env` and `.env.*`
- `secrets/`
- private key and certificate files such as `*.pem`, `*.key`, and `*.crt`
- `node_modules/`, `.next/`, `dist/`, `build/`, `out/`, `.turbo/`, `.vercel/`, and `*.tsbuildinfo`
- local Compose/runtime data such as `postgres-data/`, `redis-data/`, `minio-data/`, and `backups/`
- logs such as `*.log` and `npm-debug.log*`

Keep `.env.example` tracked so operators can create their own `.env` without exposing credentials.

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

## Create The First Commit Manually

Review what will be committed:

```shell
git status --short
git diff -- . ':!package-lock.json'
```

Stage and commit the baseline when ready:

```shell
git add .
git status --short
git commit -m "chore: establish initial PacketChat baseline"
```

Push only when the baseline is reviewed locally:

```shell
git push -u origin main
```
