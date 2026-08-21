begin;

create sequence local801.employee_action_history_seq;

create table local801.employee_actions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references local801.organizations(id),
  name text not null,
  engagement_level smallint not null default 1
    check (engagement_level between 1 and 5),
  scope_type text not null default 'organization'
    check (scope_type in ('organization','campaign','cat_action')),
  campaign_id uuid references local801.outreach_campaigns(id),
  cat_action_id uuid references local801.cat_actions(id),
  created_by uuid references local801.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  constraint employee_actions_name_nonblank_ck check (length(trim(name)) > 0),
  constraint employee_actions_scope_ck check (
    (scope_type = 'organization' and campaign_id is null and cat_action_id is null)
    or (scope_type = 'campaign' and campaign_id is not null and cat_action_id is null)
    or (scope_type = 'cat_action' and campaign_id is null and cat_action_id is not null)
  )
);

create unique index employee_actions_org_name_uq
  on local801.employee_actions (organization_id, lower(name))
  where scope_type = 'organization' and archived_at is null;

create unique index employee_actions_campaign_name_uq
  on local801.employee_actions (organization_id, campaign_id, lower(name))
  where scope_type = 'campaign' and archived_at is null;

create unique index employee_actions_cat_action_name_uq
  on local801.employee_actions (organization_id, cat_action_id, lower(name))
  where scope_type = 'cat_action' and archived_at is null;

create index employee_actions_org_scope_idx
  on local801.employee_actions (organization_id, scope_type, engagement_level, name)
  where archived_at is null;

create table local801.employee_action_responses (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references local801.organizations(id),
  person_id uuid not null references local801.people(id),
  action_id uuid not null references local801.employee_actions(id),
  engagement_event_id uuid references local801.engagement_events(id) on delete set null,
  response_status text not null
    check (response_status in ('willing','considering','declined','completed')),
  recorded_by uuid not null references local801.users(id),
  recorded_at timestamptz not null default now(),
  history_seq bigint not null default nextval('local801.employee_action_history_seq')
);

create index employee_action_responses_org_person_seq_idx
  on local801.employee_action_responses (organization_id, person_id, history_seq desc);

create index employee_action_responses_org_action_seq_idx
  on local801.employee_action_responses (organization_id, action_id, history_seq desc);

create index employee_action_responses_engagement_idx
  on local801.employee_action_responses (organization_id, engagement_event_id)
  where engagement_event_id is not null;

create table local801.employee_action_all_declines (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references local801.organizations(id),
  person_id uuid not null references local801.people(id),
  engagement_event_id uuid references local801.engagement_events(id) on delete set null,
  recorded_by uuid not null references local801.users(id),
  recorded_at timestamptz not null default now(),
  history_seq bigint not null default nextval('local801.employee_action_history_seq')
);

create index employee_action_all_declines_org_person_seq_idx
  on local801.employee_action_all_declines (organization_id, person_id, history_seq desc);

create index employee_action_all_declines_engagement_idx
  on local801.employee_action_all_declines (organization_id, engagement_event_id)
  where engagement_event_id is not null;

create or replace view reporting.employee_action_current_responses as
with decline_cutoff as (
  select
    organization_id,
    person_id,
    max(history_seq) as decline_all_seq
  from local801.employee_action_all_declines
  group by organization_id, person_id
),
ranked as (
  select
    r.organization_id,
    r.person_id,
    r.action_id,
    r.engagement_event_id,
    r.response_status,
    r.recorded_by,
    r.recorded_at,
    r.history_seq,
    row_number() over (
      partition by r.organization_id, r.person_id, r.action_id
      order by r.history_seq desc
    ) as response_rank
  from local801.employee_action_responses r
  join local801.employee_actions a
    on a.id = r.action_id
   and a.organization_id = r.organization_id
   and a.archived_at is null
  left join decline_cutoff d
    on d.organization_id = r.organization_id
   and d.person_id = r.person_id
  where r.history_seq > coalesce(d.decline_all_seq, 0)
)
select
  organization_id,
  person_id,
  action_id,
  engagement_event_id,
  response_status,
  recorded_by,
  recorded_at,
  history_seq
from ranked
where response_rank = 1;

create or replace view reporting.employee_action_current_posture as
with latest_decline as (
  select
    organization_id,
    person_id,
    max(history_seq) as decline_all_seq
  from local801.employee_action_all_declines
  group by organization_id, person_id
),
latest_reopen as (
  select
    organization_id,
    person_id,
    max(history_seq) as reopen_seq
  from local801.employee_action_responses
  where response_status in ('willing','considering','completed')
  group by organization_id, person_id
)
select
  p.organization_id,
  p.id as person_id,
  (
    d.decline_all_seq is not null
    and d.decline_all_seq > coalesce(r.reopen_seq, 0)
  ) as declines_all_actions,
  d.decline_all_seq,
  r.reopen_seq
from local801.people p
left join latest_decline d
  on d.organization_id = p.organization_id
 and d.person_id = p.id
left join latest_reopen r
  on r.organization_id = p.organization_id
 and r.person_id = p.id
where p.archived_at is null;

create or replace view reporting.employee_action_person_readiness as
select
  p.organization_id,
  p.id as person_id,
  coalesce(posture.declines_all_actions, false) as declines_all_actions,
  count(current.action_id) filter (where current.response_status = 'willing') as willing_action_count,
  count(current.action_id) filter (where current.response_status = 'considering') as considering_action_count,
  count(current.action_id) filter (where current.response_status = 'declined') as declined_action_count,
  count(current.action_id) filter (where current.response_status = 'completed') as completed_action_count
from local801.people p
left join reporting.employee_action_current_posture posture
  on posture.organization_id = p.organization_id
 and posture.person_id = p.id
left join reporting.employee_action_current_responses current
  on current.organization_id = p.organization_id
 and current.person_id = p.id
where p.archived_at is null
group by
  p.organization_id,
  p.id,
  posture.declines_all_actions;

create or replace view reporting.employee_action_readiness_by_action as
select
  a.organization_id,
  a.id as action_id,
  a.name,
  a.engagement_level,
  a.scope_type,
  a.campaign_id,
  a.cat_action_id,
  count(distinct current.person_id) filter (where current.response_status = 'willing') as willing_count,
  count(distinct current.person_id) filter (where current.response_status = 'considering') as considering_count,
  count(distinct current.person_id) filter (where current.response_status = 'declined') as declined_count,
  count(distinct current.person_id) filter (where current.response_status = 'completed') as completed_count
from local801.employee_actions a
left join reporting.employee_action_current_responses current
  on current.organization_id = a.organization_id
 and current.action_id = a.id
where a.archived_at is null
group by
  a.organization_id,
  a.id,
  a.name,
  a.engagement_level,
  a.scope_type,
  a.campaign_id,
  a.cat_action_id;

commit;
