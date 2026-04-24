import { authenticateRequest } from "@packetchat/auth";
import { getSql } from "@packetchat/db";
import { jsonError, jsonOk } from "../../../lib/http";

function textOrNull(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function GET(request: Request) {
  const user = await authenticateRequest(request.headers);
  if (!user) return jsonError("Unauthenticated", 401);

  const sql = getSql();
  const agents = await sql`
    select id, name, description, status, current_draft_id, published_version_id, created_at, updated_at
    from agents
    where owner_user_id = ${user.id}
    order by updated_at desc
  `;

  return jsonOk({ agents });
}

export async function POST(request: Request) {
  const user = await authenticateRequest(request.headers);
  if (!user) return jsonError("Unauthenticated", 401);

  const body = await request.json().catch(() => null);
  const name = textOrNull(body?.name);
  if (!name) return jsonError("name is required", 400);

  const description = textOrNull(body?.description);
  const spec = {
    name,
    description: description ?? "",
    instructions: typeof body?.instructions === "string" ? body.instructions : "",
    temperature: 0.7,
    maxOutputTokens: 1024,
    knowledgeBaseIds: [],
    knowledgeLimit: 5,
    tools: {
      knowledgeSearch: false,
      calculator: false,
      urlFetch: false
    }
  };

  const sql = getSql();
  const rows = await sql.begin(async (tx) => {
    const agents = await tx<{ id: string }[]>`
      insert into agents (owner_user_id, name, description, status)
      values (${user.id}, ${name}, ${description}, 'draft')
      returning id
    `;
    const agentId = agents[0]!.id;
    const drafts = await tx<{ id: string }[]>`
      insert into agent_drafts (agent_id, owner_user_id, spec, editor_state)
      values (${agentId}, ${user.id}, ${JSON.stringify(spec)}::jsonb, ${JSON.stringify({})}::jsonb)
      returning id
    `;
    await tx`
      update agents
      set current_draft_id = ${drafts[0]!.id}, updated_at = now()
      where id = ${agentId}
    `;
    return [{ agentId, draftId: drafts[0]!.id }];
  });

  return jsonOk(rows[0]!, { status: 201 });
}
