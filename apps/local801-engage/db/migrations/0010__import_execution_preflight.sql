begin;

alter table local801.import_approval_plans
  add column if not exists large_roster_shrink_acknowledged boolean not null default false,
  add column if not exists large_roster_shrink_set_hash text,
  add column if not exists large_roster_shrink_acknowledged_by uuid references local801.users(id),
  add column if not exists large_roster_shrink_acknowledged_at timestamptz;

-- Stage 12B preserves import provenance for authoritative work-email updates.
-- This column did not exist in the original core schema and is deliberately
-- added in the same forward migration that gates the first authoritative executor.
alter table local801.person_contact_methods
  add column if not exists source_import_file_id uuid references local801.import_files(id);

do $$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conname = 'import_approval_plans_large_shrink_ack_ck'
      and conrelid = 'local801.import_approval_plans'::regclass
  ) then
    alter table local801.import_approval_plans
      add constraint import_approval_plans_large_shrink_ack_ck check (
        (
          large_roster_shrink_acknowledged = false
          and large_roster_shrink_set_hash is null
          and large_roster_shrink_acknowledged_by is null
          and large_roster_shrink_acknowledged_at is null
        )
        or (
          large_roster_shrink_acknowledged = true
          and large_roster_shrink_set_hash ~ '^[0-9a-f]{64}$'
          and large_roster_shrink_acknowledged_by is not null
          and large_roster_shrink_acknowledged_at is not null
        )
      );
  end if;
end
$$;

create index if not exists import_approval_plans_org_large_shrink_ack_idx
  on local801.import_approval_plans (organization_id, import_batch_id, large_roster_shrink_set_hash)
  where large_roster_shrink_acknowledged = true;

create index if not exists person_contact_methods_org_source_import_file_idx
  on local801.person_contact_methods (organization_id, source_import_file_id)
  where source_import_file_id is not null;

commit;
