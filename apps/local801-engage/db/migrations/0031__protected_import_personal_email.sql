begin;

alter table local801.import_row_pii
  drop constraint if exists import_row_pii_field_masks_ck;

alter table local801.import_row_pii
  add constraint import_row_pii_field_masks_ck check (
    (
      direct_pii_field_set_version = 1
      and direct_pii_presence_mask is null
      and direct_pii_validity_mask is null
    )
    or
    (
      direct_pii_field_set_version = 2
      and direct_pii_presence_mask between 0 and 63
      and direct_pii_validity_mask between 0 and 63
      and (direct_pii_validity_mask & direct_pii_presence_mask) = direct_pii_validity_mask
    )
    or
    (
      direct_pii_field_set_version = 3
      and direct_pii_presence_mask between 0 and 127
      and direct_pii_validity_mask between 0 and 127
      and (direct_pii_validity_mask & direct_pii_presence_mask) = direct_pii_validity_mask
    )
  );

comment on column local801.import_row_pii.direct_pii_presence_mask is
  'Protected import presence bits: first=1,last=2,preferred=4,work_email=8,employee_identifier=16,member_identifier=32,personal_email=64.';
comment on column local801.import_row_pii.direct_pii_validity_mask is
  'Normalization-validity bits using the same versioned layout as direct_pii_presence_mask.';

create or replace function local801.require_protected_import_row_pii()
returns trigger
language plpgsql
as '
begin
  if not local801.pii_protected_mode_enabled(new.organization_id) then return null; end if;
  if new.normalized_json ?| array[
    ''first_name'',''last_name'',''preferred_name'',''work_email'',''personal_email'',
    ''employee_identifier'',''member_identifier''
  ] then
    raise exception ''direct PII is forbidden in protected import normalized_json'';
  end if;
  if not exists (
    select 1 from local801.import_row_pii protected
    where protected.organization_id = new.organization_id and protected.import_row_id = new.id
      and protected.direct_pii_field_set_version in (2, 3)
      and protected.direct_pii_presence_mask is not null
      and protected.direct_pii_validity_mask is not null
      and protected.row_integrity_hash ~ ''^[0-9a-f]{64}$''
  ) then raise exception ''protected import-row companion required''; end if;
  return null;
end;
';

commit;
