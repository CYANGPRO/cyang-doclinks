begin;

alter table local801.member_email_broadcasts
  add column audience_kind text not null default 'members',
  add column audience_label text not null default 'All current members',
  add column audience_reference_handle text,
  add column represented_count integer not null default 0;

update local801.member_email_broadcasts
set represented_count = eligible_count + missing_count + duplicate_count + suppressed_count
where organization_id is not null and represented_count = 0;

alter table local801.member_email_broadcasts
  add constraint member_email_broadcasts_audience_kind_ck
    check (audience_kind in ('members','nonmembers','represented_unit','cat_members','department','campaign')),
  add constraint member_email_broadcasts_audience_label_ck
    check (length(btrim(audience_label)) between 1 and 240),
  add constraint member_email_broadcasts_audience_reference_ck
    check (
      (audience_kind in ('department','campaign') and audience_reference_handle ~ '^[0-9a-f]{64}$')
      or (audience_kind not in ('department','campaign') and audience_reference_handle is null)
    ),
  add constraint member_email_broadcasts_represented_count_ck
    check (represented_count between 0 and 25000);

alter table local801.member_email_broadcast_recipients
  alter column person_id drop not null,
  add column user_id uuid references local801.users(id);

do $$
declare
  constraint_row record;
begin
  for constraint_row in
    select constraint_entry.conname as constraint_name
    from pg_constraint constraint_entry
    where constraint_entry.conrelid = 'local801.member_email_broadcast_recipients'::regclass
      and constraint_entry.contype = 'c'
  loop
    execute format('alter table local801.member_email_broadcast_recipients drop constraint %I', constraint_row.constraint_name);
  end loop;
end
$$;

alter table local801.member_email_broadcast_recipients
  add constraint member_email_recipients_contact_kind_ck
    check (contact_kind is null or contact_kind in ('home','work','cat_user')),
  add constraint member_email_recipients_status_ck
    check (recipient_status in ('eligible','missing','duplicate','suppressed')),
  add constraint member_email_recipients_subject_ck
    check ((person_id is not null)::integer + (user_id is not null)::integer = 1),
  add constraint member_email_recipients_source_ck
    check (
      (person_id is not null and user_id is null and contact_kind is distinct from 'cat_user')
      or (user_id is not null and person_id is null and contact_method_id is null and contact_kind = 'cat_user')
    ),
  add constraint member_email_recipients_missing_ck
    check (
      (recipient_status = 'missing' and contact_method_id is null and email_blind_index is null and email_encrypted_payload is null)
      or (recipient_status <> 'missing' and email_blind_index_key_version is not null
        and email_blind_index is not null and email_encrypted_payload is not null
        and email_encryption_key_version is not null and email_encryption_format_version = 1)
    ),
  add constraint member_email_recipients_duplicate_ck
    check ((recipient_status = 'duplicate') = (duplicate_of_recipient_id is not null)),
  add constraint member_email_recipients_email_index_ck
    check (email_blind_index is null or email_blind_index ~ '^[0-9a-f]{64}$'),
  add constraint member_email_recipients_email_format_ck
    check (email_encryption_format_version is null or email_encryption_format_version = 1),
  add constraint member_email_recipients_person_contact_ck
    check (person_id is null or recipient_status = 'missing' or contact_method_id is not null),
  add constraint member_email_recipients_cat_contact_ck
    check (user_id is null or contact_kind = 'cat_user');

create unique index member_email_recipients_broadcast_user_uq
  on local801.member_email_broadcast_recipients (broadcast_id, user_id)
  where user_id is not null;

comment on column local801.member_email_broadcasts.audience_kind is
  'Frozen high-level recipient selection: membership, CAT team, department, or saved campaign population.';
comment on column local801.member_email_broadcasts.audience_reference_handle is
  'Opaque department or campaign handle selected when the protected recipient snapshot was created.';

commit;
