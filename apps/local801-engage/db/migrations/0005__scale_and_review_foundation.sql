begin;

-- Durable aggregate counts and honest processing state allow review pages to
-- summarize large batches without loading every normalized row.
alter table local801.import_batches
  add column if not exists total_row_count integer,
  add column if not exists included_row_count integer,
  add column if not exists excluded_row_count integer,
  add column if not exists rejected_row_count integer,
  add column if not exists processed_row_count integer,
  add column if not exists processing_stage text,
  add column if not exists processing_error_code text;

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'import_batches_processing_counts_ck'
      and conrelid = 'local801.import_batches'::regclass
  ) then
    alter table local801.import_batches
      add constraint import_batches_processing_counts_ck check (
        (total_row_count is null or total_row_count >= 0)
        and (included_row_count is null or included_row_count >= 0)
        and (excluded_row_count is null or excluded_row_count >= 0)
        and (rejected_row_count is null or rejected_row_count >= 0)
        and (processed_row_count is null or processed_row_count >= 0)
        and (total_row_count is null or processed_row_count is null or processed_row_count <= total_row_count)
      );
  end if;
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'import_batches_processing_stage_ck'
      and conrelid = 'local801.import_batches'::regclass
  ) then
    alter table local801.import_batches
      add constraint import_batches_processing_stage_ck check (
        processing_stage is null or processing_stage in (
          'uploaded', 'queued', 'parsing', 'validating', 'matching',
          'preparing_review', 'ready_for_review', 'failed'
        )
      );
  end if;
end
$$;

-- One decision represents an entire deterministic review set. A changed set
-- hash makes the previous decision stale without rewriting it or thousands of rows.
create table if not exists local801.import_batch_review_decisions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references local801.organizations(id),
  import_batch_id uuid not null references local801.import_batches(id) on delete cascade,
  decision_type text not null check (decision_type in ('allow_proposed_new', 'acknowledge_existing_changes')),
  set_hash text not null check (set_hash ~ '^[0-9a-f]{64}$'),
  set_count integer not null check (set_count > 0),
  decided_by uuid not null references local801.users(id),
  decided_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint import_batch_review_decisions_batch_type_uq unique (import_batch_id, decision_type)
);

-- Directory keyset order and high-frequency organization-scoped traversal.
create index if not exists people_org_directory_order_idx
  on local801.people (organization_id, last_name, first_name, id)
  where archived_at is null;

-- Import batch traversal used by classification and bounded review detail.
create index if not exists import_files_org_batch_order_idx
  on local801.import_files (organization_id, import_batch_id, created_at, id);
create index if not exists import_sheets_org_file_order_idx
  on local801.import_sheets (organization_id, import_file_id, created_at, id);
create index if not exists import_rows_org_sheet_order_idx
  on local801.import_rows (organization_id, import_sheet_id, source_row_number, id);
create index if not exists import_match_candidates_org_row_person_idx
  on local801.import_match_candidates (organization_id, import_row_id, person_id);
create index if not exists import_errors_org_batch_severity_row_idx
  on local801.import_errors (organization_id, import_batch_id, severity, import_row_id);

-- Assignment-limited directory/outreach lookup must be efficient for backups too.
create index if not exists assignment_org_backup_person_idx
  on local801.engagement_assignments (organization_id, backup_user_id, person_id)
  where archived_at is null and status = 'open';

-- Campaign list/detail aggregation and deterministic population drill-down.
create index if not exists outreach_campaigns_org_created_id_idx
  on local801.outreach_campaigns (organization_id, created_at desc, id desc)
  where archived_at is null;
create index if not exists assignment_org_campaign_person_created_idx
  on local801.engagement_assignments (organization_id, campaign_id, person_id, created_at desc, id desc)
  where archived_at is null;
create index if not exists engagement_events_org_campaign_person_idx
  on local801.engagement_events (organization_id, campaign_id, person_id)
  where voided_at is null;

-- Bounded audit filtering.
create index if not exists audit_org_type_created_id_idx
  on local801.audit_events (organization_id, event_type, created_at desc, id desc);

commit;
