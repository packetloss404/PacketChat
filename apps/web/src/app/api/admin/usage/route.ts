import { getSql } from "@packetchat/db";
import { requireAdminOrJson } from "../../../../lib/admin-auth";
import { jsonOk } from "../../../../lib/http";

export async function GET(request: Request) {
  const admin = await requireAdminOrJson(request.headers);
  if (admin instanceof Response) return admin;

  const sql = getSql();

  const summary = await sql`
    select
      date_trunc('day', ur.created_at)::date as usage_date,
      coalesce(ur.provider, 'unknown') as provider,
      coalesce(ur.model, 'unknown') as model,
      coalesce(u.email, 'unknown user') as user_email,
      count(*)::integer as request_count,
      coalesce(sum(ur.input_tokens), 0)::integer as input_tokens,
      coalesce(sum(ur.output_tokens), 0)::integer as output_tokens,
      coalesce(sum(ur.reasoning_tokens), 0)::integer as reasoning_tokens,
      coalesce(sum(ur.search_queries), 0)::integer as search_queries,
      coalesce(sum(ur.cost_usd), 0)::float8 as cost_usd,
      count(*) filter (where ur.cost_usd is null)::integer as unknown_cost_count,
      count(*) filter (where coalesce((ur.raw_usage->>'estimated')::boolean, false))::integer as estimated_count
    from usage_records ur
    left join users u on u.id = ur.owner_user_id
    group by usage_date, provider, model, user_email
    order by usage_date desc, cost_usd desc, request_count desc
    limit 250
  `;

  const recent = await sql`
    select
      ur.id,
      ur.created_at,
      coalesce(u.email, 'unknown user') as user_email,
      ur.provider,
      ur.model,
      ur.input_tokens,
      ur.output_tokens,
      ur.reasoning_tokens,
      ur.search_queries,
      ur.cost_usd::float8 as cost_usd,
      coalesce((ur.raw_usage->>'estimated')::boolean, false) as estimated,
      coalesce((ur.raw_usage->'pricing'->>'unknown')::boolean, false) as unknown_pricing,
      ur.conversation_run_id,
      ur.agent_run_id
    from usage_records ur
    left join users u on u.id = ur.owner_user_id
    order by ur.created_at desc
    limit 100
  `;

  return jsonOk({ summary, recent });
}
