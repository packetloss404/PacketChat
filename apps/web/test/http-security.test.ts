import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import {
  cookieOptions,
  csrfCookieOptions,
  jsonError,
  jsonOk,
  requestIp,
  validateCsrf
} from "../src/lib/http";

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env = { ...originalEnv };
});

afterEach(() => {
  process.env = { ...originalEnv };
});

test("JSON responses include hardened browser security headers", () => {
  process.env.APP_ENV = "production";

  const ok = jsonOk({ ready: true });
  const error = jsonError("Nope", 403);

  for (const response of [ok, error]) {
    assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
    assert.equal(response.headers.get("Referrer-Policy"), "same-origin");
    assert.equal(response.headers.get("X-Frame-Options"), "DENY");
    assert.equal(response.headers.get("Permissions-Policy"), "camera=(), microphone=(), geolocation=()");
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal(response.headers.get("Strict-Transport-Security"), "max-age=31536000; includeSubDomains");
  }
});

test("cookie helpers force secure cookies for production and trusted HTTPS proxies", () => {
  process.env.APP_ENV = "production";
  assert.equal(cookieOptions(60).secure, true);
  assert.equal(csrfCookieOptions(60).secure, true);

  process.env.APP_ENV = "development";
  process.env.COOKIE_SECURE = "false";
  process.env.APP_TRUSTED_PROXY = "true";

  const proxiedHttpsRequest = new Request("http://packetchat.test", {
    headers: { "x-forwarded-proto": "https" }
  });
  assert.equal(cookieOptions(60, proxiedHttpsRequest).secure, true);

  const directHttpRequest = new Request("http://packetchat.test");
  assert.equal(cookieOptions(60, directHttpRequest).secure, false);
});

test("requestIp ignores forwarded addresses unless proxy trust is enabled", () => {
  const request = new Request("http://packetchat.test", {
    headers: {
      "x-forwarded-for": "203.0.113.10, 10.0.0.5",
      "x-real-ip": "203.0.113.20"
    }
  });

  process.env.APP_TRUSTED_PROXY = "false";
  assert.equal(requestIp(request), null);

  process.env.APP_TRUSTED_PROXY = "true";
  assert.equal(requestIp(request), "203.0.113.10");
});

test("CSRF validation requires matching cookie and header tokens", () => {
  const validRequest = new Request("http://packetchat.test", {
    headers: {
      cookie: "packetchat_csrf=token-123",
      "x-csrf-token": "token-123"
    }
  });
  assert.equal(validateCsrf(validRequest), null);

  const missingRequest = new Request("http://packetchat.test");
  assert.equal(validateCsrf(missingRequest), "Missing CSRF token");

  const mismatchedRequest = new Request("http://packetchat.test", {
    headers: {
      cookie: "packetchat_csrf=token-123",
      "x-csrf-token": "token-456"
    }
  });
  assert.equal(validateCsrf(mismatchedRequest), "Invalid CSRF token");
});
