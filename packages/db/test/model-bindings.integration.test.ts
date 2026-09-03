import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
  createTestDatabase,
  hasTestDatabase,
  seedCatalogModel,
  seedProviderAccount,
  skipWithoutDatabase,
  type TestDatabase
} from "./integration-helpers";

// These exercise the real SQL against a real Postgres. Every other test in the
// repo drives the binding writers through fakes, which cannot tell us whether
// the unique index actually holds or whether the 0005 dedupe preserves operator
// intent - both of which are only true if the database says so.

// postgres.js hands jsonb back as a string on this connection, so read it
// through a parser rather than assuming a parsed object.
function refOf(value: unknown): { id?: string; displayName?: string } {
  return typeof value === "string" ? JSON.parse(value) : (value as { id?: string; displayName?: string });
}

let db: TestDatabase | undefined;

before(async () => {
  if (!hasTestDatabase) return;
  db = await createTestDatabase();
});

after(async () => {
  await db?.close();
});

test("migrations apply cleanly from empty", skipWithoutDatabase, async () => {
  const sql = db!.sql;
  const rows = await sql<{ table_name: string }[]>`
    select table_name
    from information_schema.tables
    where table_schema = ${db!.schema} and table_name in ('users', 'provider_accounts', 'model_account_bindings')
  `;
  assert.equal(rows.length, 3);
});

test("the unique index rejects a duplicate binding outright", skipWithoutDatabase, async () => {
  const sql = db!.sql;
  const { providerAccountId } = await seedProviderAccount(sql);
  const catalogId = await seedCatalogModel(sql, "openai-compatible", `dup-${Date.now()}`);

  await sql`
    insert into model_account_bindings (provider_account_id, model_catalog_id, provider_model_ref)
    values (${providerAccountId}, ${catalogId}, '{"id":"m1"}'::jsonb)
  `;

  // A second plain insert must fail: this is the race two writers could hit
  // before the index existed, and it was previously silent.
  await assert.rejects(
    () => sql`
      insert into model_account_bindings (provider_account_id, model_catalog_id, provider_model_ref)
      values (${providerAccountId}, ${catalogId}, '{"id":"m1"}'::jsonb)
    `,
    /duplicate key value|unique constraint/i
  );
});

test("the writers' on-conflict clause updates instead of duplicating", skipWithoutDatabase, async () => {
  const sql = db!.sql;
  const { providerAccountId } = await seedProviderAccount(sql);
  const catalogId = await seedCatalogModel(sql, "openai-compatible", `conflict-${Date.now()}`);

  for (const displayName of ["first", "second"]) {
    await sql`
      insert into model_account_bindings (provider_account_id, model_catalog_id, provider_model_ref, enabled)
      values (${providerAccountId}, ${catalogId}, ${JSON.stringify({ id: "m1", displayName })}::jsonb, true)
      on conflict (provider_account_id, model_catalog_id) where model_catalog_id is not null
      do update set provider_model_ref = excluded.provider_model_ref, updated_at = now()
    `;
  }

  const rows = await sql<{ provider_model_ref: unknown }[]>`
    select provider_model_ref from model_account_bindings
    where provider_account_id = ${providerAccountId} and model_catalog_id = ${catalogId}
  `;
  assert.equal(rows.length, 1, "the second write must update, not insert");
  assert.equal(refOf(rows[0]!.provider_model_ref).displayName, "second");
});

test("bindings with a null catalog id are exempt, as the partial index intends", skipWithoutDatabase, async () => {
  const sql = db!.sql;
  const { providerAccountId } = await seedProviderAccount(sql);

  // Two null-catalog rows must both be allowed: they are the residue of
  // `on delete set null`, not the duplication path the index guards.
  for (let i = 0; i < 2; i += 1) {
    await sql`
      insert into model_account_bindings (provider_account_id, model_catalog_id, provider_model_ref)
      values (${providerAccountId}, null, '{"id":"orphaned"}'::jsonb)
    `;
  }

  const [{ count }] = await sql<{ count: string }[]>`
    select count(*)::text as count from model_account_bindings
    where provider_account_id = ${providerAccountId} and model_catalog_id is null
  `;
  assert.equal(count, "2");
});

test("0005 collapses pre-existing duplicates without disabling an enabled model", skipWithoutDatabase, async () => {
  const sql = db!.sql;
  const { providerAccountId } = await seedProviderAccount(sql);
  const catalogId = await seedCatalogModel(sql, "openai-compatible", `legacy-${Date.now()}`);

  // Recreate the pre-migration state: the index has to come off before rows
  // that violate it can exist.
  await sql`drop index if exists model_account_bindings_account_model_key`;
  await sql`
    insert into model_account_bindings (provider_account_id, model_catalog_id, provider_model_ref, enabled, updated_at)
    values
      (${providerAccountId}, ${catalogId}, '{"id":"m1","displayName":"older"}'::jsonb, true, now() - interval '1 hour'),
      (${providerAccountId}, ${catalogId}, '{"id":"m1","displayName":"newer"}'::jsonb, false, now())
  `;

  // The dedupe half of 0005, verbatim in intent: keep the newest row, OR the
  // enabled flag across the group.
  await sql.unsafe(`
    with grouped as (
      select provider_account_id, model_catalog_id, bool_or(enabled) as any_enabled,
             (array_agg(id order by updated_at desc, created_at desc))[1] as keep_id
      from model_account_bindings
      where model_catalog_id is not null
      group by provider_account_id, model_catalog_id
      having count(*) > 1
    )
    update model_account_bindings as mab
    set enabled = grouped.any_enabled, updated_at = now()
    from grouped
    where mab.id = grouped.keep_id and mab.enabled is distinct from grouped.any_enabled;
  `);
  await sql.unsafe(`
    delete from model_account_bindings as mab
    using (
      select (array_agg(id order by updated_at desc, created_at desc))[1] as keep_id,
             provider_account_id, model_catalog_id
      from model_account_bindings
      where model_catalog_id is not null
      group by provider_account_id, model_catalog_id
      having count(*) > 1
    ) as dupes
    where mab.provider_account_id = dupes.provider_account_id
      and mab.model_catalog_id = dupes.model_catalog_id
      and mab.id <> dupes.keep_id;
  `);

  const rows = await sql<{ enabled: boolean; provider_model_ref: unknown }[]>`
    select enabled, provider_model_ref from model_account_bindings
    where provider_account_id = ${providerAccountId} and model_catalog_id = ${catalogId}
  `;
  assert.equal(rows.length, 1, "duplicates must collapse to one row");
  assert.equal(refOf(rows[0]!.provider_model_ref).displayName, "newer", "the most recently updated row survives");
  assert.equal(rows[0]!.enabled, true, "an enabled duplicate must not be silently disabled");
});
