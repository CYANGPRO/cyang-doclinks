begin;

alter table local801.people
  add column if not exists hire_date date,
  add column if not exists job_status text;

alter table local801.person_contact_methods
  add column if not exists contact_label text;

create index if not exists people_org_hire_date_idx
  on local801.people (organization_id, hire_date desc, id)
  where archived_at is null and hire_date is not null;

create index if not exists person_contacts_org_person_type_label_idx
  on local801.person_contact_methods (organization_id, person_id, contact_type, contact_label, created_at desc)
  where archived_at is null;

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'person_contact_methods_label_ck'
      and conrelid = 'local801.person_contact_methods'::regclass
  ) then
    alter table local801.person_contact_methods
      add constraint person_contact_methods_label_ck check (
        contact_label is null or contact_label in ('work','cell','home')
      );
  end if;
end
$$;

alter table local801.import_row_pii
  drop constraint if exists import_row_pii_field_masks_ck;

alter table local801.import_row_pii
  add constraint import_row_pii_field_masks_ck check (
    (
      direct_pii_field_set_version = 1
      and direct_pii_presence_mask is null
      and direct_pii_validity_mask is null
    )
    or (
      direct_pii_field_set_version = 2
      and direct_pii_presence_mask between 0 and 63
      and direct_pii_validity_mask between 0 and 63
      and (direct_pii_validity_mask & direct_pii_presence_mask) = direct_pii_validity_mask
    )
    or (
      direct_pii_field_set_version >= 3
      and direct_pii_presence_mask between 0 and 1023
      and direct_pii_validity_mask between 0 and 1023
      and (direct_pii_validity_mask & direct_pii_presence_mask) = direct_pii_validity_mask
    )
  );

comment on column local801.import_row_pii.direct_pii_presence_mask is
  'Protected import presence bits: first=1,last=2,preferred=4,work_email=8,employee_identifier=16,member_identifier=32,home_email=64,work_phone=128,cell_phone=256,home_phone=512.';
comment on column local801.import_row_pii.direct_pii_validity_mask is
  'Normalization-validity bits using the same versioned layout as direct_pii_presence_mask.';

create or replace function local801.require_protected_import_row_pii()
returns trigger
language plpgsql
as $$
begin
  if not local801.pii_protected_mode_enabled(new.organization_id) then return null; end if;
  if new.normalized_json ?| array[
    'first_name','last_name','preferred_name','work_email','employee_identifier','member_identifier',
    'home_email','work_phone','cell_phone','home_phone'
  ] then
    raise exception 'direct PII is forbidden in protected import normalized_json';
  end if;
  if not exists (
    select 1 from local801.import_row_pii protected
    where protected.organization_id = new.organization_id and protected.import_row_id = new.id
      and protected.direct_pii_field_set_version >= 2
      and protected.direct_pii_presence_mask is not null
      and protected.direct_pii_validity_mask is not null
      and protected.row_integrity_hash ~ '^[0-9a-f]{64}$'
  ) then raise exception 'protected import-row companion v2 or newer required'; end if;
  return null;
end;
$$;

create or replace view reporting.current_membership as
select
  p.organization_id,
  p.id as person_id,
  p.membership_status,
  p.department,
  p.work_location,
  p.classification,
  p.local_number,
  p.updated_at as refreshed_at,
  p.hire_date,
  p.job_status
from local801.people p
where p.archived_at is null;

create or replace view reporting.new_hires as
select
  p.organization_id,
  p.id as person_id,
  coalesce(p.hire_date, hire.effective_date) as hire_date,
  coalesce(nullif(btrim(hire.department), ''), p.department) as department,
  coalesce(nullif(btrim(hire.work_location), ''), p.work_location) as work_location,
  p.job_status,
  p.classification
from local801.people p
left join lateral (
  select event.effective_date, event.department, event.work_location
  from local801.employment_events event
  where event.organization_id = p.organization_id
    and event.person_id = p.id
    and event.event_type = 'hire'
  order by event.effective_date desc, event.created_at desc, event.id desc
  limit 1
) hire on true
where p.archived_at is null
  and coalesce(p.hire_date, hire.effective_date) is not null;

create or replace view reporting.membership_by_job_status as
select organization_id, job_status, membership_status, count(*) as people_count
from reporting.current_membership
group by organization_id, job_status, membership_status;

commit;
