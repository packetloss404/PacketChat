import { NextResponse } from "next/server";
import { randomBytes, timingSafeEqual } from "node:crypto";

export const csrfCookieName = "packetchat_csrf";
const csrfHeaderName = "x-csrf-token";

export function jsonOk<T>(data: T, init?: ResponseInit) {
  return withSecurityHeaders(NextResponse.json(data, init));
}

export function jsonError(message: string, status = 400, details?: unknown) {
  return withSecurityHeaders(NextResponse.json({ error: { message, details } }, { status }));
}

export function requestIp(request: Request): string | null {
  if (trustsProxy()) return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? request.headers.get("x-real-ip") ?? null;
  return null;
}

export function userAgent(request: Request): string | null {
  return request.headers.get("user-agent");
}

export function cookieOptions(maxAge: number, request?: Request) {
  const secure = shouldUseSecureCookies(request);
  return {
    httpOnly: true,
    secure,
    sameSite: "lax" as const,
    path: "/",
    maxAge
  };
}

export function csrfCookieOptions(maxAge: number, request?: Request) {
  return {
    httpOnly: false,
    secure: shouldUseSecureCookies(request),
    sameSite: "lax" as const,
    path: "/",
    maxAge
  };
}

export function setCsrfCookie(response: NextResponse, maxAge: number, request?: Request) {
  const token = createCsrfToken();
  response.cookies.set(csrfCookieName, token, csrfCookieOptions(maxAge, request));
}

export function validateCsrf(request: Request): string | null {
  const cookieToken = readCookie(request, csrfCookieName);
  const headerToken = request.headers.get(csrfHeaderName);
  if (!cookieToken || !headerToken) return "Missing CSRF token";
  if (!safeEqual(cookieToken, headerToken)) return "Invalid CSRF token";
  return null;
}

export function readCookie(request: Request, name: string): string | null {
  const cookie = request.headers.get("cookie");
  const value = cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
  return value ? decodeURIComponent(value) : null;
}

function createCsrfToken() {
  return randomBytes(32).toString("base64url");
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.byteLength === rightBuffer.byteLength && timingSafeEqual(leftBuffer, rightBuffer);
}

function shouldUseSecureCookies(request?: Request) {
  if (process.env.COOKIE_SECURE === "true" || process.env.APP_ENV === "production") return true;
  if (!request || !trustsProxy()) return false;
  return request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() === "https";
}

function trustsProxy() {
  return ["1", "true", "yes", "on"].includes(String(process.env.APP_TRUSTED_PROXY ?? "").toLowerCase());
}

function withSecurityHeaders(response: NextResponse) {
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "same-origin");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.headers.set("Cache-Control", "no-store");
  if (process.env.APP_ENV === "production" || process.env.COOKIE_SECURE === "true") {
    response.headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  return response;
}
