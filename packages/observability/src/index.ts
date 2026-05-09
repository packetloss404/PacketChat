type LogLevel = "debug" | "info" | "warn" | "error";

export type LogFields = Record<string, unknown>;

const levelOrder: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

function currentLevel(): LogLevel {
  const level = process.env.LOG_LEVEL as LogLevel | undefined;
  return level && level in levelOrder ? level : "info";
}

function write(level: LogLevel, message: string, fields: LogFields = {}) {
  if (levelOrder[level] < levelOrder[currentLevel()]) return;

  const entry = {
    ts: new Date().toISOString(),
    level,
    service: process.env.SERVICE_NAME ?? "packetchat",
    message,
    ...fields
  };

  const line = JSON.stringify(entry);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const logger = {
  debug: (message: string, fields?: LogFields) => write("debug", message, fields),
  info: (message: string, fields?: LogFields) => write("info", message, fields),
  warn: (message: string, fields?: LogFields) => write("warn", message, fields),
  error: (message: string, fields?: LogFields) => write("error", message, fields)
};

export function getRequestId(headers: Headers): string {
  return headers.get("x-request-id") ?? crypto.randomUUID();
}

export type AuditAction =
  | "bootstrap.completed"
  | "auth.login.success"
  | "auth.login.failure"
  | "auth.logout"
  | "auth.refresh.reused"
  | "user.created"
  | "user.updated"
  | "user.byok.updated"
  | "provider.created"
  | "provider.updated"
  | "provider.deleted"
  | "provider.key.rotated"
  | "provider.models.synced"
  | "provider.tested"
  | "chat.created"
  | "agent.published";

export type AuditOutcome = "success" | "failure";
