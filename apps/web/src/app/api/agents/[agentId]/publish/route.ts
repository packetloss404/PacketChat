import { createHash } from "node:crypto";
import { authenticateRequest } from "@packetchat/auth";
import { getSql } from "@packetchat/db";
import { jsonError, jsonOk } from "../../../../../lib/http";

type RouteContext = { params: Promise<{ agentId: string }> };

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export async function POST(request: Request, context: RouteContext) {
  const user = await authenticateRequest(request.headers);
  if (!user) return jsonError("Unauthenticated", 401);

  const { agentId } = await context.params;
  const body = await request.json().catch(() => ({}));
  const changeSummary = typeof body?.changeSummary === "string" && body.changeSummary.trim().length > 0 ? body.changeSummary.trim() : null;

  const sql = getSql();
  const version = await sql.begin(async (tx) => {
    const draftRows = await tx<{ draft_id: string; spec: Record<string, unknown> }[]>`
      select d.id as draft_id, d.spec
      from agents a
      join agent_drafts d on d.id = a.current_draft_id
      where a.id = ${agentId} and a.owner_user_id = ${user.id}
      for update of a
    `;
    if (draftRows.length === 0) return null;

    const spec = draftRows[0]!.spec;
    const manifest = { spec };
    const contentHash = createHash("sha256").update(stableJson(manifest)).digest("hex");

    const versionRows = await tx<{ next_version: number }[]>`
      select coalesce(max(version_number), 0) + 1 as next_version
      from agent_versions
      where agent_id = ${agentId}
    `;
    const versions = await tx<{ id: string; version_number: number }[]>`
      insert into agent_versions (agent_id, owner_user_id, version_number, spec, manifest, content_hash, change_summary)
      values (${agentId}, ${user.id}, ${versionRows[0]!.next_version}, ${JSON.stringify(spec)}::jsonb, ${JSON.stringify(manifest)}::jsonb, ${contentHash}, ${changeSummary})
      returning id, version_number
    `;
    await tx`
      insert into agent_knowledge_bindings (agent_version_id, knowledge_base_id, binding_config, retrieval_override)
      select ${versions[0]!.id}, knowledge_base_id, binding_config, retrieval_override
      from agent_knowledge_bindings
      where agent_draft_id = ${draftRows[0]!.draft_id}
    `;
    await tx`
      update agents
      set published_version_id = ${versions[0]!.id}, status = 'active', updated_at = now()
      where id = ${agentId} and owner_user_id = ${user.id}
    `;
    return versions[0]!;
  });
  if (!version) return jsonError("Agent draft not found", 404);

  return jsonOk({ version }, { status: 201 });
}
