import "server-only";

import { writeAuditEvent } from "./audit.ts";
import { withLocal801Transaction, type DatabaseQuery } from "./db.ts";
import { REQUIRED_ACCESS_POLICIES, REQUIRED_ACCESS_POLICY_PARAMETERS } from "./policy-contract.ts";

type PolicyAcknowledgementInput = Readonly<{
  organizationSlug: string;
  userId: string;
  sessionVersion: number;
}>;

type PolicyAcknowledgementRow = {
  acknowledgement_id: string;
  organization_id: string;
  policy_key: string;
  policy_version: string;
  inserted: boolean;
};

type TransactionRunner = <T>(callback: (query: DatabaseQuery) => Promise<T>) => Promise<T>;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class PolicyAcknowledgementError extends Error {
  constructor() {
    super("The privacy and acceptable-use acknowledgment could not be recorded.");
    this.name = "PolicyAcknowledgementError";
  }
}

export async function acceptRequiredAccessPolicies(
  input: PolicyAcknowledgementInput,
  dependencies: {
    transaction?: TransactionRunner;
    audit?: typeof writeAuditEvent;
  } = {},
) {
  if (!input.organizationSlug || input.organizationSlug.length > 80
    || !uuidPattern.test(input.userId)
    || !Number.isSafeInteger(input.sessionVersion)
    || input.sessionVersion < 1) {
    throw new PolicyAcknowledgementError();
  }

  const transaction = dependencies.transaction ?? withLocal801Transaction;
  const audit = dependencies.audit ?? writeAuditEvent;
  return transaction(async (query) => {
    const rows = await query<PolicyAcknowledgementRow>(`
      /* policy-acknowledgement:accept-required */
      WITH target AS (
        SELECT organization.id AS organization_id, app_user.id AS user_id
        FROM local801.organizations organization
        JOIN local801.users app_user
          ON app_user.organization_id = organization.id
         AND app_user.id = $2::uuid
         AND app_user.auth_session_version = $3::integer
         AND app_user.deactivated_at IS NULL
        WHERE organization.slug = $1::text
          AND organization.archived_at IS NULL
        FOR UPDATE OF app_user
      ), required_policies(policy_key, policy_version) AS (
        VALUES ($4::text, $5::text), ($6::text, $7::text)
      ), inserted AS (
        INSERT INTO local801.user_policy_acknowledgements
          (organization_id, user_id, policy_key, policy_version)
        SELECT target.organization_id, target.user_id, required_policies.policy_key, required_policies.policy_version
        FROM target CROSS JOIN required_policies
        ON CONFLICT (organization_id, user_id, policy_key, policy_version) DO NOTHING
        RETURNING id, organization_id, policy_key, policy_version
      ), accepted AS (
        SELECT inserted.id AS acknowledgement_id, inserted.organization_id,
          inserted.policy_key, inserted.policy_version, true AS inserted
        FROM inserted
        UNION ALL
        SELECT existing.id AS acknowledgement_id, existing.organization_id,
          existing.policy_key, existing.policy_version, false AS inserted
        FROM local801.user_policy_acknowledgements existing
        JOIN target
          ON target.organization_id = existing.organization_id
         AND target.user_id = existing.user_id
        JOIN required_policies
          ON required_policies.policy_key = existing.policy_key
         AND required_policies.policy_version = existing.policy_version
        WHERE NOT EXISTS (
          SELECT 1 FROM inserted
          WHERE inserted.policy_key = existing.policy_key
            AND inserted.policy_version = existing.policy_version
        )
      )
      SELECT acknowledgement_id::text, organization_id::text, policy_key, policy_version, inserted
      FROM accepted
      ORDER BY policy_key
      LIMIT 3
    `, [
      input.organizationSlug,
      input.userId,
      input.sessionVersion,
      ...REQUIRED_ACCESS_POLICY_PARAMETERS,
    ]);

    const expectedPolicies = new Set(REQUIRED_ACCESS_POLICIES.map((policy) => `${policy.key}:${policy.version}`));
    if (rows.length !== REQUIRED_ACCESS_POLICIES.length
      || rows.some((row) => !uuidPattern.test(row.acknowledgement_id)
        || !uuidPattern.test(row.organization_id)
        || typeof row.inserted !== "boolean"
        || !expectedPolicies.delete(`${row.policy_key}:${row.policy_version}`))
      || expectedPolicies.size !== 0) {
      throw new PolicyAcknowledgementError();
    }

    for (const row of rows) {
      if (row.inserted) {
        await audit({
          eventType: "policy.acknowledged",
          actorId: input.userId,
          organizationId: row.organization_id,
          subjectType: "policy_acknowledgement",
          subjectId: row.acknowledgement_id,
          payload: {
            policyKey: row.policy_key,
            policyVersion: row.policy_version,
          },
        }, query);
      }
    }

    return Object.freeze({
      acknowledgements: Object.freeze(rows.map((row) => Object.freeze({
        acknowledgementId: row.acknowledgement_id,
        newlyAcknowledged: row.inserted,
        policy: REQUIRED_ACCESS_POLICIES.find((policy) => policy.key === row.policy_key && policy.version === row.policy_version),
      }))),
      newlyAcknowledgedCount: rows.filter((row) => row.inserted).length,
    });
  });
}
