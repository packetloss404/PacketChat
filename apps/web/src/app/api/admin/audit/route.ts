import { getSql } from "@packetchat/db";
import { requireAdminOrJson } from "../../../../lib/admin-auth";
import { jsonOk } from "../../../../lib/http";

export async function GET(request: Request) {
  const admin = await requireAdminOrJson(request.headers);
  if (admin instanceof Response) return admin;

  const sql = getSql();
  const events = await sql`
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
    order by ae.created_at desc
    limit 250
  `;

  return jsonOk({ events });
}
