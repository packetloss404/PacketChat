# Release Readiness Surfaces

Use this checklist after `npm run smoke` passes and before a pilot or production handoff. These checks validate wired P0/P1 surfaces that are not fully covered by the default smoke script.

## Product Workspaces

- `/projects` lists user-owned project workspaces with persistent instructions, default-model readiness, linked chat counts, and search.
- Project workspaces are single-deployment, user-owned records; multi-tenant org / team workspaces are still outside V1.

## Knowledge Debugger

- `/knowledge` supports create/edit/archive/delete, upload, reembed, and test retrieval.
- Search results expose score, matched terms, citation, source metadata, freshness, chunk details, and embedding status so retrieval quality can be inspected before release.

## Model Governance

- `/admin/providers` shows the app-wide provider accounts, enabled/disabled route state, default route state, synced model binding counts, pricing coverage, and capability metadata, and is admin-only.
- Disabled provider accounts are excluded from runtime routing, connection tests, and model sync until re-enabled.
- `/admin/operations` summarizes provider account status, model binding status, and recent provider audit events.

## Approvals And Agent Runs

- `/agents` exposes persisted run history for published single-pass augmented agents, including run status, steps, events, provider/model usage, token counts, estimated cost, and output.
- `/approvals` lets authorized users review pending approval checkpoints, approve or reject them, and see recent safe action activity.
- `/admin/approvals` routes admins into the actionable approval queue, where admins can review cross-user pending steps.
- Scheduled runs, evaluations, and true multi-step tool loops remain outside V1.

## Admin Readiness

- `/admin/usage` shows daily/user/provider/model usage, recent records, estimated-token and unknown-cost flags, monthly run-rate projection, and chargeback warnings.
- `/admin/audit` shows the latest audit events with actor, action, outcome, target, IP, user agent, metadata, filters, and action summaries.
- `/admin/operations` shows provider accounts, model bindings, knowledge ingestion, seven-day agent run status, recent job failures, and provider audit signals.

## Minimum Manual Pass

1. Log in as an admin on the target deployment.
2. Confirm `/projects`, `/knowledge`, `/providers`, `/agents`, and `/approvals` load without auth or server errors.
3. Confirm `/admin/usage`, `/admin/audit`, `/admin/operations`, and `/admin/approvals` load current data.
4. Run a knowledge search and expand at least one debug panel.
5. Run or inspect a published agent and verify run history includes steps/events/usage.
6. Review `/admin/operations` for failed jobs, failed/timed-out runs, failed ingestion, disabled model bindings, or provider audit failures.
