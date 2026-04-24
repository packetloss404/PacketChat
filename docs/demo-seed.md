# Demo Seed Data

Use the demo seed when you need a populated local workspace for UI review without provider API keys or Resend.

## Prerequisites

- Postgres is running and `DATABASE_URL` is available in `.env` or the shell.
- Database migrations have been applied with `npm run compose:migrate` or `npm run db:migrate`.
- At least one active admin user exists. Bootstrap an admin first on a fresh database.

## Run

```shell
npm run seed:demo
```

By default, the script seeds the first active admin user. To target a specific admin:

```shell
PACKETCHAT_DEMO_ADMIN_EMAIL=admin@example.com npm run seed:demo
```

If you keep environment variables somewhere other than `.env`, set `PACKETCHAT_ENV_FILE`:

```shell
PACKETCHAT_ENV_FILE=.env.local npm run seed:demo
```

## What It Creates

- `Demo:` projects with instructions.
- `Demo:` prompt templates and initial versions.
- `Demo:` conversations with seeded system, user, and assistant messages.
- A `Demo:` knowledge base, ready markdown document, and searchable chunks with local deterministic embeddings.
- An active `Demo:` agent with a draft, published version, owner permission, and knowledge binding.

The script is non-destructive and idempotent where practical. Re-running it updates the same named demo records and message/chunk seed markers instead of deleting unrelated data. It does not contact model providers, object storage, Redis, or email services.
