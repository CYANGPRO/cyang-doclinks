begin;

create table local801.user_policy_acknowledgements (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references local801.organizations(id),
  user_id uuid not null,
  policy_key text not null check (policy_key ~ '^[a-z][a-z0-9_-]{0,63}$'),
  policy_version text not null check (policy_version ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}([.][1-9][0-9]*)?$'),
  acknowledged_at timestamptz not null default now(),
  constraint user_policy_acknowledgements_org_id_uq unique (organization_id, id),
  constraint user_policy_acknowledgements_user_org_fk
    foreign key (organization_id, user_id)
    references local801.users (organization_id, id),
  constraint user_policy_acknowledgements_version_uq
    unique (organization_id, user_id, policy_key, policy_version)
);

create index user_policy_acknowledgements_current_idx
  on local801.user_policy_acknowledgements
  (organization_id, user_id, policy_key, policy_version, acknowledged_at desc);

comment on table local801.user_policy_acknowledgements is
  'Append-only evidence that an active workspace user accepted a specific policy version.';

commit;
