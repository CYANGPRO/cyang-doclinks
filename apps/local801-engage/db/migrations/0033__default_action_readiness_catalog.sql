begin;

-- The organization-wide Action Readiness catalog is ordered from the lowest
-- commitment action to the highest commitment action. Existing definitions
-- and response history are preserved; only missing active definitions are added.
with catalog(name, engagement_level) as (
  values
    ('Follow Up Call'::text, 1::smallint),
    ('Complete a Survey'::text, 1::smallint),
    ('Attend a Meeting'::text, 2::smallint),
    ('Talk to a Coworker about MAPE''s Contract'::text, 2::smallint),
    ('Sign a Petition'::text, 3::smallint),
    ('Volunteer to Become a CAT'::text, 4::smallint),
    ('Meet with Legislators'::text, 4::smallint),
    ('Participate in Workforce Action'::text, 5::smallint)
)
insert into local801.employee_actions
  (id, organization_id, name, engagement_level, scope_type, created_by)
select
  gen_random_uuid(), organization.id, catalog.name, catalog.engagement_level,
  'organization', null
from local801.organizations organization
cross join catalog
where not exists (
  select 1
  from local801.employee_actions existing
  where existing.organization_id = organization.id
    and existing.scope_type = 'organization'
    and existing.archived_at is null
    and lower(existing.name) = lower(catalog.name)
);

commit;
