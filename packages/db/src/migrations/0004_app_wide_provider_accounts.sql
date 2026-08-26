-- Provider accounts are app-wide only. Per-user BYOK accounts are promoted to
-- shared accounts and the per-user scoping columns are removed.

alter table provider_accounts drop constraint if exists provider_accounts_scope_owner_check;

update provider_accounts
set scope = 'global',
    owner_user_id = null,
    is_default = false,
    updated_at = now()
where scope <> 'global';

-- Promoted accounts never inherit the default route, and only one account can
-- hold it once the per-user partition disappears.
update provider_accounts
set is_default = false,
    updated_at = now()
where is_default = true
  and id <> (
    select id
    from provider_accounts
    where is_default = true
    order by updated_at desc, created_at desc
    limit 1
  );

drop index if exists provider_accounts_owner_user_id_idx;

alter table provider_accounts drop column if exists owner_user_id;
alter table provider_accounts drop column if exists scope;

alter table users drop column if exists byok_enabled;
