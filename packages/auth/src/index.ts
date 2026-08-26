import { randomBytes, randomUUID, createHash, createCipheriv, createDecipheriv } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { hash, verify } from "@node-rs/argon2";
import { getConfig } from "@packetchat/config";
import { getSql, recordAuditEvent } from "@packetchat/db";

export const refreshCookieName = "packetchat_refresh";

export type AuthEmailDelivery = {
  provider: "manual" | "resend";
  status: "manual" | "sent" | "failed";
  id?: string;
  message?: string;
};

export type AuthenticatedUser = {
  id: string;
  email: string;
  displayName: string;
  role: "admin" | "user";
  sessionId: string;
};

export class AuthError extends Error {
  constructor(
    message: string,
    public readonly status: 401 | 403
  ) {
    super(message);
    this.name = "AuthError";
  }
}

export function isAuthError(error: unknown): error is AuthError {
  return error instanceof AuthError;
}

type UserRow = {
  id: string;
  email: string;
  display_name: string;
  role: "admin" | "user";
  password_hash: string;
  force_reset: boolean;
};

export function createOpaqueToken(byteLength = 32): string {
  return randomBytes(byteLength).toString("base64url");
}

export function hashOpaqueToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function hashPassword(password: string): Promise<string> {
  return hash(password, {
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1
  });
}

export function validatePasswordPolicy(password: string): string[] {
  const config = getConfig();
  const failures: string[] = [];

  if (password.length < config.PASSWORD_MIN_LENGTH) failures.push(`Password must be at least ${config.PASSWORD_MIN_LENGTH} characters long`);
  if (!/[a-z]/.test(password)) failures.push("Password must include a lowercase letter");
  if (!/[A-Z]/.test(password)) failures.push("Password must include an uppercase letter");
  if (!/[0-9]/.test(password)) failures.push("Password must include a number");
  if (!/[^A-Za-z0-9]/.test(password)) failures.push("Password must include a symbol");
  if (/\s/.test(password)) failures.push("Password must not contain whitespace");

  return failures;
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  return verify(passwordHash, password);
}

function jwtSecret(): Uint8Array {
  return new TextEncoder().encode(getConfig().JWT_SECRET);
}

export async function signAccessToken(input: {
  userId: string;
  sessionId: string;
  role: "admin" | "user";
  authMethod: "local";
}) {
  const config = getConfig();
  const ttl = config.ACCESS_TOKEN_TTL_SECONDS;

  return new SignJWT({ role: input.role, auth_method: input.authMethod, sid: input.sessionId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setJti(randomUUID())
    .setSubject(input.userId)
    .setAudience("packetchat")
    .setIssuer("packetchat")
    .setExpirationTime(`${ttl}s`)
    .sign(jwtSecret());
}

export async function verifyAccessToken(token: string): Promise<{ userId: string; sessionId: string; role: "admin" | "user" }> {
  const { payload } = await jwtVerify(token, jwtSecret(), {
    audience: "packetchat",
    issuer: "packetchat"
  });

  if (!payload.sub || typeof payload.sid !== "string") {
    throw new Error("Invalid token payload");
  }

  const role = payload.role === "admin" ? "admin" : "user";
  return { userId: payload.sub, sessionId: payload.sid, role };
}

export function bearerTokenFromHeaders(headers: Headers): string | null {
  const header = headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length).trim();
}

export async function authenticateRequest(headers: Headers): Promise<AuthenticatedUser | null> {
  const token = bearerTokenFromHeaders(headers);
  if (!token) return null;

  const verified = await verifyAccessToken(token).catch(() => null);
  if (!verified) return null;

  const sql = getSql();
  const config = getConfig();
  const rows = await sql<AuthenticatedUser[]>`
    select
      u.id,
      u.email,
      u.display_name as "displayName",
      u.role,
      s.id as "sessionId"
    from users u
    join sessions s on s.user_id = u.id
    where u.id = ${verified.userId}
      and s.id = ${verified.sessionId}
      and u.status = 'active'
      and s.revoked_at is null
      and s.expires_at > now()
      and s.last_seen_at > now() - (${config.SESSION_IDLE_TIMEOUT_SECONDS} || ' seconds')::interval
    limit 1
  `;

  const user = rows[0] ?? null;
  if (user) await sql`update sessions set last_seen_at = now() where id = ${user.sessionId}`;
  return user;
}

export async function requireAdmin(headers: Headers): Promise<AuthenticatedUser> {
  const user = await authenticateRequest(headers);
  if (!user) throw new AuthError("Authentication required", 401);
  if (user.role !== "admin") throw new AuthError("Admin authorization required", 403);
  return user;
}

export async function createSession(input: {
  userId: string;
  role: "admin" | "user";
  authMethod: "local";
  ipAddress?: string | null;
  userAgent?: string | null;
}) {
  const config = getConfig();
  const sql = getSql();
  const refreshToken = createOpaqueToken(48);
  const refreshTokenHash = hashOpaqueToken(refreshToken);
  const familyId = randomUUID();
  const sessionLifetimeSeconds = config.REFRESH_TOKEN_TTL_SECONDS;

  const sessionRows = await sql<{ id: string }[]>`
    insert into sessions (user_id, auth_method, ip_address, user_agent, expires_at)
    values (${input.userId}, ${input.authMethod}, ${input.ipAddress ?? null}, ${input.userAgent ?? null}, now() + (${sessionLifetimeSeconds} || ' seconds')::interval)
    returning id
  `;

  const sessionId = sessionRows[0]?.id;
  if (!sessionId) throw new Error("Session creation failed");

  await sql`
    insert into refresh_tokens (session_id, family_id, token_hash, expires_at)
    values (${sessionId}, ${familyId}, ${refreshTokenHash}, now() + (${sessionLifetimeSeconds} || ' seconds')::interval)
  `;

  const accessToken = await signAccessToken({
    userId: input.userId,
    sessionId,
    role: input.role,
    authMethod: input.authMethod
  });

  return { accessToken, refreshToken, sessionId, refreshTokenMaxAge: sessionLifetimeSeconds };
}

export async function loginWithPassword(input: {
  email: string;
  password: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}) {
  const sql = getSql();
  const rows = await sql<UserRow[]>`
    select
      u.id,
      u.email,
      u.display_name,
      u.role,
      pc.password_hash,
      pc.force_reset
    from users u
    join password_credentials pc on pc.user_id = u.id
    where lower(u.email) = lower(${input.email})
      and u.status = 'active'
    limit 1
  `;

  const row = rows[0];
  if (!row || !(await verifyPassword(row.password_hash, input.password))) {
    await recordAuditEvent({ action: "auth.login.failure", outcome: "failure", metadata: { email: input.email } });
    return null;
  }

  if (row.force_reset) {
    await recordAuditEvent({
      actorUserId: row.id,
      action: "auth.login.failure",
      outcome: "failure",
      targetType: "user",
      targetId: row.id,
      metadata: { email: input.email, reason: "force_reset" }
    });
    throw new AuthError("Password reset required", 403);
  }

  await sql`update users set last_login_at = now(), updated_at = now() where id = ${row.id}`;
  const authMethod = "local" as const;
  const tokens = await createSession({
    userId: row.id,
    role: row.role,
    authMethod,
    ipAddress: input.ipAddress,
    userAgent: input.userAgent
  });

  await recordAuditEvent({
    actorUserId: row.id,
    action: "auth.login.success",
    targetType: "user",
    targetId: row.id,
    metadata: { authMethod }
  });

  return {
    user: {
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      role: row.role
    },
    ...tokens
  };
}

export async function rotateRefreshToken(refreshToken: string) {
  const sql = getSql();
  const tokenHash = hashOpaqueToken(refreshToken);
  const config = getConfig();

  const rotation = await sql.begin(async (tx) => {
    const rows = await tx<{
      id: string;
      session_id: string;
      family_id: string;
      user_id: string;
      role: "admin" | "user";
      auth_method: "local";
      used_at: Date | null;
      revoked_at: Date | null;
    }[]>`
    select rt.id, rt.session_id, rt.family_id, s.user_id, u.role, s.auth_method, rt.used_at, rt.revoked_at
    from refresh_tokens rt
    join sessions s on s.id = rt.session_id
    join users u on u.id = s.user_id
    where rt.token_hash = ${tokenHash}
      and rt.expires_at > now()
      and s.revoked_at is null
      and s.expires_at > now()
      and s.last_seen_at > now() - (${config.SESSION_IDLE_TIMEOUT_SECONDS} || ' seconds')::interval
      and u.status = 'active'
    limit 1
    for update of rt
  `;

    const existing = rows[0];
    if (!existing) return { kind: "none" as const };

    if (existing.used_at) {
      await tx`update refresh_tokens set reuse_detected_at = now(), revoked_at = now() where family_id = ${existing.family_id}`;
      await tx`update sessions set revoked_at = now(), revoked_reason = 'refresh token reuse' where id = ${existing.session_id}`;
      return { kind: "reused" as const, existing };
    }

    if (existing.revoked_at) return { kind: "none" as const };

    const newRefreshToken = createOpaqueToken(48);
    const newHash = hashOpaqueToken(newRefreshToken);
    const ttl = config.REFRESH_TOKEN_TTL_SECONDS;
    await tx`update refresh_tokens set used_at = now(), revoked_at = now() where id = ${existing.id}`;
    await tx`
      insert into refresh_tokens (session_id, family_id, token_hash, parent_token_id, expires_at)
      values (${existing.session_id}, ${existing.family_id}, ${newHash}, ${existing.id}, now() + (${ttl} || ' seconds')::interval)
    `;
    await tx`update sessions set last_seen_at = now() where id = ${existing.session_id}`;
    return { kind: "rotated" as const, existing, refreshToken: newRefreshToken, ttl };
  });

  if (rotation.kind === "none") return null;

  if (rotation.kind === "reused") {
    await recordAuditEvent({ actorUserId: rotation.existing.user_id, action: "auth.refresh.reused", outcome: "failure", targetType: "session", targetId: rotation.existing.session_id });
    return null;
  }

  const accessToken = await signAccessToken({
    userId: rotation.existing.user_id,
    sessionId: rotation.existing.session_id,
    role: rotation.existing.role,
    authMethod: rotation.existing.auth_method
  });

  return { accessToken, refreshToken: rotation.refreshToken, refreshTokenMaxAge: rotation.ttl };
}

export async function revokeSession(sessionId: string): Promise<void> {
  const sql = getSql();
  await sql.begin(async (tx) => {
    await tx`update sessions set revoked_at = now(), revoked_reason = 'logout' where id = ${sessionId} and revoked_at is null`;
    await tx`update refresh_tokens set revoked_at = now() where session_id = ${sessionId} and revoked_at is null`;
  });
}

export async function revokeSessionByRefreshToken(refreshToken: string): Promise<void> {
  const sql = getSql();
  const tokenHash = hashOpaqueToken(refreshToken);
  const rows = await sql<{ session_id: string }[]>`
    select session_id
    from refresh_tokens
    where token_hash = ${tokenHash}
    limit 1
  `;

  const sessionId = rows[0]?.session_id;
  if (sessionId) await revokeSession(sessionId);
}

export async function sendAuthEmail(input: {
  to: string;
  kind: "invite" | "password_reset";
  url: string;
  expiresSeconds: number;
}): Promise<AuthEmailDelivery> {
  const config = getConfig();
  if (config.EMAIL_PROVIDER !== "resend") return { provider: config.EMAIL_PROVIDER, status: "manual" };
  if (!config.RESEND_API_KEY) return { provider: "manual", status: "manual", message: "RESEND_API_KEY is not configured" };

  const isInvite = input.kind === "invite";
  const subject = isInvite ? "Accept your PacketChat invite" : "Reset your PacketChat password";
  const expiry = formatDuration(input.expiresSeconds);
  const action = isInvite ? "accept your invite" : "reset your password";
  const text = `Use this link to ${action}:\n\n${input.url}\n\nThis link expires in ${expiry}. If you did not expect this email, ignore it.`;
  const html = `<p>Use this link to ${action}:</p><p><a href="${escapeHtml(input.url)}">${escapeHtml(subject)}</a></p><p>This link expires in ${escapeHtml(expiry)}. If you did not expect this email, ignore it.</p>`;

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.RESEND_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ from: config.EMAIL_FROM, to: input.to, subject, text, html })
    });

    if (!response.ok) return { provider: "resend", status: "failed", message: `Resend returned ${response.status}` };

    const data = (await response.json().catch(() => null)) as { id?: string } | null;
    return { provider: "resend", status: "sent", id: data?.id };
  } catch {
    return { provider: "resend", status: "failed", message: "Resend request failed" };
  }
}

function formatDuration(seconds: number): string {
  if (seconds % 86_400 === 0) return `${seconds / 86_400} day${seconds === 86_400 ? "" : "s"}`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600} hour${seconds === 3_600 ? "" : "s"}`;
  return `${Math.ceil(seconds / 60)} minutes`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function encryptJsonSecret(value: unknown): Record<string, string> {
  const key = Buffer.from(getConfig().ENCRYPTION_KEY_BASE64, "base64");
  if (key.byteLength !== 32) throw new Error("ENCRYPTION_KEY_BASE64 must decode to 32 bytes");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    alg: "A256GCM",
    iv: iv.toString("base64url"),
    tag: tag.toString("base64url"),
    ciphertext: encrypted.toString("base64url")
  };
}

export function decryptJsonSecret<T>(payload: Record<string, string>): T {
  const key = Buffer.from(getConfig().ENCRYPTION_KEY_BASE64, "base64");
  if (key.byteLength !== 32) throw new Error("ENCRYPTION_KEY_BASE64 must decode to 32 bytes");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(payload.iv, "base64url"));
  decipher.setAuthTag(Buffer.from(payload.tag, "base64url"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, "base64url")),
    decipher.final()
  ]);
  return JSON.parse(decrypted.toString("utf8")) as T;
}
