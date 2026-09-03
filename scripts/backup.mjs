#!/usr/bin/env node

import { createWriteStream, mkdirSync, readFileSync, renameSync, unlinkSync } from "node:fs";
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

// docker-compose.yml pins `name: packetchat`, so the volume name is deterministic.
function minioVolumeName() {
  return process.env.PACKETCHAT_MINIO_VOLUME || "packetchat_minio-data";
}

function dockerRun(args, outputPath) {
  return runDocker(args, outputPath);
}

function dockerCompose(args, outputPath) {
  return runDocker(["compose", "--env-file", envFile, "-f", composeFile, ...args], outputPath);
}

function runDocker(args, outputPath) {
  mkdirSync(dirname(outputPath), { recursive: true });
  const tempPath = `${outputPath}.tmp-${process.pid}`;
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      try {
        unlinkSync(tempPath);
      } catch {
        /* temp file may not exist */
      }
      reject(error);
    };
    const child = spawn("docker", args, {
      cwd: root,
      stdio: ["ignore", "pipe", "inherit"]
    });
    const output = createWriteStream(tempPath, { flags: "wx" });

    child.stdout.pipe(output);
    child.on("error", fail);
    output.on("error", fail);
    child.on("close", (code) => {
      output.end();
      output.once("finish", () => {
        if (settled) return;
        if (code !== 0) {
          fail(new Error(`docker compose ${args.join(" ")} exited with ${code}`));
          return;
        }
        try {
          renameSync(tempPath, outputPath);
          settled = true;
          resolve(outputPath);
        } catch (error) {
          fail(error);
        }
      });
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
  // The MinIO image has no tar, so `compose exec minio tar` exits 127 and the
  // archive silently failed. Mount the volume into a throwaway busybox instead.
  await dockerRun(
    ["run", "--rm", "-v", `${minioVolumeName()}:/data:ro`, "busybox:stable", "tar", "-C", "/data", "-cf", "-", "."],
    output
  );
  console.log(`MinIO data backup written to ${output}`);
}

if (!["all", "postgres", "minio"].includes(mode)) {
  throw new Error("Usage: node scripts/backup.mjs [all|postgres|minio]");
}

if (mode === "all" || mode === "postgres") await backupPostgres();
if (mode === "all" || mode === "minio") await backupMinio();
