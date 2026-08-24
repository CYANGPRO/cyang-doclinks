import "server-only";

import { createHash } from "node:crypto";
import type { CatActionManagementOptions } from "./cat-action-management.ts";
import type { CatActionTaskPage } from "./cat-actions.ts";
import { queryLocal801, type DatabaseQuery } from "./db.ts";
import {
  decryptPiiField,
  getPiiKeyConfiguration,
  type EncryptedPiiField,
  type PiiKeyConfiguration,
} from "./pii-protection.ts";
import {
  assertPiiProtectedReadState,
  getPiiProtectedReadMode,
  PiiProtectedReadError,
} from "./pii-protected-read.ts";

const PREVIEW_ROW_LIMIT = 500;
const HANDLE_RE = /^[0-9a-f]{64}$/i;

type ProtectedUserRow = {
  user_id: string;
  display_name_encrypted_payload: string;
  display_name_encryption_key_version: string;
  display_name_encryption_format_version: number;
};

type TaskAssignmentRow = {
  task_handle: string;
  user_id: string | null;
};

export type ProtectedCatActionDetailBundle = {
  tasks: CatActionTaskPage;
  options: CatActionManagementOptions;
};

function blocked(code: string, message: string): never {
  throw new PiiProtectedReadError(code, message);
}

function encrypted(
  row: Record<string, unknown>,
  payload: string,
  key: string,
  format: string,
): Pick<EncryptedPiiField, "encryptedPayload" | "encryptionKeyVersion" | "encryptionFormatVersion"> {
  const encryptedPayload = row[payload];
  const encryptionKeyVersion = row[key];
  const encryptionFormatVersion = Number(row[format]);
  if (typeof encryptedPayload !== "string" || typeof encryptionKeyVersion !== "string" || encryptionFormatVersion !== 1) {
    blocked("ENVELOPE_INVALID", "A protected PII companion has an invalid envelope.");
  }
  return { encryptedPayload, encryptionKeyVersion, encryptionFormatVersion: 1 };
}

function userHandle(organizationId: string, userId: string) {
  return createHash("sha256").update(`user:${organizationId}:${userId}`).digest("hex");
}

function uniqueMap<T>(rows: readonly T[], key: (row: T) => string, label: string) {
  const result = new Map<string, T>();
  for (const row of rows) {
    const id = key(row);
    if (result.has(id)) blocked("DUPLICATE_COMPANION", `Duplicate ${label} protected companion detected.`);
    result.set(id, row);
  }
  return result;
}

function decryptUserDisplayName(row: ProtectedUserRow, organizationId: string, keyConfig: PiiKeyConfiguration) {
  return decryptPiiField(
    encrypted(row as unknown as Record<string, unknown>, "display_name_encrypted_payload", "display_name_encryption_key_version", "display_name_encryption_format_version"),
    { organizationId, entity: "user", recordId: row.user_id, field: "display-name" },
    keyConfig,
  );
}

export async function hydrateCatActionDetailFromProtectedPii(
  organizationId: string,
  actionHandle: string,
  bundle: ProtectedCatActionDetailBundle,
  dependencies: { query?: DatabaseQuery; env?: NodeJS.ProcessEnv; keyConfig?: PiiKeyConfiguration } = {},
): Promise<ProtectedCatActionDetailBundle> {
  const env = dependencies.env ?? process.env;
  const mode = getPiiProtectedReadMode(env);
  if (mode === "legacy") return bundle;
  if (!HANDLE_RE.test(actionHandle)) blocked("ACTION_HANDLE_INVALID", "CAT action protected-read context is invalid.");
  const query = dependencies.query ?? queryLocal801;
  const keyConfig = dependencies.keyConfig ?? getPiiKeyConfiguration(env);
  await assertPiiProtectedReadState(organizationId, query, mode);

  const [users, assignments] = await Promise.all([
    query<ProtectedUserRow>(`
      /* pii-protected-cat-action-read:users */
      SELECT user_id::text,
        display_name_encrypted_payload, display_name_encryption_key_version, display_name_encryption_format_version
      FROM local801.user_pii
      WHERE organization_id = $1::uuid
      ORDER BY user_id
      LIMIT ${PREVIEW_ROW_LIMIT + 1}
    `, [organizationId]),
    query<TaskAssignmentRow>(`
      /* pii-protected-cat-action-read:task-assignees */
      WITH selected_action AS (
        SELECT action.id
        FROM local801.cat_actions action
        WHERE action.organization_id = $1::uuid
          AND action.archived_at IS NULL
          AND action.status <> 'archived'
          AND encode(public.digest('cat-action:' || action.organization_id::text || ':' || action.id::text, 'sha256'), 'hex') = $2::text
        LIMIT 1
      )
      SELECT
        encode(public.digest('cat-action-task:' || task.organization_id::text || ':' || task.id::text, 'sha256'), 'hex') AS task_handle,
        task.assigned_to::text AS user_id
      FROM local801.cat_action_tasks task
      JOIN selected_action action ON action.id = task.cat_action_id
      WHERE task.organization_id = $1::uuid
      ORDER BY task.id
      LIMIT ${PREVIEW_ROW_LIMIT + 1}
    `, [organizationId, actionHandle]),
  ]);

  if (users.length > PREVIEW_ROW_LIMIT || assignments.length > PREVIEW_ROW_LIMIT) {
    blocked("PREVIEW_BOUND_EXCEEDED", "Protected CAT Action read exceeded its bounded row limit.");
  }

  const usersById = uniqueMap(users, (row) => row.user_id, "user");
  const usersByHandle = uniqueMap(users, (row) => userHandle(organizationId, row.user_id), "user handle");
  const assignmentsByTaskHandle = uniqueMap(assignments, (row) => row.task_handle, "CAT action task assignment");

  const tasks: CatActionTaskPage = {
    ...bundle.tasks,
    tasks: bundle.tasks.tasks.map((task) => {
      if (!task.assigneeName) return task;
      const assignment = assignmentsByTaskHandle.get(task.handle);
      if (!assignment?.user_id) blocked("COMPANION_MISSING", "A CAT action task assignee is missing its protected user reference.");
      const protectedUser = usersById.get(assignment.user_id);
      if (!protectedUser) blocked("COMPANION_MISSING", "A CAT action task assignee is missing its protected PII companion.");
      return { ...task, assigneeName: decryptUserDisplayName(protectedUser, organizationId, keyConfig) };
    }),
  };

  const options: CatActionManagementOptions = {
    ...bundle.options,
    assignees: bundle.options.assignees.map((option) => {
      const protectedUser = usersByHandle.get(option.handle);
      if (!protectedUser) blocked("COMPANION_MISSING", "A CAT action assignment option is missing its protected PII companion.");
      return { ...option, label: decryptUserDisplayName(protectedUser, organizationId, keyConfig) };
    }),
  };

  return { tasks, options };
}
