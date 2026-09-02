begin;

-- Keep the four standard response columns for compatibility while allowing each
-- action to carry additional, independently tracked response choices.
alter table local801.employee_actions
  add column custom_response_options jsonb not null default '[]'::jsonb;

alter table local801.employee_actions
  drop constraint if exists employee_actions_enabled_responses_ck,
  add constraint employee_actions_enabled_responses_ck check (
    cardinality(enabled_response_statuses) between 1 and 12
    and array_to_string(enabled_response_statuses, ',')
      ~ '^(willing|considering|declined|completed|custom:[0-9a-f]{32})(,(willing|considering|declined|completed|custom:[0-9a-f]{32}))*$'
    and cardinality(array_positions(enabled_response_statuses, 'willing')) <= 1
    and cardinality(array_positions(enabled_response_statuses, 'considering')) <= 1
    and cardinality(array_positions(enabled_response_statuses, 'declined')) <= 1
    and cardinality(array_positions(enabled_response_statuses, 'completed')) <= 1
  ),
  add constraint employee_actions_custom_responses_ck check (
    jsonb_typeof(custom_response_options) = 'array'
    and jsonb_array_length(custom_response_options) <= 8
  );

alter table local801.employee_action_responses
  drop constraint if exists employee_action_responses_response_status_check,
  add constraint employee_action_responses_response_status_ck check (
    response_status in ('willing','considering','declined','completed')
    or response_status ~ '^custom:[0-9a-f]{32}$'
  );

create or replace view reporting.employee_action_current_posture as
with latest_decline as (
  select organization_id, person_id, max(history_seq) as decline_all_seq
  from local801.employee_action_all_declines
  group by organization_id, person_id
),
latest_reopen as (
  select organization_id, person_id, max(history_seq) as reopen_seq
  from local801.employee_action_responses
  where response_status <> 'declined'
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
  on d.organization_id = p.organization_id and d.person_id = p.id
left join latest_reopen r
  on r.organization_id = p.organization_id and r.person_id = p.id
where p.archived_at is null;

create or replace view reporting.employee_action_person_readiness as
select
  p.organization_id,
  p.id as person_id,
  coalesce(posture.declines_all_actions, false) as declines_all_actions,
  count(current.action_id) filter (where current.response_status = 'willing') as willing_action_count,
  count(current.action_id) filter (where current.response_status = 'considering') as considering_action_count,
  count(current.action_id) filter (where current.response_status = 'declined') as declined_action_count,
  count(current.action_id) filter (where current.response_status = 'completed') as completed_action_count,
  count(current.action_id) filter (where current.response_status like 'custom:%') as custom_action_count
from local801.people p
left join reporting.employee_action_current_posture posture
  on posture.organization_id = p.organization_id and posture.person_id = p.id
left join reporting.employee_action_current_responses current
  on current.organization_id = p.organization_id and current.person_id = p.id
where p.archived_at is null
group by p.organization_id, p.id, posture.declines_all_actions;

comment on column local801.employee_actions.custom_response_options is
  'Up to eight additional action-specific response choices. Stable custom keys preserve distinct response history when labels change.';

commit;
