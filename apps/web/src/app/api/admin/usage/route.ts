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
      (ur.cost_usd is null or coalesce((ur.raw_usage->'pricing'->>'unknown')::boolean, false)) as unknown_pricing,
      ur.conversation_run_id,
      ur.agent_run_id
    from usage_records ur
    left join users u on u.id = ur.owner_user_id
    order by ur.created_at desc
    limit 100
  `;

  const governanceTotals = await sql<{
    requests: number;
    cost_usd: number;
    unknown_cost_count: number;
    estimated_count: number;
    active_users: number;
    elapsed_month_days: number;
  }[]>`
    select
      count(*)::integer as requests,
      coalesce(sum(cost_usd), 0)::float8 as cost_usd,
      count(*) filter (where cost_usd is null)::integer as unknown_cost_count,
      count(*) filter (where coalesce((raw_usage->>'estimated')::boolean, false))::integer as estimated_count,
      count(distinct owner_user_id)::integer as active_users,
      greatest(1, extract(day from now())::integer) as elapsed_month_days
    from usage_records
    where created_at >= date_trunc('month', now())
  `;

  const byUser = await sql`
    select
      coalesce(u.email, 'unknown user') as user_email,
      count(*)::integer as request_count,
      coalesce(sum(ur.cost_usd), 0)::float8 as cost_usd,
      count(*) filter (where ur.cost_usd is null)::integer as unknown_cost_count
    from usage_records ur
    left join users u on u.id = ur.owner_user_id
    where ur.created_at >= date_trunc('month', now())
    group by user_email
    order by cost_usd desc, request_count desc
    limit 25
  `;

  const byProvider = await sql`
    select
      coalesce(provider, 'unknown') as provider,
      count(*)::integer as request_count,
      coalesce(sum(cost_usd), 0)::float8 as cost_usd,
      count(*) filter (where cost_usd is null)::integer as unknown_cost_count
    from usage_records
    where created_at >= date_trunc('month', now())
    group by provider
    order by cost_usd desc, request_count desc
  `;

  const totals = governanceTotals[0] ?? {
    requests: 0,
    cost_usd: 0,
    unknown_cost_count: 0,
    estimated_count: 0,
    active_users: 0,
    elapsed_month_days: 1
  };
  const dayOfMonth = Math.max(1, Number(totals.elapsed_month_days) || 1);
  const projectedMonthCostUsd = (Number(totals.cost_usd) / dayOfMonth) * 30;
  const recommendations = [
    totals.unknown_cost_count > 0 ? `${totals.unknown_cost_count} records have unknown pricing; add catalog pricing before using this report for chargeback.` : null,
    totals.estimated_count > 0 ? `${totals.estimated_count} records used estimated tokens; compare with provider billing before month-end close.` : null,
    projectedMonthCostUsd > Number(totals.cost_usd) * 1.5 && Number(totals.cost_usd) > 0 ? `Current run rate projects ${projectedMonthCostUsd.toFixed(2)} USD for the month.` : null
  ].filter((item): item is string => Boolean(item));

  return jsonOk({
    summary,
    recent,
    governance: {
      totals: {
        requests: Number(totals.requests),
        costUsd: Number(totals.cost_usd),
        unknownCostCount: Number(totals.unknown_cost_count),
        estimatedCount: Number(totals.estimated_count),
        activeUsers: Number(totals.active_users),
        projectedMonthCostUsd
      },
      byUser,
      byProvider,
      recommendations
    }
  });
}
