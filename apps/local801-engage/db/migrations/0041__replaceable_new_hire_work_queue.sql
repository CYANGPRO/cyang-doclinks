begin;

-- A person's factual hire date remains on the person and employment history.
-- This table separately tracks who is still active in the replaceable New hires work queue.
create table local801.new_hire_roster_entries (
  organization_id uuid not null references local801.organizations(id),
  person_id uuid not null references local801.people(id),
  source_import_file_id uuid references local801.import_files(id),
  first_listed_at timestamptz not null default now(),
  last_listed_at timestamptz not null default now(),
  archived_at timestamptz,
  primary key (organization_id, person_id)
);

create index new_hire_roster_entries_active_idx
  on local801.new_hire_roster_entries (organization_id, last_listed_at desc, person_id)
  where archived_at is null;

insert into local801.new_hire_roster_entries (organization_id, person_id)
select person.organization_id, person.id
from local801.people person
where person.archived_at is null
  and (
    person.hire_date is not null
    or exists (
      select 1
      from local801.employment_events event
      where event.organization_id = person.organization_id
        and event.person_id = person.id
        and event.event_type = 'hire'
    )
  )
on conflict (organization_id, person_id) do nothing;

create or replace view reporting.new_hires as
select
  person.organization_id,
  person.id as person_id,
  coalesce(person.hire_date, hire.effective_date) as hire_date,
  coalesce(nullif(btrim(hire.department), ''), person.department) as department,
  coalesce(nullif(btrim(hire.work_location), ''), person.work_location) as work_location,
  person.job_status,
  person.classification
from local801.new_hire_roster_entries roster
join local801.people person
  on person.organization_id = roster.organization_id
 and person.id = roster.person_id
left join lateral (
  select event.effective_date, event.department, event.work_location
  from local801.employment_events event
  where event.organization_id = person.organization_id
    and event.person_id = person.id
    and event.event_type = 'hire'
  order by event.effective_date desc, event.created_at desc, event.id desc
  limit 1
) hire on true
where roster.archived_at is null
  and person.archived_at is null
  and coalesce(person.hire_date, hire.effective_date) is not null;

comment on table local801.new_hire_roster_entries is
  'Replaceable New hires work queue. Each upload keeps omitted unassigned people active and clears omitted people after assignment to CAT or a higher role; the employee, direct assignment, and factual employment history are retained.';

commit;
