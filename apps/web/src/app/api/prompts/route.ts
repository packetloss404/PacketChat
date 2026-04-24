import { authenticateRequest } from "@packetchat/auth";
import { getSql } from "@packetchat/db";
import { jsonError, jsonOk } from "../../../lib/http";

function parseVariables(value: unknown) {
  if (value == null || value === "") return [];
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") {
    return value
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
  }
  return null;
}

export async function GET(request: Request) {
  const user = await authenticateRequest(request.headers);
  if (!user) return jsonError("Unauthenticated", 401);

  const sql = getSql();
  const prompts = await sql`
    select
      pt.id,
      pt.name,
      pt.description,
      pt.body,
      pt.variables,
      pt.created_at,
      pt.updated_at,
      pv.id as latest_version_id,
      pv.version_number as latest_version_number
    from prompt_templates pt
    left join lateral (
      select id, version_number
      from prompt_versions
      where prompt_template_id = pt.id
      order by version_number desc
      limit 1
    ) pv on true
    where pt.owner_user_id = ${user.id}
    order by pt.updated_at desc, pt.created_at desc
  `;

  return jsonOk({ prompts });
}

export async function POST(request: Request) {
  const user = await authenticateRequest(request.headers);
  if (!user) return jsonError("Unauthenticated", 401);

  const body = await request.json().catch(() => null);
  const name = String(body?.name ?? "").trim();
  const promptBody = String(body?.body ?? "").trim();
  if (!name) return jsonError("name is required", 400);
  if (!promptBody) return jsonError("body is required", 400);

  const variables = parseVariables(body?.variables);
  if (!variables) return jsonError("variables must be an array or comma-separated string", 400);

  const description = body?.description ? String(body.description).trim() : null;
  const sql = getSql();
  const prompt = await sql.begin(async (tx) => {
    const templates = await tx`
      insert into prompt_templates (owner_user_id, name, description, body, variables)
      values (${user.id}, ${name}, ${description}, ${promptBody}, ${JSON.stringify(variables)}::jsonb)
      returning id, name, description, body, variables, created_at, updated_at
    `;

    const versions = await tx`
      insert into prompt_versions (prompt_template_id, version_number, body, variables, change_summary)
      values (${templates[0]!.id}, 1, ${promptBody}, ${JSON.stringify(variables)}::jsonb, 'Initial version')
      returning id, version_number
    `;

    return { ...templates[0], latest_version_id: versions[0]!.id, latest_version_number: versions[0]!.version_number };
  });

  return jsonOk({ prompt }, { status: 201 });
}
