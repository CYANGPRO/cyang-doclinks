begin;

create table local801.engagement_notes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references local801.organizations(id),
  engagement_event_id uuid not null references local801.engagement_events(id) on delete cascade,
  encrypted_payload text not null
    check (length(encrypted_payload) between 1 and 20000),
  encryption_key_version text not null
    check (length(encryption_key_version) between 1 and 32),
  encryption_format_version integer not null
    check (encryption_format_version between 1 and 100),
  visibility text not null default 'assigned_scope'
    check (visibility in ('writer_only','assigned_scope','cat_members','cat_leads','administrators')),
  created_by uuid not null references local801.users(id),
  created_at timestamptz not null default now(),
  archived_at timestamptz,
  unique (engagement_event_id)
);

create index engagement_notes_org_event_idx
  on local801.engagement_notes (organization_id, engagement_event_id)
  where archived_at is null;

create index engagement_notes_org_creator_idx
  on local801.engagement_notes (organization_id, created_by, created_at desc)
  where archived_at is null;

commit;
