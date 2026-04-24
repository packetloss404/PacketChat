import { authenticateRequest } from "@packetchat/auth";
import { getSql } from "@packetchat/db";
import { jsonError, jsonOk } from "../../../lib/http";

export async function GET(request: Request) {
  const user = await authenticateRequest(request.headers);
  if (!user) return jsonError("Unauthenticated", 401);

  const sql = getSql();
  const conversations = await sql`
    select id, project_id, title, mode, temporary, archived_at, created_at, updated_at
    from conversations
    where owner_user_id = ${user.id} and archived_at is null
    order by updated_at desc, created_at desc
  `;

  return jsonOk({ conversations });
}

export async function POST(request: Request) {
  const user = await authenticateRequest(request.headers);
  if (!user) return jsonError("Unauthenticated", 401);

  const body = await request.json().catch(() => null);
  const title = String(body?.title ?? "New chat").trim() || "New chat";
  const mode = body?.mode === "agent_test" ? "agent_test" : "chat";
  const temporary = Boolean(body?.temporary);

  const sql = getSql();
  const conversations = await sql`
    insert into conversations (owner_user_id, title, mode, temporary)
    values (${user.id}, ${title.slice(0, 160)}, ${mode}, ${temporary})
    returning id, project_id, title, mode, temporary, archived_at, created_at, updated_at
  `;

  return jsonOk({ conversation: conversations[0] }, { status: 201 });
}
