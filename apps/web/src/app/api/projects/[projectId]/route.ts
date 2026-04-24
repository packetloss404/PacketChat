import { authenticateRequest } from "@packetchat/auth";
import { getSql } from "@packetchat/db";
import { jsonError, jsonOk } from "../../../../lib/http";

type RouteContext = { params: Promise<{ projectId: string }> };

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

  const { projectId } = await context.params;
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") return jsonError("Invalid request body", 400);

  const name = optionalText(body.name);
  if (name === null) return jsonError("name cannot be empty", 400);
  const description = optionalText(body.description);
  const instructions = optionalText(body.instructions);
  const nextName = name ?? null;
  const nextDescription = description === undefined ? null : description;
  const nextInstructions = instructions === undefined ? null : instructions;

  const sql = getSql();
  const rows = await sql`
    update projects
    set name = coalesce(${nextName}, name),
        description = case when ${description !== undefined} then ${nextDescription} else description end,
        instructions = case when ${instructions !== undefined} then ${nextInstructions} else instructions end,
        updated_at = now()
    where id = ${projectId} and owner_user_id = ${user.id}
    returning id, name, description, instructions, default_model_preset_id, created_at, updated_at
  `;
  if (!rows[0]) return jsonError("Project not found", 404);

  return jsonOk({ project: rows[0] });
}

export async function DELETE(request: Request, context: RouteContext) {
  const user = await authenticateRequest(request.headers);
  if (!user) return jsonError("Unauthenticated", 401);

  const { projectId } = await context.params;
  const sql = getSql();
  const rows = await sql`
    delete from projects
    where id = ${projectId} and owner_user_id = ${user.id}
    returning id
  `;
  if (!rows[0]) return jsonError("Project not found", 404);

  return jsonOk({ deleted: true });
}
