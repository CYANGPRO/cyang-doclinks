begin;

create or replace function local801.pii_protected_mode_enabled(target_organization uuid)
returns boolean
language sql
stable
as $$
  select exists (
    select 1
    from local801.pii_protection_state state
    where state.organization_id = target_organization
      and state.write_mode = 'protected'
      and state.backfill_state = 'complete'
      and state.backfill_completed_at is not null
      and state.protected_read_enabled_at is not null
      and state.protected_write_enabled_at is not null
      and state.verified_at is not null
  );
$$;

create or replace function local801.require_protected_user_pii()
returns trigger
language plpgsql
as $$
begin
  if not local801.pii_protected_mode_enabled(new.organization_id) then return null; end if;
  if not exists (
    select 1 from local801.user_pii protected
    where protected.organization_id = new.organization_id and protected.user_id = new.id
  ) then raise exception 'protected user PII companion required'; end if;
  if not exists (
    select 1 from local801.pii_exact_indexes idx
    where idx.organization_id = new.organization_id and idx.entity_type = 'user'
      and idx.entity_id = new.id and idx.index_domain = 'user:email'
  ) then raise exception 'protected user email blind index required'; end if;
  return null;
end;
$$;

drop trigger if exists users_require_protected_pii on local801.users;
create constraint trigger users_require_protected_pii
after insert or update on local801.users
deferrable initially deferred for each row execute function local801.require_protected_user_pii();

create or replace function local801.require_protected_person_pii()
returns trigger
language plpgsql
as $$
begin
  if not local801.pii_protected_mode_enabled(new.organization_id) then return null; end if;
  if not exists (
    select 1 from local801.person_pii protected
    where protected.organization_id = new.organization_id and protected.person_id = new.id
  ) then raise exception 'protected person PII companion required'; end if;
  return null;
end;
$$;

drop trigger if exists people_require_protected_pii on local801.people;
create constraint trigger people_require_protected_pii
after insert or update on local801.people
deferrable initially deferred for each row execute function local801.require_protected_person_pii();

create or replace function local801.require_protected_identifier_pii()
returns trigger
language plpgsql
as $$
declare required_domain text;
begin
  if not local801.pii_protected_mode_enabled(new.organization_id) then return null; end if;
  if not exists (
    select 1 from local801.person_identifier_pii protected
    where protected.organization_id = new.organization_id and protected.person_identifier_id = new.id
  ) then raise exception 'protected person identifier companion required'; end if;
  required_domain := case new.identifier_type
    when 'employee_identifier' then 'identifier:employee-identifier'
    when 'member_identifier' then 'identifier:member-identifier'
    else 'identifier:' || replace(lower(new.identifier_type), '_', '-')
  end;
  if not exists (
    select 1 from local801.pii_exact_indexes idx
    where idx.organization_id = new.organization_id and idx.entity_type = 'person_identifier'
      and idx.entity_id = new.id and idx.index_domain = required_domain
  ) then raise exception 'protected person identifier blind index required'; end if;
  return null;
end;
$$;

drop trigger if exists person_identifiers_require_protected_pii on local801.person_identifiers;
create constraint trigger person_identifiers_require_protected_pii
after insert or update on local801.person_identifiers
deferrable initially deferred for each row execute function local801.require_protected_identifier_pii();

create or replace function local801.require_protected_contact_pii()
returns trigger
language plpgsql
as $$
declare required_domain text;
begin
  if not local801.pii_protected_mode_enabled(new.organization_id) then return null; end if;
  if not exists (
    select 1 from local801.person_contact_method_pii protected
    where protected.organization_id = new.organization_id and protected.contact_method_id = new.id
  ) then raise exception 'protected contact companion required'; end if;
  required_domain := 'contact:' || replace(lower(new.contact_type), '_', '-');
  if not exists (
    select 1 from local801.pii_exact_indexes idx
    where idx.organization_id = new.organization_id and idx.entity_type = 'person_contact_method'
      and idx.entity_id = new.id and idx.index_domain = required_domain
  ) then raise exception 'protected contact blind index required'; end if;
  return null;
end;
$$;

drop trigger if exists person_contacts_require_protected_pii on local801.person_contact_methods;
create constraint trigger person_contacts_require_protected_pii
after insert or update on local801.person_contact_methods
deferrable initially deferred for each row execute function local801.require_protected_contact_pii();

create or replace function local801.require_protected_auth_identity_pii()
returns trigger
language plpgsql
as $$
declare required_domain text;
begin
  if not local801.pii_protected_mode_enabled(new.organization_id) then return null; end if;
  if not exists (
    select 1 from local801.auth_identity_pii protected
    where protected.organization_id = new.organization_id and protected.auth_identity_id = new.id
  ) then raise exception 'protected authentication identity companion required'; end if;
  required_domain := 'auth:provider-subject:' || new.provider_id;
  if not exists (
    select 1 from local801.pii_exact_indexes idx
    where idx.organization_id = new.organization_id and idx.entity_type = 'auth_identity'
      and idx.entity_id = new.id and idx.index_domain = required_domain
  ) then raise exception 'protected authentication subject blind index required'; end if;
  return null;
end;
$$;

drop trigger if exists auth_identities_require_protected_pii on local801.auth_identities;
create constraint trigger auth_identities_require_protected_pii
after insert or update on local801.auth_identities
deferrable initially deferred for each row execute function local801.require_protected_auth_identity_pii();

create or replace function local801.require_protected_import_file_pii()
returns trigger
language plpgsql
as $$
begin
  if not local801.pii_protected_mode_enabled(new.organization_id) then return null; end if;
  if not exists (
    select 1 from local801.import_file_pii protected
    where protected.organization_id = new.organization_id and protected.import_file_id = new.id
  ) then raise exception 'protected import filename companion required'; end if;
  return null;
end;
$$;

drop trigger if exists import_files_require_protected_pii on local801.import_files;
create constraint trigger import_files_require_protected_pii
after insert or update on local801.import_files
deferrable initially deferred for each row execute function local801.require_protected_import_file_pii();

create or replace function local801.require_protected_import_row_pii()
returns trigger
language plpgsql
as $$
begin
  if not local801.pii_protected_mode_enabled(new.organization_id) then return null; end if;
  if new.normalized_json ?| array['first_name','last_name','preferred_name','work_email','employee_identifier','member_identifier'] then
    raise exception 'direct PII is forbidden in protected import normalized_json';
  end if;
  if not exists (
    select 1 from local801.import_row_pii protected
    where protected.organization_id = new.organization_id and protected.import_row_id = new.id
      and protected.direct_pii_field_set_version = 2
      and protected.direct_pii_presence_mask is not null
      and protected.direct_pii_validity_mask is not null
      and protected.row_integrity_hash ~ '^[0-9a-f]{64}$'
  ) then raise exception 'protected import-row companion v2 required'; end if;
  return null;
end;
$$;

drop trigger if exists import_rows_require_protected_pii on local801.import_rows;
create constraint trigger import_rows_require_protected_pii
after insert or update on local801.import_rows
deferrable initially deferred for each row execute function local801.require_protected_import_row_pii();

create or replace function local801.require_protected_correction_pii()
returns trigger
language plpgsql
as $$
begin
  if not local801.pii_protected_mode_enabled(new.organization_id) then return null; end if;
  if not exists (
    select 1 from local801.contact_correction_request_pii protected
    where protected.organization_id = new.organization_id and protected.correction_request_id = new.id
  ) then raise exception 'protected contact correction companion required'; end if;
  return null;
end;
$$;

drop trigger if exists contact_corrections_require_protected_pii on local801.contact_correction_requests;
create constraint trigger contact_corrections_require_protected_pii
after insert or update on local801.contact_correction_requests
deferrable initially deferred for each row execute function local801.require_protected_correction_pii();

create or replace function local801.require_protected_push_subscription_pii()
returns trigger
language plpgsql
as $$
begin
  if not local801.pii_protected_mode_enabled(new.organization_id) then return null; end if;
  if not exists (
    select 1 from local801.push_subscription_pii protected
    where protected.organization_id = new.organization_id and protected.push_subscription_id = new.id
  ) then raise exception 'protected push subscription companion required'; end if;
  if not exists (
    select 1 from local801.pii_exact_indexes idx
    where idx.organization_id = new.organization_id and idx.entity_type = 'push_subscription'
      and idx.entity_id = new.id and idx.index_domain = 'push:endpoint'
  ) then raise exception 'protected push endpoint blind index required'; end if;
  return null;
end;
$$;

drop trigger if exists push_subscriptions_require_protected_pii on local801.push_subscriptions;
create constraint trigger push_subscriptions_require_protected_pii
after insert or update on local801.push_subscriptions
deferrable initially deferred for each row execute function local801.require_protected_push_subscription_pii();

commit;
