import { authenticateRequest } from "@packetchat/auth";
import { getSql } from "@packetchat/db";
import { deleteObject } from "@packetchat/files";
import { jsonError, jsonOk } from "../../../../../../lib/http";

type RouteContext = { params: Promise<{ knowledgeBaseId: string; documentId: string }> };

export async function PATCH(request: Request, context: RouteContext) {
  const user = await authenticateRequest(request.headers);
  if (!user) return jsonError("Unauthenticated", 401);

  const { knowledgeBaseId, documentId } = await context.params;
  const body = await request.json().catch(() => null);
  const title = typeof body?.title === "string" ? body.title.trim() : "";
  if (!title) return jsonError("title is required", 400);

  const sql = getSql();
  const rows = await sql`
    update knowledge_documents kd
    set title = ${title}, updated_at = now()
    from knowledge_bases kb
    where kd.id = ${documentId}
      and kd.knowledge_base_id = ${knowledgeBaseId}
      and kd.knowledge_base_id = kb.id
      and kd.owner_user_id = ${user.id}
      and kb.owner_user_id = ${user.id}
    returning kd.id, kd.knowledge_base_id, kd.attachment_id, kd.title, kd.mime_type, kd.ingest_status, kd.source_metadata, kd.created_at, kd.updated_at
  `;
  if (!rows[0]) return jsonError("Document not found", 404);

  return jsonOk({ document: rows[0] });
}

export async function DELETE(request: Request, context: RouteContext) {
  const user = await authenticateRequest(request.headers);
  if (!user) return jsonError("Unauthenticated", 401);

  const { knowledgeBaseId, documentId } = await context.params;
  const sql = getSql();
  const rows = await sql<{ id: string; attachment_id: string | null; bucket: string | null; object_key: string | null; delete_attachment: boolean }[]>`
    select
      kd.id,
      kd.attachment_id,
      a.bucket,
      a.object_key,
      not exists (
        select 1
        from knowledge_documents other_kd
        where other_kd.attachment_id = kd.attachment_id
          and other_kd.id <> kd.id
      ) as delete_attachment
    from knowledge_documents kd
    join knowledge_bases kb on kb.id = kd.knowledge_base_id
    left join attachments a on a.id = kd.attachment_id and a.owner_user_id = kd.owner_user_id
    where kd.id = ${documentId}
      and kd.knowledge_base_id = ${knowledgeBaseId}
      and kd.owner_user_id = ${user.id}
      and kb.owner_user_id = ${user.id}
    limit 1
  `;
  if (!rows[0]) return jsonError("Document not found", 404);

  const document = rows[0];
  if (document.delete_attachment && document.bucket && document.object_key) {
    try {
      await deleteObject(document.bucket, document.object_key);
    } catch (error) {
      return jsonError("Object storage delete failed", 502, {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  await sql.begin(async (tx) => {
    await tx`
      delete from knowledge_documents
      where id = ${document.id}
        and owner_user_id = ${user.id}
    `;

    if (document.delete_attachment && document.attachment_id) {
      await tx`
        delete from attachments
        where id = ${document.attachment_id}
          and owner_user_id = ${user.id}
      `;
    }
  });

  return jsonOk({ deleted: true });
}
