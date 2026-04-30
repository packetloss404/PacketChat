import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { closeDatabase, getSql } from "@packetchat/db";
import { createSession, hashOpaqueToken, rotateRefreshToken } from "../src/index";

const databaseUrl = process.env.AUTH_DB_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const runDatabaseTests = process.env.PACKETCHAT_AUTH_DB_TEST === "1" && Boolean(databaseUrl);

if (databaseUrl && !process.env.DATABASE_URL) {
  process.env.DATABASE_URL = databaseUrl;
}

process.env.APP_ENV ??= "test";
process.env.REDIS_URL ??= "redis://localhost:6379";
process.env.S3_ENDPOINT ??= "http://localhost:9000";
process.env.S3_REGION ??= "us-east-1";
process.env.S3_ACCESS_KEY ??= "test";
process.env.S3_SECRET_KEY ??= "test";
process.env.S3_BUCKET_UPLOADS ??= "test-uploads";
process.env.S3_BUCKET_EXPORTS ??= "test-exports";
process.env.S3_BUCKET_ARTIFACTS ??= "test-artifacts";
process.env.BOOTSTRAP_TOKEN ??= "test-bootstrap-token";
process.env.ENCRYPTION_KEY_BASE64 ??= "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";
process.env.JWT_SECRET ??= "test-jwt-secret-with-at-least-32-bytes";
process.env.REFRESH_TOKEN_TTL_SECONDS ??= "1209600";
process.env.SESSION_IDLE_TIMEOUT_SECONDS ??= "86400";

after(async () => {
  await closeDatabase();
});

test(
  "concurrent refresh token rotation only succeeds once",
  { skip: runDatabaseTests ? false : "set PACKETCHAT_AUTH_DB_TEST=1 and DATABASE_URL or AUTH_DB_TEST_DATABASE_URL to run" },
  async () => {
    const sql = getSql();
    const email = `refresh-race-${randomUUID()}@example.test`;
    let userId: string | undefined;
    let sessionId: string | undefined;

    try {
      const users = await sql<{ id: string }[]>`
        insert into users (email, display_name, role, status)
        values (${email}, 'Refresh Race', 'user', 'active')
        returning id
      `;
      userId = users[0]?.id;
      assert.ok(userId, "test user should be created");

      const session = await createSession({
        userId,
        role: "user",
        authMethod: "local",
        ipAddress: "127.0.0.1",
        userAgent: "node:test"
      });
      sessionId = session.sessionId;

      const attempts = await Promise.all(
        Array.from({ length: 8 }, () => rotateRefreshToken(session.refreshToken))
      );

      const successful = attempts.filter((result) => result !== null);
      assert.equal(successful.length, 1, "exactly one concurrent rotation should mint replacement tokens");
      assert.ok(successful[0]?.accessToken);
      assert.ok(successful[0]?.refreshToken);
      assert.notEqual(successful[0]?.refreshToken, session.refreshToken);

      const tokenRows = await sql<
        {
          parent_token_id: string | null;
          used_at: Date | null;
          revoked_at: Date | null;
          reuse_detected_at: Date | null;
        }[]
      >`
        select child.parent_token_id, original.used_at, original.revoked_at, original.reuse_detected_at
        from refresh_tokens original
        left join refresh_tokens child on child.parent_token_id = original.id
        where original.token_hash = ${hashOpaqueToken(session.refreshToken)}
      `;

      assert.equal(tokenRows.length, 1, "the original token should have exactly one child token");
      assert.ok(tokenRows[0]?.parent_token_id, "the replacement token should point at the original token");
      assert.ok(tokenRows[0]?.used_at, "the original token should be marked used");
      assert.ok(tokenRows[0]?.revoked_at, "the original token should be revoked after rotation");
      assert.ok(tokenRows[0]?.reuse_detected_at, "losing concurrent rotations should be recorded as reuse");
    } finally {
      if (userId) {
        await sql`delete from users where id = ${userId}`;
      } else if (sessionId) {
        await sql`delete from sessions where id = ${sessionId}`;
      }
    }
  }
);
