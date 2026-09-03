import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import postgres from "postgres";

// Integration tests run only when TEST_DATABASE_URL is set. They are skipped
// otherwise so `npm test` stays runnable with no Docker, while CI and anyone
// with a local database gets the real SQL exercised rather than a fake of it.
//
// TEST_DATABASE_URL must never point at a database you care about: each run
// creates its own schema and drops it afterwards, but the connection still has
// whatever rights the URL grants.
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
export const hasTestDatabase = TEST_DATABASE_URL.length > 0;
export const skipWithoutDatabase = { skip: hasTestDatabase ? false : "TEST_DATABASE_URL is not set" };

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "migrations");

export async function listMigrations(): Promise<string[]> {
  return (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
}

export type TestDatabase = {
  sql: postgres.Sql;
  schema: string;
  close: () => Promise<void>;
};

/**
 * Opens a connection whose search_path is an empty schema of its own, applies
 * every migration into it, and hands back the client. Migrations reference
 * unqualified table names, so they land in that schema and cannot collide with
 * another test run or with anything already in the database.
 */
export async function createTestDatabase(): Promise<TestDatabase> {
  const schema = `pc_test_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const admin = postgres(TEST_DATABASE_URL, { max: 1, prepare: false });

  try {
    await admin.unsafe(`create schema "${schema}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }

  const sql = postgres(TEST_DATABASE_URL, {
    max: 2,
    prepare: false,
    connection: { search_path: `${schema},public` }
  });

  for (const file of await listMigrations()) {
    const migration = await readFile(join(migrationsDir, file), "utf8");
    await sql.begin(async (tx) => {
      await tx.unsafe(migration);
    });
  }

  return {
    sql,
    schema,
    close: async () => {
      await sql.end({ timeout: 5 });
      const cleanup = postgres(TEST_DATABASE_URL, { max: 1, prepare: false });
      try {
        await cleanup.unsafe(`drop schema if exists "${schema}" cascade`);
      } finally {
        await cleanup.end({ timeout: 5 });
      }
    }
  };
}

/** Minimal rows the binding tests need: a user, a provider account, a catalog model. */
export async function seedProviderAccount(sql: postgres.Sql, provider = "openai-compatible") {
  const [user] = await sql<{ id: string }[]>`
    insert into users (email, display_name, role, status)
    values (${`${randomUUID()}@example.test`}, 'Test Admin', 'admin', 'active')
    returning id
  `;
  const [account] = await sql<{ id: string }[]>`
    insert into provider_accounts (provider, display_name, status, created_by)
    values (${provider}, 'Test account', 'enabled', ${user!.id})
    returning id
  `;
  return { userId: user!.id, providerAccountId: account!.id };
}

export async function seedCatalogModel(sql: postgres.Sql, provider: string, vendorModelId: string) {
  const [row] = await sql<{ id: string }[]>`
    insert into model_catalog (provider, vendor_model_id, display_name)
    values (${provider}, ${vendorModelId}, ${vendorModelId})
    on conflict (provider, vendor_model_id) do update set display_name = excluded.display_name
    returning id
  `;
  return row!.id;
}
