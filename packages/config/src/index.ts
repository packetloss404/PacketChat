import { z } from "zod";

const boolFromString = z
  .union([z.boolean(), z.string()])
  .optional()
  .transform((value) => {
    if (typeof value === "boolean") return value;
    if (typeof value === "string") return ["1", "true", "yes", "on"].includes(value.toLowerCase());
    return false;
  });

// Unset and empty are both "not configured": an operator who comments out or
// blanks an optional numeric setting should get the default, not a boot failure.
const numberFromString = (fallback: number) =>
  z
    .union([z.number(), z.string()])
    .optional()
    .transform((value) => {
      if (typeof value === "number") return value;
      if (typeof value === "string" && value.trim() !== "") return Number(value);
      return fallback;
    })
    .pipe(z.number().int().positive());

const configSchema = z.object({
  APP_ENV: z.enum(["development", "test", "staging", "production"]).default("development"),
  APP_BASE_URL: z.string().url().default("http://localhost:3000"),
  APP_TRUSTED_PROXY: boolFromString.default(false),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  S3_ENDPOINT: z.string().url(),
  S3_REGION: z.string().min(1).default("us-east-1"),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_BUCKET_UPLOADS: z.string().min(1),
  S3_BUCKET_EXPORTS: z.string().min(1),
  S3_BUCKET_ARTIFACTS: z.string().min(1),
  S3_FORCE_PATH_STYLE: boolFromString.default(true),
  COOKIE_SECURE: boolFromString.default(false),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(600),
  REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(1_209_600),
  SESSION_IDLE_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(86_400),
  PASSWORD_RESET_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(3_600),
  INVITE_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(604_800),
  PASSWORD_MIN_LENGTH: z.coerce.number().int().min(8).default(12),
  BOOTSTRAP_TOKEN: z.string().min(16),
  ENCRYPTION_KEY_BASE64: z.string().min(32),
  JWT_SECRET: z.string().min(32),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(2),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(52_428_800),
  RATE_LIMIT_AUTH_PER_MINUTE: z.coerce.number().int().positive().default(20),
  RATE_LIMIT_CHAT_PER_MINUTE: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_FILE_UPLOAD_PER_MINUTE: z.coerce.number().int().positive().default(20),
  EMAIL_PROVIDER: z.enum(["manual", "resend", "smtp"]).default("manual"),
  RESEND_API_KEY: z.string().optional().default(""),
  EMAIL_FROM: z.string().optional().default("PacketChat <noreply@example.com>"),
  EMAIL_SEND_TIMEOUT_MS: numberFromString(10_000),
  SMTP_HOST: z.string().optional().default(""),
  SMTP_PORT: numberFromString(587),
  SMTP_SECURE: boolFromString.default(false),
  SMTP_USER: z.string().optional().default(""),
  SMTP_PASSWORD: z.string().optional().default(""),
  SMTP_REJECT_UNAUTHORIZED: boolFromString.default(true)
});

export type PacketChatConfig = z.infer<typeof configSchema>;

let cachedConfig: PacketChatConfig | undefined;

export function parseConfig(env: NodeJS.ProcessEnv = process.env): PacketChatConfig {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new Error(`Invalid PacketChat configuration: ${details}`);
  }

  const productionIssues = validateProductionConfig(parsed.data);
  if (productionIssues.length > 0) {
    throw new Error(`Invalid PacketChat production configuration: ${productionIssues.join("; ")}`);
  }

  return parsed.data;
}

export function getConfig(env: NodeJS.ProcessEnv = process.env): PacketChatConfig {
  if (cachedConfig) return cachedConfig;

  cachedConfig = parseConfig(env);
  return cachedConfig;
}

export function isProduction(config = getConfig()): boolean {
  return config.APP_ENV === "production";
}

export function validateProductionConfig(config: PacketChatConfig): string[] {
  if (config.APP_ENV !== "production") return [];

  const issues: string[] = [];
  const baseUrl = new URL(config.APP_BASE_URL);
  if (baseUrl.protocol !== "https:") issues.push("APP_BASE_URL must use https in production");
  if (!config.COOKIE_SECURE) issues.push("COOKIE_SECURE must be true in production");

  for (const [key, value] of Object.entries({
    BOOTSTRAP_TOKEN: config.BOOTSTRAP_TOKEN,
    ENCRYPTION_KEY_BASE64: config.ENCRYPTION_KEY_BASE64,
    JWT_SECRET: config.JWT_SECRET,
    S3_ACCESS_KEY: config.S3_ACCESS_KEY,
    S3_SECRET_KEY: config.S3_SECRET_KEY
  })) {
    if (isPlaceholderSecret(value)) issues.push(`${key} must not use a placeholder or development value in production`);
  }

  return issues;
}

function isPlaceholderSecret(value: string): boolean {
  const normalized = value.toLowerCase();
  return [
    "change-me",
    "replace-with",
    "placeholder",
    "example",
    "packetchat_dev",
    "dev_secret",
    "dev_password",
    "test-secret",
    "test-",
    "mdeymzq1njc4owfiy2rlzjaxmjm0nty3odlhymnkzwy=",
    "0123456789abcdef0123456789abcdef"
  ].some((marker) => normalized.includes(marker));
}
