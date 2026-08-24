begin;

alter table local801.documents
  add column uploaded_by_role text,
  add column approved_by uuid,
  add column approved_at timestamptz;

alter table local801.documents
  add constraint documents_uploaded_by_role_ck
  check (
    uploaded_by_role is null
    or uploaded_by_role in (
      'system_owner',
      'local_admin',
      'membership_data_manager',
      'cat_admin',
      'cat_lead',
      'cat_member',
      'report_viewer'
    )
  ) not valid,
  add constraint documents_hierarchy_role_required_ck
  check (visibility <> 'uploader_hierarchy' or uploaded_by_role is not null) not valid,
  add constraint documents_approval_pair_ck
  check ((approved_by is null) = (approved_at is null)) not valid,
  add constraint documents_approved_by_org_fk
  foreign key (organization_id, approved_by)
  references local801.users (organization_id, id)
  not valid;

alter table local801.documents
  validate constraint documents_uploaded_by_role_ck,
  validate constraint documents_hierarchy_role_required_ck,
  validate constraint documents_approval_pair_ck,
  validate constraint documents_approved_by_org_fk;

alter table local801.documents
  drop constraint if exists documents_visibility_supported_ck;

alter table local801.documents
  add constraint documents_visibility_supported_ck
  check (visibility in (
    'local_admin_only',
    'membership_management',
    'cat_admin_only',
    'cat_lead_scope',
    'cat_member_scope',
    'uploader_hierarchy',
    'everyone'
  )) not valid;

alter table local801.documents
  validate constraint documents_visibility_supported_ck;

create index documents_hierarchy_access_idx
  on local801.documents (
    organization_id,
    visibility,
    uploaded_by_role,
    created_by,
    created_at desc
  )
  where archived_at is null;

commit;
