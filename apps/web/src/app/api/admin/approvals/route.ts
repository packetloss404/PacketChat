import { getSql } from "@packetchat/db";
import { requireAdminOrJson } from "../../../../lib/admin-auth";
import { jsonOk } from "../../../../lib/http";

export async function GET(request: Request) {
  const admin = await requireAdminOrJson(request.headers);
  if (admin instanceof Response) return admin;

  const sql = getSql();
  const approvals = await sql`
    select
      ars.id as step_id,
      ars.run_id,
      ar.agent_id,
      a.name as agent_name,
      coalesce(u.email, 'unknown user') as user_email,
      ars.sequence_no,
      ars.name,
      ars.input,
      ars.output,
      ars.started_at
    from agent_run_steps ars
    join agent_runs ar on ar.id = ars.run_id
    join agents a on a.id = ar.agent_id
    left join users u on u.id = ar.owner_user_id
    where ars.step_type = 'approval'
      and ars.status = 'running'
    order by ars.started_at asc
    limit 100
  `;

  return jsonOk({ approvals });
}
