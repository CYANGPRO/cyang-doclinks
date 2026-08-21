begin;

-- local801.documents remains organization_id scoped. This migration only
-- extends the supported document visibility values for role-based sharing.
alter table local801.documents
  drop constraint if exists documents_visibility_supported_ck;

alter table local801.documents
  add constraint documents_visibility_supported_ck
  check (visibility in (
    'local_admin_only',
    'membership_management',
    'cat_admin_only',
    'cat_lead_scope',
    'cat_member_scope'
  )) not valid;

alter table local801.documents
  validate constraint documents_visibility_supported_ck;

commit;
