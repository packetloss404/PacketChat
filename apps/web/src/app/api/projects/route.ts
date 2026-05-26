import { authenticateRequest } from "@packetchat/auth";
import { getSql } from "@packetchat/db";
import { jsonError, jsonOk } from "../../../lib/http";

export async function GET(request: Request) {
  const user = await authenticateRequest(request.headers);
  if (!user) return jsonError("Unauthenticated", 401);

  const sql = getSql();
  const projects = await sql`
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
    from projects p
    left join model_presets mp
      on mp.id = p.default_model_preset_id
      and (mp.owner_user_id is null or mp.owner_user_id = ${user.id})
    left join conversations c
      on c.project_id = p.id
      and c.owner_user_id = p.owner_user_id
      and c.archived_at is null
    where p.owner_user_id = ${user.id}
    group by p.id, p.name, p.description, p.instructions, p.default_model_preset_id, p.created_at, p.updated_at, mp.id, mp.name, mp.provider, mp.model
    order by p.updated_at desc, p.created_at desc
  `;

  return jsonOk({ projects });
}

export async function POST(request: Request) {
  const user = await authenticateRequest(request.headers);
  if (!user) return jsonError("Unauthenticated", 401);

  const body = await request.json().catch(() => null);
  const name = String(body?.name ?? "").trim();
  if (!name) return jsonError("name is required", 400);

  const description = body?.description ? String(body.description).trim() : null;
  const instructions = body?.instructions ? String(body.instructions).trim() : null;

  const sql = getSql();
  const projects = await sql`
    insert into projects (owner_user_id, name, description, instructions)
    values (${user.id}, ${name}, ${description}, ${instructions})
    returning id, name, description, instructions, default_model_preset_id, null::json as default_model_preset, created_at, updated_at, 0::integer as conversation_count, null::timestamptz as last_conversation_at
  `;

  return jsonOk({ project: projects[0] }, { status: 201 });
}
