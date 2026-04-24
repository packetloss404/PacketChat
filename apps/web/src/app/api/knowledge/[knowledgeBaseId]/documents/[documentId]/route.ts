import { authenticateRequest } from "@packetchat/auth";
import { getSql } from "@packetchat/db";
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
  const rows = await sql`
    delete from knowledge_documents kd
    using knowledge_bases kb
    where kd.id = ${documentId}
      and kd.knowledge_base_id = ${knowledgeBaseId}
      and kd.knowledge_base_id = kb.id
      and kd.owner_user_id = ${user.id}
      and kb.owner_user_id = ${user.id}
    returning kd.id
  `;
  if (!rows[0]) return jsonError("Document not found", 404);

  return jsonOk({ deleted: true });
}
