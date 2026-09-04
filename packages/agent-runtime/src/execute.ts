import { logger } from "@packetchat/observability";
import type { NormalizedChatRequest, NormalizedUsage } from "@packetchat/contracts";
import {
  artifactInstructions,
  externalActionApprovalInput,
  isBlockedHost,
  parseCalculation,
  publicRunError,
  renderTemplate,
  runFailureStatus,
  textOrNull,
  throwIfAborted,
  timeoutSignal
} from "./helpers";
import type { AgentRunDeps, AgentSpec, ExecuteRunInput, RunExecutionResult } from "./types";

// The outbound-network subset of the ports. Exported helpers take only this so
// they stay callable without a database.
type NetworkDeps = Pick<AgentRunDeps, "fetch" | "resolveHost">;

export async function fetchUrlContext(deps: NetworkDeps, inputText: string, signal?: AbortSignal) {
  const matches = inputText.match(/https?:\/\/[^\s)\]}>,"']+/gi) ?? [];
  const urls = [...new Set(matches)].slice(0, 3);
  const results = [];
  for (const raw of urls) {
    throwIfAborted(signal);
    const url = new URL(raw);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || await isBlockedHost(url.hostname, deps.resolveHost)) continue;
    const timeout = timeoutSignal(5000, signal);
    try {
      const response = await deps.fetch(url, { signal: timeout.signal, redirect: "manual" });
      const contentType = response.headers.get("content-type") ?? "";
      if (!response.ok || !/text|json|html|xml/i.test(contentType)) continue;
      const text = (await response.text()).slice(0, 64_000).replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 3000);
      results.push({ url: url.toString(), status: response.status, contentType, text });
    } catch {
      throwIfAborted(signal);
      results.push({ url: url.toString(), error: "fetch_failed" });
    } finally {
      timeout.clear();
    }
  }
  return results;
}

export async function executeOpenApiActions(deps: NetworkDeps, input: { inputText: string; actions: NonNullable<AgentSpec["openApiActions"]>; maxActions: number; signal?: AbortSignal }) {
  const results = [];
  for (const action of input.actions.filter((item) => item.enabled !== false).slice(0, input.maxActions)) {
    throwIfAborted(input.signal);
    const method = (action.method || "GET").toUpperCase();
    const rawUrl = action.url?.trim();
    if (!rawUrl || !["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) continue;
    let url: URL;
    try {
      url = new URL(renderTemplate(rawUrl, { input: input.inputText, inputEncoded: encodeURIComponent(input.inputText) }));
    } catch {
      results.push({ name: action.name ?? action.id ?? "OpenAPI action", error: "invalid_url" });
      continue;
    }
    if (url.protocol !== "https:" || await isBlockedHost(url.hostname, deps.resolveHost)) {
      results.push({ name: action.name ?? action.id ?? url.toString(), error: "blocked_url" });
      continue;
    }

    const timeout = timeoutSignal(8000, input.signal);
    try {
      const headers = { ...(action.headers ?? {}) };
      const bodyText = method === "GET" ? undefined : renderTemplate(action.bodyTemplate, { input: input.inputText });
      if (bodyText && !Object.keys(headers).some((key) => key.toLowerCase() === "content-type")) headers["content-type"] = "application/json";
      const response = await deps.fetch(url, {
        method,
        headers,
        body: bodyText || undefined,
        redirect: "manual",
        signal: timeout.signal
      });
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
      throwIfAborted(input.signal);
      results.push({ name: action.name ?? action.id ?? url.toString(), method, url: url.toString(), error: "request_failed" });
    } finally {
      timeout.clear();
    }
  }
  return results;
}

async function runChildAgent(deps: AgentRunDeps, input: { parentRunId: string; resourceOwnerUserId: string; childAgentId: string; inputText: string; signal?: AbortSignal }) {
  throwIfAborted(input.signal);
  const child = await deps.loadChildAgent({ agentId: input.childAgentId, ownerUserId: input.resourceOwnerUserId });
  if (!child) return null;
  const providerAccountId = textOrNull(child.spec.providerAccountId);
  const model = textOrNull(child.spec.model);
  if (!providerAccountId || !model) return { agentId: input.childAgentId, name: child.name, error: "missing_provider_or_model" };
  const account = await deps.loadProviderAccount(providerAccountId);
  if (!account) return { agentId: input.childAgentId, name: child.name, error: "provider_account_unavailable" };
  if (child.spec.provider && account.provider !== child.spec.provider) return { agentId: input.childAgentId, name: child.name, error: "provider_mismatch" };
  const modelBinding = await deps.loadModelBinding({
    accountId: providerAccountId,
    provider: account.provider,
    model
  });
  if (!modelBinding) return { agentId: input.childAgentId, name: child.name, error: "model_disabled_or_unavailable" };

  let outputText = "";
  let providerUsage: NormalizedUsage | null = null;
  const messages = [];
  const instructions = textOrNull(child.spec.instructions);
  if (instructions) messages.push({ role: "system" as const, content: [{ type: "text" as const, text: instructions }] });
  messages.push({ role: "user" as const, content: [{ type: "text" as const, text: input.inputText }] });
  const chatRequest: NormalizedChatRequest = {
    provider: account.provider,
    model,
    messages,
    stream: true,
    temperature: typeof child.spec.temperature === "number" ? child.spec.temperature : undefined,
    maxOutputTokens: Math.min(Number(child.spec.maxOutputTokens) || 800, 4000)
  };
  for await (const event of deps.streamChat(account, chatRequest, { signal: input.signal })) {
    if (event.type === "text_delta") outputText += event.text;
    if (event.type === "message_end") providerUsage = event.usage ?? null;
    if (event.type === "error") return { agentId: input.childAgentId, name: child.name, error: event.error.message };
  }
  await deps.recordUsage({
    ownerUserId: input.resourceOwnerUserId,
    providerAccountId,
    agentRunId: input.parentRunId,
    provider: account.provider,
    model,
    request: chatRequest,
    outputText,
    providerUsage,
    metadata: { scope: "child_agent", childAgentId: input.childAgentId, childAgentName: child.name }
  }).catch((error) => {
    logger.warn("Failed to record child agent usage", { runId: input.parentRunId, childAgentId: input.childAgentId, error: error instanceof Error ? error.message : String(error) });
  });
  return { agentId: input.childAgentId, name: child.name, outputText: outputText.slice(0, 6000) };
}

// Hard cap on a single run, shared by every caller that owns a run without a
// client waiting on it: the web route's in-process fallback and the queue
// worker. A wedged provider call must not leave a run "running" forever, and the
// single-run GET reconciles anything that outlives this by a margin.
export const MAX_RUN_EXECUTION_MS = 15 * 60 * 1000;

export async function executeRun(deps: AgentRunDeps, input: ExecuteRunInput): Promise<RunExecutionResult> {
  await deps.markRunRunning(input.runId);
  await deps.addRunEvent(input.runId, "run.started", {});

  let nextStep = 1;
  let stepId: string | null = null;

  try {
    throwIfAborted(input.signal);
    const contextBlocks: string[] = [];
    const maxAgentSteps = Math.min(Math.max(Number(input.spec.maxAgentSteps) || 4, 1), 25);
    let remainingToolSteps = maxAgentSteps;
    const externalApprovalInput = externalActionApprovalInput(input.spec, input.inputText);
    if (externalApprovalInput) {
      const approvalId = await deps.addRunStep({
        runId: input.runId,
        sequenceNo: nextStep++,
        stepType: "approval",
        status: "running",
        name: "Approve external actions",
        input: externalApprovalInput,
        output: { state: "pending" }
      });
      await deps.markRunWaitingInput(input.runId);
      await deps.addRunEvent(input.runId, "approval.required", { approvalId, ...externalApprovalInput });
      return {
        status: "waiting_input",
        approvalId,
        outputText: "Waiting for approval before external actions run."
      };
    }

    const chain = input.spec.agentChain;
    if (chain?.enabled && chain.agentIds?.length && remainingToolSteps > 0) {
      const maxChildRuns = Math.min(Math.max(Number(chain.maxChildRuns) || 3, 1), 5, remainingToolSteps);
      const childResults = [];
      for (const childAgentId of chain.agentIds.slice(0, maxChildRuns)) {
        const child = await runChildAgent(deps, { parentRunId: input.runId, resourceOwnerUserId: input.resourceOwnerUserId, childAgentId, inputText: input.inputText, signal: input.signal });
        if (child) childResults.push(child);
      }
      remainingToolSteps -= maxChildRuns;
      if (childResults.length > 0) {
        await deps.addRunStep({ runId: input.runId, sequenceNo: nextStep++, stepType: "tool_result", status: "completed", name: "Agent context", input: { agentIds: chain.agentIds.slice(0, maxChildRuns) }, output: { childResults } });
        await deps.addRunEvent(input.runId, "tool.agent_chain.completed", { childResults });
        contextBlocks.push(`Agent context results:\n${childResults.map((result) => `${result.name}: ${"outputText" in result ? result.outputText : `Error: ${result.error}`}`).join("\n\n")}`);
      }
    }

    if (input.spec.openApiActions?.length && remainingToolSteps > 0) {
      const actionResults = await executeOpenApiActions(deps, { inputText: input.inputText, actions: input.spec.openApiActions, maxActions: Math.min(5, remainingToolSteps), signal: input.signal });
      remainingToolSteps -= actionResults.length;
      if (actionResults.length > 0) {
        await deps.addRunStep({ runId: input.runId, sequenceNo: nextStep++, stepType: "tool_result", status: "completed", name: "OpenAPI actions", input: { count: actionResults.length }, output: { actionResults } });
        await deps.addRunEvent(input.runId, "tool.openapi_actions.completed", { actionResults });
        contextBlocks.push(`OpenAPI action results:\n${actionResults.map((result) => `${result.name}: ${JSON.stringify(result).slice(0, 6000)}`).join("\n\n")}`);
      }
    }

    const fileContext = input.spec.fileContext;
    if (fileContext?.enabled && fileContext.knowledgeBaseIds?.length) {
      const block = await deps.fileContextBlock({
        userId: input.resourceOwnerUserId,
        knowledgeBaseIds: fileContext.knowledgeBaseIds,
        maxChars: Math.min(Math.max(Number(fileContext.maxChars) || 12000, 1000), 50000)
      });
      if (block) {
        await deps.addRunStep({ runId: input.runId, sequenceNo: nextStep++, stepType: "retrieval", status: "completed", name: "File context", input: { knowledgeBaseIds: fileContext.knowledgeBaseIds }, output: { chars: block.length } });
        await deps.addRunEvent(input.runId, "tool.file_context.completed", { chars: block.length, knowledgeBaseIds: fileContext.knowledgeBaseIds });
        contextBlocks.push(block);
      }
    }

    if (input.spec.tools?.knowledgeSearch && input.spec.knowledgeBaseIds?.length) {
      const limit = Math.min(Math.max(Number(input.spec.knowledgeLimit) || 5, 1), 10);
      const results = await deps.searchKnowledgeContext({ userId: input.resourceOwnerUserId, runId: input.runId, query: input.inputText, knowledgeBaseIds: input.spec.knowledgeBaseIds, limit });
      await deps.addRunStep({ runId: input.runId, sequenceNo: nextStep++, stepType: "retrieval", status: "completed", name: "Knowledge search", input: { query: input.inputText, knowledgeBaseIds: input.spec.knowledgeBaseIds, limit }, output: { results } });
      await deps.addRunEvent(input.runId, "tool.knowledge_search.completed", { resultCount: results.length, results });
      if (results.length > 0) {
        contextBlocks.push(`Knowledge search results:\n${results.map((result, index) => `${index + 1}. [${result.citation}] ${result.snippet}`).join("\n")}`);
      }
    }

    if (input.spec.tools?.calculator) {
      const calculation = parseCalculation(input.inputText);
      if (calculation) {
        await deps.addRunStep({ runId: input.runId, sequenceNo: nextStep++, stepType: "tool_result", status: "completed", name: "Calculator", input: { expression: calculation.expression }, output: { result: calculation.result } });
        await deps.addRunEvent(input.runId, "tool.calculator.completed", calculation);
        contextBlocks.push(`Calculator result: ${calculation.expression} = ${calculation.result}`);
      }
    }

    if (input.spec.tools?.urlFetch) {
      const fetched = await fetchUrlContext(deps, input.inputText, input.signal);
      if (fetched.length > 0) {
        await deps.addRunStep({ runId: input.runId, sequenceNo: nextStep++, stepType: "tool_result", status: "completed", name: "URL fetch", input: { inputText: input.inputText }, output: { fetched } });
        await deps.addRunEvent(input.runId, "tool.url_fetch.completed", { fetched });
        contextBlocks.push(`Fetched URL context:\n${fetched.map((item) => "text" in item ? `URL: ${item.url}\n${item.text}` : `URL: ${item.url}\nFetch failed`).join("\n\n")}`);
      }
    }

    stepId = await deps.addRunStep({ runId: input.runId, sequenceNo: nextStep++, stepType: "llm", status: "running", name: "Model response", input: { inputText: input.inputText, contextBlockCount: contextBlocks.length } });

    const account = await deps.loadProviderAccount(input.spec.providerAccountId!);
    if (!account) throw new Error("Provider account not found or is not available to this user.");
    if (input.spec.provider && account.provider !== input.spec.provider) throw new Error("Agent provider does not match the selected provider account.");
    const modelBinding = await deps.loadModelBinding({
      accountId: input.spec.providerAccountId!,
      provider: account.provider,
      model: input.spec.model!
    });
    if (!modelBinding) throw new Error("Agent model is disabled or no longer available for the selected provider account.");

    let outputText = "";
    let providerUsage: NormalizedUsage | null = null;
    let textDeltaCount = 0;
    let textDeltaChars = 0;
    let textDeltaSummaryFlushed = false;

    const flushTextDeltaSummary = async () => {
      if (textDeltaSummaryFlushed || textDeltaCount === 0) return;
      textDeltaSummaryFlushed = true;
      await deps.addRunEvent(input.runId, "provider.text_delta.summary", {
        deltaCount: textDeltaCount,
        chars: textDeltaChars,
        preview: outputText.slice(0, 500)
      });
    };

    const messages = [];
    const instructions = textOrNull(input.spec.instructions);
    if (instructions) messages.push({ role: "system" as const, content: [{ type: "text" as const, text: instructions }] });
    const artifacts = artifactInstructions(input.spec);
    if (artifacts) messages.push({ role: "system" as const, content: [{ type: "text" as const, text: artifacts }] });
    if (contextBlocks.length > 0) messages.push({ role: "user" as const, content: [{ type: "text" as const, text: `Use this pre-run context when relevant. Cite knowledge snippets by citation when used.\n\n${contextBlocks.join("\n\n")}` }] });
    messages.push({ role: "user" as const, content: [{ type: "text" as const, text: input.inputText }] });
    await deps.addRunEvent(input.runId, "model.messages.prepared", { messageCount: messages.length, hasContext: contextBlocks.length > 0 });

    const chatRequest: NormalizedChatRequest = {
      provider: account.provider,
      model: input.spec.model!,
      messages,
      stream: true,
      temperature: typeof input.spec.temperature === "number" ? input.spec.temperature : undefined,
      maxOutputTokens: Number.isInteger(input.spec.maxOutputTokens) ? input.spec.maxOutputTokens : undefined
    };

    for await (const event of deps.streamChat(account, chatRequest, { signal: input.signal })) {
      if (event.type === "text_delta") {
        outputText += event.text;
        textDeltaCount += 1;
        textDeltaChars += event.text.length;
        continue;
      }

      if (event.type === "message_end") {
        providerUsage = event.usage ?? null;
        await flushTextDeltaSummary();
      }

      if (event.type === "error") {
        await flushTextDeltaSummary();
        await deps.addRunEvent(input.runId, `provider.${event.type}`, event as unknown as Record<string, unknown>);
        throw new Error(event.error.message);
      }

      await deps.addRunEvent(input.runId, `provider.${event.type}`, event as unknown as Record<string, unknown>);
    }
    await flushTextDeltaSummary();

    await deps.completeStep(stepId, { text: outputText });
    await deps.markRunCompleted(input.runId);
    await deps.recordUsage({
      ownerUserId: input.resourceOwnerUserId,
      providerAccountId: input.spec.providerAccountId!,
      agentRunId: input.runId,
      provider: account.provider,
      model: input.spec.model!,
      request: chatRequest,
      outputText,
      providerUsage
    }).catch((error) => {
      logger.warn("Failed to record agent usage", { runId: input.runId, error: error instanceof Error ? error.message : String(error) });
    });
    await deps.addRunEvent(input.runId, "run.completed", { outputText });
    return { status: "completed", outputText };
  } catch (error) {
    const message = publicRunError(error);
    const status = runFailureStatus(message);
    logger.warn("Agent run failed", { runId: input.runId, error: error instanceof Error ? error.message : String(error) });
    await deps.failStep(stepId, message);
    await deps.markRunFailed({
      runId: input.runId,
      status,
      errorCode: status === "failed" ? "agent_run_failed" : `agent_run_${status}`,
      message
    });
    await deps.addRunEvent(input.runId, "run.failed", { message });
    throw new Error(message);
  }
}
