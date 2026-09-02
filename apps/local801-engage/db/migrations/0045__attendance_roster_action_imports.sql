begin;

create table local801.import_attendance_plans (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references local801.organizations(id),
  import_batch_id uuid not null references local801.import_batches(id) on delete cascade,
  description text not null,
  meeting_date date not null,
  response_key text not null,
  action_id uuid references local801.employee_actions(id),
  created_by uuid not null references local801.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint import_attendance_plans_batch_uq unique (import_batch_id),
  constraint import_attendance_plans_description_ck check (
    length(trim(description)) between 1 and 120
    and description !~ '[[:cntrl:]]'
  ),
  constraint import_attendance_plans_response_key_ck check (
    response_key ~ '^custom:[0-9a-f]{32}$'
  )
);

create index import_attendance_plans_org_batch_idx
  on local801.import_attendance_plans (organization_id, import_batch_id);

create unique index import_attendance_plans_org_action_uq
  on local801.import_attendance_plans (organization_id, action_id)
  where action_id is not null;

alter table local801.protected_import_execution_sets
  add column approval_fingerprint text;

alter table local801.protected_import_execution_sets
  add constraint protected_import_execution_sets_approval_fingerprint_ck check (
    approval_fingerprint is null or approval_fingerprint ~ '^[0-9a-f]{64}$'
  );

create or replace function local801.enforce_protected_execution_set_transition()
returns trigger
language plpgsql
as $$
begin
  if old.organization_id <> new.organization_id
    or old.import_batch_id <> new.import_batch_id
    or old.source_fingerprint <> new.source_fingerprint
    or old.review_fingerprint <> new.review_fingerprint
    or old.mutation_fingerprint <> new.mutation_fingerprint
    or old.mutation_count <> new.mutation_count
    or old.prepared_by <> new.prepared_by
    or old.prepared_at <> new.prepared_at
    or old.approval_fingerprint is distinct from new.approval_fingerprint then
    raise exception 'protected import execution set identity is immutable';
  end if;

  if old.state = new.state then
    return new;
  end if;
  if old.state = 'prepared' and new.state in ('executed','invalidated') then
    if new.state = 'executed' and new.executed_at is null then
      raise exception 'executed protected import execution set requires executed_at';
    end if;
    if new.state = 'invalidated' and new.invalidated_at is null then
      raise exception 'invalidated protected import execution set requires invalidated_at';
    end if;
    new.updated_at := now();
    return new;
  end if;
  raise exception 'invalid protected import execution set state transition';
end;
$$;

comment on table local801.import_attendance_plans is
  'Approval-bound meeting metadata for attendance rosters. Execution creates one organization Action Catalog item and an Attended response for each matched employee.';

revoke all on table local801.import_attendance_plans from public;

do $$
begin
  if to_regrole('local801_app') is not null then
    grant select, insert, update on table local801.import_attendance_plans to local801_app;
  end if;
  if to_regrole('local801_backup') is not null then
    grant select on table local801.import_attendance_plans to local801_backup;
  end if;
end;
$$;

commit;
