begin;

-- import_batches.id is already a UUID primary key, so every
-- (organization_id, id) pair is necessarily unique. This named parent key lets
-- child tables enforce that a referenced batch belongs to the same tenant.
alter table local801.import_batches
  add constraint import_batches_organization_id_id_uq
  unique (organization_id, id);

-- This table stores durable execution metadata only. import_batches remains the
-- organization-scoped business-state projection shown to administrators.
create table local801.import_processing_jobs (
  id uuid not null default gen_random_uuid(),
  organization_id uuid not null,
  import_batch_id uuid not null,
  processing_version text not null,
  workflow_run_id text,
  state text not null default 'queued',
  attempt_count integer not null default 0,
  safe_error_code text,
  queued_at timestamptz not null default now(),
  started_at timestamptz,
  last_progress_at timestamptz not null default now(),
  completed_at timestamptz,
  failed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint import_processing_jobs_pkey primary key (id),
  constraint import_processing_jobs_organization_fk
    foreign key (organization_id) references local801.organizations(id),
  constraint import_processing_jobs_batch_org_fk
    foreign key (organization_id, import_batch_id)
    references local801.import_batches (organization_id, id) on delete cascade,
  constraint import_processing_jobs_batch_uq unique (import_batch_id),
  constraint import_processing_jobs_version_ck check (
    btrim(processing_version) <> '' and char_length(processing_version) <= 100
  ),
  constraint import_processing_jobs_state_ck check (
    state in ('queued', 'running', 'succeeded', 'failed')
  ),
  constraint import_processing_jobs_attempt_count_ck check (attempt_count >= 0),
  constraint import_processing_jobs_workflow_run_ck check (
    workflow_run_id is null or (
      workflow_run_id = btrim(workflow_run_id)
      and char_length(btrim(workflow_run_id)) between 1 and 255
    )
  ),
  constraint import_processing_jobs_safe_error_ck check (
    safe_error_code is null or safe_error_code ~ '^[A-Z0-9_]{1,80}$'
  ),
  constraint import_processing_jobs_lifecycle_ck check (
    (state = 'queued'
      and workflow_run_id is null
      and started_at is null
      and completed_at is null
      and failed_at is null
      and safe_error_code is null)
    or (state = 'running'
      and workflow_run_id is not null
      and attempt_count >= 1
      and started_at is not null
      and completed_at is null
      and failed_at is null
      and safe_error_code is null)
    or (state = 'succeeded'
      and workflow_run_id is not null
      and attempt_count >= 1
      and started_at is not null
      and completed_at is not null
      and failed_at is null
      and safe_error_code is null)
    or (state = 'failed'
      and completed_at is null
      and failed_at is not null
      and safe_error_code is not null
      and (
        (workflow_run_id is null and attempt_count = 0 and started_at is null)
        or (workflow_run_id is not null and attempt_count >= 1 and started_at is not null)
      ))
  ),
  constraint import_processing_jobs_timestamp_order_ck check (
    created_at <= updated_at
    and queued_at <= last_progress_at
    and (started_at is null or queued_at <= started_at)
    and (completed_at is null or (started_at is not null and started_at <= completed_at))
    and (failed_at is null or queued_at <= failed_at)
    and (
      failed_at is null
      or workflow_run_id is null
      or (started_at is not null and started_at <= failed_at)
    )
  )
);

create unique index import_processing_jobs_workflow_run_uq
  on local801.import_processing_jobs (workflow_run_id)
  where workflow_run_id is not null;

-- Supports organization-scoped recovery/operations views without indexing
-- completed history that is not part of routine job monitoring.
create index import_processing_jobs_org_active_progress_idx
  on local801.import_processing_jobs (organization_id, state, last_progress_at, id)
  where state in ('queued', 'running', 'failed');

-- Migration 0005 explicitly names this constraint. Fail closed if the expected
-- predecessor is absent instead of silently changing an unknown schema.
do $$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conname = 'import_batches_processing_stage_ck'
      and conrelid = 'local801.import_batches'::regclass
      and contype = 'c'
  ) then
    raise exception 'Expected import_batches_processing_stage_ck is missing';
  end if;

  alter table local801.import_batches
    drop constraint import_batches_processing_stage_ck;
end
$$;

-- The business-state lifecycle gains the malware-scanning boundary. This is a
-- strict superset of migration 0005's allowed values.
alter table local801.import_batches
  add constraint import_batches_processing_stage_ck check (
    processing_stage is null or processing_stage in (
      'uploaded', 'queued', 'scanning', 'parsing', 'validating', 'matching',
      'preparing_review', 'ready_for_review', 'failed'
    )
  );

commit;
