import { authenticateRequest } from "@packetchat/auth";
import { getSql } from "@packetchat/db";
import { jsonError, jsonOk } from "../../../lib/http";

type ApprovalRow = {
  approval_id: string;
  run_id: string;
  agent_id: string;
  agent_name: string;
  requester_email: string | null;
  sequence_no: number;
  step_type: string;
  status: string;
  name: string | null;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  run_status: string;
  run_input: Record<string, unknown>;
  started_at: string;
  ended_at: string | null;
  created_at: string;
  can_decide?: boolean;
};

function approvalState(status: string, output: Record<string, unknown>) {
  const decision = typeof output.decision === "string" ? output.decision : null;
  if (status === "running") return "pending";
  if (decision === "approved" || status === "completed") return "approved";
  if (decision === "rejected" || status === "cancelled" || status === "failed") return "rejected";
  return "closed";
}

function mapApproval(row: ApprovalRow) {
  return {
    id: row.approval_id,
    runId: row.run_id,
    agentId: row.agent_id,
    agentName: row.agent_name,
    requesterEmail: row.requester_email,
    sequenceNo: row.sequence_no,
    status: row.status,
    state: approvalState(row.status, row.output ?? {}),
    name: row.name ?? "Approval required",
    input: row.input ?? {},
    output: row.output ?? {},
    runStatus: row.run_status,
    runInput: row.run_input ?? {},
    startedAt: row.started_at,
    endedAt: row.ended_at,
    createdAt: row.created_at,
    canDecide: Boolean(row.can_decide)
  };
}

function mapAction(row: ApprovalRow) {
  return {
    id: row.approval_id,
    runId: row.run_id,
    agentId: row.agent_id,
    agentName: row.agent_name,
    requesterEmail: row.requester_email,
    sequenceNo: row.sequence_no,
    stepType: row.step_type,
    status: row.status,
    name: row.name ?? row.step_type,
    input: row.input ?? {},
    output: row.output ?? {},
    runStatus: row.run_status,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    createdAt: row.created_at
  };
}

export async function GET(request: Request) {
  const user = await authenticateRequest(request.headers);
  if (!user) return jsonError("Unauthenticated", 401);

  const sql = getSql();
  const isAdmin = user.role === "admin";
  const approvals = await sql<ApprovalRow[]>`
    select
      ars.id as approval_id,
      ar.id as run_id,
      a.id as agent_id,
      a.name as agent_name,
      u.email as requester_email,
      ars.sequence_no,
      ars.step_type,
      ars.status,
      ars.name,
      ars.input,
      ars.output,
      ar.status as run_status,
      ar.input as run_input,
      ars.started_at,
      ars.ended_at,
      ar.created_at,
      (${isAdmin} or a.owner_user_id = ${user.id} or ap.role in ('editor', 'owner')) as can_decide
    from agent_run_steps ars
    join agent_runs ar on ar.id = ars.run_id
    join agents a on a.id = ar.agent_id
    left join users u on u.id = ar.owner_user_id
    left join agent_permissions ap on ap.agent_id = a.id and ap.subject_user_id = ${user.id}
    where ars.step_type = 'approval'
      and (
        ${isAdmin}
        or ar.owner_user_id = ${user.id}
        or a.owner_user_id = ${user.id}
        or ap.role in ('editor', 'owner')
      )
    order by
      case when ars.status = 'running' then 0 else 1 end,
      coalesce(ars.ended_at, ars.started_at) desc
    limit 100
  `;

  const recentActions = await sql<ApprovalRow[]>`
    select
      ars.id as approval_id,
      ar.id as run_id,
      a.id as agent_id,
      a.name as agent_name,
      u.email as requester_email,
      ars.sequence_no,
      ars.step_type,
      ars.status,
      ars.name,
      ars.input,
      ars.output,
      ar.status as run_status,
      ar.input as run_input,
      ars.started_at,
      ars.ended_at,
      ar.created_at
    from agent_run_steps ars
    join agent_runs ar on ar.id = ars.run_id
    join agents a on a.id = ar.agent_id
    left join users u on u.id = ar.owner_user_id
    left join agent_permissions ap on ap.agent_id = a.id and ap.subject_user_id = ${user.id}
    where ars.step_type in ('tool_call', 'tool_result')
      and (
        ${isAdmin}
        or ar.owner_user_id = ${user.id}
        or a.owner_user_id = ${user.id}
        or ap.role in ('editor', 'owner')
      )
    order by coalesce(ars.ended_at, ars.started_at) desc
    limit 100
  `;

  const approvalItems = approvals.map(mapApproval);
  return jsonOk({
    approvals: approvalItems,
    recentActions: recentActions.map(mapAction),
    stats: {
      pending: approvalItems.filter((item) => item.state === "pending").length,
      approvals: approvalItems.length,
      recentActions: recentActions.length
    }
  });
}
