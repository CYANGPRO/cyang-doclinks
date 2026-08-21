begin;

-- Stage 14B2 is intentionally additive. Existing plaintext columns remain in place until a
-- later protected-read/write/backfill acceptance gate has passed. No data rows are changed here.

-- Composite uniqueness lets protected companion rows enforce organization scope through FKs.
create unique index if not exists users_org_id_pii_uq
  on local801.users (organization_id, id);
create unique index if not exists auth_identities_org_id_pii_uq
  on local801.auth_identities (organization_id, id);
create unique index if not exists people_org_id_pii_uq
  on local801.people (organization_id, id);
create unique index if not exists person_identifiers_org_id_pii_uq
  on local801.person_identifiers (organization_id, id);
create unique index if not exists person_contact_methods_org_id_pii_uq
  on local801.person_contact_methods (organization_id, id);
create unique index if not exists contact_correction_requests_org_id_pii_uq
  on local801.contact_correction_requests (organization_id, id);
create unique index if not exists import_files_org_id_pii_uq
  on local801.import_files (organization_id, id);
create unique index if not exists import_rows_org_id_pii_uq
  on local801.import_rows (organization_id, id);
create unique index if not exists push_subscriptions_org_id_pii_uq
  on local801.push_subscriptions (organization_id, id);

create table local801.user_pii (
  organization_id uuid not null references local801.organizations(id),
  user_id uuid not null,
  email_encrypted_payload text not null check (length(email_encrypted_payload) between 1 and 5000),
  email_encryption_key_version text not null
    check (email_encryption_key_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$'),
  email_encryption_format_version integer not null
    check (email_encryption_format_version between 1 and 100),
  display_name_encrypted_payload text not null check (length(display_name_encrypted_payload) between 1 and 5000),
  display_name_encryption_key_version text not null
    check (display_name_encryption_key_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$'),
  display_name_encryption_format_version integer not null
    check (display_name_encryption_format_version between 1 and 100),
  protected_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, user_id),
  foreign key (organization_id, user_id)
    references local801.users (organization_id, id) on delete cascade
);

create table local801.auth_identity_pii (
  organization_id uuid not null references local801.organizations(id),
  auth_identity_id uuid not null,
  provider_subject_encrypted_payload text not null check (length(provider_subject_encrypted_payload) between 1 and 10000),
  provider_subject_encryption_key_version text not null
    check (provider_subject_encryption_key_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$'),
  provider_subject_encryption_format_version integer not null
    check (provider_subject_encryption_format_version between 1 and 100),
  linked_email_encrypted_payload text not null check (length(linked_email_encrypted_payload) between 1 and 5000),
  linked_email_encryption_key_version text not null
    check (linked_email_encryption_key_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$'),
  linked_email_encryption_format_version integer not null
    check (linked_email_encryption_format_version between 1 and 100),
  protected_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, auth_identity_id),
  foreign key (organization_id, auth_identity_id)
    references local801.auth_identities (organization_id, id) on delete cascade
);

create table local801.person_pii (
  organization_id uuid not null references local801.organizations(id),
  person_id uuid not null,
  first_name_encrypted_payload text not null check (length(first_name_encrypted_payload) between 1 and 5000),
  first_name_encryption_key_version text not null
    check (first_name_encryption_key_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$'),
  first_name_encryption_format_version integer not null
    check (first_name_encryption_format_version between 1 and 100),
  last_name_encrypted_payload text not null check (length(last_name_encrypted_payload) between 1 and 5000),
  last_name_encryption_key_version text not null
    check (last_name_encryption_key_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$'),
  last_name_encryption_format_version integer not null
    check (last_name_encryption_format_version between 1 and 100),
  preferred_name_encrypted_payload text,
  preferred_name_encryption_key_version text,
  preferred_name_encryption_format_version integer,
  name_sort_encrypted_payload text not null check (length(name_sort_encrypted_payload) between 1 and 10000),
  name_sort_encryption_key_version text not null
    check (name_sort_encryption_key_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$'),
  name_sort_encryption_format_version integer not null
    check (name_sort_encryption_format_version between 1 and 100),
  protected_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, person_id),
  foreign key (organization_id, person_id)
    references local801.people (organization_id, id) on delete cascade,
  check (
    (preferred_name_encrypted_payload is null
      and preferred_name_encryption_key_version is null
      and preferred_name_encryption_format_version is null)
    or
    (preferred_name_encrypted_payload is not null
      and length(preferred_name_encrypted_payload) between 1 and 5000
      and preferred_name_encryption_key_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$'
      and preferred_name_encryption_format_version between 1 and 100)
  )
);

create table local801.person_identifier_pii (
  organization_id uuid not null references local801.organizations(id),
  person_identifier_id uuid not null,
  identifier_value_encrypted_payload text not null check (length(identifier_value_encrypted_payload) between 1 and 10000),
  encryption_key_version text not null
    check (encryption_key_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$'),
  encryption_format_version integer not null check (encryption_format_version between 1 and 100),
  protected_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, person_identifier_id),
  foreign key (organization_id, person_identifier_id)
    references local801.person_identifiers (organization_id, id) on delete cascade
);

create table local801.person_contact_method_pii (
  organization_id uuid not null references local801.organizations(id),
  contact_method_id uuid not null,
  contact_value_encrypted_payload text not null check (length(contact_value_encrypted_payload) between 1 and 25000),
  encryption_key_version text not null
    check (encryption_key_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$'),
  encryption_format_version integer not null check (encryption_format_version between 1 and 100),
  protected_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, contact_method_id),
  foreign key (organization_id, contact_method_id)
    references local801.person_contact_methods (organization_id, id) on delete cascade
);

create table local801.contact_correction_request_pii (
  organization_id uuid not null references local801.organizations(id),
  correction_request_id uuid not null,
  proposed_value_encrypted_payload text not null check (length(proposed_value_encrypted_payload) between 1 and 25000),
  encryption_key_version text not null
    check (encryption_key_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$'),
  encryption_format_version integer not null check (encryption_format_version between 1 and 100),
  protected_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, correction_request_id),
  foreign key (organization_id, correction_request_id)
    references local801.contact_correction_requests (organization_id, id) on delete cascade
);

create table local801.import_file_pii (
  organization_id uuid not null references local801.organizations(id),
  import_file_id uuid not null,
  original_filename_encrypted_payload text not null check (length(original_filename_encrypted_payload) between 1 and 10000),
  encryption_key_version text not null
    check (encryption_key_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$'),
  encryption_format_version integer not null check (encryption_format_version between 1 and 100),
  protected_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, import_file_id),
  foreign key (organization_id, import_file_id)
    references local801.import_files (organization_id, id) on delete cascade
);

-- Imported direct PII is stored as one authenticated row bundle. Exact-match derivatives live in
-- pii_exact_indexes, so review/matching does not require decrypting the full import population.
create table local801.import_row_pii (
  organization_id uuid not null references local801.organizations(id),
  import_row_id uuid not null,
  direct_pii_encrypted_payload text not null check (length(direct_pii_encrypted_payload) between 1 and 50000),
  encryption_key_version text not null
    check (encryption_key_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$'),
  encryption_format_version integer not null check (encryption_format_version between 1 and 100),
  direct_pii_field_set_version integer not null default 1
    check (direct_pii_field_set_version between 1 and 100),
  row_integrity_hash text not null check (row_integrity_hash ~ '^[0-9a-f]{64}$'),
  row_integrity_key_version text not null
    check (row_integrity_key_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$'),
  protected_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, import_row_id),
  foreign key (organization_id, import_row_id)
    references local801.import_rows (organization_id, id) on delete cascade
);

create table local801.push_subscription_pii (
  organization_id uuid not null references local801.organizations(id),
  push_subscription_id uuid not null,
  subscription_encrypted_payload text not null check (length(subscription_encrypted_payload) between 1 and 50000),
  encryption_key_version text not null
    check (encryption_key_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$'),
  encryption_format_version integer not null check (encryption_format_version between 1 and 100),
  protected_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, push_subscription_id),
  foreign key (organization_id, push_subscription_id)
    references local801.push_subscriptions (organization_id, id) on delete cascade
);

-- Polymorphic equality indexes contain keyed HMAC derivatives only, never plaintext or ciphertext.
-- Queries must join the matching source/companion entity and re-check organization scope.
create table local801.pii_exact_indexes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references local801.organizations(id),
  entity_type text not null check (entity_type in (
    'user','auth_identity','person','person_identifier','person_contact_method','import_row','push_subscription'
  )),
  entity_id uuid not null,
  index_domain text not null
    check (index_domain ~ '^[a-z0-9][a-z0-9._:-]{0,95}$'),
  index_key_version text not null
    check (index_key_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$'),
  index_hash text not null check (index_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  unique (organization_id, entity_type, entity_id, index_domain, index_key_version)
);

create index pii_exact_indexes_lookup_idx
  on local801.pii_exact_indexes (
    organization_id, entity_type, index_domain, index_key_version, index_hash
  );

create table local801.person_search_tokens (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references local801.organizations(id),
  person_id uuid not null,
  token_domain text not null check (token_domain in ('first_name','last_name','preferred_name','combined_name')),
  token_kind text not null check (token_kind in ('word','prefix')),
  token_key_version text not null
    check (token_key_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$'),
  token_hash text not null check (token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  foreign key (organization_id, person_id)
    references local801.people (organization_id, id) on delete cascade,
  unique (organization_id, person_id, token_domain, token_kind, token_key_version, token_hash)
);

create index person_search_tokens_lookup_idx
  on local801.person_search_tokens (
    organization_id, token_domain, token_kind, token_key_version, token_hash, person_id
  );

-- This table records migration/cutover state only. Migration 0012 inserts no organization rows and
-- does not switch any application read/write path. Later guarded tooling may advance these states.
create table local801.pii_protection_state (
  organization_id uuid primary key references local801.organizations(id) on delete cascade,
  schema_version integer not null default 1 check (schema_version between 1 and 100),
  write_mode text not null default 'legacy' check (write_mode in ('legacy','dual','protected')),
  backfill_state text not null default 'not_started'
    check (backfill_state in ('not_started','running','complete','failed')),
  backfill_completed_at timestamptz,
  protected_read_enabled_at timestamptz,
  protected_write_enabled_at timestamptz,
  verified_at timestamptz,
  updated_at timestamptz not null default now(),
  check (write_mode <> 'protected' or protected_write_enabled_at is not null),
  check (protected_read_enabled_at is null or backfill_state = 'complete'),
  check (verified_at is null or (backfill_state = 'complete' and protected_read_enabled_at is not null))
);

commit;
