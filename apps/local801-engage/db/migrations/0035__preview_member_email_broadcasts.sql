begin;

create table local801.member_email_broadcasts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references local801.organizations(id),
  source_snapshot_id uuid not null references local801.membership_snapshots(id),
  status text not null default 'draft'
    check (status in ('draft','review','approved','simulated','cancelled')),
  subject_hash_key_version text not null,
  subject_hash text not null check (subject_hash ~ '^[0-9a-f]{64}$'),
  body_hash_key_version text not null,
  body_hash text not null check (body_hash ~ '^[0-9a-f]{64}$'),
  eligible_count integer not null default 0 check (eligible_count between 0 and 25000),
  missing_count integer not null default 0 check (missing_count between 0 and 25000),
  duplicate_count integer not null default 0 check (duplicate_count between 0 and 25000),
  suppressed_count integer not null default 0 check (suppressed_count between 0 and 25000),
  scheduled_for timestamptz,
  created_by uuid not null references local801.users(id),
  submitted_by uuid references local801.users(id),
  submitted_at timestamptz,
  approved_by uuid references local801.users(id),
  approved_at timestamptz,
  simulated_by uuid references local801.users(id),
  simulated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((submitted_by is null) = (submitted_at is null)),
  check ((approved_by is null) = (approved_at is null)),
  check ((simulated_by is null) = (simulated_at is null)),
  check (approved_by is null or approved_by <> created_by)
);

create table local801.member_email_broadcast_content (
  organization_id uuid not null references local801.organizations(id),
  broadcast_id uuid primary key references local801.member_email_broadcasts(id) on delete cascade,
  subject_encrypted_payload text not null check (length(subject_encrypted_payload) between 1 and 5000),
  subject_encryption_key_version text not null check (subject_encryption_key_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$'),
  subject_encryption_format_version smallint not null check (subject_encryption_format_version = 1),
  body_encrypted_payload text not null check (length(body_encrypted_payload) between 1 and 50000),
  body_encryption_key_version text not null check (body_encryption_key_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$'),
  body_encryption_format_version smallint not null check (body_encryption_format_version = 1),
  created_at timestamptz not null default now()
);

create table local801.member_email_broadcast_recipients (
  id uuid primary key,
  organization_id uuid not null references local801.organizations(id),
  broadcast_id uuid not null references local801.member_email_broadcasts(id) on delete cascade,
  person_id uuid not null references local801.people(id),
  contact_method_id uuid references local801.person_contact_methods(id),
  contact_kind text check (contact_kind in ('home','work')),
  recipient_status text not null check (recipient_status in ('eligible','missing','duplicate','suppressed')),
  duplicate_of_recipient_id uuid references local801.member_email_broadcast_recipients(id),
  email_blind_index_key_version text,
  email_blind_index text check (email_blind_index is null or email_blind_index ~ '^[0-9a-f]{64}$'),
  email_encrypted_payload text,
  email_encryption_key_version text,
  email_encryption_format_version smallint check (email_encryption_format_version is null or email_encryption_format_version = 1),
  simulated_delivery_at timestamptz,
  created_at timestamptz not null default now(),
  unique (broadcast_id, person_id),
  check ((recipient_status = 'missing') = (contact_method_id is null)),
  check ((recipient_status = 'duplicate') = (duplicate_of_recipient_id is not null)),
  check (
    (recipient_status = 'missing' and email_blind_index is null and email_encrypted_payload is null)
    or
    (recipient_status <> 'missing' and email_blind_index_key_version is not null
      and email_blind_index is not null and email_encrypted_payload is not null
      and email_encryption_key_version is not null and email_encryption_format_version = 1)
  )
);

create table local801.member_email_delivery_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references local801.organizations(id),
  broadcast_id uuid not null references local801.member_email_broadcasts(id) on delete cascade,
  recipient_id uuid not null references local801.member_email_broadcast_recipients(id) on delete cascade,
  provider_event_id text not null check (length(provider_event_id) between 16 and 200),
  event_type text not null check (event_type in ('simulated.test','simulated.delivered')),
  occurred_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  unique (organization_id, provider_event_id)
);

create table local801.member_email_preferences (
  organization_id uuid not null references local801.organizations(id),
  topic text not null default 'member_updates' check (topic = 'member_updates'),
  email_blind_index_key_version text not null,
  email_blind_index text not null check (email_blind_index ~ '^[0-9a-f]{64}$'),
  unsubscribed_at timestamptz not null,
  source text not null check (source in ('preview_simulation','future_provider')),
  updated_at timestamptz not null default now(),
  primary key (organization_id, topic, email_blind_index_key_version, email_blind_index)
);

create index member_email_broadcasts_org_created_idx
  on local801.member_email_broadcasts (organization_id, created_at desc, id desc);
create index member_email_recipients_broadcast_status_idx
  on local801.member_email_broadcast_recipients (organization_id, broadcast_id, recipient_status, id);
create index member_email_delivery_broadcast_idx
  on local801.member_email_delivery_events (organization_id, broadcast_id, occurred_at desc);

comment on table local801.member_email_broadcasts is
  'Preview-only member broadcast workflow. Production runtime activation is denied by application policy.';
comment on table local801.member_email_broadcast_recipients is
  'Frozen protected recipient snapshot. Raw email addresses are never stored in operational or audit JSON.';

commit;
