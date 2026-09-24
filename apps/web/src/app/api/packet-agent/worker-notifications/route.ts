import { getSql } from "@packetchat/db";
import { encryptJsonSecret } from "@packetchat/auth";
import type { JSONValue } from "postgres";
import {
  handleWorkerNotification,
  packetAgentIngestRateLimit,
  runCardFromRow,
  type PacketAgentConnectionIdentity,
  type PacketAgentIngestRepo,
  type PacketAgentRunRow
} from "../../../../lib/packet-agent";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ConnectionIdentityRow = {
  id: string;
  project_id: string;
  owner_user_id: string;
  workspace_id: string;
  deployment_id: string | null;
  ingest_token_digest: string;
};

function createRepo(): PacketAgentIngestRepo {
  const sql = getSql();

  return {
    async findConnectionById(connectionId) {
      if (!UUID_PATTERN.test(connectionId)) return null;
      const rows = await sql<ConnectionIdentityRow[]>`
        select id, project_id, owner_user_id, workspace_id, deployment_id, ingest_token_digest
        from packet_agent_connections
        where id = ${connectionId}
        limit 1
      `;
      const row = rows[0];
      if (!row) return null;
      const identity: PacketAgentConnectionIdentity = {
        id: row.id,
        projectId: row.project_id,
        ownerUserId: row.owner_user_id,
        workspaceId: row.workspace_id,
        deploymentId: row.deployment_id,
        ingestTokenDigest: row.ingest_token_digest
      };
      return identity;
    },

    async findRunByWorkerRunId(connectionId, workerRunId) {
      const rows = await sql<PacketAgentRunRow[]>`
        select
          id, connection_id, project_id, owner_user_id, workspace_id, thread_key,
          worker_run_id, worker_definition_id, worker_deployment_id, worker_version_id,
          worker_version_content_digest, title, summary, state, budget, checkpoint,
          required_action, evidence, created_at, updated_at
        from packet_agent_runs
        where connection_id = ${connectionId} and worker_run_id = ${workerRunId}
        limit 1
      `;
      const row = rows[0];
      return row ? { runId: row.id, card: runCardFromRow(row) } : null;
    },

    async eventExists(connectionId, messageKey, idempotencyKey) {
      const rows = await sql`
        select 1 from packet_agent_run_events
        where connection_id = ${connectionId}
          and (message_key = ${messageKey} or idempotency_key = ${idempotencyKey})
        limit 1
      `;
      return rows.length > 0;
    },

    async applyUpsert(input) {
      return sql.begin(async (tx) => {
        const rows = await tx<{ id: string }[]>`
          insert into packet_agent_runs (
            connection_id, project_id, owner_user_id, workspace_id, thread_key,
            worker_run_id, worker_definition_id, worker_deployment_id, worker_version_id,
            worker_version_content_digest, title, summary, state, budget, checkpoint,
            required_action, evidence, callbacks
          ) values (
            ${input.connectionId}, ${input.projectId}, ${input.ownerUserId}, ${input.workspaceId}, ${input.card.threadKey},
            ${input.card.workerRunId}, ${input.card.workerDefinitionId}, ${input.card.workerDeploymentId}, ${input.card.workerVersionId},
            ${input.card.workerVersionContentDigest}, ${input.card.title}, ${input.card.summary},
            ${sql.json(input.card.state)},
            ${sql.json(input.card.budget as JSONValue)},
            ${input.card.checkpoint ? sql.json(input.card.checkpoint) : null},
            ${input.card.requiredAction},
            ${sql.json(input.card.evidence ?? {})},
            ${sql.json(encryptJsonSecret(input.card.callbacks ?? {}))}
          )
          on conflict (connection_id, worker_run_id) do update set
            thread_key = excluded.thread_key,
            worker_definition_id = excluded.worker_definition_id,
            worker_deployment_id = excluded.worker_deployment_id,
            worker_version_id = excluded.worker_version_id,
            worker_version_content_digest = excluded.worker_version_content_digest,
            title = excluded.title,
            summary = excluded.summary,
            state = excluded.state,
            budget = excluded.budget,
            checkpoint = excluded.checkpoint,
            required_action = excluded.required_action,
            evidence = excluded.evidence,
            callbacks = excluded.callbacks,
            updated_at = now()
          returning id
        `;
        const runId = rows[0]!.id;
        if (input.appendEvent) {
          await tx`
            insert into packet_agent_run_events (run_id, connection_id, message_key, idempotency_key, event, payload)
            values (${runId}, ${input.connectionId}, ${input.messageKey}, ${input.idempotencyKey}, ${input.event}, ${sql.json(input.eventPayload as JSONValue)})
            on conflict (connection_id, message_key) do nothing
          `;
        }
        return { runId };
      });
    }
  };
}

export async function POST(request: Request) {
  return handleWorkerNotification(request, {
    repo: createRepo(),
    rateLimit: packetAgentIngestRateLimit
  });
}
