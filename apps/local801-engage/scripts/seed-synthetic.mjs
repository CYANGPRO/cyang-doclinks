import { createHash } from "node:crypto";
import postgres from "postgres";
import { assertSyntheticSeedAllowed } from "./seed-guards.mjs";

const connectionString = assertSyntheticSeedAllowed();
const sql = postgres(connectionString, { max: 1, prepare: false });

function stableId(label) {
  const bytes = createHash("sha256").update(`local801-synthetic:${label}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

const now = new Date();
const currentMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
const previousMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15));
const inDays = (days) => new Date(now.getTime() + days * 86_400_000);
const daysAgo = (days) => new Date(now.getTime() - days * 86_400_000);
const currentMonthDay = (day) => new Date(currentMonthStart.getTime() + (day - 1) * 86_400_000);

const users = [
  ["system_owner", "system_owner@example.test", "Synthetic System Owner"],
  ["local_admin", "local_admin@example.test", "Synthetic Local Administrator"],
  ["membership_data_manager", "membership_manager@example.test", "Synthetic Membership Manager"],
  ["cat_admin", "cat_admin@example.test", "Synthetic CAT Administrator"],
  ["cat_lead", "cat_lead@example.test", "Synthetic CAT Lead"],
  ["cat_member", "cat_member@example.test", "Synthetic CAT Member"],
  ["report_viewer", "report_viewer@example.test", "Synthetic Report Viewer"],
];

const people = [
  ["avery-morgan", "Avery", "Morgan", "member", "Health Licensing", "Regulation", "Clerical", "Downtown"],
  ["riley-chen", "Riley", "Chen", "member", "Administrative Services", "Finance", "Technical", "North Campus"],
  ["taylor-brooks", "Taylor", "Brooks", "nonmember", "Environmental Review", "Field", "Professional", "West Office"],
  ["casey-woods", "Casey", "Woods", "member", "Customer Support", "Help Desk", "Clerical", "East Office"],
  ["drew-hart", "Drew", "Hart", "nonmember", "Field Operations", "Inspections", "Technical", "South Campus"],
  ["skyler-james", "Skyler", "James", "member", "Health Licensing", "Intake", "Clerical", "Downtown"],
  ["quinn-stone", "Quinn", "Stone", "unknown", "Administrative Services", "Procurement", "Professional", "North Campus"],
  ["emery-lane", "Emery", "Lane", "member", "Environmental Review", "Permits", "Technical", "West Office"],
];

async function seed(transaction) {
  const [organization] = await transaction`
    INSERT INTO local801.organizations (id, slug, name)
    VALUES (${stableId("organization")}, 'local801-preview', 'Local 801 Synthetic Preview')
    ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
    RETURNING id
  `;
  const organizationId = organization.id;
  const userIds = new Map();

  for (const [roleCode, email, displayName] of users) {
    const userId = stableId(`user:${roleCode}`);
    const roleId = stableId(`role:${roleCode}`);
    const sessionSeconds = roleCode === "system_owner" || roleCode === "local_admin" ? 43_200 : 604_800;
    await transaction`
      INSERT INTO local801.users (id, organization_id, email, display_name)
      VALUES (${userId}, ${organizationId}, ${email}, ${displayName})
      ON CONFLICT (organization_id, lower(email)) DO UPDATE SET display_name = EXCLUDED.display_name
    `;
    await transaction`
      INSERT INTO local801.workspace_roles (id, organization_id, code, name, session_seconds)
      VALUES (${roleId}, ${organizationId}, ${roleCode}, ${displayName}, ${sessionSeconds})
      ON CONFLICT (organization_id, code) DO UPDATE
      SET name = EXCLUDED.name, session_seconds = EXCLUDED.session_seconds
    `;
    const [storedUser] = await transaction`
      SELECT id FROM local801.users WHERE organization_id = ${organizationId} AND lower(email) = lower(${email})
    `;
    const [storedRole] = await transaction`
      SELECT id FROM local801.workspace_roles WHERE organization_id = ${organizationId} AND code = ${roleCode}
    `;
    userIds.set(roleCode, storedUser.id);
    await transaction`
      INSERT INTO local801.workspace_user_roles (user_id, role_id, assigned_by)
      VALUES (${storedUser.id}, ${storedRole.id}, NULL)
      ON CONFLICT (user_id, role_id) DO UPDATE SET assigned_by = EXCLUDED.assigned_by
    `;
  }

  const userId = (roleCode) => {
    const id = userIds.get(roleCode);
    if (!id) throw new Error("Synthetic user setup failed.");
    return id;
  };

  for (const [index, person] of people.entries()) {
    const [key, firstName, lastName, membershipStatus, department, section, classification, workLocation] = person;
    const personId = stableId(`person:${key}`);
    await transaction`
      INSERT INTO local801.people (
        id, organization_id, preferred_name, first_name, last_name, membership_status,
        department, section, classification, work_location, local_number
      ) VALUES (
        ${personId}, ${organizationId}, ${`Synthetic ${firstName}`}, ${firstName}, ${lastName},
        ${membershipStatus}, ${department}, ${section}, ${classification}, ${workLocation}, '0801'
      )
      ON CONFLICT (id) DO UPDATE SET
        preferred_name = EXCLUDED.preferred_name,
        first_name = EXCLUDED.first_name,
        last_name = EXCLUDED.last_name,
        membership_status = EXCLUDED.membership_status,
        department = EXCLUDED.department,
        section = EXCLUDED.section,
        classification = EXCLUDED.classification,
        work_location = EXCLUDED.work_location,
        updated_at = now()
    `;
    await transaction`
      INSERT INTO local801.person_identifiers (
        id, organization_id, person_id, identifier_type, identifier_value
      ) VALUES (
        ${stableId(`identifier:${key}`)}, ${organizationId}, ${personId}, 'synthetic_preview_id', ${`SYNTH-${String(index + 1).padStart(3, "0")}`}
      )
      ON CONFLICT (organization_id, identifier_type, identifier_value) DO UPDATE SET person_id = EXCLUDED.person_id
    `;
    await transaction`
      INSERT INTO local801.person_contact_methods (
        id, organization_id, person_id, contact_type, contact_value, is_primary, visibility, verified_at
      ) VALUES (
        ${stableId(`contact:work-email:${key}`)}, ${organizationId}, ${personId}, 'work_email',
        ${`${firstName}.${lastName}@example.test`.toLowerCase()}, true, 'authorized_directory', now()
      )
      ON CONFLICT (id) DO UPDATE SET
        organization_id = EXCLUDED.organization_id,
        person_id = EXCLUDED.person_id,
        contact_type = EXCLUDED.contact_type,
        contact_value = EXCLUDED.contact_value,
        is_primary = EXCLUDED.is_primary,
        visibility = EXCLUDED.visibility,
        verified_at = EXCLUDED.verified_at,
        archived_at = NULL
    `;
  }

  const snapshotKey = isoDate(currentMonthStart);
  const snapshotId = stableId(`membership-snapshot:${snapshotKey}`);
  await transaction`
    INSERT INTO local801.membership_snapshots (
      id, organization_id, snapshot_date, status, approved_by, approved_at
    ) VALUES (
      ${snapshotId}, ${organizationId}, ${isoDate(currentMonthStart)}, 'approved',
      ${userId("membership_data_manager")}, now()
    )
    ON CONFLICT (organization_id, snapshot_date, status) DO UPDATE
    SET approved_by = EXCLUDED.approved_by, approved_at = EXCLUDED.approved_at
  `;
  const [storedSnapshot] = await transaction`
    SELECT id FROM local801.membership_snapshots
    WHERE organization_id = ${organizationId} AND snapshot_date = ${isoDate(currentMonthStart)} AND status = 'approved'
  `;
  for (const person of people) {
    const [key, , , membershipStatus, department, , classification, workLocation] = person;
    const rowHash = createHash("sha256").update(person.join("|")).digest("hex");
    await transaction`
      INSERT INTO local801.membership_snapshot_rows (
        id, organization_id, snapshot_id, person_id, membership_status,
        department, work_location, classification, row_hash
      ) VALUES (
        ${stableId(`snapshot-row:${snapshotKey}:${key}`)}, ${organizationId}, ${storedSnapshot.id}, ${stableId(`person:${key}`)},
        ${membershipStatus}, ${department}, ${workLocation}, ${classification}, ${rowHash}
      )
      ON CONFLICT (snapshot_id, person_id) DO UPDATE SET
        membership_status = EXCLUDED.membership_status,
        department = EXCLUDED.department,
        work_location = EXCLUDED.work_location,
        classification = EXCLUDED.classification,
        row_hash = EXCLUDED.row_hash
    `;
  }

  const membershipEvents = [
    ["addition", "avery-morgan", isoDate(currentMonthDay(2))],
    ["addition", "riley-chen", isoDate(currentMonthDay(3))],
    ["drop", "taylor-brooks", isoDate(currentMonthDay(4))],
    ["status_review", "quinn-stone", isoDate(previousMonth)],
  ];
  for (const [eventType, personKey, effectiveDate] of membershipEvents) {
    await transaction`
      INSERT INTO local801.membership_events (
        id, organization_id, person_id, event_type, effective_date, created_by
      ) VALUES (
        ${stableId(`membership-event:${eventType}:${personKey}`)}, ${organizationId},
        ${stableId(`person:${personKey}`)}, ${eventType}, ${effectiveDate},
        ${userId("membership_data_manager")}
      )
      ON CONFLICT (id) DO UPDATE SET effective_date = EXCLUDED.effective_date
    `;
  }

  for (const [index, personKey] of ["casey-woods", "emery-lane"].entries()) {
    await transaction`
      INSERT INTO local801.employment_events (
        id, organization_id, person_id, event_type, effective_date, department, work_location
      ) VALUES (
        ${stableId(`employment-event:hire:${personKey}`)}, ${organizationId}, ${stableId(`person:${personKey}`)},
        'hire', ${isoDate(currentMonthDay(index + 2))},
        ${people.find((person) => person[0] === personKey)[4]},
        ${people.find((person) => person[0] === personKey)[7]}
      )
      ON CONFLICT (id) DO UPDATE SET effective_date = EXCLUDED.effective_date
    `;
  }

  for (const sequence of [1, 2]) {
    await transaction`
      INSERT INTO local801.import_batches (id, organization_id, import_kind, state, uploaded_by)
      VALUES (
        ${stableId(`import-batch:${sequence}`)}, ${organizationId},
        ${sequence === 1 ? "current_roster" : "new_hires"}, 'under_review',
        ${userId("membership_data_manager")}
      )
      ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state
    `;
  }

  const campaignId = stableId("campaign:august-outreach");
  await transaction`
    INSERT INTO local801.outreach_campaigns (
      id, organization_id, name, status, starts_on, ends_on, created_by, launched_at
    ) VALUES (
      ${campaignId}, ${organizationId}, 'Synthetic Member Outreach', 'active',
      ${isoDate(currentMonthStart)}, ${isoDate(inDays(14))}, ${userId("cat_admin")}, now()
    )
    ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, ends_on = EXCLUDED.ends_on
  `;

  const assignedPeople = ["avery-morgan", "riley-chen", "taylor-brooks", "casey-woods"];
  for (const [index, personKey] of assignedPeople.entries()) {
    await transaction`
      INSERT INTO local801.outreach_campaign_population (id, organization_id, campaign_id, person_id, source_snapshot_id)
      VALUES (
        ${stableId(`campaign-population:${personKey}`)}, ${organizationId}, ${campaignId},
        ${stableId(`person:${personKey}`)}, ${storedSnapshot.id}
      )
      ON CONFLICT (campaign_id, person_id) DO UPDATE SET source_snapshot_id = EXCLUDED.source_snapshot_id
    `;
    await transaction`
      INSERT INTO local801.engagement_assignments (
        id, organization_id, campaign_id, person_id, primary_user_id, backup_user_id,
        assignment_type, status, due_at, created_by
      ) VALUES (
        ${stableId(`assignment:${personKey}`)}, ${organizationId}, ${campaignId}, ${stableId(`person:${personKey}`)},
        ${userId("cat_lead")}, ${userId("cat_admin")}, 'direct', 'open',
        ${inDays(index + 1)}, ${userId("cat_admin")}
      )
      ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, due_at = EXCLUDED.due_at
    `;
  }

  const engagementEventId = stableId("engagement-event:avery-morgan");
  await transaction`
    INSERT INTO local801.engagement_events (
      id, organization_id, assignment_id, campaign_id, person_id, recorded_by,
      contact_method, outcome, note_visibility, note_hash, occurred_at
    ) VALUES (
      ${engagementEventId}, ${organizationId}, ${stableId("assignment:avery-morgan")}, ${campaignId},
      ${stableId("person:avery-morgan")}, ${userId("cat_lead")}, 'email', 'contacted',
      'assigned_scope', ${createHash("sha256").update("synthetic-note-redacted").digest("hex")}, ${daysAgo(1)}
    )
    ON CONFLICT (id) DO UPDATE SET occurred_at = EXCLUDED.occurred_at
  `;
  await transaction`
    INSERT INTO local801.engagement_followups (
      id, organization_id, engagement_event_id, person_id, assigned_to, due_at, status
    ) VALUES (
      ${stableId("followup:avery-morgan")}, ${organizationId}, ${engagementEventId},
      ${stableId("person:avery-morgan")}, ${userId("cat_lead")}, ${daysAgo(1)}, 'open'
    )
    ON CONFLICT (id) DO UPDATE SET due_at = EXCLUDED.due_at, status = EXCLUDED.status
  `;

  const catActionId = stableId("cat-action:synthetic");
  await transaction`
    INSERT INTO local801.cat_actions (id, organization_id, name, status, created_by)
    VALUES (${catActionId}, ${organizationId}, 'Synthetic Contract Action', 'active', ${userId("cat_admin")})
    ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status
  `;
  await transaction`
    INSERT INTO local801.cat_action_tasks (id, organization_id, cat_action_id, assigned_to, title, status, due_at)
    VALUES (
      ${stableId("cat-action-task:synthetic")}, ${organizationId}, ${catActionId}, ${userId("cat_lead")},
      'Synthetic readiness exercise', 'open', ${inDays(5)}
    )
    ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, due_at = EXCLUDED.due_at
  `;

  const employeeActions = [
    ["brief-follow-up", "Take a brief follow-up call", 1, "organization"],
    ["cat-meeting", "Attend a CAT meeting", 2, "organization"],
    ["campaign-ask", "Complete the Synthetic Member Outreach ask", 2, "campaign"],
    ["coworker-conversation", "Talk with a coworker about the contract", 3, "organization"],
    ["synthetic-contract-action", "Participate in the Synthetic Contract Action", 4, "cat_action"],
    ["organize-coworkers", "Volunteer to help organize coworkers", 5, "organization"],
  ];

  for (const [key, name, engagementLevel, scopeType] of employeeActions) {
    await transaction`
      INSERT INTO local801.employee_actions (
        id, organization_id, name, engagement_level, scope_type,
        campaign_id, cat_action_id, created_by
      ) VALUES (
        ${stableId(`employee-action:${key}`)}, ${organizationId}, ${name}, ${engagementLevel}, ${scopeType},
        ${scopeType === "campaign" ? campaignId : null},
        ${scopeType === "cat_action" ? catActionId : null},
        ${userId("cat_admin")}
      )
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        engagement_level = EXCLUDED.engagement_level,
        scope_type = EXCLUDED.scope_type,
        campaign_id = EXCLUDED.campaign_id,
        cat_action_id = EXCLUDED.cat_action_id,
        created_by = EXCLUDED.created_by,
        updated_at = now(),
        archived_at = NULL
    `;
  }
}

try {
  console.log("Seeding synthetic Local 801 preview data...");
  await sql.begin(seed);
  console.log("Synthetic Local 801 preview seed complete.");
} catch {
  console.error("Synthetic Local 801 preview seed failed. No connection details were logged.");
  process.exitCode = 1;
} finally {
  await sql.end();
}
