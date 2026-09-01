begin;

create table local801.member_email_broadcast_attachments (
  organization_id uuid not null references local801.organizations(id),
  broadcast_id uuid not null references local801.member_email_broadcasts(id) on delete cascade,
  document_id uuid references local801.documents(id) on delete set null,
  display_order smallint not null check (display_order between 1 and 5),
  title text not null check (length(btrim(title)) between 1 and 255),
  original_filename text not null check (length(btrim(original_filename)) between 1 and 255),
  media_type text not null check (length(btrim(media_type)) between 1 and 200),
  byte_size integer not null check (byte_size between 1 and 20971520),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  primary key (broadcast_id, display_order),
  unique (broadcast_id, document_id)
);

create index member_email_attachments_org_broadcast_idx
  on local801.member_email_broadcast_attachments (organization_id, broadcast_id, display_order);

comment on table local801.member_email_broadcast_attachments is
  'Frozen metadata for approved encrypted CAT Documents selected for a Preview email. File bytes remain in protected document storage and are reauthorized before a one-address test.';

commit;
