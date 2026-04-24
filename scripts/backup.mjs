#!/usr/bin/env node

import { createWriteStream, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";

const mode = process.argv[2] || "all";
const root = process.cwd();
const envFile = process.env.PACKETCHAT_ENV_FILE || ".env";
const composeFile = process.env.PACKETCHAT_COMPOSE_FILE || "infrastructure/compose/docker-compose.yml";
const backupDir = process.env.PACKETCHAT_BACKUP_DIR || "backups";
const stamp = new Date().toISOString().replace(/[:.]/g, "-");

function readEnv(path) {
  const env = {};
  try {
    const content = readFileSync(path, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const index = trimmed.indexOf("=");
      if (index === -1) continue;
      const key = trimmed.slice(0, index).trim();
      const value = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, "");
      env[key] = value;
    }
  } catch {
    // Compose still receives --env-file; defaults below match docker-compose.yml.
  }
  return env;
}

function dockerCompose(args, outputPath) {
  mkdirSync(dirname(outputPath), { recursive: true });
  return new Promise((resolve, reject) => {
    const child = spawn("docker", ["compose", "--env-file", envFile, "-f", composeFile, ...args], {
      cwd: root,
      stdio: ["ignore", "pipe", "inherit"]
    });
    const output = createWriteStream(outputPath, { flags: "wx" });

    child.stdout.pipe(output);
    child.on("error", reject);
    output.on("error", reject);
    child.on("close", (code) => {
      output.end();
      if (code === 0) resolve(outputPath);
      else reject(new Error(`docker compose ${args.join(" ")} exited with ${code}`));
    });
  });
}

async function backupPostgres() {
  const env = readEnv(envFile);
  const db = env.POSTGRES_DB || "packetchat";
  const user = env.POSTGRES_USER || "packetchat";
  const output = join(backupDir, `${stamp}-postgres.dump`);
  await dockerCompose(["exec", "-T", "postgres", "pg_dump", "-U", user, "-d", db, "-Fc"], output);
  console.log(`Postgres backup written to ${output}`);
}

async function backupMinio() {
  const output = join(backupDir, `${stamp}-minio-data.tar`);
  await dockerCompose(["exec", "-T", "minio", "tar", "-C", "/data", "-cf", "-", "."], output);
  console.log(`MinIO data backup written to ${output}`);
}

if (!["all", "postgres", "minio"].includes(mode)) {
  throw new Error("Usage: node scripts/backup.mjs [all|postgres|minio]");
}

if (mode === "all" || mode === "postgres") await backupPostgres();
if (mode === "all" || mode === "minio") await backupMinio();
