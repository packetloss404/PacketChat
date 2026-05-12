#!/usr/bin/env node

import { statSync, readSync, openSync, closeSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { spawn } from "node:child_process";

const backupDir = process.env.PACKETCHAT_BACKUP_DIR || "backups";
const args = process.argv.slice(2);

function usage() {
  return [
    "Usage: node scripts/restore-check.mjs [--postgres path] [--minio path] [--skip-list]",
    "Defaults:",
    `  --postgres newest *-postgres.dump in ${backupDir}`,
    `  --minio newest *-minio-data.tar in ${backupDir}`,
    "Set PACKETCHAT_BACKUP_DIR to change the default backup directory."
  ].join("\n");
}

function parseArgs(values) {
  const options = {
    postgres: null,
    minio: null,
    list: true
  };

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--help" || value === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if (value === "--skip-list") {
      options.list = false;
      continue;
    }
    if (value === "--postgres" || value === "--minio") {
      const path = values[index + 1];
      if (!path) throw new Error(`${value} requires a path`);
      options[value.slice(2)] = path;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${value}\n${usage()}`);
  }

  return options;
}

function latestBackup(suffix) {
  let entries;
  try {
    entries = readdirSync(backupDir, { withFileTypes: true });
  } catch {
    return null;
  }

  const matches = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
    .map((entry) => {
      const path = join(backupDir, entry.name);
      return { path, mtimeMs: statSync(path).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  return matches[0]?.path ?? null;
}

function resolveDefaults(options) {
  return {
    ...options,
    postgres: options.postgres || latestBackup("-postgres.dump") || join(backupDir, "latest-postgres.dump"),
    minio: options.minio || latestBackup("-minio-data.tar") || join(backupDir, "latest-minio-data.tar")
  };
}

function readBytes(path, length, offset = 0) {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    const bytesRead = readSync(fd, buffer, 0, length, offset);
    return buffer.subarray(0, bytesRead);
  } finally {
    closeSync(fd);
  }
}

function assertFile(path, label) {
  let stats;
  try {
    stats = statSync(path);
  } catch (error) {
    throw new Error(`${label} backup not found at ${path}`);
  }
  if (!stats.isFile()) throw new Error(`${label} backup is not a file: ${path}`);
  if (stats.size === 0) throw new Error(`${label} backup is empty: ${path}`);
  return stats;
}

function checkPostgres(path) {
  const stats = assertFile(path, "Postgres");
  const header = readBytes(path, 5).toString("ascii");
  if (header !== "PGDMP") {
    throw new Error(`Postgres backup ${path} is not a pg_dump custom-format file; expected PGDMP header`);
  }
  console.log(`Postgres artifact ok: ${path} (${stats.size} bytes)`);
}

function checkTar(path) {
  const stats = assertFile(path, "MinIO tar");
  const magic = readBytes(path, 5, 257).toString("ascii");
  if (magic !== "ustar") {
    throw new Error(`MinIO backup ${path} is not a POSIX tar archive; expected ustar magic`);
  }
  console.log(`MinIO artifact ok: ${path} (${stats.size} bytes)`);
}

function run(command, argsForCommand) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argsForCommand, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} ${argsForCommand.join(" ")} exited with ${code}: ${stderr.trim()}`));
    });
  });
}

async function optionalList(options) {
  if (!options.list) return;

  try {
    const postgresList = await run("pg_restore", ["--list", options.postgres]);
    const postgresEntries = postgresList.stdout.split(/\r?\n/).filter((line) => line.trim() && !line.startsWith(";")).length;
    if (postgresEntries === 0) throw new Error("pg_restore --list returned no restore entries");
    console.log(`Postgres restore catalog ok: ${postgresEntries} entries`);
  } catch (error) {
    throw new Error(`Postgres catalog list failed. Install pg_restore or pass --skip-list for artifact-only checks. ${error.message}`);
  }

  try {
    const tarList = await run("tar", ["-tf", options.minio]);
    const minioEntries = tarList.stdout.split(/\r?\n/).filter(Boolean).length;
    if (minioEntries === 0) throw new Error("tar -tf returned no entries");
    console.log(`MinIO tar catalog ok: ${minioEntries} entries`);
  } catch (error) {
    throw new Error(`MinIO tar catalog list failed. Install tar or pass --skip-list for artifact-only checks. ${error.message}`);
  }
}

const options = resolveDefaults(parseArgs(args));
console.log("Restore check is read-only; it does not create databases, buckets, containers, or volumes.");
checkPostgres(options.postgres);
checkTar(options.minio);
await optionalList(options);
console.log(`Restore artifacts passed non-destructive checks: ${basename(options.postgres)}, ${basename(options.minio)}`);
