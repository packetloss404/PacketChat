import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getSql, closeDatabase } from "./index";
import { logger } from "@packetchat/observability";

const currentDir = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(currentDir, "migrations");

async function runMigrations() {
  const sql = getSql();
  await sql`
    create table if not exists _migrations (
      id text primary key,
      applied_at timestamptz not null default now()
    )
  `;

  const appliedRows = await sql<{ id: string }[]>`select id from _migrations`;
  const applied = new Set(appliedRows.map((row) => row.id));
  const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    const migration = await readFile(join(migrationsDir, file), "utf8");
    logger.info("Applying migration", { migration: file });
    await sql.begin(async (tx) => {
      await tx.unsafe(migration);
      await tx`insert into _migrations (id) values (${file})`;
    });
  }

  logger.info("Migrations complete", { applied: files.length });
}

runMigrations()
  .catch((error) => {
    logger.error("Migration failed", { error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDatabase();
  });
