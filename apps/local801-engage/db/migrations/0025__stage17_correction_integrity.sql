begin;

-- Stage 17 closure: serialize protected contact decisions, preserve active work-email
-- uniqueness across blind indexes, and make direct data-quality writes stale-safe.

do $$
begin
  if exists (
    select 1
    from local801.person_contact_methods contact
    where contact.archived_at is null and contact.is_primary = true
    group by contact.organization_id, contact.person_id, contact.contact_type
    having count(*) > 1
  ) then
    raise exception using
      errcode = '23505',
      message = 'Cannot enforce one active primary contact per type: duplicates exist.';
  end if;

  if exists (
    select 1
    from local801.pii_exact_indexes exact_index
    join local801.person_contact_methods contact
      on contact.organization_id = exact_index.organization_id
      and contact.id = exact_index.entity_id
      and contact.archived_at is null
      and contact.contact_type = 'work_email'
    where exact_index.entity_type = 'person_contact_method'
      and exact_index.index_domain = 'contact:work-email'
    group by exact_index.organization_id, exact_index.index_key_version, exact_index.index_hash
    having count(*) > 1
  ) then
    raise exception using
      errcode = '23505',
      message = 'Cannot enforce protected active work-email uniqueness: duplicates exist.';
  end if;
end
$$;

create unique index if not exists person_contact_active_primary_per_type_uq
  on local801.person_contact_methods (organization_id, person_id, contact_type)
  where archived_at is null and is_primary = true;

create or replace function local801.enforce_active_protected_work_email_unique()
returns trigger
language plpgsql
as $$
begin
  if new.entity_type = 'person_contact_method' and new.index_domain = 'contact:work-email' then
    perform pg_advisory_xact_lock(hashtextextended(
      'protected-work-email:' || new.organization_id::text || ':' || new.index_key_version || ':' || new.index_hash,
      0
    ));
    if exists (
      select 1
      from local801.pii_exact_indexes existing_index
      join local801.person_contact_methods contact
        on contact.organization_id = existing_index.organization_id
        and contact.id = existing_index.entity_id
      where existing_index.organization_id = new.organization_id
        and existing_index.entity_type = 'person_contact_method'
        and existing_index.index_domain = 'contact:work-email'
        and existing_index.index_key_version = new.index_key_version
        and existing_index.index_hash = new.index_hash
        and existing_index.entity_id <> new.entity_id
        and contact.contact_type = 'work_email'
        and contact.archived_at is null
    ) then
      raise exception using
        errcode = '23505',
        message = 'Protected active work email is already assigned.';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists pii_exact_active_work_email_unique on local801.pii_exact_indexes;
create trigger pii_exact_active_work_email_unique
before insert or update of organization_id, entity_type, entity_id, index_domain, index_key_version, index_hash
on local801.pii_exact_indexes
for each row execute function local801.enforce_active_protected_work_email_unique();

create or replace function local801.contact_correction_revision(
  target_organization uuid,
  target_request uuid,
  target_contact uuid,
  target_contact_version text
)
returns text
language sql
immutable
as $$
  select encode(public.digest(
    'contact-correction-revision:v1:' || target_organization::text || ':' || target_request::text || ':'
      || coalesce(target_contact::text, 'none') || ':' || coalesce(target_contact_version, 'none'),
    'sha256'
  ), 'hex')
$$;

create or replace function local801.lock_data_quality_correction_target(
  target_organization uuid,
  target_person uuid,
  needs_identifier boolean,
  needs_work_email boolean,
  needs_department boolean,
  needs_classification boolean,
  needs_work_location boolean,
  needs_membership_status boolean
)
returns boolean
language plpgsql
as $$
declare locked_person local801.people%rowtype;
begin
  select person.* into locked_person
  from local801.people person
  where person.organization_id = target_organization
    and person.id = target_person
    and person.archived_at is null
  for update;

  if locked_person.id is null
    or (needs_identifier and exists (
      select 1 from local801.person_identifiers identifier
      where identifier.organization_id = target_organization
        and identifier.person_id = target_person
        and identifier.identifier_type in ('employee_identifier','member_identifier')
    ))
    or (needs_work_email and exists (
      select 1 from local801.person_contact_methods contact
      where contact.organization_id = target_organization
        and contact.person_id = target_person
        and contact.contact_type = 'work_email'
        and contact.archived_at is null
    ))
    or (needs_department and nullif(btrim(locked_person.department),'') is not null)
    or (needs_classification and nullif(btrim(locked_person.classification),'') is not null)
    or (needs_work_location and nullif(btrim(locked_person.work_location),'') is not null)
    or (needs_membership_status and locked_person.membership_status in ('member','nonmember'))
  then
    raise exception using
      errcode = 'P1702',
      message = 'Data-quality correction target is stale or unavailable.';
  end if;
  return true;
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
  if changed <> 1 then
    raise exception using errcode = 'P1701', message = 'Contact correction request is no longer pending.';
  end if;
  return true;
end;
$$;

drop function if exists local801.approve_protected_contact_correction(
  uuid, uuid, uuid, uuid, text, text, text, text, integer, text, text
);

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
  blind_index_hash text,
  expected_contact_revision text
)
returns boolean
language plpgsql
as $$
declare
  request_person uuid;
  request_field text;
  current_primary uuid;
  current_contact_version text;
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
  if expected_contact_revision !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid expected contact revision';
  end if;
  if not exists (
    select 1 from local801.users u
    where u.organization_id = target_organization and u.id = target_reviewer and u.deactivated_at is null
  ) then raise exception 'contact correction reviewer unavailable'; end if;

  select request.person_id, request.field_name
  into request_person, request_field
  from local801.contact_correction_requests request
  where request.organization_id = target_organization
    and request.id = target_request
    and request.state = 'submitted'
  for update;
  if request_person is null then
    raise exception using errcode = 'P1701', message = 'Contact correction request is no longer pending.';
  end if;
  if request_field <> target_contact_type then raise exception 'contact correction field mismatch'; end if;

  perform 1
  from local801.people person
  where person.organization_id = target_organization
    and person.id = request_person
    and person.archived_at is null
  for update;
  if not found then
    raise exception using errcode = 'P1701', message = 'Contact correction person is no longer active.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'contact-primary:' || target_organization::text || ':' || request_person::text || ':' || target_contact_type,
    0
  ));
  select contact.id, protected.xmin::text
  into current_primary, current_contact_version
  from local801.person_contact_methods contact
  left join local801.person_contact_method_pii protected
    on protected.organization_id = contact.organization_id
    and protected.contact_method_id = contact.id
  where contact.organization_id = target_organization
    and contact.person_id = request_person
    and contact.contact_type = target_contact_type
    and contact.is_primary = true
    and contact.archived_at is null
  order by contact.created_at, contact.id
  limit 1
  for update of contact;

  if local801.contact_correction_revision(
    target_organization, target_request, current_primary, current_contact_version
  ) <> expected_contact_revision
  then
    raise exception using errcode = 'P1701', message = 'Official contact changed during review.';
  end if;
  if current_primary is not null and (current_primary <> target_contact or current_contact_version is null) then
    raise exception using errcode = 'P1701', message = 'Official contact is no longer eligible for this review.';
  end if;

  if current_primary is null then
    insert into local801.person_contact_methods
      (id, organization_id, person_id, contact_type, contact_value, is_primary, visibility, verified_at)
    values
      (target_contact, target_organization, request_person, target_contact_type,
       'protected-' || target_contact::text, true, target_visibility, now());
  else
    update local801.person_contact_methods
    set contact_value = 'protected-' || target_contact::text,
        verified_at = now()
    where organization_id = target_organization and id = target_contact;
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
  if changed <> 1 then
    raise exception using errcode = 'P1701', message = 'Contact correction request is no longer pending.';
  end if;
  return true;
end;
$$;

commit;
