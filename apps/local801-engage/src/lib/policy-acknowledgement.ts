import "server-only";

import { writeAuditEvent } from "./audit.ts";
import { withLocal801Transaction, type DatabaseQuery } from "./db.ts";
import { CURRENT_ACCESS_POLICY } from "./policy-contract.ts";

type PolicyAcknowledgementInput = Readonly<{
  organizationSlug: string;
  userId: string;
  sessionVersion: number;
}>;

type PolicyAcknowledgementRow = {
  acknowledgement_id: string;
  organization_id: string;
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

export async function acceptCurrentAccessPolicy(
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
      /* policy-acknowledgement:accept-current */
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
      ), inserted AS (
        INSERT INTO local801.user_policy_acknowledgements
          (organization_id, user_id, policy_key, policy_version)
        SELECT target.organization_id, target.user_id, $4::text, $5::text
        FROM target
        ON CONFLICT (organization_id, user_id, policy_key, policy_version) DO NOTHING
        RETURNING id, organization_id
      ), accepted AS (
        SELECT inserted.id AS acknowledgement_id, inserted.organization_id, true AS inserted
        FROM inserted
        UNION ALL
        SELECT existing.id AS acknowledgement_id, existing.organization_id, false AS inserted
        FROM local801.user_policy_acknowledgements existing
        JOIN target
          ON target.organization_id = existing.organization_id
         AND target.user_id = existing.user_id
        WHERE existing.policy_key = $4::text
          AND existing.policy_version = $5::text
          AND NOT EXISTS (SELECT 1 FROM inserted)
      )
      SELECT acknowledgement_id::text, organization_id::text, inserted
      FROM accepted
      LIMIT 2
    `, [
      input.organizationSlug,
      input.userId,
      input.sessionVersion,
      CURRENT_ACCESS_POLICY.key,
      CURRENT_ACCESS_POLICY.version,
    ]);

    const row = rows.length === 1 ? rows[0] : undefined;
    if (!row
      || !uuidPattern.test(row.acknowledgement_id)
      || !uuidPattern.test(row.organization_id)
      || typeof row.inserted !== "boolean") {
      throw new PolicyAcknowledgementError();
    }

    if (row.inserted) {
      await audit({
        eventType: "policy.acknowledged",
        actorId: input.userId,
        organizationId: row.organization_id,
        subjectType: "policy_acknowledgement",
        subjectId: row.acknowledgement_id,
        payload: {
          policyKey: CURRENT_ACCESS_POLICY.key,
          policyVersion: CURRENT_ACCESS_POLICY.version,
        },
      }, query);
    }

    return Object.freeze({
      acknowledgementId: row.acknowledgement_id,
      newlyAcknowledged: row.inserted,
      policy: CURRENT_ACCESS_POLICY,
    });
  });
}
