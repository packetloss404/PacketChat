import { randomUUID } from "node:crypto";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { authenticateRequest } from "@packetchat/auth";
import { getConfig } from "@packetchat/config";
import { getSql } from "@packetchat/db";
import { getS3Client } from "@packetchat/files";
import { enqueueFileIngestionJob } from "@packetchat/jobs";
import { jsonError, jsonOk } from "../../../../lib/http";
import { fileUploadRateLimit } from "../../../../lib/rate-limit";

function safeFileName(name: string) {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 180) || "upload";
}

export async function POST(request: Request) {
  const user = await authenticateRequest(request.headers);
  if (!user) return jsonError("Unauthenticated", 401);
  const rateLimited = await fileUploadRateLimit(request, user.id);
  if (rateLimited) return rateLimited;

  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  const knowledgeBaseId = form?.get("knowledgeBaseId");
  if (!(file instanceof File)) return jsonError("file is required", 400);
  if (typeof knowledgeBaseId !== "string" || !knowledgeBaseId) return jsonError("knowledgeBaseId is required", 400);

  const config = getConfig();
  if (file.size > config.MAX_UPLOAD_BYTES) return jsonError("File is too large", 413);

  const sql = getSql();
  const knowledgeBases = await sql<{ id: string }[]>`
    select id
    from knowledge_bases
    where id = ${knowledgeBaseId}
      and owner_user_id = ${user.id}
      and status = 'active'
    limit 1
  `;
  if (!knowledgeBases[0]) return jsonError("Knowledge base not found", 404);

  const fileName = safeFileName(file.name);
  const objectKey = `${user.id}/${randomUUID()}-${fileName}`;
  const bytes = Buffer.from(await file.arrayBuffer());

  await getS3Client().send(new PutObjectCommand({
    Bucket: config.S3_BUCKET_UPLOADS,
    Key: objectKey,
    Body: bytes,
    ContentType: file.type || "application/octet-stream",
    Metadata: {
      ownerUserId: user.id,
      knowledgeBaseId
    }
  }));

  const rows = await sql.begin(async (tx) => {
    const attachments = await tx<{ id: string }[]>`
      insert into attachments (owner_user_id, bucket, object_key, file_name, mime_type, size_bytes, status, metadata)
      values (
        ${user.id},
        ${config.S3_BUCKET_UPLOADS},
        ${objectKey},
        ${file.name || fileName},
        ${file.type || null},
        ${file.size},
        'uploaded',
        ${JSON.stringify({ purpose: "knowledge_upload", knowledgeBaseId })}::jsonb
      )
      returning id
    `;

    const documents = await tx<{ id: string }[]>`
      insert into knowledge_documents (knowledge_base_id, owner_user_id, attachment_id, title, mime_type, ingest_status, source_metadata)
      values (
        ${knowledgeBaseId},
        ${user.id},
        ${attachments[0]!.id},
        ${file.name || fileName},
        ${file.type || null},
        'queued',
        ${JSON.stringify({ bucket: config.S3_BUCKET_UPLOADS, objectKey })}::jsonb
      )
      returning id
    `;

    return { attachmentId: attachments[0]!.id, documentId: documents[0]!.id };
  });

  await enqueueFileIngestionJob({
    documentId: rows.documentId,
    knowledgeBaseId,
    ownerUserId: user.id,
    attachmentId: rows.attachmentId
  });

  return jsonOk(rows);
}
