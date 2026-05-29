import { createHash } from "node:crypto";
import type { ParsedArtifact } from "./parse";

export type ArtifactRecord = {
  ownerUserId: string;
  conversationId: string | null;
  agentRunId: string | null;
  identifier: string;
  type: string;
  title: string | null;
  contentHash: string;
  content: string;
};

export function contentHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function toArtifactRecords(
  parsed: ParsedArtifact[],
  ctx: { ownerUserId: string; conversationId?: string | null; agentRunId?: string | null }
): ArtifactRecord[] {
  const conversationId = ctx.conversationId ?? null;
  const agentRunId = ctx.agentRunId ?? null;

  // Dedupe by identifier, keeping the LAST occurrence. A Map preserves insertion
  // order, so re-setting an existing key updates its value while keeping the
  // original slot; the iteration order below therefore reflects first-seen
  // position with last-seen content.
  const byIdentifier = new Map<string, ArtifactRecord>();

  for (const artifact of parsed) {
    byIdentifier.set(artifact.identifier, {
      ownerUserId: ctx.ownerUserId,
      conversationId,
      agentRunId,
      identifier: artifact.identifier,
      type: artifact.type,
      title: artifact.title ?? null,
      contentHash: contentHash(artifact.content),
      content: artifact.content
    });
  }

  return [...byIdentifier.values()];
}
