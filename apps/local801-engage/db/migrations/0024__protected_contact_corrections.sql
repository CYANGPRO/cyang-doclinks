begin;

-- Stage 17I: protected contact-correction workflow primitives.
-- These functions intentionally accept encrypted envelopes and blind indexes only. Plaintext
-- proposed/contact values remain application-memory only and are never written to legacy columns
-- after protected mode is active.

create or replace function local801.submit_protected_contact_correction(
  target_organization uuid,
  target_request uuid,
  target_person uuid,
  target_submitter uuid,
  target_field text,
  encrypted_payload text,
  encryption_key_version text,
  encryption_format_version integer
)
returns uuid
language plpgsql
as $$
begin
  if not local801.pii_protected_mode_enabled(target_organization) then
    raise exception 'protected contact correction requires protected PII mode';
  end if;
  if target_field not in ('work_email','personal_email','phone','mailing_address') then
    raise exception 'unsupported contact correction field';
  end if;
  if not exists (
    select 1 from local801.people p
    where p.organization_id = target_organization and p.id = target_person and p.archived_at is null
  ) then raise exception 'contact correction person unavailable'; end if;
  if not exists (
    select 1 from local801.users u
    where u.organization_id = target_organization and u.id = target_submitter and u.deactivated_at is null
  ) then raise exception 'contact correction submitter unavailable'; end if;

  insert into local801.contact_correction_requests
    (id, organization_id, person_id, submitted_by, field_name, proposed_value, state)
  values
    (target_request, target_organization, target_person, target_submitter, target_field,
     'protected-' || target_request::text, 'submitted');

  insert into local801.contact_correction_request_pii
    (organization_id, correction_request_id, proposed_value_encrypted_payload,
     encryption_key_version, encryption_format_version, updated_at)
  values
    (target_organization, target_request, encrypted_payload,
     encryption_key_version, encryption_format_version, now())
  on conflict (organization_id, correction_request_id) do update set
    proposed_value_encrypted_payload = excluded.proposed_value_encrypted_payload,
    encryption_key_version = excluded.encryption_key_version,
    encryption_format_version = excluded.encryption_format_version,
    updated_at = now();

  return target_request;
end;
$$;

create or replace function local801.reject_protected_contact_correction(
  target_organization uuid,
  target_request uuid,
  target_reviewer uuid
)
returns boolean
language plpgsql
as $$
declare changed integer;
begin
  if not local801.pii_protected_mode_enabled(target_organization) then
    raise exception 'protected contact correction requires protected PII mode';
  end if;
  if not exists (
    select 1 from local801.users u
    where u.organization_id = target_organization and u.id = target_reviewer and u.deactivated_at is null
  ) then raise exception 'contact correction reviewer unavailable'; end if;

  update local801.contact_correction_requests
  set state = 'rejected', decided_by = target_reviewer, decided_at = now()
  where organization_id = target_organization and id = target_request and state = 'submitted';
  get diagnostics changed = row_count;
  if changed <> 1 then raise exception 'contact correction request is no longer pending'; end if;
  return true;
end;
$$;

create or replace function local801.approve_protected_contact_correction(
  target_organization uuid,
  target_request uuid,
  target_reviewer uuid,
  target_contact uuid,
  target_contact_type text,
  target_visibility text,
  encrypted_payload text,
  encryption_key_version text,
  encryption_format_version integer,
  blind_index_key_version text,
  blind_index_hash text
)
returns boolean
language plpgsql
as $$
declare
  request_person uuid;
  request_field text;
  changed integer;
begin
  if not local801.pii_protected_mode_enabled(target_organization) then
    raise exception 'protected contact correction requires protected PII mode';
  end if;
  if target_contact_type not in ('work_email','personal_email','phone','mailing_address') then
    raise exception 'unsupported contact type';
  end if;
  if target_visibility not in ('assigned_only','authorized_directory') then
    raise exception 'unsupported contact visibility';
  end if;
  if blind_index_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid contact blind index';
  end if;
  if not exists (
    select 1 from local801.users u
    where u.organization_id = target_organization and u.id = target_reviewer and u.deactivated_at is null
  ) then raise exception 'contact correction reviewer unavailable'; end if;

  select person_id, field_name into request_person, request_field
  from local801.contact_correction_requests
  where organization_id = target_organization and id = target_request and state = 'submitted'
  for update;
  if request_person is null then raise exception 'contact correction request is no longer pending'; end if;
  if request_field <> target_contact_type then raise exception 'contact correction field mismatch'; end if;

  -- Preserve an existing contact's visibility/primary metadata when the supplied id already exists.
  update local801.person_contact_methods
  set contact_value = 'protected-' || target_contact::text,
      verified_at = now()
  where organization_id = target_organization
    and id = target_contact
    and person_id = request_person
    and contact_type = target_contact_type
    and archived_at is null;
  get diagnostics changed = row_count;

  if changed = 0 then
    insert into local801.person_contact_methods
      (id, organization_id, person_id, contact_type, contact_value, is_primary, visibility, verified_at)
    values
      (target_contact, target_organization, request_person, target_contact_type,
       'protected-' || target_contact::text, true, target_visibility, now());
  end if;

  insert into local801.person_contact_method_pii
    (organization_id, contact_method_id, contact_value_encrypted_payload,
     encryption_key_version, encryption_format_version, updated_at)
  values
    (target_organization, target_contact, encrypted_payload,
     encryption_key_version, encryption_format_version, now())
  on conflict (organization_id, contact_method_id) do update set
    contact_value_encrypted_payload = excluded.contact_value_encrypted_payload,
    encryption_key_version = excluded.encryption_key_version,
    encryption_format_version = excluded.encryption_format_version,
    updated_at = now();

  delete from local801.pii_exact_indexes
  where organization_id = target_organization
    and entity_type = 'person_contact_method'
    and entity_id = target_contact
    and index_domain = 'contact:' || replace(lower(target_contact_type), '_', '-');

  insert into local801.pii_exact_indexes
    (organization_id, entity_type, entity_id, index_domain, index_key_version, index_hash)
  values
    (target_organization, 'person_contact_method', target_contact,
     'contact:' || replace(lower(target_contact_type), '_', '-'),
     blind_index_key_version, blind_index_hash);

  update local801.contact_correction_requests
  set state = 'approved', decided_by = target_reviewer, decided_at = now()
  where organization_id = target_organization and id = target_request and state = 'submitted';
  get diagnostics changed = row_count;
  if changed <> 1 then raise exception 'contact correction request is no longer pending'; end if;
  return true;
end;
$$;

commit;