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
    with updated as (
      update projects
      set name = coalesce(${nextName}, name),
          description = case when ${description !== undefined} then ${nextDescription} else description end,
          instructions = case when ${instructions !== undefined} then ${nextInstructions} else instructions end,
          updated_at = now()
      where id = ${projectId} and owner_user_id = ${user.id}
      returning id, owner_user_id, name, description, instructions, default_model_preset_id, created_at, updated_at
    )
    select
      p.id,
      p.name,
      p.description,
      p.instructions,
      p.default_model_preset_id,
      case
        when mp.id is null then null
        else json_build_object(
          'id', mp.id,
          'name', mp.name,
          'provider', mp.provider,
          'model', mp.model
        )
      end as default_model_preset,
      p.created_at,
      p.updated_at,
      count(c.id)::integer as conversation_count,
      max(c.updated_at) as last_conversation_at
    from updated p
    left join model_presets mp
      on mp.id = p.default_model_preset_id
      and (mp.owner_user_id is null or mp.owner_user_id = ${user.id})
    left join conversations c
      on c.project_id = p.id
      and c.owner_user_id = p.owner_user_id
      and c.archived_at is null
    group by p.id, p.name, p.description, p.instructions, p.default_model_preset_id, p.created_at, p.updated_at, mp.id, mp.name, mp.provider, mp.model
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
