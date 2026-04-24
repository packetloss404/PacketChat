import { checkDatabase } from "@packetchat/db";
import { checkObjectStorage } from "@packetchat/files";
import { checkRedis } from "@packetchat/jobs";
import { jsonError, jsonOk } from "../../../lib/http";

export async function GET() {
  const checks: Record<string, string> = {};

  try {
    await checkDatabase();
    checks.database = "ok";
  } catch (error) {
    checks.database = error instanceof Error ? error.message : "failed";
  }

  try {
    await checkRedis();
    checks.redis = "ok";
  } catch (error) {
    checks.redis = error instanceof Error ? error.message : "failed";
  }

  try {
    await checkObjectStorage();
    checks.objectStorage = "ok";
  } catch (error) {
    checks.objectStorage = error instanceof Error ? error.message : "failed";
  }

  const ready = Object.values(checks).every((value) => value === "ok");
  if (!ready) return jsonError("PacketChat is not ready", 503, checks);
  return jsonOk({ ok: true, checks });
}
