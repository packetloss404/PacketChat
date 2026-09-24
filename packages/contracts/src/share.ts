/**
 * Pure helpers for conversation share links.
 *
 * A share is a bearer token in a public URL that grants read-only access to a
 * conversation's active path. The token format, URL construction and the public
 * response shape live here so they can be unit-tested without a database and
 * reused by both the owner API and the public read API. Nothing in this module
 * touches Postgres or the request/response objects.
 */

import { buildActivePath, contentToText, type ChatTreeMessage } from "./chat-tree";

/** Entropy of a generated token: 32 bytes -> 43 base64url characters. */
export const SHARE_TOKEN_BYTES = 32;

// base64url, no padding. Bounds keep the format narrow enough to reject
// anything a caller might paste back in. 32 bytes yields 43 characters.
const SHARE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,64}$/;

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Random, URL-safe, unguessable share token. Uses Web Crypto, not Buffer. */
export function generateShareToken(): string {
  const bytes = new Uint8Array(SHARE_TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

/** Trims and validates a token, returning null for anything malformed. */
export function normalizeShareToken(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return SHARE_TOKEN_PATTERN.test(trimmed) ? trimmed : null;
}

/** Absolute public URL for a token, tolerant of a trailing slash on the base. */
export function buildShareUrl(baseUrl: string, token: string): string {
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  return `${base}/share/${token}`;
}

/** Owner-facing view of a `conversation_shares` row. */
export type ConversationShare = {
  id: string;
  conversationId: string;
  token: string;
  activeLeafMessageId: string | null;
  createdAt: string;
  revokedAt: string | null;
  revoked: boolean;
  url: string;
};

/** The snake_case row as returned by `select ... from conversation_shares`. */
export type ConversationShareRow = {
  id: string;
  conversation_id: string;
  token: string;
  active_leaf_message_id: string | null;
  created_at: string | Date;
  revoked_at: string | Date | null;
};

function toIso(value: string | Date | null): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : value;
}

/** Maps a database row to the owner-facing response shape, adding the URL. */
export function toConversationShare(row: ConversationShareRow, baseUrl: string): ConversationShare {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    token: row.token,
    activeLeafMessageId: row.active_leaf_message_id ?? null,
    createdAt: toIso(row.created_at) ?? "",
    revokedAt: toIso(row.revoked_at),
    revoked: row.revoked_at !== null && row.revoked_at !== undefined,
    url: buildShareUrl(baseUrl, row.token)
  };
}

/** A single message in the public transcript: no ids, parents or metadata. */
export type SharedConversationMessage = {
  role: string;
  content: string;
  createdAt: string;
};

export type SharedConversation = {
  title: string;
  messages: SharedConversationMessage[];
};

/**
 * Builds the public payload: only title, role, content and timestamps. The
 * active path is reconstructed exactly like the owner export, but every
 * identifying field (message id, parent link, metadata, owner) is dropped so a
 * leaked link can never widen into account or run data.
 *
 * Returns `null` (fail closed) when the share recorded an active leaf that no
 * longer exists in the conversation. Falling back to the newest message there
 * would silently drift a shared link onto newer, unintended content as the
 * owner keeps chatting. The "latest message" fallback is only allowed for a
 * share that was created with no leaf at all (a snapshot of an empty
 * conversation, captured before any message existed).
 */
export function buildSharedConversation(input: {
  title: string;
  activeLeafMessageId?: string | null;
  messages: ChatTreeMessage[];
}): SharedConversation | null {
  const recordedLeaf = input.activeLeafMessageId ?? null;
  if (recordedLeaf && !input.messages.some((message) => message.id === recordedLeaf)) {
    return null;
  }

  const path = buildActivePath(input.messages, recordedLeaf);
  return {
    title: input.title,
    messages: path.map((message) => ({
      role: message.role,
      content: contentToText(message.content),
      createdAt: message.createdAt
    }))
  };
}
