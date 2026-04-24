import { authenticateRequest } from "@packetchat/auth";
import { getSql } from "@packetchat/db";
import { jsonError, jsonOk } from "../../../../../lib/http";

export async function GET(request: Request, { params }: { params: Promise<{ knowledgeBaseId: string }> }) {
  const user = await authenticateRequest(request.headers);
  if (!user) return jsonError("Unauthenticated", 401);

  const { knowledgeBaseId } = await params;
  const sql = getSql();
  const knowledgeBases = await sql<{ id: string }[]>`
    select id
    from knowledge_bases
    where id = ${knowledgeBaseId}
      and owner_user_id = ${user.id}
    limit 1
  `;
  if (!knowledgeBases[0]) return jsonError("Knowledge base not found", 404);

  const documents = await sql`
    select
      kd.id,
      kd.knowledge_base_id,
      kd.attachment_id,
      kd.title,
      kd.mime_type,
      kd.ingest_status,
      kd.source_metadata,
      kd.created_at,
      kd.updated_at,
      a.file_name,
      a.size_bytes,
      a.bucket,
      a.object_key
    from knowledge_documents kd
    left join attachments a on a.id = kd.attachment_id
    where kd.knowledge_base_id = ${knowledgeBaseId}
      and kd.owner_user_id = ${user.id}
    order by kd.created_at desc
  `;

  return jsonOk({ documents });
}
