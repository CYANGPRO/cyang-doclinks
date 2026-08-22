-- CIS Control 8 evidence: application audit events are append-only at the database boundary.
-- Privileged database recovery administrators retain provider-level recovery capabilities.

create or replace function local801.reject_audit_event_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'local801.audit_events is append-only';
end;
$$;

drop trigger if exists audit_events_append_only on local801.audit_events;
create trigger audit_events_append_only
before update or delete on local801.audit_events
for each row execute function local801.reject_audit_event_mutation();

comment on trigger audit_events_append_only on local801.audit_events is
  'Prevents application-level mutation or deletion of organization_id-scoped security audit events.';
