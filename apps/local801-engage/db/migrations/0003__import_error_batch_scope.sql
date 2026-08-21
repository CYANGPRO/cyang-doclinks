begin;

-- File-level validation errors need a deterministic batch relationship even
-- when import_row_id is NULL. Existing rows remain compatible with NULL.
alter table local801.import_errors
  add column if not exists import_batch_id uuid;

do $$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conname = 'import_errors_batch_fk'
      and conrelid = 'local801.import_errors'::regclass
  ) then
    alter table local801.import_errors
      add constraint import_errors_batch_fk
      foreign key (import_batch_id) references local801.import_batches(id) on delete cascade;
  end if;
end
$$;

create index if not exists import_errors_org_batch_created_idx
  on local801.import_errors (organization_id, import_batch_id, created_at, id);

commit;
