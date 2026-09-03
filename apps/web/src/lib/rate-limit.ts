import { getConfig } from "@packetchat/config";
import { checkRateLimit, type RateLimitAlgorithm } from "@packetchat/jobs";
import { logger } from "@packetchat/observability";
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

// Redis is reached through a connection configured with maxRetriesPerRequest:
// null and ioredis's offline queue enabled, which BullMQ requires for Workers.
// A command issued while Redis is unreachable is therefore buffered rather than
// rejected, and its promise never settles. Without a bound, an outage would
// hang every rate-limited request - including login - holding each connection
// open until the gateway gave up, which takes the whole app down rather than
// degrading it.
const RATE_LIMIT_TIMEOUT_MS = 2_000;

async function checkWithinTimeout(input: Parameters<typeof checkRateLimit>[0]) {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      checkRateLimit(input),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`rate limit check timed out after ${RATE_LIMIT_TIMEOUT_MS}ms`)), RATE_LIMIT_TIMEOUT_MS);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function rateLimitResponse(options: RateLimitOptions): Promise<Response | null> {
  let result;
  try {
    result = await checkWithinTimeout({
      namespace: options.namespace,
      identifier: clientIdentifier(options.request, options.subject),
      limit: options.limit,
      windowSeconds: options.windowSeconds ?? 60,
      algorithm: options.algorithm ?? "sliding-window"
    });
  } catch (error) {
    // Deliberate fail-open: when the limiter itself is unavailable the request
    // proceeds unlimited rather than the app becoming unusable. Logged at error
    // level because it means auth endpoints are briefly unthrottled. Invert this
    // to a 503 if unthrottled auth is the worse risk for your deployment.
    logger.error("Rate limit check failed; allowing request unthrottled", {
      namespace: options.namespace,
      error: error instanceof Error ? error.message : String(error)
    });
    return null;
  }

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
