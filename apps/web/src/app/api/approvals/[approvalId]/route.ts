import { authenticateRequest } from "@packetchat/auth";
import { getSql, recordAuditEvent } from "@packetchat/db";
import {
  claimRunForExecution,
  createAgentRunDeps,
  executeRun,
  MAX_RUN_EXECUTION_MS,
  publicRunError,
  recordRunOutcome,
  textOrNull,
  type AgentSpec
} from "@packetchat/agent-runtime";
import { enqueueAgentRunJob } from "@packetchat/jobs";
import { jsonError, jsonOk, requestIp, userAgent } from "../../../../lib/http";
import { dispatchApprovedResume, finalizeRejectedRun } from "../../../../lib/agent-runtime/approval-resume";

type RouteContext = { params: Promise<{ approvalId: string }> };

type ApprovalDecision = "approved" | "rejected";

type ApprovalStepRow = {
  id: string;
  run_id: string;
  agent_id: string;
  agent_name: string;
  requester_user_id: string;
  agent_owner_user_id: string;
  conversation_id: string | null;
  user_message_id: string | null;
  approval_sequence_no: number;
  status: string;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  run_input: Record<string, unknown>;
  resolved_provider_account_id: string | null;
  resolved_model: string | null;
  spec: AgentSpec;
};

function decisionFromBody(value: unknown): ApprovalDecision | null {
  if (value === "approved" || value === "rejected") return value;
  if (value === "approve") return "approved";
  if (value === "reject") return "rejected";
  return null;
}

function noteFromBody(value: unknown) {
  return typeof value === "string" ? value.trim().slice(0, 1000) : "";
}

function inputTextFromRun(input: Record<string, unknown>) {
  const text = input.text;
  return typeof text === "string" ? text : "";
}

export async function PATCH(request: Request, context: RouteContext) {
  const user = await authenticateRequest(request.headers);
  if (!user) return jsonError("Unauthenticated", 401);

  const { approvalId } = await context.params;
  const body = await request.json().catch(() => null);
  const decision = decisionFromBody(body?.decision ?? body?.action);
  if (!decision) return jsonError("decision must be approved or rejected", 400);

  const note = noteFromBody(body?.note);
  const decidedAt = new Date().toISOString();
  const nextStatus = decision === "approved" ? "completed" : "cancelled";
  const sql = getSql();
  const isAdmin = user.role === "admin";

  const updated = await sql.begin(async (tx) => {
    const rows = await tx<ApprovalStepRow[]>`
      select
        ars.id,
        ars.run_id,
        ar.agent_id,
        a.name as agent_name,
        ar.owner_user_id as requester_user_id,
        a.owner_user_id as agent_owner_user_id,
        ar.conversation_id,
        ar.user_message_id,
        ars.sequence_no as approval_sequence_no,
        ars.status,
        ars.input,
        ars.output,
        ar.input as run_input,
        ar.resolved_provider_account_id,
        ar.resolved_model,
        v.spec
      from agent_run_steps ars
      join agent_runs ar on ar.id = ars.run_id
      join agents a on a.id = ar.agent_id
      join agent_versions v on v.id = ar.agent_version_id
      left join agent_permissions ap on ap.agent_id = a.id and ap.subject_user_id = ${user.id}
      where ars.id = ${approvalId}
        and ars.step_type = 'approval'
        and (
          ${isAdmin}
          or a.owner_user_id = ${user.id}
          or ap.role in ('editor', 'owner')
        )
      for update
    `;
    const approval = rows[0];
    if (!approval) return null;
    if (approval.status !== "running") return { conflict: true as const, approval };

    const decisionOutput = {
      decision,
      decidedByUserId: user.id,
      decidedAt,
      ...(note ? { note } : {})
    };

    const updatedRows = await tx<ApprovalStepRow[]>`
      update agent_run_steps
      set status = ${nextStatus},
          output = output || ${JSON.stringify(decisionOutput)}::jsonb,
          ended_at = now()
      where id = ${approvalId}
      returning id, run_id, status, input, output
    `;

    await tx`
      insert into agent_run_events (run_id, sequence_no, event_type, payload)
      select ${approval.run_id}, coalesce(max(sequence_no), 0) + 1, ${`approval.${decision}`}, ${JSON.stringify({ approvalId, decision, noteProvided: Boolean(note) })}::jsonb
      from agent_run_events
      where run_id = ${approval.run_id}
    `;

    // Approved runs go back to 'queued' so the queue worker can claim and resume
    // them (its claim only accepts queued/preparing). Rejected runs are terminal.
    await tx`
      update agent_runs
      set status = ${decision === "approved" ? "queued" : "cancelled"},
          ended_at = ${decision === "approved" ? null : new Date()}
      where id = ${approval.run_id}
    `;

    // The resume continues the run's (run_id, sequence_no) numbering, so it must
    // start after every step the paused run already wrote - including this
    // approval step.
    const sequenceRows = await tx<{ next_sequence_no: number }[]>`
      select coalesce(max(sequence_no), 0) + 1 as next_sequence_no
      from agent_run_steps
      where run_id = ${approval.run_id}
    `;

    return {
      conflict: false as const,
      nextSequenceNo: sequenceRows[0]?.next_sequence_no ?? 1,
      approval: { ...approval, ...updatedRows[0]!, status: nextStatus, output: { ...(approval.output ?? {}), ...decisionOutput } }
    };
  });

  if (!updated) return jsonError("Approval not found", 404);
  if (updated.conflict) return jsonError("Approval has already been resolved", 409);

  await recordAuditEvent({
    actorUserId: user.id,
    action: decision === "approved" ? "approval.approved" : "approval.rejected",
    targetType: "agent_run_step",
    targetId: approvalId,
    ipAddress: requestIp(request),
    userAgent: userAgent(request),
    metadata: {
      runId: updated.approval.run_id,
      agentId: updated.approval.agent_id,
      agentName: updated.approval.agent_name,
      requesterUserId: updated.approval.requester_user_id,
      decision,
      noteProvided: Boolean(note),
      noteLength: note.length
    }
  });

  const runtimeDeps = createAgentRunDeps();
  const approval = updated.approval;
  const version = { agent_id: approval.agent_id, agent_name: approval.agent_name };

  if (decision === "rejected") {
    await finalizeRejectedRun(
      {
        addRunEvent: runtimeDeps.addRunEvent,
        addMessageStep: async (input) => {
          await runtimeDeps.addRunStep({
            runId: input.runId,
            sequenceNo: updated.nextSequenceNo,
            stepType: "message",
            status: "completed",
            name: input.name,
            input: input.input,
            output: input.output
          });
        },
        record: (outcome) =>
          recordRunOutcome({
            conversationId: approval.conversation_id,
            runId: approval.run_id,
            userId: approval.requester_user_id,
            version,
            status: outcome.status,
            text: outcome.text,
            userMessageId: approval.user_message_id
          })
      },
      { runId: approval.run_id, approvalId, note }
    );
    return jsonOk({ approval });
  }

  // The recorded binding is authoritative when present; a run created before
  // 0006 falls back to the pinned version's spec, which is immutable and yields
  // the same values.
  const providerAccountId = approval.resolved_provider_account_id ?? textOrNull(approval.spec.providerAccountId);
  const model = approval.resolved_model ?? textOrNull(approval.spec.model);
  const inputText = inputTextFromRun(approval.run_input);
  const resume = {
    approvalSequenceNo: approval.approval_sequence_no,
    nextSequenceNo: updated.nextSequenceNo
  };

  const dispatch = await dispatchApprovedResume(
    {
      runId: approval.run_id,
      claim: () => claimRunForExecution(approval.run_id),
      execute: (signal) =>
        executeRun(runtimeDeps, {
          runId: approval.run_id,
          resourceOwnerUserId: approval.agent_owner_user_id,
          spec: { ...approval.spec, providerAccountId: providerAccountId ?? undefined, model: model ?? undefined },
          inputText,
          signal,
          resume
        }),
      record: (outcome) =>
        recordRunOutcome({
          conversationId: approval.conversation_id,
          runId: approval.run_id,
          userId: approval.requester_user_id,
          version,
          status: outcome.status,
          text: outcome.text,
          userMessageId: approval.user_message_id
        }),
      publicError: publicRunError,
      maxRunMs: MAX_RUN_EXECUTION_MS,
      enqueue: () =>
        enqueueAgentRunJob({
          runId: approval.run_id,
          agentId: approval.agent_id,
          resourceOwnerUserId: approval.agent_owner_user_id,
          userMessageId: approval.user_message_id
        })
    },
    { runId: approval.run_id }
  );

  return jsonOk({ approval, resume: dispatch });
}
