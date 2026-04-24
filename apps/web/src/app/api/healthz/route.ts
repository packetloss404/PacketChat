import { jsonOk } from "../../../lib/http";

export async function GET() {
  return jsonOk({ ok: true, service: "packetchat-web", ts: new Date().toISOString() });
}
