begin;

-- Migration 0012 is already a forward migration in the preview history. This additive constraint
-- makes the optional preferred-name envelope strictly all-null or all-present; PostgreSQL CHECK
-- expressions otherwise accept UNKNOWN when nullable metadata is only tested with regex/range operators.
alter table local801.person_pii
  add constraint person_pii_preferred_name_envelope_complete_ck
  check (
    (
      preferred_name_encrypted_payload is null
      and preferred_name_encryption_key_version is null
      and preferred_name_encryption_format_version is null
    )
    or
    (
      preferred_name_encrypted_payload is not null
      and preferred_name_encryption_key_version is not null
      and preferred_name_encryption_format_version is not null
    )
  );

-- Keep organization scoping explicit for migration verification and future review.
comment on constraint person_pii_preferred_name_envelope_complete_ck on local801.person_pii is
  'Stage 14B PII envelope completeness; organization_id remains part of the person_pii primary/foreign key scope.';

commit;
