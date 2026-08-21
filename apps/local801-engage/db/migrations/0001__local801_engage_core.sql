begin;

create extension if not exists pgcrypto;

create schema if not exists local801;
create schema if not exists reporting;

create table local801.organizations (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  created_at timestamptz not null default now(),
  archived_at timestamptz
);

create table local801.users (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references local801.organizations(id),
  email text not null,
  display_name text not null,
  mfa_enrolled_at timestamptz,
  deactivated_at timestamptz,
  created_at timestamptz not null default now()
);

create unique index users_organization_lower_email_uq
  on local801.users (organization_id, lower(email));

create table local801.workspace_roles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references local801.organizations(id),
  code text not null,
  name text not null,
  session_seconds integer not null,
  created_at timestamptz not null default now(),
  unique (organization_id, code)
);

create table local801.workspace_permissions (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  description text not null
);

create table local801.workspace_role_permissions (
  role_id uuid not null references local801.workspace_roles(id) on delete cascade,
  permission_id uuid not null references local801.workspace_permissions(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (role_id, permission_id)
);

create table local801.workspace_user_roles (
  user_id uuid not null references local801.users(id) on delete cascade,
  role_id uuid not null references local801.workspace_roles(id) on delete cascade,
  assigned_by uuid references local801.users(id),
  created_at timestamptz not null default now(),
  primary key (user_id, role_id)
);

create table local801.people (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references local801.organizations(id),
  preferred_name text,
  first_name text not null,
  last_name text not null,
  membership_status text not null check (membership_status in ('member','nonmember','unknown')),
  department text,
  section text,
  classification text,
  work_location text,
  local_number text not null default '0801',
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table local801.person_identifiers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references local801.organizations(id),
  person_id uuid not null references local801.people(id) on delete cascade,
  identifier_type text not null,
  identifier_value text not null,
  source_import_file_id uuid,
  created_at timestamptz not null default now(),
  unique (organization_id, identifier_type, identifier_value)
);

create table local801.person_contact_methods (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references local801.organizations(id),
  person_id uuid not null references local801.people(id) on delete cascade,
  contact_type text not null check (contact_type in ('work_email','personal_email','phone','mailing_address')),
  contact_value text not null,
  is_primary boolean not null default false,
  visibility text not null default 'assigned_only',
  verified_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz not null default now()
);

create table local801.membership_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references local801.organizations(id),
  person_id uuid not null references local801.people(id),
  event_type text not null check (event_type in ('addition','drop','status_review','correction')),
  effective_date date not null,
  source_import_file_id uuid,
  created_by uuid references local801.users(id),
  created_at timestamptz not null default now()
);

create table local801.employment_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references local801.organizations(id),
  person_id uuid not null references local801.people(id),
  event_type text not null check (event_type in ('hire','transfer','separation','correction')),
  effective_date date not null,
  department text,
  work_location text,
  source_import_file_id uuid,
  created_at timestamptz not null default now()
);

create table local801.membership_snapshots (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references local801.organizations(id),
  snapshot_date date not null,
  status text not null check (status in ('pending','approved','superseded','archived')),
  approved_by uuid references local801.users(id),
  approved_at timestamptz,
  source_import_batch_id uuid,
  created_at timestamptz not null default now(),
  unique (organization_id, snapshot_date, status)
);

create table local801.membership_snapshot_rows (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references local801.organizations(id),
  snapshot_id uuid not null references local801.membership_snapshots(id) on delete cascade,
  person_id uuid not null references local801.people(id),
  membership_status text not null,
  department text,
  work_location text,
  classification text,
  row_hash text not null,
  created_at timestamptz not null default now(),
  unique (snapshot_id, person_id)
);

create table local801.import_batches (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references local801.organizations(id),
  import_kind text not null,
  state text not null check (state in ('uploaded','mapping','validated','under_review','approved','rejected')),
  uploaded_by uuid references local801.users(id),
  approved_by uuid references local801.users(id),
  approved_at timestamptz,
  rejected_reason text,
  created_at timestamptz not null default now()
);

create table local801.import_files (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references local801.organizations(id),
  import_batch_id uuid not null references local801.import_batches(id) on delete cascade,
  original_filename text not null,
  media_type text not null,
  byte_size bigint not null,
  storage_key text not null,
  sha256 text not null,
  malware_scan_status text not null default 'pending',
  created_at timestamptz not null default now()
);

alter table local801.person_identifiers
  add constraint person_identifiers_source_file_fk foreign key (source_import_file_id) references local801.import_files(id);

alter table local801.membership_events
  add constraint membership_events_source_file_fk foreign key (source_import_file_id) references local801.import_files(id);

alter table local801.employment_events
  add constraint employment_events_source_file_fk foreign key (source_import_file_id) references local801.import_files(id);

alter table local801.membership_snapshots
  add constraint membership_snapshots_batch_fk foreign key (source_import_batch_id) references local801.import_batches(id);

create table local801.import_sheets (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references local801.organizations(id),
  import_file_id uuid not null references local801.import_files(id) on delete cascade,
  sheet_name text not null,
  sheet_state text not null check (sheet_state in ('included','ignored','obsolete','notes_review')),
  row_count integer not null default 0,
  created_at timestamptz not null default now()
);

create table local801.import_mappings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references local801.organizations(id),
  import_sheet_id uuid not null references local801.import_sheets(id) on delete cascade,
  source_column text not null,
  target_column text not null,
  transform text,
  created_at timestamptz not null default now()
);

create table local801.import_rows (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references local801.organizations(id),
  import_sheet_id uuid not null references local801.import_sheets(id) on delete cascade,
  source_row_number integer not null,
  row_hash text not null,
  normalized_json jsonb not null,
  state text not null default 'pending',
  created_at timestamptz not null default now()
);

create table local801.import_errors (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references local801.organizations(id),
  import_row_id uuid references local801.import_rows(id) on delete cascade,
  severity text not null check (severity in ('warning','error')),
  field_name text,
  message text not null,
  created_at timestamptz not null default now()
);

create table local801.import_match_candidates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references local801.organizations(id),
  import_row_id uuid not null references local801.import_rows(id) on delete cascade,
  person_id uuid references local801.people(id),
  match_rule text not null,
  confidence numeric(5,2) not null,
  requires_review boolean not null default true,
  created_at timestamptz not null default now()
);

create table local801.import_approvals (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references local801.organizations(id),
  import_batch_id uuid not null references local801.import_batches(id),
  approved_by uuid not null references local801.users(id),
  approval_hash text not null,
  approved_at timestamptz not null default now(),
  unique (import_batch_id, approval_hash)
);

create table local801.legacy_note_review_queue (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references local801.organizations(id),
  import_row_id uuid references local801.import_rows(id),
  note_excerpt_hash text not null,
  source_context text not null,
  state text not null default 'needs_review',
  reviewed_by uuid references local801.users(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);

create table local801.outreach_campaigns (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references local801.organizations(id),
  name text not null,
  status text not null check (status in ('draft','active','closed','archived')),
  starts_on date,
  ends_on date,
  created_by uuid references local801.users(id),
  launched_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz not null default now()
);

create table local801.outreach_campaign_population (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references local801.organizations(id),
  campaign_id uuid not null references local801.outreach_campaigns(id) on delete cascade,
  person_id uuid not null references local801.people(id),
  frozen_at timestamptz not null default now(),
  source_snapshot_id uuid references local801.membership_snapshots(id),
  unique (campaign_id, person_id)
);

create table local801.engagement_assignments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references local801.organizations(id),
  campaign_id uuid references local801.outreach_campaigns(id),
  person_id uuid not null references local801.people(id),
  primary_user_id uuid references local801.users(id),
  backup_user_id uuid references local801.users(id),
  assignment_type text not null default 'direct',
  status text not null default 'open',
  due_at timestamptz,
  created_by uuid references local801.users(id),
  created_at timestamptz not null default now(),
  archived_at timestamptz
);

create table local801.engagement_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references local801.organizations(id),
  assignment_id uuid references local801.engagement_assignments(id),
  campaign_id uuid references local801.outreach_campaigns(id),
  person_id uuid not null references local801.people(id),
  recorded_by uuid not null references local801.users(id),
  contact_method text not null,
  outcome text not null,
  note_visibility text not null default 'assigned_scope',
  note_hash text,
  occurred_at timestamptz not null default now(),
  voided_at timestamptz,
  voided_by uuid references local801.users(id)
);

create table local801.engagement_followups (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references local801.organizations(id),
  engagement_event_id uuid references local801.engagement_events(id),
  person_id uuid not null references local801.people(id),
  assigned_to uuid references local801.users(id),
  due_at timestamptz not null,
  status text not null default 'open',
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create table local801.contact_correction_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references local801.organizations(id),
  person_id uuid not null references local801.people(id),
  submitted_by uuid not null references local801.users(id),
  field_name text not null,
  proposed_value text not null,
  state text not null default 'submitted',
  decided_by uuid references local801.users(id),
  decided_at timestamptz,
  created_at timestamptz not null default now()
);

create table local801.campaign_instructions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references local801.organizations(id),
  campaign_id uuid not null references local801.outreach_campaigns(id) on delete cascade,
  body text not null,
  created_by uuid references local801.users(id),
  created_at timestamptz not null default now()
);

create table local801.contract_cycles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references local801.organizations(id),
  name text not null,
  starts_on date,
  ends_on date,
  status text not null default 'planning',
  created_at timestamptz not null default now()
);

create table local801.cat_actions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references local801.organizations(id),
  contract_cycle_id uuid references local801.contract_cycles(id),
  name text not null,
  status text not null check (status in ('draft','active','closed','archived')),
  created_by uuid references local801.users(id),
  created_at timestamptz not null default now(),
  archived_at timestamptz
);

create table local801.cat_action_strategy (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references local801.organizations(id),
  cat_action_id uuid not null references local801.cat_actions(id) on delete cascade,
  strategy_hash text not null,
  visibility text not null default 'cat_admin_only',
  created_by uuid references local801.users(id),
  created_at timestamptz not null default now()
);

create table local801.cat_action_tasks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references local801.organizations(id),
  cat_action_id uuid not null references local801.cat_actions(id) on delete cascade,
  assigned_to uuid references local801.users(id),
  title text not null,
  status text not null default 'open',
  due_at timestamptz,
  created_at timestamptz not null default now()
);

create table local801.cat_action_metrics (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references local801.organizations(id),
  cat_action_id uuid not null references local801.cat_actions(id) on delete cascade,
  metric_key text not null,
  metric_value numeric not null,
  recorded_at timestamptz not null default now()
);

create table local801.report_definitions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references local801.organizations(id),
  code text not null,
  name text not null,
  requires_person_level_permission boolean not null default false,
  created_at timestamptz not null default now(),
  unique (organization_id, code)
);

create table local801.report_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references local801.organizations(id),
  report_definition_id uuid not null references local801.report_definitions(id),
  run_by uuid not null references local801.users(id),
  source_snapshot_id uuid references local801.membership_snapshots(id),
  parameters jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table local801.generated_reports (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references local801.organizations(id),
  report_run_id uuid not null references local801.report_runs(id) on delete cascade,
  storage_key text not null,
  sha256 text not null,
  expires_at timestamptz,
  created_at timestamptz not null default now()
);

create table local801.documents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references local801.organizations(id),
  category text not null,
  title text not null,
  storage_key text not null,
  encryption_key_version text not null,
  sha256 text not null,
  visibility text not null,
  status text not null check (status in ('draft','active','under_review','approved','superseded','archived')),
  created_by uuid references local801.users(id),
  created_at timestamptz not null default now(),
  archived_at timestamptz
);

create table local801.document_links (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references local801.organizations(id),
  document_id uuid not null references local801.documents(id) on delete cascade,
  related_table text not null,
  related_id uuid not null,
  created_at timestamptz not null default now()
);

create table local801.user_notifications (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references local801.organizations(id),
  user_id uuid not null references local801.users(id) on delete cascade,
  notification_type text not null,
  generic_body text not null,
  target_url text not null,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create table local801.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references local801.organizations(id),
  user_id uuid not null references local801.users(id) on delete cascade,
  endpoint_hash text not null,
  subscription_json jsonb not null,
  disabled_at timestamptz,
  created_at timestamptz not null default now(),
  unique (organization_id, endpoint_hash)
);

create table local801.audit_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references local801.organizations(id),
  actor_user_id uuid references local801.users(id),
  event_type text not null,
  subject_type text,
  subject_id uuid,
  payload jsonb not null default '{}'::jsonb,
  previous_hash text,
  event_hash text not null,
  created_at timestamptz not null default now()
);

create index people_org_status_idx on local801.people (organization_id, membership_status) where archived_at is null;
create index people_org_department_idx on local801.people (organization_id, department) where archived_at is null;
create index contact_person_idx on local801.person_contact_methods (organization_id, person_id) where archived_at is null;
create index import_batches_org_state_idx on local801.import_batches (organization_id, state, created_at desc);
create index import_rows_sheet_state_idx on local801.import_rows (import_sheet_id, state);
create index assignment_org_user_idx on local801.engagement_assignments (organization_id, primary_user_id, status, due_at);
create index followups_org_user_idx on local801.engagement_followups (organization_id, assigned_to, status, due_at);
create index engagement_org_person_idx on local801.engagement_events (organization_id, person_id, occurred_at desc);
create index audit_org_created_idx on local801.audit_events (organization_id, created_at desc);

create or replace view reporting.current_membership as
select
  p.organization_id,
  p.id as person_id,
  p.membership_status,
  p.department,
  p.work_location,
  p.classification,
  p.local_number,
  p.updated_at as refreshed_at
from local801.people p
where p.archived_at is null;

create or replace view reporting.membership_snapshot_summary as
select
  ms.organization_id,
  ms.id as snapshot_id,
  ms.snapshot_date,
  ms.status,
  count(*) as represented_count,
  count(*) filter (where msr.membership_status = 'member') as member_count,
  count(*) filter (where msr.membership_status = 'nonmember') as nonmember_count
from local801.membership_snapshots ms
join local801.membership_snapshot_rows msr on msr.snapshot_id = ms.id
group by ms.organization_id, ms.id, ms.snapshot_date, ms.status;

create or replace view reporting.monthly_membership_changes as
select
  organization_id,
  date_trunc('month', effective_date)::date as month,
  count(*) filter (where event_type = 'addition') as additions,
  count(*) filter (where event_type = 'drop') as drops
from local801.membership_events
group by organization_id, date_trunc('month', effective_date)::date;

create or replace view reporting.new_hires as
select
  ee.organization_id,
  ee.person_id,
  ee.effective_date as hire_date,
  ee.department,
  ee.work_location
from local801.employment_events ee
where ee.event_type = 'hire';

create or replace view reporting.new_hire_conversion as
select
  nh.organization_id,
  date_trunc('month', nh.hire_date)::date as hire_month,
  count(*) as new_hires,
  count(*) filter (where p.membership_status = 'member') as current_members
from reporting.new_hires nh
join local801.people p on p.id = nh.person_id
group by nh.organization_id, date_trunc('month', nh.hire_date)::date;

create or replace view reporting.membership_by_department as
select organization_id, department, membership_status, count(*) as people_count
from reporting.current_membership
group by organization_id, department, membership_status;

create or replace view reporting.membership_by_work_location as
select organization_id, work_location, membership_status, count(*) as people_count
from reporting.current_membership
group by organization_id, work_location, membership_status;

create or replace view reporting.membership_retention as
select organization_id, month, additions, drops, additions - drops as net_change
from reporting.monthly_membership_changes;

create or replace view reporting.data_quality_summary as
select
  p.organization_id,
  count(*) filter (where p.first_name = '' or p.last_name = '') as missing_names,
  count(*) filter (where not exists (
    select 1 from local801.person_contact_methods pcm
    where pcm.person_id = p.id and pcm.contact_type = 'work_email' and pcm.archived_at is null
  )) as missing_work_email
from local801.people p
where p.archived_at is null
group by p.organization_id;

create or replace view reporting.campaign_summary as
select
  c.organization_id,
  c.id as campaign_id,
  c.name,
  c.status,
  count(distinct pop.person_id) as population_count,
  count(distinct e.person_id) as reached_count
from local801.outreach_campaigns c
left join local801.outreach_campaign_population pop on pop.campaign_id = c.id
left join local801.engagement_events e on e.campaign_id = c.id and e.voided_at is null
group by c.organization_id, c.id, c.name, c.status;

create or replace view reporting.engagement_by_department as
select e.organization_id, p.department, count(*) as event_count
from local801.engagement_events e
join local801.people p on p.id = e.person_id
where e.voided_at is null
group by e.organization_id, p.department;

create or replace view reporting.engagement_by_work_location as
select e.organization_id, p.work_location, count(*) as event_count
from local801.engagement_events e
join local801.people p on p.id = e.person_id
where e.voided_at is null
group by e.organization_id, p.work_location;

create or replace view reporting.engagement_by_organizer as
select e.organization_id, e.recorded_by as organizer_user_id, count(*) as event_count
from local801.engagement_events e
where e.voided_at is null
group by e.organization_id, e.recorded_by;

create or replace view reporting.followups as
select organization_id, assigned_to, status, count(*) as followup_count
from local801.engagement_followups
group by organization_id, assigned_to, status;

create or replace view reporting.contact_methods as
select organization_id, contact_method, count(*) as event_count
from local801.engagement_events
where voided_at is null
group by organization_id, contact_method;

create or replace view reporting.engagement_over_time as
select organization_id, date_trunc('day', occurred_at)::date as engagement_date, count(*) as event_count
from local801.engagement_events
where voided_at is null
group by organization_id, date_trunc('day', occurred_at)::date;

create or replace view reporting.engagement_coverage as
select
  pop.organization_id,
  pop.campaign_id,
  count(distinct pop.person_id) as assigned_count,
  count(distinct e.person_id) as contacted_count
from local801.outreach_campaign_population pop
left join local801.engagement_events e on e.campaign_id = pop.campaign_id and e.person_id = pop.person_id and e.voided_at is null
group by pop.organization_id, pop.campaign_id;

create or replace view reporting.cat_action_summary as
select ca.organization_id, ca.id as cat_action_id, ca.name, ca.status, count(t.id) as task_count
from local801.cat_actions ca
left join local801.cat_action_tasks t on t.cat_action_id = ca.id
group by ca.organization_id, ca.id, ca.name, ca.status;

create or replace view reporting.cat_action_participation as
select ca.organization_id, ca.id as cat_action_id, count(distinct t.assigned_to) filter (where t.status = 'complete') as participant_count
from local801.cat_actions ca
left join local801.cat_action_tasks t on t.cat_action_id = ca.id
group by ca.organization_id, ca.id;

create or replace view reporting.new_hire_engagement as
select nh.organization_id, nh.person_id, nh.hire_date, count(e.id) as engagement_count
from reporting.new_hires nh
left join local801.engagement_events e on e.person_id = nh.person_id and e.voided_at is null
group by nh.organization_id, nh.person_id, nh.hire_date;

commit;
