begin;

create table local801.rate_limit_buckets (
  bucket_key text primary key check (bucket_key ~ '^[0-9a-f]{64}$'),
  organization_id uuid references local801.organizations(id) on delete cascade,
  subject_kind text not null check (subject_kind in ('user', 'ip')),
  subject_hash text not null check (subject_hash ~ '^[0-9a-f]{64}$'),
  policy text not null check (policy in (
    'authentication', 'upload', 'import', 'download_export', 'search', 'administrative_mutation'
  )),
  window_started_at timestamptz not null,
  window_seconds integer not null check (window_seconds between 1 and 86400),
  request_count integer not null check (request_count > 0),
  expires_at timestamptz not null,
  last_denied_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index rate_limit_buckets_expiry_idx
  on local801.rate_limit_buckets (expires_at, bucket_key);

create index rate_limit_buckets_org_policy_idx
  on local801.rate_limit_buckets (organization_id, policy, updated_at desc);

create or replace function local801.consume_rate_limit(
  p_bucket_key text,
  p_organization_id uuid,
  p_subject_kind text,
  p_subject_hash text,
  p_policy text,
  p_window_started_at timestamptz,
  p_window_seconds integer,
  p_limit integer,
  p_now timestamptz default now()
) returns table(allowed boolean, retry_after_seconds integer, current_count integer)
language plpgsql
as $$
declare
  consumed local801.rate_limit_buckets%rowtype;
begin
  if p_bucket_key !~ '^[0-9a-f]{64}$'
    or p_subject_hash !~ '^[0-9a-f]{64}$'
    or p_subject_kind not in ('user', 'ip')
    or p_policy not in ('authentication', 'upload', 'import', 'download_export', 'search', 'administrative_mutation')
    or p_window_seconds < 1 or p_window_seconds > 86400
    or p_limit < 1 or p_limit > 100000
    or p_window_started_at > p_now
    or p_window_started_at + make_interval(secs => p_window_seconds) <= p_now
  then
    raise exception 'invalid Local 801 rate-limit input';
  end if;

  insert into local801.rate_limit_buckets (
    bucket_key, organization_id, subject_kind, subject_hash, policy,
    window_started_at, window_seconds, request_count, expires_at, updated_at
  ) values (
    p_bucket_key, p_organization_id, p_subject_kind, p_subject_hash, p_policy,
    p_window_started_at, p_window_seconds, 1,
    p_window_started_at + make_interval(secs => p_window_seconds), p_now
  )
  on conflict (bucket_key) do update set
    request_count = local801.rate_limit_buckets.request_count + 1,
    last_denied_at = case
      when local801.rate_limit_buckets.request_count + 1 > p_limit then p_now
      else local801.rate_limit_buckets.last_denied_at
    end,
    updated_at = p_now
  where local801.rate_limit_buckets.organization_id is not distinct from p_organization_id
    and local801.rate_limit_buckets.subject_kind = p_subject_kind
    and local801.rate_limit_buckets.subject_hash = p_subject_hash
    and local801.rate_limit_buckets.policy = p_policy
    and local801.rate_limit_buckets.window_started_at = p_window_started_at
    and local801.rate_limit_buckets.window_seconds = p_window_seconds
    and local801.rate_limit_buckets.expires_at > p_now
  returning * into consumed;

  if consumed.bucket_key is null then
    raise exception 'Local 801 rate-limit bucket identity conflict';
  end if;

  return query select
    consumed.request_count <= p_limit,
    greatest(1, ceil(extract(epoch from (consumed.expires_at - p_now)))::integer),
    consumed.request_count;
end;
$$;

create or replace function local801.cleanup_expired_rate_limits(
  p_batch_size integer,
  p_now timestamptz default now()
) returns integer
language plpgsql
as $$
declare
  deleted_count integer;
begin
  if p_batch_size < 1 or p_batch_size > 1000 then
    raise exception 'invalid Local 801 rate-limit cleanup batch size';
  end if;
  with expired as (
    select bucket_key
    from local801.rate_limit_buckets
    where expires_at <= p_now
    order by expires_at, bucket_key
    limit p_batch_size
    for update skip locked
  ), deleted as (
    delete from local801.rate_limit_buckets bucket
    using expired
    where bucket.bucket_key = expired.bucket_key
    returning 1
  )
  select count(*)::integer into deleted_count from deleted;
  return deleted_count;
end;
$$;

commit;
