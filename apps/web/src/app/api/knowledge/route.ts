import { authenticateRequest } from "@packetchat/auth";
import { getSql } from "@packetchat/db";
import { jsonError, jsonOk } from "../../../lib/http";

export async function GET(request: Request) {
  const user = await authenticateRequest(request.headers);
  if (!user) return jsonError("Unauthenticated", 401);

  const sql = getSql();
  const knowledgeBases = await sql`
    select
      kb.id,
      kb.name,
      kb.description,
      kb.status,
      kb.created_at,
      kb.updated_at,
      count(kd.id)::int as document_count
    from knowledge_bases kb
    left join knowledge_documents kd on kd.knowledge_base_id = kb.id
    where kb.owner_user_id = ${user.id}
    group by kb.id
    order by kb.created_at desc
  `;

  return jsonOk({ knowledgeBases });
}

export async function POST(request: Request) {
  const user = await authenticateRequest(request.headers);
  if (!user) return jsonError("Unauthenticated", 401);

  const body = await request.json().catch(() => null);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const description = typeof body?.description === "string" ? body.description.trim() : "";
  if (!name) return jsonError("name is required", 400);

  const sql = getSql();
  const rows = await sql<{ id: string }[]>`
    insert into knowledge_bases (owner_user_id, name, description)
    values (${user.id}, ${name}, ${description || null})
    returning id
  `;

  return jsonOk({ knowledgeBaseId: rows[0]!.id });
}
