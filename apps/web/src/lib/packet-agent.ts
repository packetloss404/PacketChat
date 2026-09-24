import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { bearerTokenFromHeaders, decryptJsonSecret, encryptJsonSecret } from "@packetchat/auth";
import { getConfig } from "@packetchat/config";
import {
  packetAgentRunDisplayState,
  packetAgentWorkerMessageSchema,
  resolveRunCardUpsert,
  type PacketAgentRunCard,
  type PacketAgentWorkerMessage
} from "@packetchat/contracts";
import { jsonError, jsonOk } from "./http";
import { rateLimitResponse } from "./rate-limit";

/** Path the operator pastes into the PacketAgent worker version's route config. */
export const PACKET_AGENT_INGEST_PATH = "/api/packet-agent/worker-notifications";

const INGEST_TOKEN_PREFIX = "pchat_";
const INGEST_DIGEST_VERSION = "v1";
const PACKET_AGENT_TIMEOUT_MS = 15_000;
const CALLBACK_TIMEOUT_MS = 15_000;

export type PacketAgentConnectionCredentials = {
  token: string;
  workspaceId: string;
};

/** The connection identity the ingest path is allowed to see. */
export type PacketAgentConnectionIdentity = {
  id: string;
  projectId: string;
  ownerUserId: string;
  workspaceId: string;
  deploymentId: string | null;
  ingestTokenDigest: string;
};

export type PacketAgentConnection = PacketAgentConnectionIdentity & {
  name: string;
  agentBaseUrl: string;
  agentCredentials: Record<string, string>;
  ingestTokenPrefix: string;
  createdAt: string;
  updatedAt: string;
  rotatedAt: string | null;
};

// ---------------------------------------------------------------------------
// Inbound ingest token
// ---------------------------------------------------------------------------

export function createIngestSecret(): string {
  return randomBytes(32).toString("base64url");
}

export function buildIngestToken(connectionId: string, secret: string): string {
  return `${INGEST_TOKEN_PREFIX}${connectionId}.${secret}`;
}

/** sha256 of the connection id and secret, versioned so the format can change. */
export function digestIngestToken(connectionId: string, secret: string): string {
  return `${INGEST_DIGEST_VERSION}:${createHash("sha256").update(`${connectionId}.${secret}`, "utf8").digest("hex")}`;
}

export function ingestTokenPrefix(secret: string): string {
  return secret.slice(0, 8);
}

export function createIngestToken(connectionId: string): { token: string; secret: string; digest: string; prefix: string } {
  const secret = createIngestSecret();
  return {
    token: buildIngestToken(connectionId, secret),
    secret,
    digest: digestIngestToken(connectionId, secret),
    prefix: ingestTokenPrefix(secret)
  };
}

export function parseIngestToken(token: string): { connectionId: string; secret: string } | null {
  if (typeof token !== "string" || !token.startsWith(INGEST_TOKEN_PREFIX)) return null;
  const rest = token.slice(INGEST_TOKEN_PREFIX.length);
  const separator = rest.indexOf(".");
  if (separator <= 0 || separator === rest.length - 1) return null;
  const connectionId = rest.slice(0, separator);
  const secret = rest.slice(separator + 1);
  if (!connectionId || !secret) return null;
  return { connectionId, secret };
}

/** Constant-time comparison of a presented token against the stored digest. */
export function verifyIngestTokenDigest(token: string, expectedDigest: string): boolean {
  const parsed = parseIngestToken(token);
  if (!parsed || !expectedDigest) return false;
  const actual = Buffer.from(digestIngestToken(parsed.connectionId, parsed.secret), "utf8");
  const expected = Buffer.from(expectedDigest, "utf8");
  if (actual.byteLength !== expected.byteLength) return false;
  return timingSafeEqual(actual, expected);
}

// ---------------------------------------------------------------------------
// Rate limits
// ---------------------------------------------------------------------------

export function packetAgentRateLimit(request: Request, userId: string) {
  return rateLimitResponse({
    namespace: "packet-agent",
    request,
    subject: { userId },
    limit: getConfig().RATE_LIMIT_CHAT_PER_MINUTE
  });
}

export function packetAgentIngestRateLimit(request: Request, connectionId: string) {
  return rateLimitResponse({
    namespace: "packet-agent-ingest",
    request,
    subject: { userId: `connection:${connectionId}` },
    limit: getConfig().RATE_LIMIT_CHAT_PER_MINUTE
  });
}

// ---------------------------------------------------------------------------
// Outbound Agent client
// ---------------------------------------------------------------------------

export class PacketAgentError extends Error {
  constructor(
    message: string,
    public readonly status?: number
  ) {
    super(message);
    this.name = "PacketAgentError";
  }
}

export type PacketAgentOutboundConnection = {
  agentBaseUrl: string;
  workspaceId: string;
  agentCredentials: Record<string, string>;
};

/**
 * Calls the connected PacketAgent deployment. The agent bearer token is
 * decrypted only here and sent only to the Agent host; the target URL and token
 * are never logged, because either can carry a signed secret.
 */
export async function callPacketAgent(
  connection: PacketAgentOutboundConnection,
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  const credentials = decryptJsonSecret<PacketAgentConnectionCredentials>(connection.agentCredentials);
  const base = connection.agentBaseUrl.endsWith("/") ? connection.agentBaseUrl.slice(0, -1) : connection.agentBaseUrl;
  const target = `${base}${path.startsWith("/") ? path : `/${path}`}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PACKET_AGENT_TIMEOUT_MS);
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${credentials.token}`);
  headers.set("PacketAgent-Workspace-Id", connection.workspaceId || credentials.workspaceId);

  try {
    return await fetch(target, { ...init, headers, signal: controller.signal, redirect: "manual" });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new PacketAgentError("PacketAgent request timed out");
    }
    throw new PacketAgentError("PacketAgent request failed");
  } finally {
    clearTimeout(timer);
  }
}

export async function callPacketAgentJson<T>(
  connection: PacketAgentOutboundConnection,
  path: string,
  init: RequestInit = {}
): Promise<{ response: Response; body: T | null }> {
  const response = await callPacketAgent(connection, path, init);
  const body = (await response.json().catch(() => null)) as T | null;
  return { response, body };
}

/** Fetches a signed callback URL server-side. The URL is never logged or returned. */
export async function fetchSignedCallback(url: string): Promise<{ status: number; body: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALLBACK_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: "manual", headers: { accept: "application/json" } });
    const body = await response.json().catch(() => null);
    return { status: response.status, body };
  } catch {
    return { status: 0, body: null };
  } finally {
    clearTimeout(timer);
  }
}

export type PacketAgentInspectOutcome =
  | { ok: true; expired: false; detail: unknown }
  | { ok: false; expired: true; message: string }
  | { ok: false; expired: false; error: string; status: number };

/** Pure mapping of an Agent inspect response into the proxied result. */
export function interpretInspectResponse(status: number, body: unknown): PacketAgentInspectOutcome {
  if (status === 401 || status === 410) {
    return {
      ok: false,
      expired: true,
      message: "This run's inspect link has expired. The Agent no longer serves read-only detail for it."
    };
  }
  if (status === 0) return { ok: false, expired: false, error: "PacketAgent is unreachable", status };
  if (status < 200 || status >= 300) {
    return { ok: false, expired: false, error: `PacketAgent inspect failed (${status})`, status };
  }
  return { ok: true, expired: false, detail: sanitizeAgentPayload(body) };
}

export type PacketAgentOpenOutcome =
  | { ok: true; expired: false; url: string }
  | { ok: false; expired: true; message: string }
  | { ok: false; expired: false; error: string; status: number };

export function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Maps an Agent "open" callback response into the proxied result. PacketChat
 * calls the signed callback server-side and returns only the Agent's plain UI
 * URL, so the signed callback never reaches the browser.
 */
export function interpretOpenResponse(status: number, body: unknown): PacketAgentOpenOutcome {
  if (status === 401 || status === 410) {
    return {
      ok: false,
      expired: true,
      message: "This run's open link has expired. A fresh notification from PacketAgent renews it."
    };
  }
  if (status === 0) return { ok: false, expired: false, error: "PacketAgent is unreachable", status };
  if (status < 200 || status >= 300) {
    return { ok: false, expired: false, error: `PacketAgent open failed (${status})`, status };
  }
  const openUrl =
    body && typeof body === "object" ? (body as { openUrl?: unknown }).openUrl : undefined;
  if (!isHttpUrl(openUrl)) {
    return { ok: false, expired: false, error: "PacketAgent returned no open URL", status };
  }
  return { ok: true, expired: false, url: openUrl };
}

// ---------------------------------------------------------------------------
// Connection input validation / URL building
// ---------------------------------------------------------------------------

/** Returns the normalized http(s) origin, or null when the value is not one. */
export function normalizeAgentBaseUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  if (url.search || url.hash) return null;
  if (url.pathname !== "/" && url.pathname !== "") return null;
  return url.origin;
}

export function buildIngestEndpointUrl(): string {
  const base = getConfig().APP_BASE_URL.replace(/\/+$/, "");
  return `${base}${PACKET_AGENT_INGEST_PATH}`;
}

export { encryptJsonSecret, decryptJsonSecret };

// ---------------------------------------------------------------------------
// Ingest planning (pure) + handler
// ---------------------------------------------------------------------------

export type PacketAgentStoredRun = {
  runId: string;
  card: PacketAgentRunCard;
};

export type PacketAgentUpsertInput = {
  connectionId: string;
  projectId: string;
  ownerUserId: string;
  workspaceId: string;
  card: PacketAgentRunCard;
  appendEvent: boolean;
  messageKey: string;
  idempotencyKey: string;
  event: string;
  eventPayload: Record<string, unknown>;
};

export type PacketAgentIngestRepo = {
  findConnectionById(connectionId: string): Promise<PacketAgentConnectionIdentity | null>;
  findRunByWorkerRunId(connectionId: string, workerRunId: string): Promise<PacketAgentStoredRun | null>;
  /** True when either the message key or the idempotency key has already been seen. */
  eventExists(connectionId: string, messageKey: string, idempotencyKey: string): Promise<boolean>;
  applyUpsert(input: PacketAgentUpsertInput): Promise<{ runId: string }>;
};

export type PacketAgentIngestPlan =
  | { kind: "forbidden"; reason: string }
  | { kind: "duplicate"; workerRunId: string }
  | {
      kind: "upsert";
      workerRunId: string;
      behavior: "append" | "replace";
      appendEvent: boolean;
      card: PacketAgentRunCard;
      connectionId: string;
      projectId: string;
      ownerUserId: string;
      workspaceId: string;
    };

/**
 * Pure decision for one notification: who owns it, whether it is a redelivery,
 * and what it changes. The Postgres adapter applies the result; tests can apply
 * it to an in-memory store to prove the append/replace/idempotency rules.
 */
export function planIngest(input: {
  connection: PacketAgentConnectionIdentity;
  existingCard: PacketAgentRunCard | null;
  eventExists: boolean;
  message: PacketAgentWorkerMessage;
}): PacketAgentIngestPlan {
  const { connection, message } = input;

  if (message.worker.workspaceId !== connection.workspaceId) {
    return { kind: "forbidden", reason: "worker workspace does not match the connection" };
  }
  if (connection.deploymentId && message.worker.deploymentId !== connection.deploymentId) {
    return { kind: "forbidden", reason: "worker deployment does not match the connection" };
  }

  const { card, eventBehavior, isDuplicate } = resolveRunCardUpsert(
    input.existingCard,
    message,
    input.eventExists ? [message.thread.messageKey] : []
  );

  if (message.thread.behavior === "append" && (isDuplicate || eventBehavior === "append-ignore-duplicate")) {
    return { kind: "duplicate", workerRunId: message.worker.runId };
  }

  return {
    kind: "upsert",
    workerRunId: message.worker.runId,
    behavior: message.thread.behavior,
    appendEvent: message.thread.behavior === "append",
    card: { ...card, connectionId: connection.id },
    connectionId: connection.id,
    projectId: connection.projectId,
    ownerUserId: connection.ownerUserId,
    workspaceId: connection.workspaceId
  };
}

function eventNameFor(message: PacketAgentWorkerMessage): string {
  if (message.state.run.trim()) return message.state.run.trim();
  if (message.requiredAction && message.requiredAction.toLowerCase() !== "none") return "attention";
  return "progress";
}

/**
 * The event payload excludes callbacks: those are signed, encrypted at rest on
 * the run card, and proxied server-side. A plaintext copy in the event thread
 * would defeat that.
 */
function eventPayloadFor(message: PacketAgentWorkerMessage): Record<string, unknown> {
  const { callbacks: _callbacks, ...rest } = message;
  return rest as Record<string, unknown>;
}

function deliveryReference(request: Request, message: PacketAgentWorkerMessage): string {
  return request.headers.get("idempotency-key")?.trim() || message.thread.messageKey;
}

export type PacketAgentIngestDeps = {
  repo: PacketAgentIngestRepo;
  rateLimit: (request: Request, connectionId: string) => Promise<Response | null>;
};

/**
 * The ingress handler, independent of Postgres so it can be driven by a fake
 * repository in tests. Authentication is constant-time against the stored
 * digest; a missing connection and a wrong token are indistinguishable (401) so
 * the endpoint never confirms a connection id.
 */
export async function handleWorkerNotification(request: Request, deps: PacketAgentIngestDeps): Promise<Response> {
  const token = bearerTokenFromHeaders(request.headers);
  if (!token) return jsonError("Unauthorized", 401);

  const parsedToken = parseIngestToken(token);
  if (!parsedToken) return jsonError("Unauthorized", 401);

  const connection = await deps.repo.findConnectionById(parsedToken.connectionId);
  if (!connection || !verifyIngestTokenDigest(token, connection.ingestTokenDigest)) {
    return jsonError("Unauthorized", 401);
  }

  const limited = await deps.rateLimit(request, connection.id);
  if (limited) return limited;

  const body = await request.json().catch(() => null);
  const parsed = packetAgentWorkerMessageSchema.safeParse(body);
  if (!parsed.success) {
    return jsonError(
      "Invalid worker message",
      400,
      parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }))
    );
  }
  const message = parsed.data;

  const existingRun = await deps.repo.findRunByWorkerRunId(connection.id, message.worker.runId);
  const idempotencyKey = request.headers.get("idempotency-key")?.trim() || message.thread.messageKey;
  const eventExists = await deps.repo.eventExists(connection.id, message.thread.messageKey, idempotencyKey);
  const plan = planIngest({ connection, existingCard: existingRun?.card ?? null, eventExists, message });

  if (plan.kind === "forbidden") return jsonError("Forbidden", 403);

  if (plan.kind === "duplicate") {
    const response = jsonOk({ ok: true, runId: existingRun?.runId ?? null });
    response.headers.set("x-request-id", deliveryReference(request, message));
    return response;
  }

  const result = await deps.repo.applyUpsert({
    connectionId: plan.connectionId,
    projectId: plan.projectId,
    ownerUserId: plan.ownerUserId,
    workspaceId: plan.workspaceId,
    card: plan.card,
    appendEvent: plan.appendEvent,
    messageKey: message.thread.messageKey,
    idempotencyKey,
    event: eventNameFor(message),
    eventPayload: eventPayloadFor(message)
  });

  const response = jsonOk({ ok: true, runId: result.runId });
  response.headers.set("x-request-id", deliveryReference(request, message));
  return response;
}

/** Maps a stored run row to the display card. Callbacks are stripped by callers. */
export function displayStateForCard(card: Pick<PacketAgentRunCard, "state" | "requiredAction" | "budget">) {
  return packetAgentRunDisplayState(card);
}

/** The snake_case `packet_agent_runs` row as selected by the server. */
export type PacketAgentRunRow = {
  id: string;
  connection_id: string;
  project_id: string;
  owner_user_id: string;
  workspace_id: string;
  thread_key: string;
  worker_run_id: string;
  worker_definition_id: string;
  worker_deployment_id: string;
  worker_version_id: string;
  worker_version_content_digest: string;
  title: string;
  summary: string;
  state: unknown;
  budget: unknown;
  checkpoint: unknown;
  required_action: string;
  evidence: unknown;
  created_at: string;
  updated_at: string;
};

/**
 * Maps a stored run row to the card the ingest planner reasons about. Callbacks
 * are intentionally null here: they are stored encrypted and only decrypted in
 * the inspect/open proxy, never on the read path.
 */
export function runCardFromRow(row: PacketAgentRunRow): PacketAgentRunCard {
  return {
    connectionId: row.connection_id,
    threadKey: row.thread_key,
    workerRunId: row.worker_run_id,
    workerDefinitionId: row.worker_definition_id,
    workerDeploymentId: row.worker_deployment_id,
    workerVersionId: row.worker_version_id,
    workerVersionContentDigest: row.worker_version_content_digest,
    title: row.title,
    summary: row.summary,
    state: row.state as PacketAgentRunCard["state"],
    budget: row.budget as PacketAgentRunCard["budget"],
    checkpoint: (row.checkpoint as PacketAgentRunCard["checkpoint"]) ?? null,
    requiredAction: row.required_action,
    evidence: (row.evidence as PacketAgentRunCard["evidence"]) ?? {},
    callbacks: null
  };
}

/** The snake_case `packet_agent_connections` row as selected by the server. */
export type PacketAgentConnectionRow = {
  id: string;
  project_id: string;
  owner_user_id: string;
  name: string;
  workspace_id: string;
  deployment_id: string | null;
  agent_base_url: string;
  agent_credentials: Record<string, string>;
  ingest_token_digest: string;
  ingest_token_prefix: string;
  created_at: string;
  updated_at: string;
  rotated_at: string | null;
};

/** Client-safe connection metadata. Never includes credentials or the token. */
export function connectionMetadataFromRow(row: PacketAgentConnectionRow) {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    workspaceId: row.workspace_id,
    deploymentId: row.deployment_id,
    agentBaseUrl: row.agent_base_url,
    ingestTokenPrefix: row.ingest_token_prefix,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    rotatedAt: row.rotated_at
  };
}

/** Client-safe run card projection. Callbacks are never included. */
export function runViewFromRow(row: PacketAgentRunRow) {
  const card = runCardFromRow(row);
  return {
    id: row.id,
    connectionId: row.connection_id,
    projectId: row.project_id,
    threadKey: card.threadKey,
    workerRunId: card.workerRunId,
    workerDefinitionId: card.workerDefinitionId,
    workerDeploymentId: card.workerDeploymentId,
    workerVersionId: card.workerVersionId,
    workerVersionContentDigest: card.workerVersionContentDigest,
    title: card.title,
    summary: card.summary,
    state: card.state,
    budget: card.budget,
    checkpoint: card.checkpoint,
    requiredAction: card.requiredAction,
    evidence: card.evidence,
    displayState: packetAgentRunDisplayState(card),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export type PacketAgentRunView = ReturnType<typeof runViewFromRow>;

/** Strips anything that looks like a credential from an Agent response before it leaves the server. */
export function sanitizeAgentPayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeAgentPayload);
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (/token|secret|password|authorization|credential/i.test(key)) continue;
      output[key] = sanitizeAgentPayload(entry);
    }
    return output;
  }
  return value;
}
