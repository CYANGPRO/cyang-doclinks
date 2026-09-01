begin;

-- employee_actions is organization-scoped by its existing organization_id column;
-- these response controls remain on that same tenant-owned action record.
alter table local801.employee_actions
  add column willing_response_label text not null default 'Willing',
  add column considering_response_label text not null default 'Considering',
  add column declined_response_label text not null default 'Declined',
  add column completed_response_label text not null default 'Completed',
  add column enabled_response_statuses text[] not null
    default array['willing','considering','declined','completed']::text[];

alter table local801.employee_actions
  add constraint employee_actions_response_labels_ck check (
    length(btrim(willing_response_label)) between 1 and 40
    and length(btrim(considering_response_label)) between 1 and 40
    and length(btrim(declined_response_label)) between 1 and 40
    and length(btrim(completed_response_label)) between 1 and 40
  ),
  add constraint employee_actions_enabled_responses_ck check (
    cardinality(enabled_response_statuses) between 1 and 4
    and enabled_response_statuses <@ array['willing','considering','declined','completed']::text[]
    and cardinality(array_positions(enabled_response_statuses, 'willing')) <= 1
    and cardinality(array_positions(enabled_response_statuses, 'considering')) <= 1
    and cardinality(array_positions(enabled_response_statuses, 'declined')) <= 1
    and cardinality(array_positions(enabled_response_statuses, 'completed')) <= 1
  );

commit;
