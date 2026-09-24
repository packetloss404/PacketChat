import { authenticateRequest } from "@packetchat/auth";
import { normalizeConversationSearch } from "@packetchat/contracts";
import { getSql } from "@packetchat/db";
import { jsonError, jsonOk } from "../../../lib/http";

export async function GET(request: Request) {
  const user = await authenticateRequest(request.headers);
  if (!user) return jsonError("Unauthenticated", 401);

  const url = new URL(request.url);
  const { hasSearch, pattern } = normalizeConversationSearch(url.searchParams.get("search"));

  const sql = getSql();
  const conversations = await sql`
    select c.id, c.project_id, c.title, c.mode, c.temporary, c.archived_at, c.active_leaf_message_id, c.created_at, c.updated_at
    from conversations c
    where c.owner_user_id = ${user.id}
      and c.archived_at is null
      and (
        ${hasSearch} = false
        or c.title ilike ${pattern}
        or exists (
          select 1 from messages m
          where m.conversation_id = c.id and m.content::text ilike ${pattern}
        )
      )
    order by c.updated_at desc, c.created_at desc
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
    returning id, project_id, title, mode, temporary, archived_at, active_leaf_message_id, created_at, updated_at
  `;

  return jsonOk({ conversation: conversations[0] }, { status: 201 });
}
