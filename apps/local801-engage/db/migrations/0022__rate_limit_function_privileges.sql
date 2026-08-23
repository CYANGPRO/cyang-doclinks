begin;

-- Keep organization_id-bound and public rate-limit state behind the two reviewed functions.
alter function local801.consume_rate_limit(
  text, uuid, text, text, text, timestamptz, integer, integer, timestamptz
) security definer;
alter function local801.consume_rate_limit(
  text, uuid, text, text, text, timestamptz, integer, integer, timestamptz
) set search_path = pg_catalog, local801;

alter function local801.cleanup_expired_rate_limits(integer, timestamptz) security definer;
alter function local801.cleanup_expired_rate_limits(integer, timestamptz)
  set search_path = pg_catalog, local801;

revoke all on function local801.consume_rate_limit(
  text, uuid, text, text, text, timestamptz, integer, integer, timestamptz
) from public;
revoke all on function local801.cleanup_expired_rate_limits(integer, timestamptz) from public;
revoke all on table local801.rate_limit_buckets from public;

do $$
begin
  if to_regrole('local801_app') is not null then
    grant usage on schema local801 to local801_app;
    revoke all on table local801.rate_limit_buckets from local801_app;
    grant execute on function local801.consume_rate_limit(
      text, uuid, text, text, text, timestamptz, integer, integer, timestamptz
    ) to local801_app;
    grant execute on function local801.cleanup_expired_rate_limits(integer, timestamptz) to local801_app;
  end if;
  if to_regrole('local801_backup') is not null then
    grant usage on schema local801 to local801_backup;
    grant select on table local801.rate_limit_buckets to local801_backup;
  end if;
end;
$$;

commit;
