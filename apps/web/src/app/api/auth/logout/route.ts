import { authenticateRequest, refreshCookieName, revokeSession, revokeSessionByRefreshToken } from "@packetchat/auth";
import { cookieOptions, csrfCookieName, csrfCookieOptions, jsonError, jsonOk, readCookie, validateCsrf } from "../../../../lib/http";
import { authRateLimit } from "../../../../lib/rate-limit";

export async function POST(request: Request) {
  const csrfError = validateCsrf(request);
  if (csrfError) return jsonError(csrfError, 403);

  const user = await authenticateRequest(request.headers).catch(() => null);
  const rateLimited = await authRateLimit(request, user?.id);
  if (rateLimited) return rateLimited;

  if (user) {
    await revokeSession(user.sessionId);
  } else {
    const refreshToken = readCookie(request, refreshCookieName);
    if (refreshToken) await revokeSessionByRefreshToken(refreshToken);
  }

  const response = jsonOk({ ok: true });
  response.cookies.set(refreshCookieName, "", cookieOptions(0, request));
  response.cookies.set(csrfCookieName, "", csrfCookieOptions(0, request));
  return response;
}
