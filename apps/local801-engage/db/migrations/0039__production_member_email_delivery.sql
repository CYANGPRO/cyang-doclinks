begin;

alter table local801.member_email_broadcasts
  drop constraint member_email_broadcasts_status_check,
  add constraint member_email_broadcasts_status_check
    check (status in ('draft','review','approved','queued','sending','paused','sent','failed','simulated','cancelled')),
  add column workflow_run_id text,
  add column queued_by uuid references local801.users(id),
  add column queued_at timestamptz,
  add column started_at timestamptz,
  add column completed_at timestamptz,
  add column paused_by uuid references local801.users(id),
  add column paused_at timestamptz,
  add column cancelled_by uuid references local801.users(id),
  add column cancelled_at timestamptz,
  add column failure_code text,
  add column sender_address text,
  add column reply_to_address text,
  add constraint member_email_broadcasts_workflow_run_ck
    check (workflow_run_id is null or workflow_run_id ~ '^[A-Za-z0-9_-]{8,160}$'),
  add constraint member_email_broadcasts_failure_code_ck
    check (failure_code is null or failure_code ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  add constraint member_email_broadcasts_sender_ck
    check (sender_address is null or length(sender_address) between 3 and 320),
  add constraint member_email_broadcasts_reply_to_ck
    check (reply_to_address is null or length(reply_to_address) between 3 and 320);

alter table local801.member_email_broadcast_recipients
  add column provider_message_id text,
  add column delivery_status text not null default 'pending'
    check (delivery_status in ('pending','accepted','delivered','bounced','complained','suppressed','failed')),
  add column attempt_count smallint not null default 0 check (attempt_count between 0 and 20),
  add column last_attempt_at timestamptz,
  add column accepted_at timestamptz,
  add column delivered_at timestamptz,
  add column failed_at timestamptz;

alter table local801.member_email_delivery_events
  drop constraint member_email_delivery_events_event_type_check,
  add constraint member_email_delivery_events_event_type_check
    check (event_type in (
      'simulated.test','simulated.delivered','provider.accepted','provider.delivered',
      'provider.bounced','provider.complained','provider.suppressed','provider.failed'
    ));

create table local801.member_email_templates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references local801.organizations(id),
  name text not null check (length(btrim(name)) between 1 and 120),
  subject_encrypted_payload text not null check (length(subject_encrypted_payload) between 1 and 5000),
  subject_encryption_key_version text not null,
  subject_encryption_format_version smallint not null check (subject_encryption_format_version = 1),
  body_encrypted_payload text not null check (length(body_encrypted_payload) between 1 and 50000),
  body_encryption_key_version text not null,
  body_encryption_format_version smallint not null check (body_encryption_format_version = 1),
  created_by uuid not null references local801.users(id),
  updated_by uuid not null references local801.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  unique (organization_id, name)
);

create index member_email_broadcasts_delivery_queue_idx
  on local801.member_email_broadcasts (organization_id, status, scheduled_for, created_at);
create index member_email_recipients_delivery_status_idx
  on local801.member_email_broadcast_recipients (organization_id, broadcast_id, delivery_status, id);
create unique index member_email_recipients_provider_message_uq
  on local801.member_email_broadcast_recipients (provider_message_id)
  where provider_message_id is not null;
create index member_email_templates_active_idx
  on local801.member_email_templates (organization_id, updated_at desc)
  where archived_at is null;
create unique index member_email_templates_active_name_uq
  on local801.member_email_templates (organization_id, lower(btrim(name)))
  where archived_at is null;

comment on table local801.member_email_broadcasts is
  'Protected Local 801 notice workflow. Preview delivery is simulated; Production delivery requires the independent CAT Resend and launch gates.';
comment on table local801.member_email_templates is
  'Encrypted reusable notice content. Templates never contain recipient addresses or attachment bytes.';

commit;
