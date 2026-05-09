import assert from "node:assert/strict";
import { test } from "node:test";
import { parseConfig } from "../src/index";

const validProductionEnv: NodeJS.ProcessEnv = {
  NODE_ENV: "production",
  APP_ENV: "production",
  APP_BASE_URL: "https://chat.example.test",
  APP_TRUSTED_PROXY: "true",
  DATABASE_URL: "postgres://packetchat:strong-prod-password@postgres:5432/packetchat",
  REDIS_URL: "redis://redis:6379",
  S3_ENDPOINT: "https://s3.example.test",
  S3_REGION: "us-east-1",
  S3_ACCESS_KEY: "prod-access-key-2026",
  S3_SECRET_KEY: "prod-storage-secret-2026",
  S3_BUCKET_UPLOADS: "packetchat-uploads",
  S3_BUCKET_EXPORTS: "packetchat-exports",
  S3_BUCKET_ARTIFACTS: "packetchat-artifacts",
  COOKIE_SECURE: "true",
  BOOTSTRAP_TOKEN: "prod-bootstrap-token-2026",
  ENCRYPTION_KEY_BASE64: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWc=",
  JWT_SECRET: "prod-jwt-secret-with-at-least-32-bytes"
};

test("parseConfig accepts hardened production configuration", () => {
  const config = parseConfig(validProductionEnv);
  assert.equal(config.APP_ENV, "production");
  assert.equal(config.APP_BASE_URL, "https://chat.example.test");
  assert.equal(config.COOKIE_SECURE, true);
});

test("parseConfig rejects insecure production transport settings", () => {
  assert.throws(
    () => parseConfig({ ...validProductionEnv, APP_BASE_URL: "http://chat.example.test", COOKIE_SECURE: "false" } as NodeJS.ProcessEnv),
    /APP_BASE_URL must use https in production; COOKIE_SECURE must be true in production/
  );
});

test("parseConfig rejects placeholder production secrets", () => {
  assert.throws(
    () =>
      parseConfig({
        ...validProductionEnv,
        BOOTSTRAP_TOKEN: "change-me-before-deploy",
        ENCRYPTION_KEY_BASE64: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
        JWT_SECRET: "replace-with-long-random-jwt-secret",
        S3_SECRET_KEY: "packetchat_dev_secret"
      } as NodeJS.ProcessEnv),
    /BOOTSTRAP_TOKEN must not use a placeholder.*ENCRYPTION_KEY_BASE64 must not use a placeholder.*JWT_SECRET must not use a placeholder.*S3_SECRET_KEY must not use a placeholder/
  );
});
