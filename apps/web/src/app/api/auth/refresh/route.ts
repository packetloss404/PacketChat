import { refreshCookieName, rotateRefreshToken } from "@packetchat/auth";
import { cookieOptions, jsonError, jsonOk, readCookie, setCsrfCookie, validateCsrf } from "../../../../lib/http";
import { authRateLimit } from "../../../../lib/rate-limit";

export async function POST(request: Request) {
  const rateLimited = await authRateLimit(request);
  if (rateLimited) return rateLimited;

  const csrfError = validateCsrf(request);
  if (csrfError) return jsonError(csrfError, 403);

  const refreshToken = readCookie(request, refreshCookieName);
  if (!refreshToken) return jsonError("Missing refresh token", 401);

  const rotated = await rotateRefreshToken(refreshToken);
  if (!rotated) return jsonError("Refresh token rejected", 401);

  const response = jsonOk({ accessToken: rotated.accessToken });
  response.cookies.set(refreshCookieName, rotated.refreshToken, cookieOptions(rotated.refreshTokenMaxAge, request));
  setCsrfCookie(response, rotated.refreshTokenMaxAge, request);
  return response;
}
