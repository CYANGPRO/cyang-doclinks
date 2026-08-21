begin;

create table if not exists local801.pii_key_rotation_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references local801.organizations(id),
  from_encryption_key_version text not null
    check (from_encryption_key_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$'),
  to_encryption_key_version text not null
    check (to_encryption_key_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$'),
  from_blind_index_key_version text not null
    check (from_blind_index_key_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$'),
  to_blind_index_key_version text not null
    check (to_blind_index_key_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$'),
  state text not null check (state in ('planned','applied','verified','retired','failed')),
  source_counts jsonb not null default '{}'::jsonb check (jsonb_typeof(source_counts) = 'object'),
  protected_counts jsonb not null default '{}'::jsonb check (jsonb_typeof(protected_counts) = 'object'),
  started_by uuid references local801.users(id),
  started_at timestamptz not null default now(),
  applied_at timestamptz,
  verified_at timestamptz,
  retired_at timestamptz,
  failed_at timestamptz,
  failure_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (from_encryption_key_version <> to_encryption_key_version),
  check (from_blind_index_key_version <> to_blind_index_key_version),
  check (state <> 'applied' or applied_at is not null),
  check (state <> 'verified' or (applied_at is not null and verified_at is not null)),
  check (state <> 'retired' or (applied_at is not null and verified_at is not null and retired_at is not null)),
  check (state <> 'failed' or failed_at is not null)
);

create index if not exists pii_key_rotation_runs_org_started_idx
  on local801.pii_key_rotation_runs (organization_id, started_at desc);

create unique index if not exists pii_key_rotation_one_active_uq
  on local801.pii_key_rotation_runs (organization_id)
  where state in ('planned','applied');

comment on table local801.pii_key_rotation_runs is
  'Stage 14B protected-PII encryption/blind-index rotation ledger. Old blind-index generations remain until a verified retirement step.';

commit;
