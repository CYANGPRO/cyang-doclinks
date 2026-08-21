import "server-only";

import {
  withLocal801Transaction,
  type DatabaseQuery,
  type DatabaseRow,
} from "./db.ts";
import { PROTECTED_IMPORT_APPLY_SQL } from "./pii-protected-import-apply.ts";

type BatchMeta = {
  import_kind: string;
  source_file_id: string;
  snapshot_date: string | null;
  effective_date: string | null;
};

type MutationMembership = {
  target_person_id: string;
  mutation_kind: string;
  imported_status: string | null;
};

type PriorMembership = {
  person_id: string;
  membership_status: string;
};

type CountRow = { event_count: number | string };

function uuid(value: unknown) {
  return typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value) ? value : null;
}

function expectedMembershipEvents(
  importKind: string,
  mutations: readonly MutationMembership[],
  priorByPerson: ReadonlyMap<string, string>,
) {
  if (importKind === "current_roster") {
    return mutations.filter((mutation) => mutation.mutation_kind === "existing"
      && ["member", "nonmember", "unknown"].includes(mutation.imported_status ?? "")
      && mutation.imported_status !== priorByPerson.get(mutation.target_person_id))
      .map((mutation) => mutation.target_person_id);
  }
  if (importKind === "membership_additions") {
    return mutations.filter((mutation) => mutation.mutation_kind === "new"
      || priorByPerson.get(mutation.target_person_id) !== "member")
      .map((mutation) => mutation.target_person_id);
  }
  if (importKind === "membership_drops") {
    return mutations.filter((mutation) => mutation.mutation_kind === "new"
      || priorByPerson.get(mutation.target_person_id) !== "nonmember")
      .map((mutation) => mutation.target_person_id);
  }
  return [];
}

function eventType(importKind: string) {
  if (importKind === "current_roster") return "correction";
  if (importKind === "membership_additions") return "addition";
  if (importKind === "membership_drops") return "drop";
  return null;
}

export const protectedImportMembershipTransaction: typeof withLocal801Transaction = async <T>(
  callback: (query: DatabaseQuery) => Promise<T>,
) => withLocal801Transaction(async (rawQuery) => {
  const decoratedQuery: DatabaseQuery = async <R extends DatabaseRow>(
    statement: string,
    parameters: readonly unknown[] = [],
  ) => {
    if (statement !== PROTECTED_IMPORT_APPLY_SQL) return rawQuery<R>(statement, parameters);

    const organizationId = uuid(parameters[0]);
    const batchId = uuid(parameters[1]);
    const executionSetId = uuid(parameters[2]);
    const actorUserId = uuid(parameters[3]);
    if (!organizationId || !batchId || !executionSetId || !actorUserId) {
      throw new Error("Protected import membership reconciliation received invalid execution parameters.");
    }

    const [meta] = await rawQuery<BatchMeta>(`
      /* pii-protected-execution:membership-meta */
      SELECT batch.import_kind, source.id::text AS source_file_id,
        plan.snapshot_date::text, plan.effective_date::text
      FROM local801.import_batches batch
      JOIN local801.import_files source
        ON source.organization_id = batch.organization_id AND source.import_batch_id = batch.id
      LEFT JOIN local801.import_approval_plans plan
        ON plan.organization_id = batch.organization_id AND plan.import_batch_id = batch.id
      WHERE batch.organization_id = $1::uuid AND batch.id = $2::uuid
      LIMIT 1
    `, [organizationId, batchId]);
    if (!meta) throw new Error("Protected import membership reconciliation could not resolve batch metadata.");

    const mutations = await rawQuery<MutationMembership>(`
      /* pii-protected-execution:membership-mutations */
      SELECT mutation.target_person_id::text, mutation.mutation_kind,
        mutation.operational_json ->> 'membership_status' AS imported_status
      FROM local801.protected_import_execution_mutations mutation
      WHERE mutation.organization_id = $1::uuid AND mutation.execution_set_id = $2::uuid
      ORDER BY mutation.target_person_id
    `, [organizationId, executionSetId]);

    const existingIds = mutations.filter((mutation) => mutation.mutation_kind === "existing")
      .map((mutation) => ({ person_id: mutation.target_person_id }));
    const priorRows = existingIds.length ? await rawQuery<PriorMembership>(`
      /* pii-protected-execution:lock-prior-membership */
      WITH requested AS (
        SELECT source.person_id::uuid AS person_id
        FROM jsonb_to_recordset($2::text::jsonb) AS source(person_id text)
      )
      SELECT person.id::text AS person_id, person.membership_status
      FROM requested
      JOIN local801.people person
        ON person.organization_id = $1::uuid AND person.id = requested.person_id
      ORDER BY person.id
      FOR UPDATE OF person
    `, [organizationId, JSON.stringify(existingIds)]) : [];
    if (priorRows.length !== existingIds.length) {
      throw new Error("Protected import membership reconciliation could not lock every existing target person.");
    }
    const priorByPerson = new Map(priorRows.map((row) => [row.person_id, row.membership_status]));
    const expectedIds = expectedMembershipEvents(meta.import_kind, mutations, priorByPerson);
    const expectedJson = JSON.stringify(expectedIds);
    const type = eventType(meta.import_kind);
    const effectiveDate = meta.import_kind === "current_roster" ? meta.snapshot_date : meta.effective_date;

    const result = await rawQuery<R>(statement, parameters);

    if (type && effectiveDate) {
      await rawQuery(`
        /* pii-protected-execution:remove-noop-membership-events */
        DELETE FROM local801.membership_events event
        WHERE event.organization_id = $1::uuid
          AND event.source_import_file_id = $2::uuid
          AND event.created_by = $3::uuid
          AND event.event_type = $4::text
          AND event.effective_date = $5::date
          AND event.created_at = transaction_timestamp()
          AND NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements_text($6::text::jsonb) expected(person_id)
            WHERE expected.person_id::uuid = event.person_id
          )
      `, [organizationId, meta.source_file_id, actorUserId, type, effectiveDate, expectedJson]);
      const [count] = await rawQuery<CountRow>(`
        SELECT count(*)::int AS event_count
        FROM local801.membership_events event
        WHERE event.organization_id = $1::uuid
          AND event.source_import_file_id = $2::uuid
          AND event.created_by = $3::uuid
          AND event.event_type = $4::text
          AND event.effective_date = $5::date
          AND event.created_at = transaction_timestamp()
      `, [organizationId, meta.source_file_id, actorUserId, type, effectiveDate]);
      if (Number(count?.event_count ?? -1) !== expectedIds.length) {
        throw new Error("Protected import membership-event reconciliation failed atomically.");
      }
    } else if (expectedIds.length !== 0) {
      throw new Error("Protected import membership-event plan is inconsistent with the import kind.");
    }

    return result;
  };

  return callback(decoratedQuery);
});

export const __testing = { expectedMembershipEvents, eventType };
