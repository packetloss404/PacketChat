import { authenticateRequest } from "@packetchat/auth";
import { getSql } from "@packetchat/db";
import { logger } from "@packetchat/observability";
import { getProviderAdapter } from "@packetchat/providers";
import type { NormalizedChatRequest, NormalizedUsage, ProviderId } from "@packetchat/contracts";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { jsonError, jsonOk } from "../../../../../lib/http";
import { getAgentAccess } from "../../../../../lib/agent-access";
import { getProviderAccountForRuntime } from "../../../../../lib/providers";
import { agentRateLimit } from "../../../../../lib/rate-limit";
import { recordUsage } from "../../../../../lib/usage";

type RouteContext = { params: Promise<{ agentId: string }> };

type AgentSpec = {
  name?: string;
  instructions?: string;
  provider?: ProviderId;
  providerAccountId?: string;
  model?: string;
  temperature?: number;
  maxOutputTokens?: number;
  maxContextTokens?: number;
  maxAgentSteps?: number;
  knowledgeBaseIds?: string[];
  knowledgeLimit?: number;
  fileContext?: {
    enabled?: boolean;
    knowledgeBaseIds?: string[];
    maxChars?: number;
  };
  artifacts?: {
    enabled?: boolean;
    customPromptMode?: boolean;
    instructions?: string;
  };
  openApiActions?: Array<{
    id?: string;
    name?: string;
    method?: string;
    url?: string;
    headers?: Record<string, string>;
    bodyTemplate?: string;
    enabled?: boolean;
  }>;
  agentChain?: {
    enabled?: boolean;
    agentIds?: string[];
    maxChildRuns?: number;
  };
  tools?: {
    knowledgeSearch?: boolean;
    calculator?: boolean;
    urlFetch?: boolean;
  };
};

type KnowledgeResult = {
  knowledgeBaseId: string;
  knowledgeBaseName: string;
  documentId: string;
  chunkId: string;
  chunkIndex: number;
  title: string;
  score: number;
  snippet: string;
  citation: string;
};

function textOrNull(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
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

function termsFor(text: string) {
  return text.toLowerCase().match(/[a-z0-9_]{2,}/g) ?? [];
}

function snippetFor(content: string, terms: string[]) {
  const lower = content.toLowerCase();
  const firstHit = terms.reduce((best, term) => {
    const index = lower.indexOf(term);
    return index >= 0 && index < best ? index : best;
  }, Number.POSITIVE_INFINITY);
  const start = Number.isFinite(firstHit) ? Math.max(0, firstHit - 140) : 0;
  const snippet = content.slice(start, start + 360).trim();
  return `${start > 0 ? "..." : ""}${snippet}${start + 360 < content.length ? "..." : ""}`;
}

async function addRunStep(input: {
  runId: string;
  sequenceNo: number;
  stepType: "system" | "llm" | "tool_call" | "tool_result" | "retrieval" | "approval" | "message";
  status: "running" | "completed" | "failed" | "cancelled";
  name: string;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
}) {
  const sql = getSql();
  const rows = await sql<{ id: string }[]>`
    insert into agent_run_steps (run_id, sequence_no, step_type, status, name, input, output, ended_at)
    values (
      ${input.runId},
      ${input.sequenceNo},
      ${input.stepType},
      ${input.status},
      ${input.name},
      ${JSON.stringify(input.input ?? {})}::jsonb,
      ${JSON.stringify(input.output ?? {})}::jsonb,
      ${input.status === "running" ? null : new Date()}
    )
    returning id
  `;
  return rows[0]!.id;
}

async function searchKnowledgeContext(input: { userId: string; runId: string; query: string; knowledgeBaseIds: string[]; limit: number }) {
  const terms = [...new Set(termsFor(input.query))];
  if (terms.length === 0 || input.knowledgeBaseIds.length === 0) return [];

  const sql = getSql();
  const rows = await sql<{
    knowledge_base_id: string;
    knowledge_base_name: string;
    chunk_id: string;
    document_id: string;
    chunk_index: number;
    content: string;
    title: string;
  }[]>`
    select
      kb.id as knowledge_base_id,
      kb.name as knowledge_base_name,
      kc.id as chunk_id,
      kc.document_id,
      kc.chunk_index,
      kc.content,
      kd.title
    from knowledge_chunks kc
    join knowledge_documents kd on kd.id = kc.document_id
    join knowledge_bases kb on kb.id = kd.knowledge_base_id
    where kd.knowledge_base_id = any(${input.knowledgeBaseIds})
      and kb.owner_user_id = ${input.userId}
      and kb.status = 'active'
      and kd.owner_user_id = ${input.userId}
      and kd.ingest_status = 'ready'
    order by kd.created_at desc, kc.chunk_index asc
    limit 2000
  `;

  const results = rows
    .map((chunk) => {
      const content = chunk.content.toLowerCase();
      const title = chunk.title.toLowerCase();
      let score = 0;
      for (const term of terms) {
        score += content.split(term).length - 1;
        score += (title.split(term).length - 1) * 3;
      }
      return { chunk, score };
    })
    .filter((result) => result.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, input.limit)
    .map<KnowledgeResult>(({ chunk, score }) => ({
      knowledgeBaseId: chunk.knowledge_base_id,
      knowledgeBaseName: chunk.knowledge_base_name,
      documentId: chunk.document_id,
      chunkId: chunk.chunk_id,
      chunkIndex: chunk.chunk_index,
      title: chunk.title,
      score,
      snippet: snippetFor(chunk.content, terms),
      citation: `${chunk.title}#chunk-${chunk.chunk_index}`
    }));

  await sql`
    insert into retrieval_runs (owner_user_id, knowledge_base_id, query, results)
    select ${input.userId}, kb_id, ${input.query}, ${JSON.stringify(results)}::jsonb
    from unnest(${input.knowledgeBaseIds}::uuid[]) as kb_id
  `;

  return results;
}

async function fileContextBlock(input: { userId: string; knowledgeBaseIds: string[]; maxChars: number }) {
  if (input.knowledgeBaseIds.length === 0 || input.maxChars <= 0) return "";
  const sql = getSql();
  const rows = await sql<{ title: string; chunk_index: number; content: string }[]>`
    select kd.title, kc.chunk_index, kc.content
    from knowledge_chunks kc
    join knowledge_documents kd on kd.id = kc.document_id
    join knowledge_bases kb on kb.id = kd.knowledge_base_id
    where kd.knowledge_base_id = any(${input.knowledgeBaseIds})
      and kb.owner_user_id = ${input.userId}
      and kb.status = 'active'
      and kd.owner_user_id = ${input.userId}
      and kd.ingest_status = 'ready'
    order by kd.created_at desc, kc.chunk_index asc
    limit 200
  `;
  let used = 0;
  const excerpts = [];
  for (const row of rows) {
    if (used >= input.maxChars) break;
    const excerpt = `[${row.title}#chunk-${row.chunk_index}]\n${row.content.trim()}`;
    const remaining = input.maxChars - used;
    const clipped = excerpt.slice(0, remaining);
    excerpts.push(clipped);
    used += clipped.length;
  }
  return excerpts.length > 0 ? `Persistent file context:\n${excerpts.join("\n\n")}` : "";
}

function artifactInstructions(spec: AgentSpec) {
  if (!spec.artifacts?.enabled) return "";
  if (spec.artifacts.customPromptMode) return textOrNull(spec.artifacts.instructions) ?? "";
  const custom = textOrNull(spec.artifacts.instructions);
  return [
    "When creating content that should be displayed as an artifact, use this exact wrapper:",
    ":::artifact{identifier=\"unique-identifier\" type=\"mime-type\" title=\"Artifact Title\"}",
    "```",
    "artifact content",
    "```",
    ":::",
    "Allowed types: text/html, application/vnd.mermaid, application/vnd.react, image/svg+xml.",
    custom ? `Additional artifact guidance:\n${custom}` : ""
  ].filter(Boolean).join("\n");
}

function parseCalculation(input: string) {
  const trimmed = input.trim().replace(/^calculate\s+/i, "").replace(/^what is\s+/i, "").replace(/\?$/, "").trim();
  if (!/^[\d\s+\-*/().]+$/.test(trimmed) || !/\d/.test(trimmed)) return null;
  let index = 0;
  const peek = () => trimmed[index];
  const skip = () => { while (trimmed[index] === " ") index += 1; };
  const number = (): number => {
    skip();
    let value = "";
    while (/[\d.]/.test(peek() ?? "")) value += trimmed[index++];
    if (!value || value.split(".").length > 2) throw new Error("Invalid number");
    return Number(value);
  };
  const factor = (): number => {
    skip();
    if (peek() === "-") {
      index += 1;
      return -factor();
    }
    if (peek() === "(") {
      index += 1;
      const value = expression();
      skip();
      if (peek() !== ")") throw new Error("Missing closing parenthesis");
      index += 1;
      return value;
    }
    return number();
  };
  const term = (): number => {
    let value = factor();
    while (true) {
      skip();
      if (peek() === "*") {
        index += 1;
        value *= factor();
      } else if (peek() === "/") {
        index += 1;
        const divisor = factor();
        if (divisor === 0) throw new Error("Division by zero");
        value /= divisor;
      } else {
        return value;
      }
    }
  };
  function expression(): number {
    let value = term();
    while (true) {
      skip();
      if (peek() === "+") {
        index += 1;
        value += term();
      } else if (peek() === "-") {
        index += 1;
        value -= term();
      } else {
        return value;
      }
    }
  }

  try {
    const value = expression();
    skip();
    if (index !== trimmed.length || !Number.isFinite(value)) return null;
    return { expression: trimmed, result: value };
  } catch {
    return null;
  }
}

function publicRunError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (/provider account|agent provider|missing provider|missing model/i.test(message)) return message;
  return "Agent run failed. Check server logs or provider account settings for details.";
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

async function fetchUrlContext(inputText: string) {
  const matches = inputText.match(/https?:\/\/[^\s)\]}>,"']+/gi) ?? [];
  const urls = [...new Set(matches)].slice(0, 3);
  const results = [];
  for (const raw of urls) {
    const url = new URL(raw);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || await isBlockedHost(url.hostname)) continue;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(url, { signal: controller.signal, redirect: "manual" });
      const contentType = response.headers.get("content-type") ?? "";
      if (!response.ok || !/text|json|html|xml/i.test(contentType)) continue;
      const text = (await response.text()).slice(0, 64_000).replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 3000);
      results.push({ url: url.toString(), status: response.status, contentType, text });
    } catch {
      results.push({ url: url.toString(), error: "fetch_failed" });
    } finally {
      clearTimeout(timeout);
    }
  }
  return results;
}

function renderTemplate(template: string | undefined, values: Record<string, string>) {
  if (!template) return "";
  return Object.entries(values).reduce((next, [key, value]) => next.replaceAll(`{{${key}}}`, value), template);
}

async function executeOpenApiActions(input: { inputText: string; actions: NonNullable<AgentSpec["openApiActions"]>; maxActions: number }) {
  const results = [];
  for (const action of input.actions.filter((item) => item.enabled !== false).slice(0, input.maxActions)) {
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
    if (url.protocol !== "https:" || await isBlockedHost(url.hostname)) {
      results.push({ name: action.name ?? action.id ?? url.toString(), error: "blocked_url" });
      continue;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const headers = { ...(action.headers ?? {}) };
      const bodyText = method === "GET" ? undefined : renderTemplate(action.bodyTemplate, { input: input.inputText });
      if (bodyText && !Object.keys(headers).some((key) => key.toLowerCase() === "content-type")) headers["content-type"] = "application/json";
      const response = await fetch(url, {
        method,
        headers,
        body: bodyText || undefined,
        redirect: "manual",
        signal: controller.signal
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
      results.push({ name: action.name ?? action.id ?? url.toString(), method, url: url.toString(), error: "request_failed" });
    } finally {
      clearTimeout(timeout);
    }
  }
  return results;
}

async function runChildAgent(input: { userId: string; resourceOwnerUserId: string; childAgentId: string; inputText: string }) {
  const sql = getSql();
  const rows = await sql<{ name: string; spec: AgentSpec }[]>`
    select a.name, v.spec
    from agents a
    join agent_versions v on v.id = a.published_version_id
    where a.id = ${input.childAgentId}
      and a.owner_user_id = ${input.resourceOwnerUserId}
    limit 1
  `;
  const child = rows[0];
  if (!child) return null;
  const providerAccountId = textOrNull(child.spec.providerAccountId);
  const model = textOrNull(child.spec.model);
  if (!providerAccountId || !model) return { agentId: input.childAgentId, name: child.name, error: "missing_provider_or_model" };
  const account = await getProviderAccountForRuntime(providerAccountId, input.resourceOwnerUserId);
  if (!account) return { agentId: input.childAgentId, name: child.name, error: "provider_account_unavailable" };

  const adapter = getProviderAdapter(account.provider);
  let outputText = "";
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
  for await (const event of adapter.streamChat(account, chatRequest)) {
    if (event.type === "text_delta") outputText += event.text;
    if (event.type === "error") return { agentId: input.childAgentId, name: child.name, error: event.error.message };
  }
  return { agentId: input.childAgentId, name: child.name, outputText: outputText.slice(0, 6000) };
}

async function executeRun(input: {
  runId: string;
  userId: string;
  resourceOwnerUserId: string;
  spec: AgentSpec;
  inputText: string;
}) {
  const sql = getSql();
  await sql`
    update agent_runs
    set status = 'running', started_at = now()
    where id = ${input.runId}
  `;
  await addRunEvent(input.runId, "run.started", {});

  let nextStep = 1;
  let stepId: string | null = null;

  try {
    const contextBlocks: string[] = [];
    const maxAgentSteps = Math.min(Math.max(Number(input.spec.maxAgentSteps) || 4, 1), 25);
    let remainingToolSteps = maxAgentSteps;
    const chain = input.spec.agentChain;
    if (chain?.enabled && chain.agentIds?.length && remainingToolSteps > 0) {
      const maxChildRuns = Math.min(Math.max(Number(chain.maxChildRuns) || 3, 1), 5, remainingToolSteps);
      const childResults = [];
      for (const childAgentId of chain.agentIds.slice(0, maxChildRuns)) {
        const child = await runChildAgent({ userId: input.userId, resourceOwnerUserId: input.resourceOwnerUserId, childAgentId, inputText: input.inputText });
        if (child) childResults.push(child);
      }
      remainingToolSteps -= maxChildRuns;
      if (childResults.length > 0) {
        await addRunStep({ runId: input.runId, sequenceNo: nextStep++, stepType: "tool_result", status: "completed", name: "Agent chain", input: { agentIds: chain.agentIds.slice(0, maxChildRuns) }, output: { childResults } });
        await addRunEvent(input.runId, "tool.agent_chain.completed", { childResults });
        contextBlocks.push(`Agent chain results:\n${childResults.map((result) => `${result.name}: ${"outputText" in result ? result.outputText : `Error: ${result.error}`}`).join("\n\n")}`);
      }
    }

    if (input.spec.openApiActions?.length && remainingToolSteps > 0) {
      const actionResults = await executeOpenApiActions({ inputText: input.inputText, actions: input.spec.openApiActions, maxActions: Math.min(5, remainingToolSteps) });
      remainingToolSteps -= actionResults.length;
      if (actionResults.length > 0) {
        await addRunStep({ runId: input.runId, sequenceNo: nextStep++, stepType: "tool_result", status: "completed", name: "OpenAPI actions", input: { count: actionResults.length }, output: { actionResults } });
        await addRunEvent(input.runId, "tool.openapi_actions.completed", { actionResults });
        contextBlocks.push(`OpenAPI action results:\n${actionResults.map((result) => `${result.name}: ${JSON.stringify(result).slice(0, 6000)}`).join("\n\n")}`);
      }
    }

    const fileContext = input.spec.fileContext;
    if (fileContext?.enabled && fileContext.knowledgeBaseIds?.length) {
      const block = await fileContextBlock({
        userId: input.resourceOwnerUserId,
        knowledgeBaseIds: fileContext.knowledgeBaseIds,
        maxChars: Math.min(Math.max(Number(fileContext.maxChars) || 12000, 1000), 50000)
      });
      if (block) {
        await addRunStep({ runId: input.runId, sequenceNo: nextStep++, stepType: "retrieval", status: "completed", name: "File context", input: { knowledgeBaseIds: fileContext.knowledgeBaseIds }, output: { chars: block.length } });
        await addRunEvent(input.runId, "tool.file_context.completed", { chars: block.length, knowledgeBaseIds: fileContext.knowledgeBaseIds });
        contextBlocks.push(block);
      }
    }

    if (input.spec.tools?.knowledgeSearch && input.spec.knowledgeBaseIds?.length) {
      const limit = Math.min(Math.max(Number(input.spec.knowledgeLimit) || 5, 1), 10);
      const results = await searchKnowledgeContext({ userId: input.resourceOwnerUserId, runId: input.runId, query: input.inputText, knowledgeBaseIds: input.spec.knowledgeBaseIds, limit });
      await addRunStep({ runId: input.runId, sequenceNo: nextStep++, stepType: "retrieval", status: "completed", name: "Knowledge search", input: { query: input.inputText, knowledgeBaseIds: input.spec.knowledgeBaseIds, limit }, output: { results } });
      await addRunEvent(input.runId, "tool.knowledge_search.completed", { resultCount: results.length, results });
      if (results.length > 0) {
        contextBlocks.push(`Knowledge search results:\n${results.map((result, index) => `${index + 1}. [${result.citation}] ${result.snippet}`).join("\n")}`);
      }
    }

    if (input.spec.tools?.calculator) {
      const calculation = parseCalculation(input.inputText);
      if (calculation) {
        await addRunStep({ runId: input.runId, sequenceNo: nextStep++, stepType: "tool_result", status: "completed", name: "Calculator", input: { expression: calculation.expression }, output: { result: calculation.result } });
        await addRunEvent(input.runId, "tool.calculator.completed", calculation);
        contextBlocks.push(`Calculator result: ${calculation.expression} = ${calculation.result}`);
      }
    }

    if (input.spec.tools?.urlFetch) {
      const fetched = await fetchUrlContext(input.inputText);
      if (fetched.length > 0) {
        await addRunStep({ runId: input.runId, sequenceNo: nextStep++, stepType: "tool_result", status: "completed", name: "URL fetch", input: { inputText: input.inputText }, output: { fetched } });
        await addRunEvent(input.runId, "tool.url_fetch.completed", { fetched });
        contextBlocks.push(`Fetched URL context:\n${fetched.map((item) => "text" in item ? `URL: ${item.url}\n${item.text}` : `URL: ${item.url}\nFetch failed`).join("\n\n")}`);
      }
    }

    stepId = await addRunStep({ runId: input.runId, sequenceNo: nextStep++, stepType: "llm", status: "running", name: "Model response", input: { inputText: input.inputText, contextBlockCount: contextBlocks.length } });

    const account = await getProviderAccountForRuntime(input.spec.providerAccountId!, input.resourceOwnerUserId);
    if (!account) throw new Error("Provider account not found or is not available to this user.");
    if (input.spec.provider && account.provider !== input.spec.provider) throw new Error("Agent provider does not match the selected provider account.");

    const adapter = getProviderAdapter(account.provider);
    let outputText = "";
    let providerUsage: NormalizedUsage | null = null;

    const messages = [];
    const instructions = textOrNull(input.spec.instructions);
    if (instructions) messages.push({ role: "system" as const, content: [{ type: "text" as const, text: instructions }] });
    const artifacts = artifactInstructions(input.spec);
    if (artifacts) messages.push({ role: "system" as const, content: [{ type: "text" as const, text: artifacts }] });
    if (contextBlocks.length > 0) messages.push({ role: "user" as const, content: [{ type: "text" as const, text: `Use this pre-run context when relevant. Cite knowledge snippets by citation when used.\n\n${contextBlocks.join("\n\n")}` }] });
    messages.push({ role: "user" as const, content: [{ type: "text" as const, text: input.inputText }] });
    await addRunEvent(input.runId, "model.messages.prepared", { messageCount: messages.length, hasContext: contextBlocks.length > 0 });

    const chatRequest: NormalizedChatRequest = {
      provider: account.provider,
      model: input.spec.model!,
      messages,
      stream: true,
      temperature: typeof input.spec.temperature === "number" ? input.spec.temperature : undefined,
      maxOutputTokens: Number.isInteger(input.spec.maxOutputTokens) ? input.spec.maxOutputTokens : undefined
    };

    for await (const event of adapter.streamChat(account, chatRequest)) {
      await addRunEvent(input.runId, `provider.${event.type}`, event as unknown as Record<string, unknown>);
      if (event.type === "text_delta") outputText += event.text;
      if (event.type === "message_end") providerUsage = event.usage ?? null;
      if (event.type === "error") throw new Error(event.error.message);
    }

    await sql`
      update agent_run_steps
      set status = 'completed', output = ${JSON.stringify({ text: outputText })}::jsonb, ended_at = now()
      where id = ${stepId}
    `;
    await sql`
      update agent_runs
      set status = 'completed', ended_at = now()
      where id = ${input.runId}
    `;
    await recordUsage({
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
    await addRunEvent(input.runId, "run.completed", { outputText });
    return outputText;
  } catch (error) {
    const message = publicRunError(error);
    logger.warn("Agent run failed", { runId: input.runId, error: error instanceof Error ? error.message : String(error) });
    await sql`
      update agent_run_steps
      set status = 'failed', output = ${JSON.stringify({ error: message })}::jsonb, ended_at = now()
      where id = ${stepId}
    `;
    await sql`
      update agent_runs
      set status = 'failed', error_code = 'agent_run_failed', error_message = ${message}, ended_at = now()
      where id = ${input.runId}
    `;
    await addRunEvent(input.runId, "run.failed", { message });
    throw new Error(message);
  }
}

export async function POST(request: Request, context: RouteContext) {
  const user = await authenticateRequest(request.headers);
  if (!user) return jsonError("Unauthenticated", 401);
  const rateLimited = await agentRateLimit(request, user.id);
  if (rateLimited) return rateLimited;

  const { agentId } = await context.params;
  const access = await getAgentAccess(agentId, user);
  if (!access?.canRun) return jsonError("Published agent version not found", 404);
  const body = await request.json().catch(() => null);
  const inputText = textOrNull(body?.inputText) ?? textOrNull(body?.input);
  if (!inputText) return jsonError("inputText or input is required", 400);

  const sql = getSql();
  const versionRows = await sql<{ agent_id: string; version_id: string; spec: AgentSpec; manifest: Record<string, unknown> }[]>`
    select a.id as agent_id, v.id as version_id, v.spec, v.manifest
    from agents a
    join agent_versions v on v.id = a.published_version_id
    where a.id = ${agentId}
    limit 1
  `;
  if (versionRows.length === 0) return jsonError("Published agent version not found", 404);

  const version = versionRows[0]!;
  const providerAccountId = textOrNull(version.spec.providerAccountId);
  const model = textOrNull(version.spec.model);
  if (!providerAccountId) return jsonError("Agent spec is missing providerAccountId. Save and publish a provider account before running.", 400);
  if (!model) return jsonError("Agent spec is missing model. Save and publish a model before running.", 400);

  const runRows = await sql<{ id: string }[]>`
    insert into agent_runs (owner_user_id, agent_id, agent_version_id, trigger_type, status, input, resolved_manifest)
    values (${user.id}, ${version.agent_id}, ${version.version_id}, 'manual', 'running', ${JSON.stringify({ text: inputText })}::jsonb, ${JSON.stringify(version.manifest)}::jsonb)
    returning id
  `;
  const runId = runRows[0]!.id;
  await addRunEvent(runId, "run.created", { inputText });

  try {
    const outputText = await executeRun({ runId, userId: user.id, resourceOwnerUserId: access.ownerUserId, spec: { ...version.spec, providerAccountId, model }, inputText });
    return jsonOk({ runId, status: "completed", outputText }, { status: 201 });
  } catch (error) {
    return jsonOk({ runId, status: "failed", error: publicRunError(error) }, { status: 201 });
  }
}
