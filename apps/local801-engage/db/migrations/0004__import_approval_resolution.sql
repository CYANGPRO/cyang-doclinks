begin;

-- Fail closed before adding normalized authoritative-identity constraints.
do $$
begin
  if exists (
    select 1
    from local801.person_contact_methods
    where contact_type = 'work_email'
      and archived_at is null
    group by organization_id, lower(btrim(contact_value))
    having count(*) > 1
  ) then
    raise exception using
      errcode = '23505',
      message = 'Cannot enforce active work-email uniqueness: normalized duplicates exist.';
  end if;

  if exists (
    select 1
    from local801.person_contact_methods
    where contact_type = 'work_email'
      and archived_at is null
      and is_primary = true
    group by organization_id, person_id
    having count(*) > 1
  ) then
    raise exception using
      errcode = '23505',
      message = 'Cannot enforce one active primary work email: duplicates exist.';
  end if;

  if exists (
    select 1
    from local801.person_identifiers
    where identifier_type = 'employee_identifier'
    group by organization_id, lower(btrim(identifier_value))
    having count(*) > 1
  ) then
    raise exception using
      errcode = '23505',
      message = 'Cannot enforce employee-identifier uniqueness: normalized duplicates exist.';
  end if;

  if exists (
    select 1
    from local801.person_identifiers
    where identifier_type = 'member_identifier'
    group by organization_id, lower(btrim(identifier_value))
    having count(*) > 1
  ) then
    raise exception using
      errcode = '23505',
      message = 'Cannot enforce member-identifier uniqueness: normalized duplicates exist.';
  end if;

  if exists (
    select 1
    from local801.import_approvals
    group by import_batch_id
    having count(*) > 1
  ) then
    raise exception using
      errcode = '23505',
      message = 'Cannot enforce one approval per import batch: multiple approvals exist.';
  end if;

  if exists (
    select 1
    from local801.membership_snapshots
    where status = 'approved'
    group by organization_id, snapshot_date
    having count(*) > 1
  ) then
    raise exception using
      errcode = '23505',
      message = 'Cannot enforce approved snapshot uniqueness: multiple approved snapshots exist.';
  end if;
end
$$;

create unique index if not exists person_contact_active_work_email_org_normalized_uq
  on local801.person_contact_methods (organization_id, lower(btrim(contact_value)))
  where contact_type = 'work_email' and archived_at is null;

create unique index if not exists person_contact_active_primary_work_email_person_uq
  on local801.person_contact_methods (organization_id, person_id)
  where contact_type = 'work_email' and archived_at is null and is_primary = true;

create unique index if not exists person_identifiers_employee_org_normalized_uq
  on local801.person_identifiers (organization_id, lower(btrim(identifier_value)))
  where identifier_type = 'employee_identifier';

create unique index if not exists person_identifiers_member_org_normalized_uq
  on local801.person_identifiers (organization_id, lower(btrim(identifier_value)))
  where identifier_type = 'member_identifier';

alter table local801.person_contact_methods
  add column if not exists source_import_file_id uuid;

do $$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conname = 'person_contact_methods_source_file_fk'
      and conrelid = 'local801.person_contact_methods'::regclass
  ) then
    alter table local801.person_contact_methods
      add constraint person_contact_methods_source_file_fk
      foreign key (source_import_file_id) references local801.import_files(id);
  end if;
end
$$;

do $$
declare
  matching_constraints text[];
begin
  select array_agg(candidate.constraint_name order by candidate.constraint_oid)
  into matching_constraints
  from (
    select constraint_definition.oid as constraint_oid,
      constraint_definition.conname as constraint_name
    from pg_catalog.pg_constraint constraint_definition
    where constraint_definition.conrelid = 'local801.import_approvals'::regclass
      and constraint_definition.contype = 'u'
      and cardinality(constraint_definition.conkey) = 2
      and (
        select array_agg(attribute.attname::text order by attribute.attname::text)
        from unnest(constraint_definition.conkey) key_column(attnum)
        join pg_catalog.pg_attribute attribute
          on attribute.attrelid = constraint_definition.conrelid
          and attribute.attnum = key_column.attnum
      ) = array['approval_hash', 'import_batch_id']::text[]
  ) candidate;

  if coalesce(cardinality(matching_constraints), 0) > 1 then
    raise exception using
      errcode = '55000',
      message = 'Cannot replace import approval uniqueness: multiple matching constraints exist.';
  elsif cardinality(matching_constraints) = 1 then
    execute format(
      'alter table local801.import_approvals drop constraint %I',
      matching_constraints[1]
    );
  end if;
end
$$;

create unique index if not exists import_approvals_batch_uq
  on local801.import_approvals (import_batch_id);

do $$
declare
  matching_constraints text[];
begin
  select array_agg(candidate.constraint_name order by candidate.constraint_oid)
  into matching_constraints
  from (
    select constraint_definition.oid as constraint_oid,
      constraint_definition.conname as constraint_name
    from pg_catalog.pg_constraint constraint_definition
    where constraint_definition.conrelid = 'local801.membership_snapshots'::regclass
      and constraint_definition.contype = 'u'
      and cardinality(constraint_definition.conkey) = 3
      and (
        select array_agg(attribute.attname::text order by attribute.attname::text)
        from unnest(constraint_definition.conkey) key_column(attnum)
        join pg_catalog.pg_attribute attribute
          on attribute.attrelid = constraint_definition.conrelid
          and attribute.attnum = key_column.attnum
      ) = array['organization_id', 'snapshot_date', 'status']::text[]
  ) candidate;

  if coalesce(cardinality(matching_constraints), 0) > 1 then
    raise exception using
      errcode = '55000',
      message = 'Cannot replace membership snapshot uniqueness: multiple matching constraints exist.';
  elsif cardinality(matching_constraints) = 1 then
    execute format(
      'alter table local801.membership_snapshots drop constraint %I',
      matching_constraints[1]
    );
  end if;
end
$$;

create unique index if not exists membership_snapshots_approved_org_date_uq
  on local801.membership_snapshots (organization_id, snapshot_date)
  where status = 'approved';

create table if not exists local801.import_row_resolutions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references local801.organizations(id),
  import_batch_id uuid not null references local801.import_batches(id) on delete cascade,
  import_row_id uuid not null references local801.import_rows(id) on delete cascade,
  resolution_type text not null check (resolution_type in ('confirm_existing', 'create_new')),
  person_id uuid references local801.people(id),
  decided_by uuid not null references local801.users(id),
  decided_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint import_row_resolutions_person_ck check (
    (resolution_type = 'confirm_existing' and person_id is not null)
    or (resolution_type = 'create_new' and person_id is null)
  ),
  constraint import_row_resolutions_row_uq unique (import_row_id)
);

create index if not exists import_row_resolutions_org_batch_row_idx
  on local801.import_row_resolutions (organization_id, import_batch_id, import_row_id);

create table if not exists local801.import_approval_plans (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references local801.organizations(id),
  import_batch_id uuid not null references local801.import_batches(id) on delete cascade,
  snapshot_date date,
  effective_date date,
  duplicate_source_acknowledged boolean not null default false,
  duplicate_source_acknowledged_by uuid references local801.users(id),
  duplicate_source_acknowledged_at timestamptz,
  created_by uuid not null references local801.users(id),
  updated_by uuid not null references local801.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint import_approval_plans_batch_uq unique (import_batch_id),
  constraint import_approval_plans_duplicate_ack_ck check (
    (duplicate_source_acknowledged = false
      and duplicate_source_acknowledged_by is null
      and duplicate_source_acknowledged_at is null)
    or (duplicate_source_acknowledged = true
      and duplicate_source_acknowledged_by is not null
      and duplicate_source_acknowledged_at is not null)
  )
);

create index if not exists import_approval_plans_org_batch_idx
  on local801.import_approval_plans (organization_id, import_batch_id);

commit;
