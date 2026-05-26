import { authenticateRequest } from "@packetchat/auth";
import { getSql, recordAuditEvent } from "@packetchat/db";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { jsonError, jsonOk, requestIp, userAgent } from "../../../../lib/http";

type RouteContext = { params: Promise<{ approvalId: string }> };

type ApprovalDecision = "approved" | "rejected";

type AgentSpec = {
  openApiActions?: Array<{
    id?: string;
    name?: string;
    method?: string;
    url?: string;
    headers?: Record<string, string>;
    bodyTemplate?: string;
    enabled?: boolean;
  }>;
  tools?: {
    urlFetch?: boolean;
  };
};

type ApprovalStepRow = {
  id: string;
  run_id: string;
  agent_id: string;
  agent_name: string;
  requester_user_id: string;
  status: string;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  run_input: Record<string, unknown>;
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

function renderTemplate(template: string | undefined, values: Record<string, string>) {
  if (!template) return "";
  return Object.entries(values).reduce((next, [key, value]) => next.replaceAll(`{{${key}}}`, value), template);
}

function timeoutSignal(timeoutMs: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timeout === "object" && "unref" in timeout && typeof timeout.unref === "function") timeout.unref();
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timeout)
  };
}

function isBlockedAddress(address: string) {
  if (address.startsWith("127.") || address.startsWith("0.") || address.startsWith("10.") || address.startsWith("169.254.") || address.startsWith("192.168.")) return true;
  const ipv4Private = address.match(/^172\.(\d+)\./);
  if (ipv4Private && Number(ipv4Private[1]) >= 16 && Number(ipv4Private[1]) <= 31) return true;
  const normalized = address.toLowerCase();
  return normalized === "::1" || normalized === "::" || normalized.startsWith("fe80:") || normalized.startsWith("fc") || normalized.startsWith("fd");
}

async function isBlockedHost(hostname: string) {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.)/.test(host)) return true;
  const match = host.match(/^172\.(\d+)\./);
  if (match && Number(match[1]) >= 16 && Number(match[1]) <= 31) return true;
  if (isIP(host)) return isBlockedAddress(host);
  const records = await lookup(host, { all: true, verbatim: true }).catch(() => []);
  if (records.length === 0) return true;
  return records.some((record) => isBlockedAddress(record.address));
}

async function addRunEvent(runId: string, eventType: string, payload: Record<string, unknown>) {
  const sql = getSql();
  await sql`
    insert into agent_run_events (run_id, sequence_no, event_type, payload)
    select ${runId}, coalesce(max(sequence_no), 0) + 1, ${eventType}, ${JSON.stringify(payload)}::jsonb
    from agent_run_events
    where run_id = ${runId}
  `;
}

async function addCompletedStep(runId: string, stepType: "tool_result" | "message", name: string, input: Record<string, unknown>, output: Record<string, unknown>) {
  const sql = getSql();
  await sql`
    insert into agent_run_steps (run_id, sequence_no, step_type, status, name, input, output, ended_at)
    select ${runId}, coalesce(max(sequence_no), 0) + 1, ${stepType}, 'completed', ${name}, ${JSON.stringify(input)}::jsonb, ${JSON.stringify(output)}::jsonb, now()
    from agent_run_steps
    where run_id = ${runId}
  `;
}

async function executeOpenApiActions(inputText: string, actions: NonNullable<AgentSpec["openApiActions"]>) {
  const results = [];
  for (const action of actions.filter((item) => item.enabled !== false).slice(0, 5)) {
    const method = (action.method || "GET").toUpperCase();
    const rawUrl = action.url?.trim();
    if (!rawUrl || !["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) continue;
    let url: URL;
    try {
      url = new URL(renderTemplate(rawUrl, { input: inputText, inputEncoded: encodeURIComponent(inputText) }));
    } catch {
      results.push({ name: action.name ?? action.id ?? "OpenAPI action", error: "invalid_url" });
      continue;
    }
    if (url.protocol !== "https:" || await isBlockedHost(url.hostname)) {
      results.push({ name: action.name ?? action.id ?? url.toString(), error: "blocked_url" });
      continue;
    }

    const timeout = timeoutSignal(8000);
    try {
      const headers = { ...(action.headers ?? {}) };
      const bodyText = method === "GET" ? undefined : renderTemplate(action.bodyTemplate, { input: inputText });
      if (bodyText && !Object.keys(headers).some((key) => key.toLowerCase() === "content-type")) headers["content-type"] = "application/json";
      const response = await fetch(url, { method, headers, body: bodyText || undefined, redirect: "manual", signal: timeout.signal });
      const contentType = response.headers.get("content-type") ?? "";
      const text = (await response.text()).slice(0, 32_000);
      results.push({
        name: action.name ?? action.id ?? url.toString(),
        method,
        url: url.toString(),
        status: response.status,
        contentType,
        body: /json|text|html|xml/i.test(contentType) ? text.slice(0, 6000) : `[${contentType || "binary"} response omitted]`
      });
    } catch {
      results.push({ name: action.name ?? action.id ?? url.toString(), method, url: url.toString(), error: "request_failed" });
    } finally {
      timeout.clear();
    }
  }
  return results;
}

async function fetchUrlContext(inputText: string) {
  const matches = inputText.match(/https?:\/\/[^\s)\]}>,"']+/gi) ?? [];
  const urls = [...new Set(matches)].slice(0, 3);
  const results = [];
  for (const raw of urls) {
    const url = new URL(raw);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || await isBlockedHost(url.hostname)) continue;
    const timeout = timeoutSignal(5000);
    try {
      const response = await fetch(url, { signal: timeout.signal, redirect: "manual" });
      const contentType = response.headers.get("content-type") ?? "";
      if (!response.ok || !/text|json|html|xml/i.test(contentType)) continue;
      const text = (await response.text()).slice(0, 64_000).replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 3000);
      results.push({ url: url.toString(), status: response.status, contentType, text });
    } catch {
      results.push({ url: url.toString(), error: "fetch_failed" });
    } finally {
      timeout.clear();
    }
  }
  return results;
}

async function completeApprovedExternalActions(approval: ApprovalStepRow) {
  const sql = getSql();
  const inputText = inputTextFromRun(approval.run_input);
  const actionResults = approval.spec.openApiActions?.length ? await executeOpenApiActions(inputText, approval.spec.openApiActions) : [];
  if (actionResults.length > 0) {
    await addCompletedStep(approval.run_id, "tool_result", "Approved OpenAPI actions", { approvalId: approval.id, count: actionResults.length }, { actionResults });
    await addRunEvent(approval.run_id, "tool.openapi_actions.completed", { approvalId: approval.id, actionResults });
  }

  const fetched = approval.spec.tools?.urlFetch ? await fetchUrlContext(inputText) : [];
  if (fetched.length > 0) {
    await addCompletedStep(approval.run_id, "tool_result", "Approved URL fetch", { approvalId: approval.id, inputText }, { fetched });
    await addRunEvent(approval.run_id, "tool.url_fetch.completed", { approvalId: approval.id, fetched });
  }

  await addCompletedStep(approval.run_id, "message", "Approval completion", { approvalId: approval.id }, {
    text: actionResults.length > 0 || fetched.length > 0
      ? "Approved external actions completed. Inspect tool steps for captured results."
      : "Approval recorded. No external actions were available to execute."
  });
  await sql`
    update agent_runs
    set status = 'completed', ended_at = now()
    where id = ${approval.run_id}
  `;
  await addRunEvent(approval.run_id, "run.completed", { approvalId: approval.id, approvedExternalActions: actionResults.length, approvedUrlFetches: fetched.length });
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
        ars.status,
        ars.input,
        ars.output,
        ar.input as run_input,
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

    await tx`
      update agent_runs
      set status = ${decision === "approved" ? "running" : "cancelled"},
          ended_at = ${decision === "approved" ? null : new Date()}
      where id = ${approval.run_id}
    `;

    return {
      conflict: false as const,
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

  if (decision === "approved") {
    await completeApprovedExternalActions(updated.approval);
  } else {
    await addRunEvent(updated.approval.run_id, "run.cancelled", { approvalId, decision });
  }

  return jsonOk({ approval: updated.approval });
}
