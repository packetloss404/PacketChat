import { getConfig } from "@packetchat/config";
import { checkRateLimit, type RateLimitAlgorithm } from "@packetchat/jobs";
import { jsonError, requestIp, userAgent } from "./http";

type RateLimitSubject = {
  userId?: string | null;
};

type RateLimitOptions = {
  namespace: string;
  request: Request;
  subject?: RateLimitSubject | null;
  limit: number;
  windowSeconds?: number;
  algorithm?: RateLimitAlgorithm;
};

function clientIdentifier(request: Request, subject?: RateLimitSubject | null) {
  if (subject?.userId) return `user:${subject.userId}`;

  const ip = requestIp(request);
  if (ip) return `ip:${ip}`;

  return `anonymous:${userAgent(request) ?? "unknown"}`;
}

export async function rateLimitResponse(options: RateLimitOptions): Promise<Response | null> {
  const result = await checkRateLimit({
    namespace: options.namespace,
    identifier: clientIdentifier(options.request, options.subject),
    limit: options.limit,
    windowSeconds: options.windowSeconds ?? 60,
    algorithm: options.algorithm ?? "sliding-window"
  });

  if (result.allowed) return null;

  const retryAfterSeconds = result.retryAfterSeconds;
  const response = jsonError("Rate limit exceeded", 429, {
    limit: result.limit,
    remaining: result.remaining,
    retryAfterSeconds,
    resetAt: result.resetAt.toISOString()
  });
  response.headers.set("Retry-After", String(retryAfterSeconds));
  response.headers.set("X-RateLimit-Limit", String(result.limit));
  response.headers.set("X-RateLimit-Remaining", String(result.remaining));
  response.headers.set("X-RateLimit-Reset", String(Math.ceil(result.resetAt.getTime() / 1_000)));
  return response;
}

export function authRateLimit(request: Request, userId?: string | null) {
  return rateLimitResponse({
    namespace: "auth",
    request,
    subject: userId ? { userId } : undefined,
    limit: getConfig().RATE_LIMIT_AUTH_PER_MINUTE,
    algorithm: "fixed-window"
  });
}

export function chatRateLimit(request: Request, userId: string) {
  return rateLimitResponse({
    namespace: "chat",
    request,
    subject: { userId },
    limit: getConfig().RATE_LIMIT_CHAT_PER_MINUTE
  });
}

export function agentRateLimit(request: Request, userId: string) {
  return rateLimitResponse({
    namespace: "agent-run",
    request,
    subject: { userId },
    limit: getConfig().RATE_LIMIT_CHAT_PER_MINUTE
  });
}

export function providerRateLimit(request: Request, userId: string) {
  return rateLimitResponse({
    namespace: "provider-expensive",
    request,
    subject: { userId },
    limit: getConfig().RATE_LIMIT_CHAT_PER_MINUTE
  });
}

export function fileUploadRateLimit(request: Request, userId: string) {
  return rateLimitResponse({
    namespace: "file-upload",
    request,
    subject: { userId },
    limit: getConfig().RATE_LIMIT_FILE_UPLOAD_PER_MINUTE
  });
}
