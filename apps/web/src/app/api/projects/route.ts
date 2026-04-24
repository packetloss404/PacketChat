import { authenticateRequest } from "@packetchat/auth";
import { getSql } from "@packetchat/db";
import { jsonError, jsonOk } from "../../../lib/http";

export async function GET(request: Request) {
  const user = await authenticateRequest(request.headers);
  if (!user) return jsonError("Unauthenticated", 401);

  const sql = getSql();
  const projects = await sql`
    select id, name, description, instructions, default_model_preset_id, created_at, updated_at
    from projects
    where owner_user_id = ${user.id}
    order by updated_at desc, created_at desc
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
    returning id, name, description, instructions, default_model_preset_id, created_at, updated_at
  `;

  return jsonOk({ project: projects[0] }, { status: 201 });
}
