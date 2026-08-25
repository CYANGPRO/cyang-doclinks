import "server-only";

import { randomUUID } from "node:crypto";
import { can, type Role } from "./access.ts";
import { prepareAtomicAuditStatement } from "./audit.ts";
import { queryLocal801, runLocal801Transaction, withLocal801Transaction, type DatabaseQuery, type DatabaseStatement } from "./db.ts";
import type { WorkspaceContext } from "./workspace-context.ts";

const HANDLE_RE = /^[0-9a-f]{64}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const assignableRoles: Role[] = ["system_owner", "local_admin", "membership_data_manager", "cat_admin", "cat_lead", "cat_member", "report_viewer"];
const lowerRoles: Role[] = ["membership_data_manager", "cat_admin", "cat_lead", "cat_member", "report_viewer"];
const safeTeamReadCodes = new Set([
  "ACTIVE_KEY_INVALID", "AUTHENTICATION_FAILED", "BACKFILL_GATE_ON", "BACKFILL_INCOMPLETE",
  "COMPANION_MISSING", "CUTOVER_ALREADY_STARTED", "CUTOVER_INCOMPLETE", "DUAL_WRITE_OFF",
  "DUAL_WRITE_ON", "DUPLICATE_COMPANION", "ENVELOPE_INVALID", "INVALID_CONTEXT", "INVALID_KEY",
  "KEY_NOT_FOUND", "KEYRING_INVALID", "KEYRING_MISSING", "KEY_VERSION_INVALID", "NOT_PREVIEW",
  "PREVIEW_BOUND_EXCEEDED", "STATE_MISSING", "WRITE_MODE_INVALID",
]);

export type TeamMember = {
  handle: string;
  displayName: string;
  email: string;
  role: Role;
  active: boolean;
  invitedAt: string | null;
  lastAuthenticatedAt: string | null;
  lastMfaAt: string | null;
  identityLinked: boolean;
  onboardingStatus: "pending" | "processing" | "invited" | "ready" | "failed" | "not_managed";
};

export type TeamAccessPage = {
  members: TeamMember[];
  assignableRoles: Role[];
};

type TeamRow = {
  handle: string;
  display_name: string;
  email: string;
  role: string;
  deactivated_at: string | Date | null;
  invited_at: string | Date | null;
  last_authenticated_at: string | Date | null;
  last_mfa_at: string | Date | null;
  identity_linked: boolean;
  onboarding_status: string | null;
};

type TargetRow = {
  id: string;
  role: string;
  deactivated_at: string | Date | null;
};

type RemovalStateRow = {
  provider_user_id: string | null;
  last_authenticated_at: string | Date | null;
  identity_linked: boolean;
};

export type TeamMemberRemovalTarget = {
  organizationId: string;
  userId: string;
  providerUserId: string | null;
  role: Role;
};

type TransactionRunner = <T>(callback: (query: DatabaseQuery) => Promise<T>) => Promise<T>;

export class TeamAccessError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "TeamAccessError";
    this.code = code;
    this.status = status;
  }
}

/** Returns only an allowlisted diagnostic code; never an error message or database value. */
export function teamReadSafeCode(error: unknown) {
  if (!error || typeof error !== "object") return "TEAM_ACCESS_UNAVAILABLE";
  const source = error as Record<string, unknown>;
  if (source.name === "WorkspaceContextError") return "WORKSPACE_CONTEXT_UNAVAILABLE";
  const code = typeof source.code === "string" ? source.code : "";
  if (safeTeamReadCodes.has(code)) return code;
  if (/^[0-9A-Z]{5}$/.test(code)) return `DATABASE_${code}`;
  return "TEAM_ACCESS_UNAVAILABLE";
}

function asRole(value: string): Role | null {
  return assignableRoles.includes(value as Role) ? value as Role : null;
}

function requireManager(context: WorkspaceContext) {
  if (!can(context.role, "manageUsers")) throw new TeamAccessError("FORBIDDEN", "Team access management is not authorized.", 403);
}

function requireHandle(value: unknown) {
  if (typeof value !== "string" || !HANDLE_RE.test(value)) throw new TeamAccessError("INVALID_HANDLE", "The team member is not available.", 400);
  return value.toLowerCase();
}

function normalizeEmail(value: unknown) {
  if (typeof value !== "string") throw new TeamAccessError("INVALID_EMAIL", "A valid email address is required.", 400);
  const email = value.trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 320) throw new TeamAccessError("INVALID_EMAIL", "A valid email address is required.", 400);
  return email;
}

function normalizeName(value: unknown) {
  if (typeof value !== "string") throw new TeamAccessError("INVALID_NAME", "Display name is required.", 400);
  const name = value.trim().replace(/\s+/g, " ");
  if (!name || name.length > 160) throw new TeamAccessError("INVALID_NAME", "Display name must be between 1 and 160 characters.", 400);
  return name;
}

function normalizeRole(value: unknown) {
  if (typeof value !== "string" || !assignableRoles.includes(value as Role)) throw new TeamAccessError("INVALID_ROLE", "The selected role is invalid.", 400);
  return value as Role;
}

function assertRoleAssignable(actorRole: Role, targetRole: Role) {
  if (actorRole === "system_owner") return;
  if (actorRole === "local_admin" && lowerRoles.includes(targetRole)) return;
  throw new TeamAccessError("ROLE_NOT_ASSIGNABLE", "You cannot assign that role.", 403);
}

function assertTargetManageable(actorRole: Role, targetRole: Role) {
  if (actorRole === "system_owner") return;
  if (actorRole === "local_admin" && !["system_owner", "local_admin"].includes(targetRole)) return;
  throw new TeamAccessError("TARGET_PROTECTED", "Only a system owner can change access for an administrator account.", 403);
}

function timestamp(value: string | Date | null) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function onboardingStatus(value: string | null, identityLinked: boolean): TeamMember["onboardingStatus"] {
  if (value === "pending" || value === "processing" || value === "invited" || value === "ready" || value === "failed") return value;
  return identityLinked ? "ready" : "not_managed";
}

async function resolveTarget(context: WorkspaceContext, handleInput: unknown, query: DatabaseQuery) {
  requireManager(context);
  const handle = requireHandle(handleInput);
  const [row] = await query<TargetRow>(`
    /* team-access:resolve-target */
    SELECT app_user.id, role.code AS role, app_user.deactivated_at
    FROM local801.users app_user
    JOIN local801.workspace_user_roles user_role ON user_role.user_id = app_user.id
    JOIN local801.workspace_roles role
      ON role.id = user_role.role_id AND role.organization_id = app_user.organization_id
    WHERE app_user.organization_id = $1::uuid
      AND encode(public.digest('user:' || $1::text || ':' || app_user.id::text, 'sha256'), 'hex') = $2::text
    LIMIT 1
  `, [context.organizationId, handle]);
  if (!row || !asRole(row.role)) throw new TeamAccessError("USER_NOT_FOUND", "The team member is no longer available.", 409);
  return { ...row, role: row.role as Role };
}

function managerActorCte() {
  return `actor AS (
    SELECT app_user.id
    FROM local801.users app_user
    WHERE app_user.id = $2::uuid
      AND app_user.organization_id = $1::uuid
      AND app_user.deactivated_at IS NULL
      AND EXISTS (
        SELECT 1
        FROM local801.workspace_user_roles user_role
        JOIN local801.workspace_roles role
          ON role.id = user_role.role_id AND role.organization_id = $1::uuid
        WHERE user_role.user_id = app_user.id
          AND role.code = $3::text
          AND role.code IN ('system_owner','local_admin')
      )
  )`;
}

export async function getTeamAccessPage(context: WorkspaceContext, query: DatabaseQuery = queryLocal801): Promise<TeamAccessPage> {
  requireManager(context);
  const rows = await query<TeamRow>(`
    /* team-access:list */
    SELECT encode(public.digest('user:' || $1::text || ':' || app_user.id::text, 'sha256'), 'hex') AS handle,
      app_user.display_name, app_user.email, role.code AS role, app_user.deactivated_at,
      app_user.invited_at, app_user.last_authenticated_at, app_user.last_mfa_at,
      EXISTS (
        SELECT 1 FROM local801.auth_identities identity
        WHERE identity.organization_id = $1::uuid AND identity.user_id = app_user.id
      ) AS identity_linked, onboarding.status AS onboarding_status
    FROM local801.users app_user
    JOIN local801.workspace_user_roles user_role ON user_role.user_id = app_user.id
    JOIN local801.workspace_roles role
      ON role.id = user_role.role_id AND role.organization_id = $1::uuid
    LEFT JOIN local801.user_identity_onboarding onboarding
      ON onboarding.organization_id = app_user.organization_id AND onboarding.user_id = app_user.id
    WHERE app_user.organization_id = $1::uuid
    ORDER BY app_user.deactivated_at NULLS FIRST, lower(app_user.display_name), app_user.id
    LIMIT 500
  `, [context.organizationId]);
  return {
    members: rows.flatMap((row) => {
      const role = asRole(row.role);
      return role && HANDLE_RE.test(row.handle) ? [{
        handle: row.handle,
        displayName: row.display_name,
        email: row.email,
        role,
        active: row.deactivated_at === null,
        invitedAt: timestamp(row.invited_at),
        lastAuthenticatedAt: timestamp(row.last_authenticated_at),
        lastMfaAt: timestamp(row.last_mfa_at),
        identityLinked: row.identity_linked,
        onboardingStatus: onboardingStatus(row.onboarding_status, row.identity_linked),
      }] : [];
    }),
    assignableRoles: context.role === "system_owner" ? assignableRoles : lowerRoles,
  };
}

export async function provisionTeamMember(
  context: WorkspaceContext,
  input: { email: unknown; displayName: unknown; role: unknown },
  dependencies: { query?: DatabaseQuery; transaction?: (statements: readonly DatabaseStatement[]) => Promise<void>; uuid?: () => string } = {},
) {
  requireManager(context);
  const email = normalizeEmail(input.email);
  const displayName = normalizeName(input.displayName);
  const role = normalizeRole(input.role);
  assertRoleAssignable(context.role, role);
  const query = dependencies.query ?? queryLocal801;
  const transaction = dependencies.transaction ?? runLocal801Transaction;
  const id = (dependencies.uuid ?? randomUUID)();
  const [existing] = await query<Record<string, unknown>>(`
    SELECT 1
    FROM local801.users app_user
    WHERE app_user.organization_id = $1::uuid AND lower(app_user.email) = lower($2::text)
    LIMIT 1
  `, [context.organizationId, email]);
  if (existing) throw new TeamAccessError("EMAIL_EXISTS", "A Local 801 user already exists for that email address. Use Retry onboarding in the existing user’s row.", 409);

  const mutation: DatabaseStatement = {
    sql: `WITH ${managerActorCte()}, selected_role AS (
      SELECT role.id
      FROM local801.workspace_roles role
      WHERE role.organization_id = $1::uuid AND role.code = $6::text
        AND ($3::text = 'system_owner' OR role.code IN ('membership_data_manager','cat_admin','cat_lead','cat_member','report_viewer'))
      LIMIT 1
    ), inserted_user AS (
      INSERT INTO local801.users (id, organization_id, email, display_name, invited_at, invited_by)
      SELECT $4::uuid, $1::uuid, lower($5::text), $7::text, now(), actor.id
      FROM actor CROSS JOIN selected_role
      RETURNING id
    ), inserted_role AS (
      INSERT INTO local801.workspace_user_roles (user_id, role_id, assigned_by)
      SELECT inserted_user.id, selected_role.id, actor.id
      FROM inserted_user CROSS JOIN selected_role CROSS JOIN actor
      RETURNING user_id
    ), inserted_onboarding AS (
      INSERT INTO local801.user_identity_onboarding (organization_id, user_id, status)
      SELECT $1::uuid, inserted_role.user_id, 'pending'
      FROM inserted_role
      RETURNING user_id
    )
    SELECT CASE WHEN count(*) = 1 THEN true ELSE 1 / count(*)::integer = 1 END AS user_provisioned FROM inserted_onboarding`,
    parameters: [context.organizationId, context.userId, context.role, id, email, role, displayName],
  };
  const audit = await prepareAtomicAuditStatement({
    eventType: "record.create", actorId: context.userId, organizationId: context.organizationId,
    subjectType: "workspace_user", subjectId: id, payload: { role, provisioned: true },
  }, query);
  await transaction([mutation, audit]);
  return { created: true, userId: id, email, displayName, role };
}

export async function resolveTeamMemberOnboardingTarget(
  context: WorkspaceContext,
  handleInput: unknown,
  query: DatabaseQuery = queryLocal801,
) {
  const handle = requireHandle(handleInput);
  const target = await resolveTarget(context, handle, query);
  assertTargetManageable(context.role, target.role);
  if (target.deactivated_at !== null) throw new TeamAccessError("USER_DEACTIVATED", "Reactivate this user before retrying onboarding.", 409);
  const [authorization] = await query<{ authorized: boolean }>(`
    SELECT EXISTS (
      SELECT 1
      FROM local801.users actor
      JOIN local801.workspace_user_roles actor_user_role ON actor_user_role.user_id = actor.id
      JOIN local801.workspace_roles actor_role
        ON actor_role.id = actor_user_role.role_id AND actor_role.organization_id = actor.organization_id
      WHERE actor.organization_id = $1::uuid
        AND actor.id = $2::uuid
        AND actor.deactivated_at IS NULL
        AND actor_role.code = $3::text
        AND actor_role.code IN ('system_owner','local_admin')
    ) AS authorized
  `, [context.organizationId, context.userId, context.role]);
  if (authorization?.authorized !== true) throw new TeamAccessError("FORBIDDEN", "Team access management is not authorized.", 403);
  const page = await getTeamAccessPage(context, query);
  const { hydrateTeamAccessPageFromProtectedPii } = await import("./pii-protected-read.ts");
  const hydrated = await hydrateTeamAccessPageFromProtectedPii(context.organizationId, page, { query });
  const member = hydrated.members.find((candidate) => candidate.handle === handle);
  if (!member) throw new TeamAccessError("USER_NOT_FOUND", "The team member is no longer available.", 409);
  return {
    organizationId: context.organizationId,
    userId: target.id,
    email: member.email,
    displayName: member.displayName,
    role: target.role,
  };
}

export async function resolveTeamMemberRemovalTarget(
  context: WorkspaceContext,
  handleInput: unknown,
  query: DatabaseQuery = queryLocal801,
): Promise<TeamMemberRemovalTarget> {
  const target = await resolveTarget(context, handleInput, query);
  if (target.id === context.userId) throw new TeamAccessError("SELF_REMOVAL", "Use another system owner to remove your account.", 409);
  assertTargetManageable(context.role, target.role);
  const [state] = await query<RemovalStateRow>(`
    /* team-access:resolve-removal-target */
    SELECT onboarding.provider_user_id::text, app_user.last_authenticated_at,
      EXISTS (
        SELECT 1 FROM local801.auth_identities identity
        WHERE identity.organization_id = app_user.organization_id AND identity.user_id = app_user.id
      ) AS identity_linked
    FROM local801.users app_user
    LEFT JOIN local801.user_identity_onboarding onboarding
      ON onboarding.organization_id = app_user.organization_id AND onboarding.user_id = app_user.id
    WHERE app_user.organization_id = $1::uuid AND app_user.id = $2::uuid
    LIMIT 1
  `, [context.organizationId, target.id]);
  if (!state) throw new TeamAccessError("USER_NOT_FOUND", "The team member is no longer available.", 409);
  if (state.last_authenticated_at !== null || state.identity_linked) {
    throw new TeamAccessError("ACCOUNT_HAS_HISTORY", "This account has CAT sign-in history and cannot be erased. Deactivate it instead to preserve records and audit history.", 409);
  }
  return {
    organizationId: context.organizationId,
    userId: target.id,
    providerUserId: state.provider_user_id,
    role: target.role,
  };
}

async function hardDeleteUnusedTeamMember(context: WorkspaceContext, target: TeamMemberRemovalTarget, query: DatabaseQuery) {
  await query(`
    DELETE FROM local801.pii_exact_indexes
    WHERE organization_id = $1::uuid AND entity_type = 'user' AND entity_id = $2::uuid
  `, [context.organizationId, target.userId]);
  const deleted = await query<{ id: string }>(`
    WITH ${managerActorCte()}
    DELETE FROM local801.users app_user
    USING actor
    WHERE app_user.organization_id = $1::uuid
      AND app_user.id = $4::uuid
      AND app_user.id <> actor.id
      AND app_user.last_authenticated_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM local801.auth_identities identity
        WHERE identity.organization_id = app_user.organization_id AND identity.user_id = app_user.id
      )
      AND ($3::text = 'system_owner' OR NOT EXISTS (
        SELECT 1 FROM local801.workspace_user_roles protected_user_role
        JOIN local801.workspace_roles protected_role
          ON protected_role.id = protected_user_role.role_id AND protected_role.organization_id = $1::uuid
        WHERE protected_user_role.user_id = app_user.id AND protected_role.code IN ('system_owner','local_admin')
      ))
    RETURNING app_user.id::text
  `, [context.organizationId, context.userId, context.role, target.userId]);
  if (deleted.length !== 1) {
    throw new TeamAccessError("REMOVAL_CONFLICT", "This account changed before it could be removed. Refresh Team & Access and try again.", 409);
  }
}

function removalHistoryError(error: unknown) {
  if (error instanceof TeamAccessError) return error;
  const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : null;
  if (code === "23503") {
    return new TeamAccessError("ACCOUNT_HAS_HISTORY", "This account is referenced by CAT work or audit history and cannot be erased. Deactivate it instead.", 409);
  }
  return null;
}

export async function preflightTeamMemberRemoval(
  context: WorkspaceContext,
  target: TeamMemberRemovalTarget,
  transaction: TransactionRunner = withLocal801Transaction,
) {
  const rollback = new Error("TEAM_REMOVAL_PREFLIGHT_ROLLBACK");
  try {
    await transaction(async (query) => {
      await hardDeleteUnusedTeamMember(context, target, query);
      throw rollback;
    });
  } catch (error) {
    if (error === rollback) return { removable: true as const };
    const safe = removalHistoryError(error);
    if (safe) throw safe;
    throw error;
  }
  throw new TeamAccessError("REMOVAL_PREFLIGHT_INVALID", "The account removal preflight did not roll back safely.", 503);
}

export async function removeTeamMemberFromCat(
  context: WorkspaceContext,
  target: TeamMemberRemovalTarget,
  dependencies: { query?: DatabaseQuery; transaction?: TransactionRunner } = {},
) {
  const query = dependencies.query ?? queryLocal801;
  const transaction = dependencies.transaction ?? withLocal801Transaction;
  const audit = await prepareAtomicAuditStatement({
    eventType: "record.archive", actorId: context.userId, organizationId: context.organizationId,
    subjectType: "workspace_user", subjectId: target.userId,
    payload: { accountRemoved: true, entraRemovalRequested: target.providerUserId !== null },
  }, query);
  try {
    await transaction(async (transactionQuery) => {
      await hardDeleteUnusedTeamMember(context, target, transactionQuery);
      await transactionQuery(audit.sql, audit.parameters);
    });
  } catch (error) {
    const safe = removalHistoryError(error);
    if (safe) throw safe;
    throw error;
  }
  return { removed: true as const };
}

export async function changeTeamMemberRole(
  context: WorkspaceContext,
  handle: unknown,
  roleInput: unknown,
  dependencies: { query?: DatabaseQuery; transaction?: (statements: readonly DatabaseStatement[]) => Promise<void> } = {},
) {
  requireManager(context);
  const query = dependencies.query ?? queryLocal801;
  const transaction = dependencies.transaction ?? runLocal801Transaction;
  const target = await resolveTarget(context, handle, query);
  const role = normalizeRole(roleInput);
  assertRoleAssignable(context.role, role);
  if (target.id === context.userId) throw new TeamAccessError("SELF_ROLE_CHANGE", "Use another system owner to change your own role.", 409);
  assertTargetManageable(context.role, target.role);
  if (target.role === role) throw new TeamAccessError("NO_CHANGES", "The team member already has that role.", 400);

  const mutation: DatabaseStatement = {
    sql: `WITH ${managerActorCte()}, target AS (
      SELECT app_user.id
      FROM local801.users app_user
      WHERE app_user.id = $4::uuid AND app_user.organization_id = $1::uuid
        AND app_user.deactivated_at IS NULL
        AND ($3::text = 'system_owner' OR NOT EXISTS (
          SELECT 1 FROM local801.workspace_user_roles current_user_role
          JOIN local801.workspace_roles current_role ON current_role.id = current_user_role.role_id AND current_role.organization_id = $1::uuid
          WHERE current_user_role.user_id = app_user.id AND current_role.code IN ('system_owner','local_admin')
        ))
    ), selected_role AS (
      SELECT role.id FROM local801.workspace_roles role
      WHERE role.organization_id = $1::uuid AND role.code = $5::text
        AND ($3::text = 'system_owner' OR role.code IN ('membership_data_manager','cat_admin','cat_lead','cat_member','report_viewer'))
      LIMIT 1
    ), deleted AS (
      DELETE FROM local801.workspace_user_roles user_role
      USING target
      WHERE user_role.user_id = target.id
      RETURNING user_role.user_id
    ), inserted AS (
      INSERT INTO local801.workspace_user_roles (user_id, role_id, assigned_by)
      SELECT target.id, selected_role.id, actor.id
      FROM target CROSS JOIN selected_role CROSS JOIN actor CROSS JOIN deleted
      RETURNING user_id
    ), revoked AS (
      UPDATE local801.users app_user SET auth_session_version = auth_session_version + 1
      FROM inserted WHERE app_user.id = inserted.user_id AND app_user.organization_id = $1::uuid
      RETURNING app_user.id
    )
    SELECT CASE WHEN count(*) = 1 THEN true ELSE 1 / count(*)::integer = 1 END AS role_changed FROM revoked`,
    parameters: [context.organizationId, context.userId, context.role, target.id, role],
  };
  const audit = await prepareAtomicAuditStatement({
    eventType: "role.change", actorId: context.userId, organizationId: context.organizationId,
    subjectType: "workspace_user", subjectId: target.id, payload: { from: target.role, to: role, sessionsRevoked: true },
  }, query);
  await transaction([mutation, audit]);
  return { updated: true };
}

export async function setTeamMemberActive(
  context: WorkspaceContext,
  handle: unknown,
  active: boolean,
  dependencies: { query?: DatabaseQuery; transaction?: (statements: readonly DatabaseStatement[]) => Promise<void> } = {},
) {
  requireManager(context);
  const query = dependencies.query ?? queryLocal801;
  const transaction = dependencies.transaction ?? runLocal801Transaction;
  const target = await resolveTarget(context, handle, query);
  if (target.id === context.userId) throw new TeamAccessError("SELF_DEACTIVATION", "Use another system owner or administrator to change your own account state.", 409);
  assertTargetManageable(context.role, target.role);
  const currentlyActive = target.deactivated_at === null;
  if (currentlyActive === active) throw new TeamAccessError("NO_CHANGES", `The team member is already ${active ? "active" : "deactivated"}.`, 400);

  const mutation: DatabaseStatement = {
    sql: `WITH ${managerActorCte()}, updated AS (
      UPDATE local801.users app_user
      SET deactivated_at = CASE WHEN $5::boolean THEN NULL ELSE now() END,
        auth_session_version = auth_session_version + 1
      WHERE app_user.id = $4::uuid AND app_user.organization_id = $1::uuid
        AND EXISTS (SELECT 1 FROM actor)
        AND ($3::text = 'system_owner' OR NOT EXISTS (
          SELECT 1 FROM local801.workspace_user_roles protected_user_role
          JOIN local801.workspace_roles protected_role ON protected_role.id = protected_user_role.role_id AND protected_role.organization_id = $1::uuid
          WHERE protected_user_role.user_id = app_user.id AND protected_role.code IN ('system_owner','local_admin')
        ))
      RETURNING app_user.id
    ) SELECT CASE WHEN count(*) = 1 THEN true ELSE 1 / count(*)::integer = 1 END AS account_state_changed FROM updated`,
    parameters: [context.organizationId, context.userId, context.role, target.id, active],
  };
  const audit = await prepareAtomicAuditStatement({
    eventType: active ? "record.restore" : "record.archive", actorId: context.userId, organizationId: context.organizationId,
    subjectType: "workspace_user", subjectId: target.id, payload: { active, sessionsRevoked: true },
  }, query);
  await transaction([mutation, audit]);
  return { updated: true };
}

export async function revokeTeamMemberSessions(
  context: WorkspaceContext,
  handle: unknown,
  dependencies: { query?: DatabaseQuery; transaction?: (statements: readonly DatabaseStatement[]) => Promise<void> } = {},
) {
  requireManager(context);
  const query = dependencies.query ?? queryLocal801;
  const transaction = dependencies.transaction ?? runLocal801Transaction;
  const target = await resolveTarget(context, handle, query);
  assertTargetManageable(context.role, target.role);
  const mutation: DatabaseStatement = {
    sql: `WITH ${managerActorCte()}, updated AS (
      UPDATE local801.users app_user
      SET auth_session_version = auth_session_version + 1
      WHERE app_user.id = $4::uuid AND app_user.organization_id = $1::uuid
        AND EXISTS (SELECT 1 FROM actor)
        AND ($3::text = 'system_owner' OR NOT EXISTS (
          SELECT 1 FROM local801.workspace_user_roles protected_user_role
          JOIN local801.workspace_roles protected_role ON protected_role.id = protected_user_role.role_id AND protected_role.organization_id = $1::uuid
          WHERE protected_user_role.user_id = app_user.id AND protected_role.code IN ('system_owner','local_admin')
        ))
      RETURNING app_user.id
    ) SELECT CASE WHEN count(*) = 1 THEN true ELSE 1 / count(*)::integer = 1 END AS sessions_revoked FROM updated`,
    parameters: [context.organizationId, context.userId, context.role, target.id],
  };
  const audit = await prepareAtomicAuditStatement({
    eventType: "config.change", actorId: context.userId, organizationId: context.organizationId,
    subjectType: "workspace_user", subjectId: target.id, payload: { sessionsRevoked: true },
  }, query);
  await transaction([mutation, audit]);
  return { revoked: true };
}

export const __testing = { assignableRoles, lowerRoles, normalizeEmail, normalizeName, normalizeRole, assertRoleAssignable, assertTargetManageable, onboardingStatus };
