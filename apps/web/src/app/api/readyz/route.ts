import { checkDatabase } from "@packetchat/db";
import { checkObjectStorage } from "@packetchat/files";
import { checkRedis } from "@packetchat/jobs";
import { jsonError, jsonOk } from "../../../lib/http";

// A readiness probe must always answer. Each dependency check can block rather
// than fail - the Redis client buffers commands while disconnected instead of
// rejecting, and a database or object-store check can stall on a half-open
// socket - so an unbounded probe hangs exactly when the outage it exists to
// report is happening, and reports nothing.
const CHECK_TIMEOUT_MS = 3_000;

async function probe(name: string, check: () => Promise<unknown>): Promise<string> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      check(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${name} check timed out after ${CHECK_TIMEOUT_MS}ms`)), CHECK_TIMEOUT_MS);
      })
    ]);
    return "ok";
  } catch (error) {
    return error instanceof Error ? error.message : "failed";
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function GET() {
  // Run the checks concurrently: three sequential timeouts would let a probe
  // take three times as long as any single dependency is allowed to.
  const [database, redis, objectStorage] = await Promise.all([
    probe("database", checkDatabase),
    probe("redis", checkRedis),
    probe("objectStorage", checkObjectStorage)
  ]);

  const checks: Record<string, string> = { database, redis, objectStorage };
  const ready = Object.values(checks).every((value) => value === "ok");
  if (!ready) return jsonError("PacketChat is not ready", 503, checks);
  return jsonOk({ ok: true, checks });
}
