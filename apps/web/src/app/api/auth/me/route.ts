import { authenticateRequest } from "@packetchat/auth";
import { jsonError, jsonOk } from "../../../../lib/http";

export async function GET(request: Request) {
  const user = await authenticateRequest(request.headers).catch(() => null);
  if (!user) return jsonError("Unauthenticated", 401);
  return jsonOk({ user });
}
