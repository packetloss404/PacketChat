import { authenticateRequest } from "@packetchat/auth";
import { getSql } from "@packetchat/db";
import { getAgentAccess } from "../../../../../lib/agent-access";
import { jsonError, jsonOk } from "../../../../../lib/http";

type RouteContext = { params: Promise<{ agentId: string }> };

function textOrNull(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function uuidList(value: unknown) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(item)))];
}

function normalizeFileContext(value: unknown) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const maxChars = Number(input.maxChars);
  return {
    enabled: Boolean(input.enabled),
    knowledgeBaseIds: uuidList(input.knowledgeBaseIds),
    maxChars: Number.isInteger(maxChars) ? Math.min(Math.max(maxChars, 1000), 50000) : 12000
  };
}

function normalizeArtifacts(value: unknown) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return {
    enabled: Boolean(input.enabled),
    customPromptMode: Boolean(input.customPromptMode),
    instructions: typeof input.instructions === "string" ? input.instructions.slice(0, 12000) : ""
  };
}

function normalizeOpenApiActions(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 8).flatMap((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const action = item as Record<string, unknown>;
    const method = typeof action.method === "string" ? action.method.toUpperCase() : "GET";
    if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) return [];
    const name = typeof action.name === "string" && action.name.trim() ? action.name.trim().slice(0, 80) : `Action ${index + 1}`;
    const url = typeof action.url === "string" ? action.url.trim().slice(0, 2048) : "";
    if (!/^https:\/\//i.test(url)) return [];
    const headers = action.headers && typeof action.headers === "object" && !Array.isArray(action.headers) ? action.headers as Record<string, unknown> : {};
    const safeHeaders = Object.fromEntries(Object.entries(headers).filter(([key, value]) => /^[a-z0-9-]+$/i.test(key) && typeof value === "string").slice(0, 12));
    return [{
      id: typeof action.id === "string" && action.id.trim() ? action.id.trim().slice(0, 80) : `action-${index + 1}`,
      name,
      method,
      url,
      headers: safeHeaders,
      bodyTemplate: typeof action.bodyTemplate === "string" ? action.bodyTemplate.slice(0, 12000) : "",
      enabled: action.enabled !== false
    }];
  });
}

function normalizeAgentChain(value: unknown) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const maxChildRuns = Number(input.maxChildRuns);
  return {
    enabled: Boolean(input.enabled),
    agentIds: uuidList(input.agentIds).slice(0, 5),
    maxChildRuns: Number.isInteger(maxChildRuns) ? Math.min(Math.max(maxChildRuns, 1), 5) : 3
  };
}

function normalizeSpec(spec: Record<string, unknown>) {
  const tools = spec.tools && typeof spec.tools === "object" && !Array.isArray(spec.tools) ? spec.tools as Record<string, unknown> : {};
  const temperature = Number(spec.temperature);
  const maxOutputTokens = Number(spec.maxOutputTokens);
  const maxContextTokens = Number(spec.maxContextTokens);
  const maxAgentSteps = Number(spec.maxAgentSteps);
  const knowledgeLimit = Number(spec.knowledgeLimit);
  return {
    ...spec,
    name: typeof spec.name === "string" ? spec.name : undefined,
    description: typeof spec.description === "string" ? spec.description : "",
    instructions: typeof spec.instructions === "string" ? spec.instructions : "",
    provider: typeof spec.provider === "string" ? spec.provider : undefined,
    providerAccountId: typeof spec.providerAccountId === "string" ? spec.providerAccountId : undefined,
    model: typeof spec.model === "string" ? spec.model : undefined,
    temperature: Number.isFinite(temperature) ? Math.min(Math.max(temperature, 0), 2) : undefined,
    maxOutputTokens: Number.isInteger(maxOutputTokens) ? Math.min(Math.max(maxOutputTokens, 1), 32000) : undefined,
    maxContextTokens: Number.isInteger(maxContextTokens) ? Math.min(Math.max(maxContextTokens, 1000), 200000) : undefined,
    maxAgentSteps: Number.isInteger(maxAgentSteps) ? Math.min(Math.max(maxAgentSteps, 1), 25) : 4,
    knowledgeBaseIds: uuidList(spec.knowledgeBaseIds),
    knowledgeLimit: Number.isInteger(knowledgeLimit) ? Math.min(Math.max(knowledgeLimit, 1), 10) : 5,
    fileContext: normalizeFileContext(spec.fileContext),
    artifacts: normalizeArtifacts(spec.artifacts),
    openApiActions: normalizeOpenApiActions(spec.openApiActions),
    agentChain: normalizeAgentChain(spec.agentChain),
    tools: {
      knowledgeSearch: Boolean(tools.knowledgeSearch),
      calculator: Boolean(tools.calculator),
      urlFetch: Boolean(tools.urlFetch)
    }
  };
}

export async function GET(request: Request, context: RouteContext) {
  const user = await authenticateRequest(request.headers);
  if (!user) return jsonError("Unauthenticated", 401);

  const { agentId } = await context.params;
  const access = await getAgentAccess(agentId, user);
  if (!access?.canEdit) return jsonError("Agent draft not found", 404);
  const sql = getSql();
  const rows = await sql`
    select
      a.id as agent_id,
      a.name,
      a.description,
      a.status,
      a.published_version_id,
      d.id as draft_id,
      d.base_version_id,
      d.spec,
      d.editor_state,
      d.revision,
      d.updated_at
    from agents a
    join agent_drafts d on d.id = a.current_draft_id
    where a.id = ${agentId}
    limit 1
  `;
  if (rows.length === 0) return jsonError("Agent draft not found", 404);

  return jsonOk({ draft: rows[0] });
}

export async function PATCH(request: Request, context: RouteContext) {
  const user = await authenticateRequest(request.headers);
  if (!user) return jsonError("Unauthenticated", 401);

  const { agentId } = await context.params;
  const access = await getAgentAccess(agentId, user);
  if (!access?.canEdit) return jsonError("Agent draft not found", 404);
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") return jsonError("Invalid request body", 400);

  const sql = getSql();
  const existing = await sql<{ draft_id: string; spec: Record<string, unknown>; editor_state: Record<string, unknown> }[]>`
    select d.id as draft_id, d.spec, d.editor_state
    from agents a
    join agent_drafts d on d.id = a.current_draft_id
    where a.id = ${agentId}
    limit 1
  `;
  if (existing.length === 0) return jsonError("Agent draft not found", 404);

  const current = existing[0]!;
  const spec = body.spec && typeof body.spec === "object" && !Array.isArray(body.spec)
    ? normalizeSpec(body.spec as Record<string, unknown>)
    : current.spec;
  const editorState = body.editorState && typeof body.editorState === "object" && !Array.isArray(body.editorState)
    ? body.editorState as Record<string, unknown>
    : current.editor_state;
  const name = textOrNull(body.name) ?? textOrNull(spec.name) ?? "Untitled agent";
  const description = textOrNull(body.description) ?? (typeof spec.description === "string" ? spec.description : null);

  const rows = await sql.begin(async (tx) => {
    const specRecord = spec as Record<string, unknown>;
    const searchKnowledgeBaseIds = Array.isArray(specRecord.knowledgeBaseIds) ? specRecord.knowledgeBaseIds : [];
    const fileContext = normalizeFileContext(specRecord.fileContext);
    const agentChain = normalizeAgentChain(specRecord.agentChain);
    const requestedKnowledgeBaseIds = [...new Set([...searchKnowledgeBaseIds, ...fileContext.knowledgeBaseIds])];
    const ownedKnowledgeBases = requestedKnowledgeBaseIds.length
      ? await tx<{ id: string }[]>`
          select id
          from knowledge_bases
          where owner_user_id = ${access.ownerUserId}
            and id = any(${requestedKnowledgeBaseIds})
        `
      : [];
    const allowedIds = new Set(ownedKnowledgeBases.map((kb) => kb.id));
    const ownedKnowledgeBaseIds = searchKnowledgeBaseIds.filter((id): id is string => typeof id === "string" && allowedIds.has(id));
    const fileContextKnowledgeBaseIds = fileContext.knowledgeBaseIds.filter((id) => allowedIds.has(id));
    const childAgents = agentChain.agentIds.length
      ? await tx<{ id: string }[]>`
          select id
          from agents
          where owner_user_id = ${access.ownerUserId}
            and id <> ${agentId}
            and id = any(${agentChain.agentIds})
            and published_version_id is not null
        `
      : [];
    const allowedChildAgentIds = new Set(childAgents.map((agent) => agent.id));
    const boundSpec: Record<string, unknown> = {
      ...specRecord,
      knowledgeBaseIds: ownedKnowledgeBaseIds,
      fileContext: { ...fileContext, knowledgeBaseIds: fileContextKnowledgeBaseIds },
      agentChain: { ...agentChain, agentIds: agentChain.agentIds.filter((id) => allowedChildAgentIds.has(id)) }
    };

    await tx`
      update agents
      set name = ${name}, description = ${description}, updated_at = now()
      where id = ${agentId}
    `;
    await tx`
      delete from agent_knowledge_bindings
      where agent_draft_id = ${current.draft_id}
    `;
    for (const knowledgeBaseId of ownedKnowledgeBaseIds) {
      const knowledgeLimit = typeof boundSpec.knowledgeLimit === "number" ? boundSpec.knowledgeLimit : 5;
      await tx`
        insert into agent_knowledge_bindings (agent_draft_id, knowledge_base_id, binding_config, retrieval_override)
        values (${current.draft_id}, ${knowledgeBaseId}, ${JSON.stringify({ source: "builder" })}::jsonb, ${JSON.stringify({ limit: knowledgeLimit })}::jsonb)
      `;
    }
    return tx`
      update agent_drafts
      set spec = ${JSON.stringify(boundSpec)}::jsonb, editor_state = ${JSON.stringify(editorState)}::jsonb, revision = revision + 1, updated_at = now()
      where id = ${current.draft_id}
      returning id as draft_id, spec, editor_state, revision, updated_at
    `;
  });

  return jsonOk({ draft: rows[0] });
}
