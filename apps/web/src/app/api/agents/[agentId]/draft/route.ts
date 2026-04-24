import { authenticateRequest } from "@packetchat/auth";
import { getSql } from "@packetchat/db";
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

function normalizeSpec(spec: Record<string, unknown>) {
  const tools = spec.tools && typeof spec.tools === "object" && !Array.isArray(spec.tools) ? spec.tools as Record<string, unknown> : {};
  const temperature = Number(spec.temperature);
  const maxOutputTokens = Number(spec.maxOutputTokens);
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
    knowledgeBaseIds: uuidList(spec.knowledgeBaseIds),
    knowledgeLimit: Number.isInteger(knowledgeLimit) ? Math.min(Math.max(knowledgeLimit, 1), 10) : 5,
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
    where a.id = ${agentId} and a.owner_user_id = ${user.id}
    limit 1
  `;
  if (rows.length === 0) return jsonError("Agent draft not found", 404);

  return jsonOk({ draft: rows[0] });
}

export async function PATCH(request: Request, context: RouteContext) {
  const user = await authenticateRequest(request.headers);
  if (!user) return jsonError("Unauthenticated", 401);

  const { agentId } = await context.params;
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") return jsonError("Invalid request body", 400);

  const sql = getSql();
  const existing = await sql<{ draft_id: string; spec: Record<string, unknown>; editor_state: Record<string, unknown> }[]>`
    select d.id as draft_id, d.spec, d.editor_state
    from agents a
    join agent_drafts d on d.id = a.current_draft_id
    where a.id = ${agentId} and a.owner_user_id = ${user.id}
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
    const knowledgeBaseIds = Array.isArray(specRecord.knowledgeBaseIds) ? specRecord.knowledgeBaseIds : [];
    const ownedKnowledgeBases = knowledgeBaseIds.length
      ? await tx<{ id: string }[]>`
          select id
          from knowledge_bases
          where owner_user_id = ${user.id}
            and id = any(${knowledgeBaseIds})
        `
      : [];
    const ownedKnowledgeBaseIds = ownedKnowledgeBases.map((kb) => kb.id);
    const boundSpec: Record<string, unknown> = { ...specRecord, knowledgeBaseIds: ownedKnowledgeBaseIds };

    await tx`
      update agents
      set name = ${name}, description = ${description}, updated_at = now()
      where id = ${agentId} and owner_user_id = ${user.id}
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
      where id = ${current.draft_id} and owner_user_id = ${user.id}
      returning id as draft_id, spec, editor_state, revision, updated_at
    `;
  });

  return jsonOk({ draft: rows[0] });
}
