import { authenticateRequest } from "@packetchat/auth";
import { getSql } from "@packetchat/db";
import { jsonError, jsonOk } from "../../../../lib/http";

type RouteContext = { params: Promise<{ promptId: string }> };

function parseVariables(value: unknown) {
  if (value === undefined) return undefined;
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

  const { promptId } = await context.params;
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") return jsonError("Invalid request body", 400);

  const name = optionalText(body.name);
  if (name === null) return jsonError("name cannot be empty", 400);
  const description = optionalText(body.description);
  const promptBody = optionalText(body.body);
  if (promptBody === null) return jsonError("body cannot be empty", 400);
  const variables = parseVariables(body.variables);
  if (variables === null) return jsonError("variables must be an array or comma-separated string", 400);
  const nextName = name ?? null;
  const nextDescription = description === undefined ? null : description;

  const sql = getSql();
  const prompt = await sql.begin(async (tx) => {
    const existing = await tx<{ id: string; body: string; variables: unknown }[]>`
      select id, body, variables
      from prompt_templates
      where id = ${promptId} and owner_user_id = ${user.id}
      limit 1
    `;
    if (!existing[0]) return null;

    const nextBody = promptBody ?? existing[0].body;
    const nextVariables = variables ?? existing[0].variables;
    const rows = await tx`
      update prompt_templates
      set name = coalesce(${nextName}, name),
          description = case when ${description !== undefined} then ${nextDescription} else description end,
          body = ${nextBody},
          variables = ${JSON.stringify(nextVariables)}::jsonb,
          updated_at = now()
      where id = ${promptId} and owner_user_id = ${user.id}
      returning id, name, description, body, variables, created_at, updated_at
    `;

    const bodyChanged = promptBody !== undefined && promptBody !== existing[0].body;
    const variablesChanged = variables !== undefined && JSON.stringify(variables) !== JSON.stringify(existing[0].variables);
    if (bodyChanged || variablesChanged) {
      const versions = await tx<{ next_version: number }[]>`
        select coalesce(max(version_number), 0) + 1 as next_version
        from prompt_versions
        where prompt_template_id = ${promptId}
      `;
      await tx`
        insert into prompt_versions (prompt_template_id, version_number, body, variables, change_summary)
        values (${promptId}, ${versions[0]!.next_version}, ${nextBody}, ${JSON.stringify(nextVariables)}::jsonb, 'Edited prompt')
      `;
    }

    const latest = await tx<{ latest_version_id: string | null; latest_version_number: number | null }[]>`
      select id as latest_version_id, version_number as latest_version_number
      from prompt_versions
      where prompt_template_id = ${promptId}
      order by version_number desc
      limit 1
    `;

    return { ...rows[0], latest_version_id: latest[0]?.latest_version_id ?? null, latest_version_number: latest[0]?.latest_version_number ?? null };
  });
  if (!prompt) return jsonError("Prompt not found", 404);

  return jsonOk({ prompt });
}

export async function DELETE(request: Request, context: RouteContext) {
  const user = await authenticateRequest(request.headers);
  if (!user) return jsonError("Unauthenticated", 401);

  const { promptId } = await context.params;
  const sql = getSql();
  const rows = await sql`
    delete from prompt_templates
    where id = ${promptId} and owner_user_id = ${user.id}
    returning id
  `;
  if (!rows[0]) return jsonError("Prompt not found", 404);

  return jsonOk({ deleted: true });
}
