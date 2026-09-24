/**
 * Pure helpers for reconstructing and exporting a conversation message tree.
 *
 * The server persists every message with a `parent_message_id`, and the
 * conversation records the leaf of the currently selected branch. These helpers
 * turn that flat list back into the active path, navigate sibling branches and
 * serialize an export, without touching a database so they are unit-testable.
 */

export type ChatTreeRole = "system" | "developer" | "user" | "assistant" | "tool" | (string & {});

export type ChatTreeMessage = {
  id: string;
  role: ChatTreeRole;
  /** Raw stored content (a jsonb array of parts) when known. */
  content?: unknown;
  /** Precomputed plain text when the caller already derived it. */
  text?: string;
  parentMessageId: string | null;
  createdAt: string;
};

export type ConversationExportFormat = "md" | "json" | "txt";

export type ConversationExportInput = {
  conversationId: string;
  title: string;
  messages: ChatTreeMessage[];
  format: ConversationExportFormat;
};

/** Joins the text parts of a stored jsonb content array. */
export function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part && typeof part === "object" && "type" in part && (part as { type?: unknown }).type === "text" && "text" in part
        ? String((part as { text?: unknown }).text)
        : ""
    )
    .filter(Boolean)
    .join("\n");
}

/** Prefers an already-derived text field, falling back to the raw content. */
export function messageText(message: Pick<ChatTreeMessage, "text" | "content">): string {
  if (typeof message.text === "string") return message.text;
  return contentToText(message.content);
}

function createdAtValue(message: ChatTreeMessage): number {
  const value = Date.parse(message.createdAt);
  return Number.isNaN(value) ? 0 : value;
}

function chronological(a: ChatTreeMessage, b: ChatTreeMessage): number {
  return createdAtValue(a) - createdAtValue(b) || a.id.localeCompare(b.id);
}

/**
 * Picks the message the active path should end at. Uses the recorded leaf when
 * it still exists, otherwise the most recently created message, so a
 * conversation with a stale or missing leaf still exports something sensible.
 */
export function findActiveLeaf(messages: ChatTreeMessage[], activeLeafMessageId?: string | null): ChatTreeMessage | null {
  if (messages.length === 0) return null;
  if (activeLeafMessageId) {
    const match = messages.find((message) => message.id === activeLeafMessageId);
    if (match) return match;
  }
  return messages.reduce((latest, message) => (createdAtValue(message) >= createdAtValue(latest) ? message : latest));
}

/** Walks parent links from a starting message to its root, cycle-safely. */
function walkToRoot(byId: Map<string, ChatTreeMessage>, start: ChatTreeMessage | null): ChatTreeMessage[] {
  const path: ChatTreeMessage[] = [];
  const seen = new Set<string>();
  let current = start;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    path.push(current);
    current = current.parentMessageId ? byId.get(current.parentMessageId) ?? null : null;
  }
  return path.reverse();
}

/**
 * Reconstructs the messages that should be exported for a conversation.
 *
 * Three shapes are handled:
 *
 * - A normal branch: walk parent links from the active leaf to the root and
 *   return that path in root-to-leaf order, unchanged.
 * - A flat/legacy conversation: rows written before parent links existed have
 *   `parentMessageId = null` on every message, so the parent walk can only ever
 *   see the newest one. All messages are returned in chronological order.
 * - A mixed thread: null-parent legacy rows followed by a newer parent-linked
 *   chain. The orphan null-parent rows (roots that are not on the active path)
 *   are returned in chronological order, then the active parent-linked path.
 *
 * Unknown parents and cycles terminate the walk rather than looping forever.
 */
export function buildActivePath(messages: ChatTreeMessage[], activeLeafMessageId?: string | null): ChatTreeMessage[] {
  if (messages.length === 0) return [];
  const byId = new Map(messages.map((message) => [message.id, message]));

  // No message carries a parent: every row is an independent legacy message.
  if (messages.every((message) => message.parentMessageId === null)) {
    return [...messages].sort(chronological);
  }

  const linkedPath = walkToRoot(byId, findActiveLeaf(messages, activeLeafMessageId));
  const onPath = new Set(linkedPath.map((message) => message.id));

  // Roots the active chain does not reach are orphaned legacy rows. They are
  // prepended in chronological order so a mixed thread reads oldest-first.
  const orphans = messages
    .filter((message) => message.parentMessageId === null && !onPath.has(message.id))
    .sort(chronological);

  return [...orphans, ...linkedPath];
}

/**
 * All messages that share a parent with `messageId` (including it), ordered
 * oldest-first. These are the branches a reader can switch between at one node.
 */
export function siblingsOf(messages: ChatTreeMessage[], messageId: string): ChatTreeMessage[] {
  const target = messages.find((message) => message.id === messageId);
  if (!target) return [];
  return messages
    .filter((message) => message.parentMessageId === target.parentMessageId)
    .sort((a, b) => createdAtValue(a) - createdAtValue(b) || a.id.localeCompare(b.id));
}

/** Moves `direction` (1 = next, -1 = previous) within the sibling group. */
export function adjacentSibling(messages: ChatTreeMessage[], messageId: string, direction: 1 | -1): ChatTreeMessage | null {
  const group = siblingsOf(messages, messageId);
  const index = group.findIndex((message) => message.id === messageId);
  if (index === -1) return null;
  return group[index + direction] ?? null;
}

/**
 * Shapes a user-supplied `?search=` value into an `ILIKE` pattern, escaping the
 * wildcard characters so a literal `%` or `_` in a query is matched literally.
 */
export function normalizeConversationSearch(value: unknown): { hasSearch: boolean; pattern: string } {
  if (typeof value !== "string") return { hasSearch: false, pattern: "" };
  const trimmed = value.trim();
  if (!trimmed) return { hasSearch: false, pattern: "" };
  const escaped = trimmed.replace(/[\\%_]/g, (char) => `\\${char}`);
  return { hasSearch: true, pattern: `%${escaped}%` };
}

export function parseConversationExportFormat(value: unknown): ConversationExportFormat | null {
  if (value === undefined || value === null || value === "") return "md";
  if (value === "md" || value === "markdown") return "md";
  if (value === "json") return "json";
  if (value === "txt" || value === "text") return "txt";
  return null;
}

export function conversationExportFilename(title: string, conversationId: string, format: ConversationExportFormat): string {
  const base =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "conversation";
  const shortId = conversationId.replace(/-/g, "").slice(0, 8) || "export";
  const extension = format === "json" ? "json" : format === "txt" ? "txt" : "md";
  return `${base}-${shortId}.${extension}`;
}

function roleLabel(role: ChatTreeRole): string {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

/** Serializes the active path to Markdown, plain text or a JSON document. */
export function serializeConversationExport(input: ConversationExportInput): string {
  const { conversationId, title, messages, format } = input;

  if (format === "json") {
    return `${JSON.stringify(
      {
        conversation: { id: conversationId, title },
        messages: messages.map((message) => ({
          id: message.id,
          role: message.role,
          content: messageText(message),
          parentMessageId: message.parentMessageId,
          createdAt: message.createdAt
        }))
      },
      null,
      2
    )}\n`;
  }

  if (format === "txt") {
    const lines = [title, ""];
    for (const message of messages) lines.push(`${roleLabel(message.role)}: ${messageText(message)}`, "");
    return `${lines.join("\n").trimEnd()}\n`;
  }

  const lines = [`# ${title}`, ""];
  for (const message of messages) lines.push(`**${roleLabel(message.role)}:** ${messageText(message)}`, "");
  return `${lines.join("\n").trimEnd()}\n`;
}
