import { loginWithPassword, refreshCookieName } from "@packetchat/auth";
import { cookieOptions, jsonError, jsonOk, requestIp, setCsrfCookie, userAgent } from "../../../../../lib/http";
import { authRateLimit } from "../../../../../lib/rate-limit";

export async function POST(request: Request) {
  const rateLimited = await authRateLimit(request);
  if (rateLimited) return rateLimited;

  const body = await request.json().catch(() => null);
  if (!body?.email || !body?.password) return jsonError("Email and password are required", 400);

  const result = await loginWithPassword({
    email: String(body.email),
    password: String(body.password),
    breakGlassOnly: true,
    ipAddress: requestIp(request),
    userAgent: userAgent(request)
  });

  if (!result) return jsonError("Invalid break-glass credentials", 401);

  const response = jsonOk({ user: result.user, accessToken: result.accessToken, warning: "Break-glass session is audited and time-limited." });
  response.cookies.set(refreshCookieName, result.refreshToken, cookieOptions(result.refreshTokenMaxAge, request));
  setCsrfCookie(response, result.refreshTokenMaxAge, request);
  return response;
}
