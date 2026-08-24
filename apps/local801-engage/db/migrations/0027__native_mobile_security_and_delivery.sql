begin;

-- One-time challenges bind native attestation evidence to the current tenant and
-- authenticated user. Only a digest of the random challenge is retained.
create table local801.mobile_attestation_challenges (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references local801.organizations(id),
  user_id uuid not null,
  purpose text not null check (purpose in ('device_registration', 'step_up')),
  challenge_hash text not null check (challenge_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now(),
  constraint mobile_attestation_challenges_org_id_uq unique (organization_id, id),
  constraint mobile_attestation_challenges_user_org_fk
    foreign key (organization_id, user_id)
    references local801.users (organization_id, id) on delete cascade,
  constraint mobile_attestation_challenges_time_ck check (
    created_at < expires_at and (used_at is null or created_at <= used_at)
  )
);
create unique index mobile_attestation_challenges_live_hash_uq
  on local801.mobile_attestation_challenges (organization_id, user_id, challenge_hash)
  where used_at is null;
create index mobile_attestation_challenges_expiry_idx
  on local801.mobile_attestation_challenges (organization_id, expires_at)
  where used_at is null;

-- Device keys and native push tokens never appear in plaintext. The verifier
-- returns an opaque device key whose irreversible digest is stored here; push
-- tokens use the protected-PII keyring and are never included in notifications.
create table local801.mobile_devices (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references local801.organizations(id),
  user_id uuid not null,
  platform text not null check (platform in ('ios', 'android')),
  device_key_hash text not null check (device_key_hash ~ '^[0-9a-f]{64}$'),
  integrity_level text not null check (
    integrity_level in ('app_attested', 'device_integrity', 'strong_integrity')
  ),
  push_token_encrypted_payload text,
  push_token_key_version text,
  push_token_format_version integer,
  push_token_updated_at timestamptz,
  attested_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  disabled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint mobile_devices_org_id_uq unique (organization_id, id),
  constraint mobile_devices_user_org_fk
    foreign key (organization_id, user_id)
    references local801.users (organization_id, id) on delete cascade,
  constraint mobile_devices_push_envelope_ck check (
    num_nonnulls(
      push_token_encrypted_payload,
      push_token_key_version,
      push_token_format_version,
      push_token_updated_at
    ) in (0, 4)
  ),
  constraint mobile_devices_timestamp_ck check (
    created_at <= updated_at and attested_at <= last_seen_at
  )
);
create unique index mobile_devices_active_key_uq
  on local801.mobile_devices (organization_id, user_id, platform, device_key_hash)
  where disabled_at is null;
create index mobile_devices_active_user_idx
  on local801.mobile_devices (organization_id, user_id, last_seen_at desc)
  where disabled_at is null;

commit;
