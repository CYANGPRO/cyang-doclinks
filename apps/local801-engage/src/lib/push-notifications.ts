import "server-only";

import { createHash, randomUUID } from "node:crypto";
import webPush, { type PushSubscription } from "web-push";
import { can } from "./access.ts";
import { buildSyntheticPiiBackfillPlan, type PiiBackfillSourceDataset } from "./pii-backfill.ts";
import { decryptPiiField, getPiiKeyConfiguration } from "./pii-protection.ts";
import { sendGenericNativePushToCurrentUser } from "./mobile-device-trust.ts";
import { queryLocal801, runLocal801Transaction, type DatabaseQuery, type DatabaseStatement } from "./db.ts";
import type { WorkspaceContext } from "./workspace-context.ts";

const MAX_ENDPOINT = 4096;
const KEY_RE = /^[A-Za-z0-9_-]{16,2048}$/;
type Dependencies = { query?: DatabaseQuery; transaction?: (statements: readonly DatabaseStatement[]) => Promise<void>; env?: NodeJS.ProcessEnv; id?: () => string };

export class PushNotificationError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) { super(message); this.name = "PushNotificationError"; this.code = code; this.status = status; }
}

function requireAccess(context: WorkspaceContext) {
  if (!can(context.role, "viewPersonalWorkspace")) throw new PushNotificationError("FORBIDDEN", "Push notification preferences are not authorized.", 403);
}

export function getPushConfiguration(env: NodeJS.ProcessEnv = process.env) {
  const enabled = env.LOCAL801_PUSH_ENABLED === "1";
  const publicKey = env.LOCAL801_VAPID_PUBLIC_KEY?.trim() ?? "";
  const privateKey = env.LOCAL801_VAPID_PRIVATE_KEY?.trim() ?? "";
  const subject = env.LOCAL801_VAPID_SUBJECT?.trim() ?? "";
  const publicKeyBytes = KEY_RE.test(publicKey) ? Buffer.from(publicKey, "base64url").length : 0;
  const privateKeyBytes = KEY_RE.test(privateKey) ? Buffer.from(privateKey, "base64url").length : 0;
  const valid = enabled && publicKeyBytes === 65 && privateKeyBytes === 32 && /^(mailto:[^\s@]+@[^\s@]+|https:\/\/[^\s]+)$/.test(subject)
    && !publicKey.startsWith("disabled-") && !privateKey.startsWith("disabled-");
  return { enabled: valid, publicKey: valid ? publicKey : "" , privateKey: valid ? privateKey : "", subject: valid ? subject : "" };
}

function parseSubscription(value: unknown): PushSubscription {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PushNotificationError("INVALID_SUBSCRIPTION", "The browser push subscription is invalid.", 400);
  const record = value as Record<string, unknown>;
  const keys = record.keys && typeof record.keys === "object" && !Array.isArray(record.keys) ? record.keys as Record<string, unknown> : null;
  if (typeof record.endpoint !== "string" || record.endpoint.length < 10 || record.endpoint.length > MAX_ENDPOINT
    || !/^https:\/\//.test(record.endpoint) || typeof keys?.p256dh !== "string" || typeof keys.auth !== "string"
    || !KEY_RE.test(keys.p256dh) || !KEY_RE.test(keys.auth)) {
    throw new PushNotificationError("INVALID_SUBSCRIPTION", "The browser push subscription is invalid.", 400);
  }
  return { endpoint: record.endpoint, expirationTime: typeof record.expirationTime === "number" ? record.expirationTime : null, keys: { p256dh: keys.p256dh, auth: keys.auth } };
}

function emptyDataset(pushSubscriptions: PiiBackfillSourceDataset["pushSubscriptions"]): PiiBackfillSourceDataset {
  return { users: [], authIdentities: [], people: [], identifiers: [], contacts: [], corrections: [], importFiles: [], importRows: [], pushSubscriptions };
}

function protectedPlan(id: string, context: WorkspaceContext, subscription: PushSubscription, env: NodeJS.ProcessEnv) {
  const plan = buildSyntheticPiiBackfillPlan(emptyDataset([{ id, organization_id: context.organizationId, subscription_json: subscription }]), getPiiKeyConfiguration(env));
  const protectedRow = plan.pushSubscriptions[0] as Record<string, unknown>;
  const index = plan.exactIndexes.find((item) => item.entityType === "push_subscription" && item.domain === "push:endpoint");
  if (!protectedRow || !index) throw new PushNotificationError("PROTECTION_FAILED", "The push subscription could not be protected.", 503);
  return { protectedRow, index };
}

export async function savePushSubscription(context: WorkspaceContext, subscriptionInput: unknown, dependencies: Dependencies = {}) {
  requireAccess(context);
  const subscription = parseSubscription(subscriptionInput);
  const env = dependencies.env ?? process.env;
  const protectedOnly = env.LOCAL801_DATABASE_PII_PROTECTION_ENABLED === "1";
  const protection = protectedOnly || env.LOCAL801_PII_DUAL_WRITE_ENABLED === "1";
  const candidateId = (dependencies.id ?? randomUUID)();
  const plan = protection ? protectedPlan(candidateId, context, subscription, env) : null;
  const endpointHash = protectedOnly && plan ? plan.index.hash : createHash("sha256").update(subscription.endpoint).digest("hex");
  const query = dependencies.query ?? queryLocal801;
  const [existing] = protectedOnly && plan ? await query<{ id: string }>(`
    SELECT subscription.id FROM local801.pii_exact_indexes exact_index
    JOIN local801.push_subscriptions subscription ON subscription.organization_id = exact_index.organization_id AND subscription.id = exact_index.entity_id
    WHERE exact_index.organization_id = $1::uuid AND exact_index.entity_type = 'push_subscription'
      AND exact_index.index_domain = 'push:endpoint' AND exact_index.index_key_version = $2 AND exact_index.index_hash = $3 LIMIT 1
  `, [context.organizationId, plan.index.keyVersion, plan.index.hash]) : await query<{ id: string }>(`SELECT id FROM local801.push_subscriptions WHERE organization_id = $1::uuid AND endpoint_hash = $2 LIMIT 1`, [context.organizationId, endpointHash]);
  const id = existing?.id ?? candidateId;
  const protectedValues = protection && id !== candidateId ? protectedPlan(id, context, subscription, env) : plan;
  const legacyPayload = protectedOnly ? { protected: true } : subscription;
  const actorPredicate = `EXISTS (SELECT 1 FROM local801.workspace_user_roles user_role JOIN local801.workspace_roles role ON role.id = user_role.role_id AND role.organization_id = $2::uuid WHERE user_role.user_id = actor.id AND role.code IN ('system_owner','local_admin','membership_data_manager','cat_admin','cat_lead','cat_member'))`;
  const statements: DatabaseStatement[] = [{ sql: existing ? `
    /* pii-protected-execution:legacy-placeholder push-subscription */
    WITH changed AS (
      UPDATE local801.push_subscriptions subscription SET user_id = actor.id, endpoint_hash = $4,
        subscription_json = $5::text::jsonb, disabled_at = NULL
      FROM local801.users actor
      WHERE subscription.id = $1::uuid AND subscription.organization_id = $2::uuid
        AND actor.organization_id = $2::uuid AND actor.id = $3::uuid AND actor.deactivated_at IS NULL
        AND ${actorPredicate}
      RETURNING subscription.id
    ) SELECT CASE WHEN count(*) = 1 THEN true ELSE 1 / count(*)::integer = 1 END FROM changed
  ` : `
    /* pii-protected-execution:legacy-placeholder push-subscription */
    WITH changed AS (
      INSERT INTO local801.push_subscriptions (id, organization_id, user_id, endpoint_hash, subscription_json, disabled_at)
      SELECT $1::uuid, $2::uuid, actor.id, $4, $5::text::jsonb, NULL FROM local801.users actor
      WHERE actor.organization_id = $2::uuid AND actor.id = $3::uuid AND actor.deactivated_at IS NULL
        AND ${actorPredicate}
      RETURNING id
    ) SELECT CASE WHEN count(*) = 1 THEN true ELSE 1 / count(*)::integer = 1 END FROM changed
  `, parameters: [id, context.organizationId, context.userId, endpointHash, JSON.stringify(legacyPayload)] }];
  if (protection && protectedValues) {
    const row = protectedValues.protectedRow;
    statements.push({ sql: `INSERT INTO local801.push_subscription_pii (organization_id, push_subscription_id, subscription_encrypted_payload, encryption_key_version, encryption_format_version, updated_at) VALUES ($1::uuid, $2::uuid, $3, $4, $5::integer, now()) ON CONFLICT (organization_id, push_subscription_id) DO UPDATE SET subscription_encrypted_payload = excluded.subscription_encrypted_payload, encryption_key_version = excluded.encryption_key_version, encryption_format_version = excluded.encryption_format_version, updated_at = now()`, parameters: [context.organizationId, id, row.encryptedPayload, row.encryptionKeyVersion, row.encryptionFormatVersion] });
    statements.push({ sql: `INSERT INTO local801.pii_exact_indexes (organization_id, entity_type, entity_id, index_domain, index_key_version, index_hash) VALUES ($1::uuid, 'push_subscription', $2::uuid, 'push:endpoint', $3, $4) ON CONFLICT (organization_id, entity_type, entity_id, index_domain, index_key_version) DO UPDATE SET index_hash = excluded.index_hash`, parameters: [context.organizationId, id, protectedValues.index.keyVersion, protectedValues.index.hash] });
  }
  await (dependencies.transaction ?? runLocal801Transaction)(statements);
  return { subscribed: true, subscriptionId: id } as const;
}

export async function disablePushSubscription(context: WorkspaceContext, subscriptionInput: unknown, dependencies: Dependencies = {}) {
  requireAccess(context); const subscription = parseSubscription(subscriptionInput); const env = dependencies.env ?? process.env;
  const protectedOnly = env.LOCAL801_DATABASE_PII_PROTECTION_ENABLED === "1";
  const query = dependencies.query ?? queryLocal801;
  const rows = protectedOnly ? await (() => {
    const index = protectedPlan(randomUUID(), context, subscription, env).index;
    return query<{ id: string }>(`UPDATE local801.push_subscriptions subscription SET disabled_at = now() FROM local801.pii_exact_indexes exact_index WHERE subscription.organization_id = $1::uuid AND subscription.user_id = $2::uuid AND subscription.disabled_at IS NULL AND exact_index.organization_id = subscription.organization_id AND exact_index.entity_type = 'push_subscription' AND exact_index.entity_id = subscription.id AND exact_index.index_domain = 'push:endpoint' AND exact_index.index_key_version = $3 AND exact_index.index_hash = $4 AND EXISTS (SELECT 1 FROM local801.workspace_user_roles user_role JOIN local801.workspace_roles role ON role.id = user_role.role_id AND role.organization_id = $1::uuid WHERE user_role.user_id = $2::uuid AND role.code IN ('system_owner','local_admin','membership_data_manager','cat_admin','cat_lead','cat_member')) RETURNING subscription.id`, [context.organizationId, context.userId, index.keyVersion, index.hash]);
  })() : await query<{ id: string }>(`UPDATE local801.push_subscriptions SET disabled_at = now() WHERE organization_id = $1::uuid AND user_id = $2::uuid AND endpoint_hash = $3 AND disabled_at IS NULL AND EXISTS (SELECT 1 FROM local801.workspace_user_roles user_role JOIN local801.workspace_roles role ON role.id = user_role.role_id AND role.organization_id = $1::uuid WHERE user_role.user_id = $2::uuid AND role.code IN ('system_owner','local_admin','membership_data_manager','cat_admin','cat_lead','cat_member')) RETURNING id`, [context.organizationId, context.userId, createHash("sha256").update(subscription.endpoint).digest("hex")]);
  return { disabled: rows.length === 1 } as const;
}

async function activeSubscriptions(context: WorkspaceContext, query: DatabaseQuery, env: NodeJS.ProcessEnv) {
  const protectedMode = env.LOCAL801_DATABASE_PII_PROTECTION_ENABLED === "1";
  const rows = await query<Record<string, unknown>>(`
    SELECT subscription.id, subscription.subscription_json,
      protected.subscription_encrypted_payload, protected.encryption_key_version, protected.encryption_format_version
    FROM local801.push_subscriptions subscription
    LEFT JOIN local801.push_subscription_pii protected ON protected.organization_id = subscription.organization_id AND protected.push_subscription_id = subscription.id
    WHERE subscription.organization_id = $1::uuid AND subscription.user_id = $2::uuid AND subscription.disabled_at IS NULL
    ORDER BY subscription.created_at DESC LIMIT 10
  `, [context.organizationId, context.userId]);
  const config = protectedMode ? getPiiKeyConfiguration(env) : null;
  return rows.map((row) => {
    if (!protectedMode) return { id: String(row.id), subscription: parseSubscription(row.subscription_json) };
    const serialized = decryptPiiField({ encryptedPayload: String(row.subscription_encrypted_payload), encryptionKeyVersion: String(row.encryption_key_version), encryptionFormatVersion: Number(row.encryption_format_version) as 1 }, { organizationId: context.organizationId, entity: "push-subscription", recordId: String(row.id), field: "subscription" }, config!);
    return { id: String(row.id), subscription: parseSubscription(JSON.parse(serialized)) };
  });
}

export async function sendGenericPushToCurrentUser(context: WorkspaceContext, dependencies: { query?: DatabaseQuery; env?: NodeJS.ProcessEnv } = {}) {
  requireAccess(context); const env = dependencies.env ?? process.env; const config = getPushConfiguration(env);
  if (!config.enabled) throw new PushNotificationError("PUSH_DISABLED", "Browser push is not configured for this deployment.", 409);
  webPush.setVapidDetails(config.subject, config.publicKey, config.privateKey);
  const subscriptions = await activeSubscriptions(context, dependencies.query ?? queryLocal801, env);
  let delivered = 0;
  for (const item of subscriptions) {
    try { await webPush.sendNotification(item.subscription); delivered += 1; }
    catch (error) {
      const status = error && typeof error === "object" ? (error as { statusCode?: unknown }).statusCode : null;
      if (status === 404 || status === 410) await (dependencies.query ?? queryLocal801)(`UPDATE local801.push_subscriptions SET disabled_at = now() WHERE organization_id = $1::uuid AND id = $2::uuid`, [context.organizationId, item.id]);
    }
  }
  return { delivered };
}

export async function dispatchGenericWorkPush(
  context: WorkspaceContext,
  digestInput: unknown,
  dependencies: { query?: DatabaseQuery; env?: NodeJS.ProcessEnv } = {},
) {
  requireAccess(context);
  if (typeof digestInput !== "string" || !/^[0-9a-f]{64}$/.test(digestInput)) {
    throw new PushNotificationError("INVALID_DIGEST", "The notification digest is invalid.", 400);
  }
  if (!getPushConfiguration(dependencies.env ?? process.env).enabled) {
    throw new PushNotificationError("PUSH_DISABLED", "Browser push is not configured for this deployment.", 409);
  }
  const query = dependencies.query ?? queryLocal801;
  const rows = await query<{ user_id: string }>(`
    /* push-notifications:deduplicated-work-dispatch */
    INSERT INTO local801.push_delivery_state
      (organization_id, user_id, last_work_digest, last_sent_at, updated_at)
    SELECT $1::uuid, actor.id, $3, now(), now()
    FROM local801.users actor
    WHERE actor.organization_id = $1::uuid AND actor.id = $2::uuid AND actor.deactivated_at IS NULL
      AND EXISTS (SELECT 1 FROM local801.workspace_user_roles user_role JOIN local801.workspace_roles role ON role.id = user_role.role_id AND role.organization_id = $1::uuid WHERE user_role.user_id = actor.id AND role.code IN ('system_owner','local_admin','membership_data_manager','cat_admin','cat_lead','cat_member'))
    ON CONFLICT (organization_id, user_id) DO UPDATE SET
      last_work_digest = excluded.last_work_digest, last_sent_at = now(), updated_at = now()
    WHERE push_delivery_state.last_work_digest <> excluded.last_work_digest
      AND push_delivery_state.last_sent_at <= now() - interval '15 minutes'
    RETURNING user_id
  `, [context.organizationId, context.userId, digestInput]);
  if (rows.length === 0) return { delivered: 0, deduplicated: true } as const;
  const [browser, native] = await Promise.all([
    sendGenericPushToCurrentUser(context, dependencies),
    sendGenericNativePushToCurrentUser(context, dependencies),
  ]);
  return { delivered: browser.delivered + native.delivered, browserDelivered: browser.delivered, nativeDelivered: native.delivered, deduplicated: false } as const;
}

export const __testing = { parseSubscription };
