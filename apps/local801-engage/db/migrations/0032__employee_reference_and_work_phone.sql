begin;

create sequence if not exists local801.employee_reference_seq
  as bigint start with 100001;

alter table local801.people
  add column if not exists employee_reference bigint;

update local801.people
set employee_reference = nextval('local801.employee_reference_seq')
where employee_reference is null;

-- The people table has deferred constraint triggers. Flush the backfill's
-- pending events before issuing further ALTER TABLE statements.
set constraints all immediate;

alter table local801.people
  alter column employee_reference set default nextval('local801.employee_reference_seq'),
  alter column employee_reference set not null;

create unique index if not exists people_employee_reference_uq
  on local801.people (employee_reference);

alter table local801.import_row_pii
  drop constraint if exists import_row_pii_field_masks_ck;

alter table local801.import_row_pii
  add constraint import_row_pii_field_masks_ck check (
    (direct_pii_field_set_version = 1 and direct_pii_presence_mask is null and direct_pii_validity_mask is null)
    or (direct_pii_field_set_version = 2 and direct_pii_presence_mask between 0 and 63
      and direct_pii_validity_mask between 0 and 63 and (direct_pii_validity_mask & direct_pii_presence_mask) = direct_pii_validity_mask)
    or (direct_pii_field_set_version = 3 and direct_pii_presence_mask between 0 and 127
      and direct_pii_validity_mask between 0 and 127 and (direct_pii_validity_mask & direct_pii_presence_mask) = direct_pii_validity_mask)
    or (direct_pii_field_set_version = 4 and direct_pii_presence_mask between 0 and 255
      and direct_pii_validity_mask between 0 and 255 and (direct_pii_validity_mask & direct_pii_presence_mask) = direct_pii_validity_mask)
  );

comment on column local801.people.employee_reference is
  'Permanent Local 801-generated employee reference; independent of optional source employee/member identifiers.';
comment on column local801.import_row_pii.direct_pii_presence_mask is
  'Protected import presence bits: first=1,last=2,preferred=4,work_email=8,employee_identifier=16,member_identifier=32,personal_email=64,work_phone=128.';

create or replace function local801.require_protected_import_row_pii()
returns trigger
language plpgsql
as '
begin
  if not local801.pii_protected_mode_enabled(new.organization_id) then return null; end if;
  if new.normalized_json ?| array[
    ''first_name'',''last_name'',''preferred_name'',''work_email'',''personal_email'',''work_phone'',
    ''employee_identifier'',''member_identifier''
  ] then
    raise exception ''direct PII is forbidden in protected import normalized_json'';
  end if;
  if not exists (
    select 1 from local801.import_row_pii protected
    where protected.organization_id = new.organization_id and protected.import_row_id = new.id
      and protected.direct_pii_field_set_version in (2, 3, 4)
      and protected.direct_pii_presence_mask is not null
      and protected.direct_pii_validity_mask is not null
      and protected.row_integrity_hash ~ ''^[0-9a-f]{64}$''
  ) then raise exception ''protected import-row companion required''; end if;
  return null;
end;
';

commit;
