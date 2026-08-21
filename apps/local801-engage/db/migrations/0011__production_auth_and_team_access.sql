begin;

alter table local801.users
  add column if not exists auth_session_version integer not null default 1,
  add column if not exists last_authenticated_at timestamptz,
  add column if not exists last_mfa_at timestamptz,
  add column if not exists invited_at timestamptz,
  add column if not exists invited_by uuid references local801.users(id);

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'users_auth_session_version_ck'
      and conrelid = 'local801.users'::regclass
  ) then
    alter table local801.users
      add constraint users_auth_session_version_ck check (auth_session_version > 0);
  end if;
end
$$;

create table if not exists local801.auth_identities (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references local801.organizations(id),
  user_id uuid not null references local801.users(id) on delete cascade,
  provider_id text not null,
  provider_subject text not null,
  linked_email text not null,
  linked_at timestamptz not null default now(),
  last_sign_in_at timestamptz not null default now(),
  unique (organization_id, provider_id, provider_subject),
  unique (organization_id, user_id, provider_id)
);

create index if not exists auth_identities_org_user_idx
  on local801.auth_identities (organization_id, user_id);

create unique index if not exists workspace_user_roles_one_role_per_user_uq
  on local801.workspace_user_roles (user_id);

create index if not exists users_org_active_email_auth_idx
  on local801.users (organization_id, lower(email), auth_session_version)
  where deactivated_at is null;

commit;
