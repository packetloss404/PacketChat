-- Make duplicate model bindings structurally impossible.
--
-- Both writers (the admin model-refresh route and the worker's provider sync)
-- upsert bindings with a read-then-insert. They now take a shared advisory lock,
-- but a lock is a convention: any future writer that forgets it silently
-- reintroduces duplicates. A unique index enforces it in the database instead.
--
-- model_catalog_id is nullable and NULLs never collide in a unique index, so the
-- index is partial. Rows with a null catalog id are the residue of
-- `on delete set null` when a catalog entry is removed, not the duplication
-- path, and are deliberately left unconstrained.

-- Collapse any existing duplicates first, keeping the most recently updated row
-- of each group. `enabled` is OR-ed across the group so a model the operator had
-- switched on is not silently switched off by whichever row happens to survive.
with grouped as (
  select
    provider_account_id,
    model_catalog_id,
    bool_or(enabled) as any_enabled,
    (array_agg(id order by updated_at desc, created_at desc))[1] as keep_id
  from model_account_bindings
  where model_catalog_id is not null
  group by provider_account_id, model_catalog_id
  having count(*) > 1
)
update model_account_bindings as mab
set enabled = grouped.any_enabled,
    updated_at = now()
from grouped
where mab.id = grouped.keep_id
  and mab.enabled is distinct from grouped.any_enabled;

delete from model_account_bindings as mab
using (
  select
    (array_agg(id order by updated_at desc, created_at desc))[1] as keep_id,
    provider_account_id,
    model_catalog_id
  from model_account_bindings
  where model_catalog_id is not null
  group by provider_account_id, model_catalog_id
  having count(*) > 1
) as dupes
where mab.provider_account_id = dupes.provider_account_id
  and mab.model_catalog_id = dupes.model_catalog_id
  and mab.id <> dupes.keep_id;

create unique index if not exists model_account_bindings_account_model_key
  on model_account_bindings (provider_account_id, model_catalog_id)
  where model_catalog_id is not null;
