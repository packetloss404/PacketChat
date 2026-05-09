import { authenticateRequest } from "@packetchat/auth";
import { getSql } from "@packetchat/db";
import { deleteObject } from "@packetchat/files";
import { jsonError, jsonOk } from "../../../../lib/http";

type RouteContext = { params: Promise<{ knowledgeBaseId: string }> };

function optionalText(value: unknown) {
  if (value === undefined) return undefined;
  if (value == null) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function PATCH(request: Request, context: RouteContext) {
  const user = await authenticateRequest(request.headers);
  if (!user) return jsonError("Unauthenticated", 401);

  const { knowledgeBaseId } = await context.params;
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") return jsonError("Invalid request body", 400);

  const name = optionalText(body.name);
  if (name === null) return jsonError("name cannot be empty", 400);
  const description = optionalText(body.description);
  const status = body.status === "active" || body.status === "archived" ? body.status : undefined;
  const archived = typeof body.archived === "boolean" ? (body.archived ? "archived" : "active") : undefined;
  const nextStatus = archived ?? status;
  const nextName = name ?? null;
  const nextDescription = description === undefined ? null : description;
  const statusValue = nextStatus ?? null;

  const sql = getSql();
  const rows = await sql`
    update knowledge_bases
    set name = coalesce(${nextName}, name),
        description = case when ${description !== undefined} then ${nextDescription} else description end,
        status = coalesce(${statusValue}, status),
        updated_at = now()
    where id = ${knowledgeBaseId} and owner_user_id = ${user.id}
    returning id, name, description, status, created_at, updated_at
  `;
  if (!rows[0]) return jsonError("Knowledge base not found", 404);

  return jsonOk({ knowledgeBase: rows[0] });
}

export async function DELETE(request: Request, context: RouteContext) {
  const user = await authenticateRequest(request.headers);
  if (!user) return jsonError("Unauthenticated", 401);

  const { knowledgeBaseId } = await context.params;
  const sql = getSql();
  const rows = await sql<{ id: string }[]>`
    select id
    from knowledge_bases
    where id = ${knowledgeBaseId} and owner_user_id = ${user.id}
    limit 1
  `;
  if (!rows[0]) return jsonError("Knowledge base not found", 404);

  const attachments = await sql<{ id: string; bucket: string; object_key: string }[]>`
    select distinct a.id, a.bucket, a.object_key
    from knowledge_documents kd
    join attachments a on a.id = kd.attachment_id and a.owner_user_id = kd.owner_user_id
    where kd.knowledge_base_id = ${knowledgeBaseId}
      and kd.owner_user_id = ${user.id}
      and not exists (
        select 1
        from knowledge_documents other_kd
        where other_kd.attachment_id = kd.attachment_id
          and other_kd.knowledge_base_id <> ${knowledgeBaseId}
      )
  `;

  try {
    await Promise.all(attachments.map((attachment) => deleteObject(attachment.bucket, attachment.object_key)));
  } catch (error) {
    return jsonError("Object storage delete failed", 502, {
      error: error instanceof Error ? error.message : String(error)
    });
  }

  await sql.begin(async (tx) => {
    await tx`
      delete from knowledge_bases
      where id = ${knowledgeBaseId} and owner_user_id = ${user.id}
    `;

    if (attachments.length > 0) {
      await tx`
        delete from attachments
        where owner_user_id = ${user.id}
          and id in ${tx(attachments.map((attachment) => attachment.id))}
      `;
    }
  });

  return jsonOk({ deleted: true });
}
