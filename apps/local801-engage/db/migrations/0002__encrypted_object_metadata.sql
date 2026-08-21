begin;

-- These tables remain organization_id scoped. The added metadata lets the
-- application validate and rotate encrypted private objects without changing 0001.
alter table local801.documents
  add column if not exists original_filename text,
  add column if not exists media_type text,
  add column if not exists byte_size bigint,
  add column if not exists storage_cleanup_pending_at timestamptz;

do $$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conname = 'documents_visibility_supported_ck'
      and conrelid = 'local801.documents'::regclass
  ) then
    alter table local801.documents
      add constraint documents_visibility_supported_ck
      check (visibility in (
        'local_admin_only',
        'membership_management',
        'cat_admin_only',
        'cat_lead_scope'
      ));
  end if;
end
$$;

alter table local801.import_files
  add column if not exists encryption_key_version text;

alter table local801.generated_reports
  add column if not exists encryption_key_version text,
  add column if not exists media_type text,
  add column if not exists byte_size bigint;

commit;
