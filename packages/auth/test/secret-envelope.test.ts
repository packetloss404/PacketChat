import assert from "node:assert/strict";
import { test } from "node:test";

// getConfig() reads these lazily on first use, so setting them here is enough.
process.env.DATABASE_URL ??= "postgres://localhost:5432/packetchat_test";
process.env.REDIS_URL ??= "redis://localhost:6379";
process.env.S3_ENDPOINT ??= "http://localhost:9000";
process.env.S3_ACCESS_KEY ??= "test-access";
process.env.S3_SECRET_KEY ??= "test-secret";
process.env.S3_BUCKET_UPLOADS ??= "uploads";
process.env.S3_BUCKET_EXPORTS ??= "exports";
process.env.S3_BUCKET_ARTIFACTS ??= "artifacts";
process.env.BOOTSTRAP_TOKEN ??= "test-bootstrap-token-value";
process.env.JWT_SECRET ??= "test-jwt-secret-that-is-long-enough";
process.env.ENCRYPTION_KEY_BASE64 ??= Buffer.alloc(32, 5).toString("base64");

import { decryptJsonSecret, encryptJsonSecret } from "../src/index";

test("a secret envelope round-trips through encrypt/decrypt", () => {
  const envelope = encryptJsonSecret({ apiKey: "sk-test-123" });
  assert.deepEqual(decryptJsonSecret<{ apiKey: string }>(envelope), { apiKey: "sk-test-123" });
});

test("a legacy stringified envelope still decrypts", () => {
  const envelope = encryptJsonSecret({ apiKey: "sk-legacy-456" });
  // Provider routes used to store `JSON.stringify(envelope)::jsonb`, which
  // Postgres reads back as a JSON string rather than an object. The reader must
  // keep accepting that shape so an account created before the fix still works.
  const legacy = JSON.stringify(envelope) as unknown as Record<string, string>;
  assert.deepEqual(decryptJsonSecret<{ apiKey: string }>(legacy), { apiKey: "sk-legacy-456" });
});

test("a malformed envelope fails with a clear message", () => {
  assert.throws(() => decryptJsonSecret({} as Record<string, string>), /Encrypted payload is missing iv/);
  assert.throws(() => decryptJsonSecret("not json" as unknown as Record<string, string>), /not a secret envelope/);
  assert.throws(() => decryptJsonSecret({ iv: "a", tag: "b" } as Record<string, string>), /missing ciphertext/);
});
