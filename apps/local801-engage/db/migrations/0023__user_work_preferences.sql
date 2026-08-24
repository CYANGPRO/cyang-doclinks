begin;

create table if not exists local801.saved_work_views (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references local801.organizations(id),
  user_id uuid not null,
  label text not null,
  destination text not null,
  query_params jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint saved_work_views_user_fk
    foreign key (organization_id, user_id)
    references local801.users(organization_id, id)
    on delete cascade,
  constraint saved_work_views_label_ck
    check (char_length(trim(label)) between 1 and 80),
  constraint saved_work_views_destination_ck
    check (destination in ('/workload','/follow-ups','/outreach','/new-hires','/imports','/membership/data-quality')),
  constraint saved_work_views_query_params_object_ck
    check (jsonb_typeof(query_params) = 'object'),
  constraint saved_work_views_query_params_size_ck
    check (octet_length(query_params::text) <= 2048)
);

create unique index if not exists saved_work_views_org_user_lower_label_uq
  on local801.saved_work_views (organization_id, user_id, lower(label));

create index if not exists saved_work_views_org_user_created_idx
  on local801.saved_work_views (organization_id, user_id, created_at desc, id);

create table if not exists local801.notification_acknowledgements (
  organization_id uuid not null references local801.organizations(id),
  user_id uuid not null,
  notification_key char(64) not null,
  acknowledged_at timestamptz not null default now(),
  constraint notification_acknowledgements_user_fk
    foreign key (organization_id, user_id)
    references local801.users(organization_id, id)
    on delete cascade,
  constraint notification_acknowledgements_key_ck
    check (notification_key ~ '^[0-9a-f]{64}$'),
  primary key (organization_id, user_id, notification_key)
);

create index if not exists notification_acknowledgements_org_user_time_idx
  on local801.notification_acknowledgements (organization_id, user_id, acknowledged_at desc);

commit;