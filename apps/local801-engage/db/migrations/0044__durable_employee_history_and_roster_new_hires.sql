begin;

-- Employee records are historical records. Operational workflows archive them;
-- no application, administrator, or later cascade may physically remove them.
create or replace function local801.prevent_employee_hard_delete()
returns trigger
language plpgsql
as $$
begin
  raise exception using
    errcode = '55000',
    message = 'Employee records must be archived and cannot be deleted.';
end;
$$;

revoke all on function local801.prevent_employee_hard_delete() from public;

drop trigger if exists people_prevent_hard_delete on local801.people;
create trigger people_prevent_hard_delete
before delete on local801.people
for each row execute function local801.prevent_employee_hard_delete();

comment on function local801.prevent_employee_hard_delete() is
  'Preserves Local 801 employee history by requiring archival instead of physical deletion.';

-- Migration 0041 seeded every employee with any hire date into the work queue.
-- Rebuild the active cohort from the newest two approved roster snapshots:
--   * the MAPE Hire Date is after the prior snapshot and no later than the latest;
--   * the employee did not appear in the prior snapshot;
--   * when there is no prior snapshot, use a bounded 30-day baseline window.
with ranked_snapshots as materialized (
  select snapshot.id, snapshot.organization_id, snapshot.snapshot_date,
    snapshot.source_import_batch_id,
    row_number() over (
      partition by snapshot.organization_id
      order by snapshot.snapshot_date desc, snapshot.created_at desc, snapshot.id desc
    ) as rank
  from local801.membership_snapshots snapshot
  where snapshot.status = 'approved'
), latest_snapshot as materialized (
  select * from ranked_snapshots where rank = 1
), prior_snapshot as materialized (
  select * from ranked_snapshots where rank = 2
), derived_new_hires as materialized (
  select current_row.organization_id, current_row.person_id
  from latest_snapshot latest
  join local801.membership_snapshot_rows current_row
    on current_row.organization_id = latest.organization_id
   and current_row.snapshot_id = latest.id
  join local801.people person
    on person.organization_id = current_row.organization_id
   and person.id = current_row.person_id
   and person.archived_at is null
  left join prior_snapshot prior
    on prior.organization_id = latest.organization_id
  where person.hire_date is not null
    and person.hire_date <= latest.snapshot_date
    and person.hire_date > coalesce(prior.snapshot_date, latest.snapshot_date - 30)
    and not exists (
      select 1
      from local801.membership_snapshot_rows previous_row
      where previous_row.organization_id = current_row.organization_id
        and previous_row.snapshot_id = prior.id
        and previous_row.person_id = current_row.person_id
    )
)
update local801.new_hire_roster_entries roster
set archived_at = now()
where roster.archived_at is null
  and not exists (
    select 1
    from derived_new_hires derived
    where derived.organization_id = roster.organization_id
      and derived.person_id = roster.person_id
  );

with ranked_snapshots as materialized (
  select snapshot.id, snapshot.organization_id, snapshot.snapshot_date,
    snapshot.source_import_batch_id,
    row_number() over (
      partition by snapshot.organization_id
      order by snapshot.snapshot_date desc, snapshot.created_at desc, snapshot.id desc
    ) as rank
  from local801.membership_snapshots snapshot
  where snapshot.status = 'approved'
), latest_snapshot as materialized (
  select * from ranked_snapshots where rank = 1
), prior_snapshot as materialized (
  select * from ranked_snapshots where rank = 2
), derived_new_hires as materialized (
  select current_row.organization_id, current_row.person_id,
    source_file.id as source_import_file_id
  from latest_snapshot latest
  join local801.membership_snapshot_rows current_row
    on current_row.organization_id = latest.organization_id
   and current_row.snapshot_id = latest.id
  join local801.people person
    on person.organization_id = current_row.organization_id
   and person.id = current_row.person_id
   and person.archived_at is null
  left join prior_snapshot prior
    on prior.organization_id = latest.organization_id
  left join lateral (
    select file.id
    from local801.import_files file
    where file.organization_id = latest.organization_id
      and file.import_batch_id = latest.source_import_batch_id
    order by file.created_at desc, file.id desc
    limit 1
  ) source_file on true
  where person.hire_date is not null
    and person.hire_date <= latest.snapshot_date
    and person.hire_date > coalesce(prior.snapshot_date, latest.snapshot_date - 30)
    and not exists (
      select 1
      from local801.membership_snapshot_rows previous_row
      where previous_row.organization_id = current_row.organization_id
        and previous_row.snapshot_id = prior.id
        and previous_row.person_id = current_row.person_id
    )
)
insert into local801.new_hire_roster_entries (
  organization_id, person_id, source_import_file_id, first_listed_at, last_listed_at, archived_at
)
select organization_id, person_id, source_import_file_id, now(), now(), null
from derived_new_hires
on conflict (organization_id, person_id) do update set
  source_import_file_id = excluded.source_import_file_id,
  last_listed_at = now(),
  archived_at = null;

commit;
