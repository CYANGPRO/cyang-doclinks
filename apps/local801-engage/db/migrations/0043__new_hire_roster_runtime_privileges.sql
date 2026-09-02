begin;

-- Migration 0041 introduced the replaceable New hires queue after the scoped
-- production roles were provisioned. Grant only the runtime access required by
-- the import transaction and the read-only New hires report.
-- Row access remains organization_id-scoped by every application query and the
-- queue's organization-bound foreign keys and primary key.
revoke all on table local801.new_hire_roster_entries from public;
revoke all on table reporting.new_hires from public;

do $$
begin
  if to_regrole('local801_app') is not null then
    grant usage on schema local801, reporting to local801_app;
    grant select, insert, update on table local801.new_hire_roster_entries to local801_app;
    grant select on table reporting.new_hires to local801_app;
  end if;

  if to_regrole('local801_backup') is not null then
    grant usage on schema local801, reporting to local801_backup;
    grant select on table local801.new_hire_roster_entries to local801_backup;
    grant select on table reporting.new_hires to local801_backup;
  end if;

  -- reporting.new_hires is owned by the scoped migration role in production;
  -- its owner needs read access to the table used by the view.
  if to_regrole('local801_migrator') is not null then
    grant select on table local801.new_hire_roster_entries to local801_migrator;
  end if;
end;
$$;

commit;
