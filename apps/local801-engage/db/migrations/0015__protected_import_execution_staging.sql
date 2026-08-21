begin;

create table if not exists local801.protected_import_execution_sets (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references local801.organizations(id),
  import_batch_id uuid not null references local801.import_batches(id),
  source_fingerprint text not null check (source_fingerprint ~ '^[0-9a-f]{64}$'),
  review_fingerprint text not null check (review_fingerprint ~ '^[0-9a-f]{64}$'),
  mutation_fingerprint text not null check (mutation_fingerprint ~ '^[0-9a-f]{64}$'),
  mutation_count integer not null check (mutation_count >= 0 and mutation_count <= 25000),
  state text not null default 'prepared' check (state in ('prepared','executed','invalidated')),
  prepared_by uuid not null references local801.users(id),
  prepared_at timestamptz not null default now(),
  executed_at timestamptz,
  invalidated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, import_batch_id, mutation_fingerprint)
);

create index if not exists protected_import_execution_sets_batch_idx
  on local801.protected_import_execution_sets (organization_id, import_batch_id, prepared_at desc);

create table if not exists local801.protected_import_execution_mutations (
  organization_id uuid not null references local801.organizations(id),
  execution_set_id uuid not null references local801.protected_import_execution_sets(id) on delete cascade,
  import_row_id uuid not null references local801.import_rows(id),
  target_person_id uuid not null,
  mutation_kind text not null check (mutation_kind in ('existing','new')),
  operational_json jsonb not null check (jsonb_typeof(operational_json) = 'object'),
  person_protected_json jsonb not null check (jsonb_typeof(person_protected_json) = 'object'),
  identifier_protected_json jsonb not null check (jsonb_typeof(identifier_protected_json) = 'array'),
  contact_protected_json jsonb not null check (jsonb_typeof(contact_protected_json) = 'array'),
  exact_indexes_json jsonb not null check (jsonb_typeof(exact_indexes_json) = 'array'),
  search_tokens_json jsonb not null check (jsonb_typeof(search_tokens_json) = 'array'),
  mutation_hash text not null check (mutation_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  primary key (execution_set_id, import_row_id),
  unique (execution_set_id, target_person_id)
);

create index if not exists protected_import_execution_mutations_org_batch_idx
  on local801.protected_import_execution_mutations (organization_id, execution_set_id, target_person_id);

create or replace function local801.reject_protected_import_mutation_change()
returns trigger
language plpgsql
as $$
begin
  raise exception 'protected import execution mutations are immutable';
end;
$$;

drop trigger if exists protected_import_execution_mutations_immutable on local801.protected_import_execution_mutations;
create trigger protected_import_execution_mutations_immutable
before update or delete on local801.protected_import_execution_mutations
for each row execute function local801.reject_protected_import_mutation_change();

create or replace function local801.enforce_protected_execution_set_transition()
returns trigger
language plpgsql
as $$
begin
  if old.organization_id <> new.organization_id
    or old.import_batch_id <> new.import_batch_id
    or old.source_fingerprint <> new.source_fingerprint
    or old.review_fingerprint <> new.review_fingerprint
    or old.mutation_fingerprint <> new.mutation_fingerprint
    or old.mutation_count <> new.mutation_count
    or old.prepared_by <> new.prepared_by
    or old.prepared_at <> new.prepared_at then
    raise exception 'protected import execution set identity is immutable';
  end if;

  if old.state = new.state then
    return new;
  end if;

  if old.state = 'prepared' and new.state in ('executed','invalidated') then
    if new.state = 'executed' and new.executed_at is null then
      raise exception 'executed protected import execution set requires executed_at';
    end if;
    if new.state = 'invalidated' and new.invalidated_at is null then
      raise exception 'invalidated protected import execution set requires invalidated_at';
    end if;
    new.updated_at := now();
    return new;
  end if;

  raise exception 'invalid protected import execution set state transition';
end;
$$;

drop trigger if exists protected_import_execution_sets_transition on local801.protected_import_execution_sets;
create trigger protected_import_execution_sets_transition
before update on local801.protected_import_execution_sets
for each row execute function local801.enforce_protected_execution_set_transition();

commit;
