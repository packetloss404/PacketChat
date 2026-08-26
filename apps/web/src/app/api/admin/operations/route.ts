import { getSql } from "@packetchat/db";
import { requireAdminOrJson } from "../../../../lib/admin-auth";
import { jsonOk } from "../../../../lib/http";

export async function GET(request: Request) {
  const admin = await requireAdminOrJson(request.headers);
  if (admin instanceof Response) return admin;

  const sql = getSql();
  const [providerAccounts, modelBindings, knowledge, agentRuns, jobFailures, recentProviderAudits] = await Promise.all([
    sql`
      select provider, status, count(*)::integer as count
      from provider_accounts
      group by provider, status
      order by provider asc, status asc
    `,
    sql`
      select pa.provider, mab.enabled, count(*)::integer as count
      from model_account_bindings mab
      join provider_accounts pa on pa.id = mab.provider_account_id
      group by pa.provider, mab.enabled
      order by pa.provider asc, mab.enabled desc
    `,
    sql`
      select ingest_status, count(*)::integer as count
      from knowledge_documents
      group by ingest_status
      order by ingest_status asc
    `,
    sql`
      select status, count(*)::integer as count
      from agent_runs
      where created_at >= now() - interval '7 days'
      group by status
      order by status asc
    `,
    sql`
      select id, queue_name, job_name, job_id, error_message, created_at
      from job_failures
      order by created_at desc
      limit 25
    `,
    sql`
      select
        ae.id,
        ae.actor_user_id,
        u.email as actor_email,
        ae.action,
        ae.outcome,
        ae.target_type,
        ae.target_id,
        ae.ip_address,
        ae.user_agent,
        ae.metadata,
        ae.created_at
      from audit_events ae
      left join users u on u.id = ae.actor_user_id
      where ae.action like 'provider.%'
      order by ae.created_at desc
      limit 25
    `
  ]);

  return jsonOk({ providerAccounts, modelBindings, knowledge, agentRuns, jobFailures, recentProviderAudits });
}
