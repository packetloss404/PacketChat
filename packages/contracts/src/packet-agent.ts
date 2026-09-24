/**
 * PacketAgent integration contracts.
 *
 * PacketAgent owns the inbound notification body (`packetagent.packetchat-worker-message/v1`)
 * and posts it to a PacketChat ingestion endpoint. The zod schema here mirrors
 * that fixed body exactly so a malformed or replayed notification is rejected
 * before anything is written.
 *
 * The two helpers are deliberately pure and database-free: `resolveRunCardUpsert`
 * decides what a notification does to a run card (replace the card, append an
 * event, or ignore a redelivery) and `packetAgentRunDisplayState` folds the
 * PacketAgent lifecycle fields into a single bucket the UI can render. Keeping
 * them pure makes the threading and idempotency rules unit-testable without a
 * live Agent or database.
 */

import { z } from "zod";

export const PACKET_AGENT_WORKER_MESSAGE_SCHEMA_VERSION = "packetagent.packetchat-worker-message/v1";
export const PACKET_AGENT_ROUTE_SCHEMA_VERSION = "packetagent.packetchat-route/v1";

const stringValue = z.string();

export const packetAgentThreadSchema = z.object({
  key: z.string(),
  messageKey: z.string().min(1),
  behavior: z.enum(["append", "replace"])
});

export const packetAgentWorkerSchema = z.object({
  workspaceId: stringValue,
  definitionId: stringValue,
  deploymentId: stringValue,
  runId: z.string().min(1),
  versionId: stringValue,
  versionContentDigest: stringValue
});

export const packetAgentStateSchema = z.object({
  deployment: stringValue,
  run: stringValue,
  version: stringValue,
  versionNumber: z.number(),
  reason: z.string().nullable().optional()
});

export const packetAgentBudgetSchema = z.object({
  usage: z.record(z.unknown()),
  limits: z.record(z.unknown())
});

export const packetAgentCheckpointSchema = z.object({
  id: stringValue,
  sequence: z.number(),
  phase: stringValue,
  iteration: z.number(),
  stateDigest: stringValue
});

export const packetAgentEvidenceSchema = z.object({
  id: stringValue,
  href: stringValue
});

export const packetAgentCallbacksSchema = z.object({
  open: stringValue,
  inspect: stringValue
});

export const packetAgentWorkerMessageSchema = z
  .object({
    schemaVersion: z.literal(PACKET_AGENT_WORKER_MESSAGE_SCHEMA_VERSION),
    thread: packetAgentThreadSchema,
    worker: packetAgentWorkerSchema,
    state: packetAgentStateSchema,
    budget: packetAgentBudgetSchema,
    checkpoint: packetAgentCheckpointSchema.nullable().optional(),
    evidence: packetAgentEvidenceSchema,
    requiredAction: stringValue,
    title: stringValue,
    summary: stringValue,
    callbacks: packetAgentCallbacksSchema
  })
  .superRefine((value, context) => {
    if (value.thread.key !== `worker-run:${value.worker.runId}`) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["thread", "key"],
        message: "thread.key must equal worker-run:<worker.runId>"
      });
    }
  });

export type PacketAgentThread = z.infer<typeof packetAgentThreadSchema>;
export type PacketAgentWorker = z.infer<typeof packetAgentWorkerSchema>;
export type PacketAgentState = z.infer<typeof packetAgentStateSchema>;
export type PacketAgentBudget = z.infer<typeof packetAgentBudgetSchema>;
export type PacketAgentCheckpoint = z.infer<typeof packetAgentCheckpointSchema>;
export type PacketAgentEvidence = z.infer<typeof packetAgentEvidenceSchema>;
export type PacketAgentCallbacks = z.infer<typeof packetAgentCallbacksSchema>;
export type PacketAgentWorkerMessage = z.infer<typeof packetAgentWorkerMessageSchema>;

/** The versioned run card PacketChat keeps per worker run. */
export type PacketAgentRunCard = {
  connectionId: string;
  threadKey: string;
  workerRunId: string;
  workerDefinitionId: string;
  workerDeploymentId: string;
  workerVersionId: string;
  workerVersionContentDigest: string;
  title: string;
  summary: string;
  state: PacketAgentState;
  budget: PacketAgentBudget;
  checkpoint: PacketAgentCheckpoint | null;
  requiredAction: string;
  evidence: PacketAgentEvidence | Record<string, never>;
  callbacks: PacketAgentCallbacks | null;
};

export type PacketAgentEventBehavior = "replace" | "append" | "append-ignore-duplicate";

export type PacketAgentRunCardUpsert = {
  card: PacketAgentRunCard;
  eventBehavior: PacketAgentEventBehavior;
  isDuplicate: boolean;
};

/**
 * Builds the card fields a notification contributes. Everything mutable is
 * taken from the newest message; a missing checkpoint keeps the last known one
 * so an append that only advances the summary does not erase progress.
 */
function cardFromMessage(
  existing: PacketAgentRunCard | null,
  message: PacketAgentWorkerMessage
): PacketAgentRunCard {
  const checkpoint = message.checkpoint ?? existing?.checkpoint ?? null;
  return {
    connectionId: existing?.connectionId ?? "",
    threadKey: message.thread.key,
    workerRunId: message.worker.runId,
    workerDefinitionId: message.worker.definitionId,
    workerDeploymentId: message.worker.deploymentId,
    workerVersionId: message.worker.versionId,
    workerVersionContentDigest: message.worker.versionContentDigest,
    title: message.title,
    summary: message.summary,
    state: message.state,
    budget: message.budget,
    checkpoint,
    requiredAction: message.requiredAction || "none",
    evidence: message.evidence,
    callbacks: message.callbacks
  };
}

/**
 * Decides what a notification does to a run card.
 *
 * - `replace` always replaces the card; the run-level thread key means a repeat
 *   replace is naturally idempotent because it writes the same fields.
 * - `append` adds an event unless the message key has already been seen, in
 *   which case it is a redelivery and must be ignored (`append-ignore-duplicate`)
 *   so a retry cannot double the thread.
 */
export function resolveRunCardUpsert(
  existing: PacketAgentRunCard | null,
  message: PacketAgentWorkerMessage,
  existingEventKeys: string[]
): PacketAgentRunCardUpsert {
  const card = cardFromMessage(existing, message);

  if (message.thread.behavior === "replace") {
    return { card, eventBehavior: "replace", isDuplicate: false };
  }

  const isDuplicate = existingEventKeys.includes(message.thread.messageKey);
  return {
    card,
    eventBehavior: isDuplicate ? "append-ignore-duplicate" : "append",
    isDuplicate
  };
}

export type PacketAgentDisplayState =
  | "progress"
  | "attention"
  | "completed"
  | "failed"
  | "cancelled"
  | "budget_exceeded"
  | "unknown";

function budgetExceeded(budget: PacketAgentBudget | Record<string, unknown> | null | undefined): boolean {
  if (!budget || typeof budget !== "object") return false;
  const record = budget as Record<string, unknown>;
  if (record.exceeded === true) return true;
  const usage = record.usage;
  const limits = record.limits;
  if (usage && limits && typeof usage === "object" && typeof limits === "object") {
    const usageRecord = usage as Record<string, unknown>;
    const limitsRecord = limits as Record<string, unknown>;
    const total = typeof usageRecord.total === "number" ? usageRecord.total : null;
    const limit = typeof limitsRecord.total === "number" ? limitsRecord.total : null;
    if (total !== null && limit !== null && limit > 0 && total >= limit) return true;
  }
  return false;
}

/**
 * Folds the PacketAgent lifecycle fields into one display bucket. A required
 * action outranks progress (a blocked run needs a human), and a budget outcome
 * outranks the generic run status because it is the more specific result.
 */
export function packetAgentRunDisplayState(
  card: Pick<PacketAgentRunCard, "state" | "requiredAction" | "budget">
): PacketAgentDisplayState {
  const run = (card.state?.run ?? "").toLowerCase();
  const reason = (card.state?.reason ?? "").toLowerCase();
  const requiredAction = (card.requiredAction ?? "").toLowerCase();

  if (budgetExceeded(card.budget) || run.includes("budget") || reason.includes("budget")) {
    return "budget_exceeded";
  }
  if (requiredAction && requiredAction !== "none") return "attention";
  if (/(cancel|abort)/.test(run) || /(cancel|abort)/.test(reason)) return "cancelled";
  if (/(fail|error)/.test(run) || /(fail|error)/.test(reason)) return "failed";
  if (/(complete|succeed|success|done|finish)/.test(run) || /(complete|succeed|done)/.test(reason)) return "completed";
  if (/(run|progress|active|start|queue|pending|wait|work)/.test(run) || /(progress|run)/.test(reason)) return "progress";
  return "unknown";
}

/** The route-config template PacketChat hands an operator to paste into PacketAgent. */
export function packetAgentRouteConfigTemplate(input: {
  endpoint: string;
  bearerToken: string;
  callbackBaseUrl?: string;
  callbackSecret?: string;
}) {
  return {
    schemaVersion: PACKET_AGENT_ROUTE_SCHEMA_VERSION,
    endpoint: input.endpoint,
    bearerToken: input.bearerToken,
    callbackBaseUrl: input.callbackBaseUrl ?? "https://<your-packetagent-callback-host>",
    callbackSecret: input.callbackSecret ?? "<operator-provided-callback-secret>"
  };
}
