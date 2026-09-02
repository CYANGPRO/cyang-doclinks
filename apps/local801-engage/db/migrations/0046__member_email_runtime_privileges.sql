begin;

-- Migrations 0035, 0038, and 0039 introduced the protected member-email
-- workflow after the scoped production roles were provisioned. Grant only the
-- table access used by draft creation, two-person approval, delivery tracking,
-- templates, and the read-only archive. Protected content and recipient values
-- remain organization_id-scoped and encrypted by the application.
revoke all on table
  local801.member_email_broadcasts,
  local801.member_email_broadcast_content,
  local801.member_email_broadcast_recipients,
  local801.member_email_broadcast_attachments,
  local801.member_email_delivery_events,
  local801.member_email_templates
from public;

do $$
begin
  if to_regrole('local801_app') is not null then
    grant usage on schema local801 to local801_app;
    grant select, insert, update on table local801.member_email_broadcasts to local801_app;
    grant select, insert on table local801.member_email_broadcast_content to local801_app;
    grant select, insert, update on table local801.member_email_broadcast_recipients to local801_app;
    grant select, insert on table local801.member_email_broadcast_attachments to local801_app;
    grant select, insert on table local801.member_email_delivery_events to local801_app;
    grant select, insert on table local801.member_email_templates to local801_app;
  end if;

  if to_regrole('local801_backup') is not null then
    grant usage on schema local801 to local801_backup;
    grant select on table
      local801.member_email_broadcasts,
      local801.member_email_broadcast_content,
      local801.member_email_broadcast_recipients,
      local801.member_email_broadcast_attachments,
      local801.member_email_delivery_events,
      local801.member_email_templates
    to local801_backup;
  end if;
end;
$$;

commit;
