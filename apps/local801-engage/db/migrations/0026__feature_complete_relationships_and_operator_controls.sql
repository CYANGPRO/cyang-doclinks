begin;

-- Stable tenant-qualified parent keys for the final relationship model.
alter table local801.outreach_campaigns
  add constraint outreach_campaigns_organization_id_id_uq unique (organization_id, id);
alter table local801.cat_actions
  add constraint cat_actions_organization_id_id_uq unique (organization_id, id);
alter table local801.documents
  add constraint documents_organization_id_id_uq unique (organization_id, id);

create table local801.campaign_cat_action_links (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references local801.organizations(id),
  campaign_id uuid not null,
  cat_action_id uuid not null,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  archived_at timestamptz,
  constraint campaign_cat_action_links_campaign_org_fk
    foreign key (organization_id, campaign_id)
    references local801.outreach_campaigns (organization_id, id),
  constraint campaign_cat_action_links_action_org_fk
    foreign key (organization_id, cat_action_id)
    references local801.cat_actions (organization_id, id),
  constraint campaign_cat_action_links_actor_org_fk
    foreign key (organization_id, created_by)
    references local801.users (organization_id, id)
);
create unique index campaign_cat_action_links_active_uq
  on local801.campaign_cat_action_links (organization_id, campaign_id, cat_action_id)
  where archived_at is null;
create index campaign_cat_action_links_campaign_idx
  on local801.campaign_cat_action_links (organization_id, campaign_id, created_at desc)
  where archived_at is null;
create index campaign_cat_action_links_action_idx
  on local801.campaign_cat_action_links (organization_id, cat_action_id, created_at desc)
  where archived_at is null;

create table local801.document_tags (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references local801.organizations(id),
  label text not null,
  normalized_label text not null,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  archived_at timestamptz,
  constraint document_tags_label_ck check (
    label = btrim(label) and char_length(label) between 1 and 40
    and normalized_label = lower(btrim(label))
  ),
  constraint document_tags_organization_id_id_uq unique (organization_id, id),
  constraint document_tags_actor_org_fk foreign key (organization_id, created_by)
    references local801.users (organization_id, id)
);
create unique index document_tags_active_label_uq
  on local801.document_tags (organization_id, normalized_label)
  where archived_at is null;

create table local801.document_tag_assignments (
  organization_id uuid not null,
  document_id uuid not null,
  tag_id uuid not null,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  constraint document_tag_assignments_pkey primary key (organization_id, document_id, tag_id),
  constraint document_tag_assignments_document_org_fk
    foreign key (organization_id, document_id)
    references local801.documents (organization_id, id) on delete cascade,
  constraint document_tag_assignments_tag_org_fk
    foreign key (organization_id, tag_id)
    references local801.document_tags (organization_id, id) on delete cascade,
  constraint document_tag_assignments_actor_org_fk
    foreign key (organization_id, created_by)
    references local801.users (organization_id, id)
);

create table local801.document_relationships (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references local801.organizations(id),
  document_id uuid not null,
  relationship_type text not null,
  related_document_id uuid,
  campaign_id uuid,
  cat_action_id uuid,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  archived_at timestamptz,
  constraint document_relationships_type_ck check (
    relationship_type in ('related', 'supports', 'reference', 'supersedes')
  ),
  constraint document_relationships_one_target_ck check (
    num_nonnulls(related_document_id, campaign_id, cat_action_id) = 1
  ),
  constraint document_relationships_not_self_ck check (
    related_document_id is null or related_document_id <> document_id
  ),
  constraint document_relationships_document_org_fk
    foreign key (organization_id, document_id)
    references local801.documents (organization_id, id) on delete cascade,
  constraint document_relationships_related_document_org_fk
    foreign key (organization_id, related_document_id)
    references local801.documents (organization_id, id),
  constraint document_relationships_campaign_org_fk
    foreign key (organization_id, campaign_id)
    references local801.outreach_campaigns (organization_id, id),
  constraint document_relationships_action_org_fk
    foreign key (organization_id, cat_action_id)
    references local801.cat_actions (organization_id, id),
  constraint document_relationships_actor_org_fk
    foreign key (organization_id, created_by)
    references local801.users (organization_id, id)
);
create unique index document_relationships_active_document_uq
  on local801.document_relationships
    (organization_id, document_id, related_document_id, relationship_type)
  where archived_at is null and related_document_id is not null;
create unique index document_relationships_active_campaign_uq
  on local801.document_relationships
    (organization_id, document_id, campaign_id, relationship_type)
  where archived_at is null and campaign_id is not null;
create unique index document_relationships_active_action_uq
  on local801.document_relationships
    (organization_id, document_id, cat_action_id, relationship_type)
  where archived_at is null and cat_action_id is not null;

-- Only a non-reversible digest and delivery timestamp are persisted. Notification
-- text, work details, and protected record identifiers never enter this table.
create table local801.push_delivery_state (
  organization_id uuid not null references local801.organizations(id),
  user_id uuid not null,
  last_work_digest text not null check (last_work_digest ~ '^[0-9a-f]{64}$'),
  last_sent_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint push_delivery_state_pkey primary key (organization_id, user_id),
  constraint push_delivery_state_user_org_fk foreign key (organization_id, user_id)
    references local801.users (organization_id, id) on delete cascade,
  constraint push_delivery_state_timestamp_ck check (last_sent_at <= updated_at)
);

-- Cancellation is cooperative for running durable jobs and immediate for queued
-- jobs. Free-form operator notes are intentionally excluded from this table.
alter table local801.import_processing_jobs
  add column cancellation_requested_at timestamptz,
  add column cancelled_at timestamptz,
  add column cancelled_by uuid,
  add column operator_reason_code text;

alter table local801.import_processing_jobs
  drop constraint import_processing_jobs_state_ck,
  drop constraint import_processing_jobs_lifecycle_ck,
  drop constraint import_processing_jobs_timestamp_order_ck;

alter table local801.import_processing_jobs
  add constraint import_processing_jobs_state_ck check (
    state in ('queued', 'running', 'succeeded', 'failed', 'cancelled')
  ),
  add constraint import_processing_jobs_operator_reason_ck check (
    operator_reason_code is null or operator_reason_code in
      ('operator_cancelled', 'superseded_source', 'incorrect_source', 'maintenance')
  ),
  add constraint import_processing_jobs_cancellation_request_ck check (
    num_nonnulls(cancellation_requested_at, cancelled_by, operator_reason_code) in (0, 3)
  ),
  add constraint import_processing_jobs_cancelled_by_org_fk
    foreign key (organization_id, cancelled_by)
    references local801.users (organization_id, id),
  add constraint import_processing_jobs_lifecycle_ck check (
    (state = 'queued'
      and workflow_run_id is null and started_at is null and completed_at is null
      and failed_at is null and cancelled_at is null and safe_error_code is null
      and cancellation_requested_at is null and cancelled_by is null and operator_reason_code is null)
    or (state = 'running'
      and workflow_run_id is not null and attempt_count >= 1 and started_at is not null
      and completed_at is null and failed_at is null and cancelled_at is null
      and safe_error_code is null)
    or (state = 'succeeded'
      and workflow_run_id is not null and attempt_count >= 1 and started_at is not null
      and completed_at is not null and failed_at is null and cancelled_at is null
      and cancellation_requested_at is null and cancelled_by is null
      and operator_reason_code is null and safe_error_code is null)
    or (state = 'failed'
      and completed_at is null and failed_at is not null and cancelled_at is null
      and cancellation_requested_at is null and cancelled_by is null
      and operator_reason_code is null and safe_error_code is not null
      and ((workflow_run_id is null and attempt_count = 0 and started_at is null)
        or (workflow_run_id is not null and attempt_count >= 1 and started_at is not null)))
    or (state = 'cancelled'
      and completed_at is null and failed_at is null and cancelled_at is not null
      and cancellation_requested_at is not null and cancelled_by is not null
      and operator_reason_code is not null and safe_error_code is null
      and ((workflow_run_id is null and attempt_count = 0 and started_at is null)
        or (workflow_run_id is not null and attempt_count >= 1 and started_at is not null)))
  ),
  add constraint import_processing_jobs_timestamp_order_ck check (
    created_at <= updated_at and queued_at <= last_progress_at
    and (started_at is null or queued_at <= started_at)
    and (completed_at is null or (started_at is not null and started_at <= completed_at))
    and (failed_at is null or queued_at <= failed_at)
    and (cancellation_requested_at is null or queued_at <= cancellation_requested_at)
    and (cancelled_at is null or cancellation_requested_at <= cancelled_at)
  );

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'import_batches_processing_stage_ck'
      and conrelid = 'local801.import_batches'::regclass and contype = 'c'
  ) then
    raise exception 'Expected import_batches_processing_stage_ck is missing';
  end if;
  alter table local801.import_batches drop constraint import_batches_processing_stage_ck;
end
$$;
alter table local801.import_batches
  add constraint import_batches_processing_stage_ck check (
    processing_stage is null or processing_stage in (
      'uploaded', 'queued', 'scanning', 'parsing', 'validating', 'matching',
      'preparing_review', 'ready_for_review', 'failed', 'cancelled'
    )
  );

commit;
