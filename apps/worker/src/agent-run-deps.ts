import { getSql } from "@packetchat/db";
import {
  claimRunForExecution,
  createAgentRunDeps,
  executeRun,
  publicRunError,
  recordRunOutcome,
  textOrNull,
  type AgentRunDeps,
  type AgentSpec
} from "@packetchat/agent-runtime";
import type { AgentRunContext, AgentRunJobDeps } from "./agent-run";

type RunContextRow = {
  caller_user_id: string;
  conversation_id: string | null;
  input: Record<string, unknown>;
  resolved_provider_account_id: string | null;
  resolved_model: string | null;
  agent_id: string;
  agent_name: string;
  resource_owner_user_id: string;
  spec: AgentSpec;
};

/**
 * Rebuilds the run the web route created. Everything comes from the run row and
 * the version it pinned, so a job carries no state that could drift from what
 * the caller was told.
 */
async function loadContext(input: { runId: string; agentId: string }): Promise<AgentRunContext | null> {
  const sql = getSql();
  const rows = await sql<RunContextRow[]>`
    select
      r.owner_user_id as caller_user_id,
      r.conversation_id,
      r.input,
      r.resolved_provider_account_id,
      r.resolved_model,
      a.id as agent_id,
      a.name as agent_name,
      a.owner_user_id as resource_owner_user_id,
      v.spec
    from agent_runs r
    join agents a on a.id = r.agent_id
    join agent_versions v on v.id = r.agent_version_id
    where r.id = ${input.runId}
      and r.agent_id = ${input.agentId}
    limit 1
  `;
  const row = rows[0];
  if (!row) return null;

  const inputText = textOrNull(row.input?.text);
  if (!inputText) throw new Error(`Agent run ${input.runId} has no input text to execute`);

  const providerAccountId = textOrNull(row.resolved_provider_account_id);
  const model = textOrNull(row.resolved_model);

  // The recorded binding is authoritative when present: it is the exact account
  // and model this caller was promised. When it is absent - a run created before
  // 0006 added the columns - fall back to the pinned agent_versions.spec the run
  // already references. That is not a re-resolve: agent versions are immutable,
  // so it yields the same values the route itself read. Refusing instead would
  // fail an otherwise perfectly executable run for a schema detail.
  const specProviderAccountId = providerAccountId ?? textOrNull((row.spec as { providerAccountId?: unknown }).providerAccountId);
  const specModel = model ?? textOrNull((row.spec as { model?: unknown }).model);
  if (!specProviderAccountId || !specModel) {
    throw new Error(`Agent run ${input.runId} has no provider binding to execute`);
  }

  return {
    runId: input.runId,
    agentId: row.agent_id,
    agentName: row.agent_name,
    callerUserId: row.caller_user_id,
    resourceOwnerUserId: row.resource_owner_user_id,
    conversationId: row.conversation_id,
    spec: { ...row.spec, providerAccountId: specProviderAccountId, model: specModel },
    inputText
  };
}

/**
 * The production ports: postgres and the shared agent runtime. Same shape as the
 * worker's provider-sync and cleanup adapters.
 */
export function createAgentRunJobDeps(runtime: AgentRunDeps = createAgentRunDeps()): AgentRunJobDeps {
  return {
    loadContext,
    claimRun: (runId) => claimRunForExecution(runId),
    execute: ({ context, signal }) => executeRun(runtime, {
      runId: context.runId,
      resourceOwnerUserId: context.resourceOwnerUserId,
      spec: context.spec,
      inputText: context.inputText,
      signal
    }),
    // The answer belongs to the caller's conversation, so it is written as the
    // caller, not as the agent's owner.
    recordOutcome: ({ context, status, text }) => recordRunOutcome({
      conversationId: context.conversationId,
      runId: context.runId,
      userId: context.callerUserId,
      version: { agent_id: context.agentId, agent_name: context.agentName },
      status,
      text
    }),
    publicError: publicRunError
  };
}
