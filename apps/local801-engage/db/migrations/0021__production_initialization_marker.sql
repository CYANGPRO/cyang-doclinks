begin;

create table local801.production_initializations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null unique references local801.organizations(id),
  initial_system_owner_id uuid not null unique references local801.users(id),
  initialization_version integer not null default 1 check (initialization_version = 1),
  target_fingerprint text not null check (target_fingerprint ~ '^[0-9a-f]{64}$'),
  audit_event_id uuid not null unique references local801.audit_events(id),
  initialized_at timestamptz not null default now()
);

commit;
