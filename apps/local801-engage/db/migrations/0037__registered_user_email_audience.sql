begin;

-- This table-wide value constraint changes no rows; every runtime audience read remains scoped by member_email_broadcasts.organization_id.
alter table local801.member_email_broadcasts
  drop constraint member_email_broadcasts_audience_kind_ck,
  add constraint member_email_broadcasts_audience_kind_ck
    check (audience_kind in (
      'members',
      'nonmembers',
      'represented_unit',
      'registered_users',
      'cat_members',
      'department',
      'campaign'
    ));

comment on column local801.member_email_broadcasts.audience_kind is
  'Frozen high-level recipient selection: membership, active registered users, CAT team, department, or saved campaign population.';

commit;
