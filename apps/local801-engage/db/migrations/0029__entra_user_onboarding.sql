begin;

create table local801.user_identity_onboarding (
  organization_id uuid not null references local801.organizations(id),
  user_id uuid primary key references local801.users(id) on delete cascade,
  provider_id text not null default 'microsoft-entra-b2b',
  provider_user_id uuid,
  status text not null default 'pending',
  invitation_status text,
  invitation_sent_at timestamptz,
  access_assigned_at timestamptz,
  last_attempted_at timestamptz,
  attempt_count integer not null default 0,
  last_error_code text,
  completed_at timestamptz,
  constraint user_identity_onboarding_user_org_fk
    foreign key (organization_id, user_id)
    references local801.users (organization_id, id)
    on delete cascade,
  constraint user_identity_onboarding_status_ck
    check (status in ('pending', 'processing', 'invited', 'ready', 'failed')),
  constraint user_identity_onboarding_attempt_count_ck
    check (attempt_count >= 0),
  constraint user_identity_onboarding_error_code_ck
    check (last_error_code is null or last_error_code ~ '^[A-Z][A-Z0-9_]{0,79}$'),
  constraint user_identity_onboarding_completed_ck
    check ((status = 'ready') = (completed_at is not null))
);

create unique index user_identity_onboarding_provider_user_uq
  on local801.user_identity_onboarding (organization_id, provider_id, provider_user_id)
  where provider_user_id is not null;

create index user_identity_onboarding_status_idx
  on local801.user_identity_onboarding (organization_id, status, last_attempted_at desc);

comment on table local801.user_identity_onboarding is
  'Non-PII state for CAT-driven Microsoft Entra B2B invitation and enterprise-application assignment.';

commit;
