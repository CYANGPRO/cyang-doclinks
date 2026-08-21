begin;

-- Stage 14B protected-import classification needs non-PII field-presence/validity metadata so
-- PostgreSQL can classify rows without reading direct PII from import_rows.normalized_json.
-- Version 1 protected import rows remain valid until the guarded Preview backfill refreshes them.
alter table local801.import_row_pii
  add column if not exists direct_pii_presence_mask smallint,
  add column if not exists direct_pii_validity_mask smallint;

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'import_row_pii_field_masks_ck'
      and conrelid = 'local801.import_row_pii'::regclass
  ) then
    alter table local801.import_row_pii
      add constraint import_row_pii_field_masks_ck check (
        (
          direct_pii_field_set_version = 1
          and direct_pii_presence_mask is null
          and direct_pii_validity_mask is null
        )
        or
        (
          direct_pii_field_set_version >= 2
          and direct_pii_presence_mask between 0 and 63
          and direct_pii_validity_mask between 0 and 63
          and (direct_pii_validity_mask & direct_pii_presence_mask) = direct_pii_validity_mask
        )
      );
  end if;
end
$$;

comment on column local801.import_row_pii.direct_pii_presence_mask is
  'Stage 14B non-PII presence bits: first=1,last=2,preferred=4,work_email=8,employee_identifier=16,member_identifier=32.';
comment on column local801.import_row_pii.direct_pii_validity_mask is
  'Stage 14B non-PII normalization-validity bits using the same bit layout as direct_pii_presence_mask.';

-- Rotation-aware uniqueness is enforced on keyed blind indexes rather than legacy plaintext.
-- The key version remains part of the unique key so old/new rotation generations may overlap.
create unique index if not exists pii_exact_user_email_uq
  on local801.pii_exact_indexes (organization_id, index_key_version, index_hash)
  where entity_type = 'user' and index_domain = 'user:email';

create unique index if not exists pii_exact_identifier_value_uq
  on local801.pii_exact_indexes (organization_id, index_domain, index_key_version, index_hash)
  where entity_type = 'person_identifier' and index_domain like 'identifier:%';

create unique index if not exists pii_exact_auth_provider_subject_uq
  on local801.pii_exact_indexes (organization_id, index_domain, index_key_version, index_hash)
  where entity_type = 'auth_identity' and index_domain like 'auth:provider-subject:%';

create unique index if not exists pii_exact_push_endpoint_uq
  on local801.pii_exact_indexes (organization_id, index_key_version, index_hash)
  where entity_type = 'push_subscription' and index_domain = 'push:endpoint';

commit;
