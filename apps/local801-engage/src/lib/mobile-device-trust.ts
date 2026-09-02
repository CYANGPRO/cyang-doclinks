import "server-only";

import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { can } from "./access.ts";
import { prepareAtomicAuditStatement } from "./audit.ts";
import { queryLocal801, withLocal801Transaction, type DatabaseQuery } from "./db.ts";
import { decryptPiiField, encryptPiiField, getPiiKeyConfiguration } from "./pii-protection.ts";
import type { WorkspaceContext } from "./workspace-context.ts";

const handlePattern = /^[0-9a-f]{64}$/;
const evidencePattern = /^[A-Za-z0-9+/=._-]{32,65536}$/;
const keyIdPattern = /^[A-Za-z0-9+/=_-]{16,512}$/;
const tokenPattern = /^[A-Za-z0-9:._-]{16,8192}$/;
const teamIdPattern = /^[A-Z0-9]{10}$/;
const projectNumberPattern = /^[0-9]{6,20}$/;
const secretPattern = /^[0-9a-f]{64}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const challengeLifetimeMs = 5 * 60_000;

export type MobilePlatform = "ios" | "android";
export type MobileIntegrityLevel = "app_attested" | "device_integrity" | "strong_integrity";

export class MobileDeviceError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message); this.name = "MobileDeviceError"; this.code = code; this.status = status;
  }
}

function canonicalGateway(value: string | undefined, hostname: string) {
  try {
    const url = new URL(value ?? "");
    return url.protocol === "https:" && !url.username && !url.password && !url.port
      && (url.pathname === "" || url.pathname === "/") && !url.search && !url.hash
      && url.hostname.toLowerCase() === hostname ? url.origin : null;
  } catch { return null; }
}

export function getMobileDeviceConfiguration(env: NodeJS.ProcessEnv = process.env) {
  const attestationGateway = canonicalGateway(env.LOCAL801_MOBILE_ATTESTATION_GATEWAY_URL, "attest.cyang.io");
  const pushGateway = canonicalGateway(env.LOCAL801_MOBILE_PUSH_GATEWAY_URL, "push.cyang.io");
  const attestationSecret = env.LOCAL801_MOBILE_ATTESTATION_HMAC_SECRET_HEX?.trim() ?? "";
  const pushSecret = env.LOCAL801_MOBILE_PUSH_HMAC_SECRET_HEX?.trim() ?? "";
  const appleTeamId = env.LOCAL801_APPLE_TEAM_ID?.trim() ?? "";
  const androidCloudProjectNumber = env.LOCAL801_ANDROID_CLOUD_PROJECT_NUMBER?.trim() ?? "";
  const enabled = env.LOCAL801_NATIVE_MOBILE_ENABLED === "1" && Boolean(attestationGateway && pushGateway)
    && secretPattern.test(attestationSecret) && secretPattern.test(pushSecret)
    && teamIdPattern.test(appleTeamId) && projectNumberPattern.test(androidCloudProjectNumber);
  return Object.freeze({
    enabled,
    attestationGateway: enabled ? attestationGateway! : "",
    pushGateway: enabled ? pushGateway! : "",
    attestationSecret: enabled ? attestationSecret : "",
    pushSecret: enabled ? pushSecret : "",
    appleAppId: enabled ? `${appleTeamId}.io.cyang.local801engage` : "",
    androidPackageName: "io.cyang.local801.engage",
    androidCloudProjectNumber: enabled ? androidCloudProjectNumber : "",
  });
}

function requireMobileAccess(context: WorkspaceContext) {
  if (!can(context.role, "viewPersonalWorkspace")) throw new MobileDeviceError("FORBIDDEN", "Native mobile access is not authorized.", 403);
}

function normalizePlatform(value: unknown): MobilePlatform {
  if (value !== "ios" && value !== "android") throw new MobileDeviceError("INVALID_PLATFORM", "The mobile platform is invalid.", 400);
  return value;
}

function sha256Hex(value: string) { return createHash("sha256").update(value, "utf8").digest("hex"); }
function deviceHandle(organizationId: string, id: string) { return sha256Hex(`local801-mobile-device:${organizationId}:${id}`); }
function signature(secret: string, timestamp: string, body: string) {
  return createHmac("sha256", Buffer.from(secret, "hex")).update(`${timestamp}.${body}`, "utf8").digest("hex");
}

type Transaction = <T>(callback: (query: DatabaseQuery) => Promise<T>) => Promise<T>;
type VerifierResult = Readonly<{ valid: boolean; deviceKey: string; integrityLevel: MobileIntegrityLevel }>;
type Dependencies = Readonly<{
  query?: DatabaseQuery;
  transaction?: Transaction;
  verify?: (input: Record<string, unknown>, env: NodeJS.ProcessEnv) => Promise<VerifierResult>;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  id?: () => string;
  challenge?: () => Buffer;
}>;

async function callAttestationGateway(input: Record<string, unknown>, env: NodeJS.ProcessEnv) {
  const config = getMobileDeviceConfiguration(env);
  if (!config.enabled) throw new MobileDeviceError("MOBILE_DISABLED", "Native device verification is not configured for this deployment.", 409);
  const body = JSON.stringify(input);
  const timestamp = String(Date.now());
  const response = await fetch(`${config.attestationGateway}/v1/verify`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Local801-Timestamp": timestamp,
      "X-Local801-Signature": signature(config.attestationSecret, timestamp, body),
    },
    body,
    cache: "no-store",
    signal: AbortSignal.timeout(8_000),
  });
  const value = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok || !value || value.valid !== true || typeof value.deviceKey !== "string"
    || !keyIdPattern.test(value.deviceKey) || !new Set(["app_attested", "device_integrity", "strong_integrity"]).has(String(value.integrityLevel))) {
    throw new MobileDeviceError("ATTESTATION_REJECTED", "This application or device could not be verified.", 403);
  }
  return { valid: true, deviceKey: value.deviceKey, integrityLevel: value.integrityLevel as MobileIntegrityLevel };
}

export async function issueMobileAttestationChallenge(context: WorkspaceContext, dependencies: Dependencies = {}) {
  requireMobileAccess(context);
  const env = dependencies.env ?? process.env;
  const config = getMobileDeviceConfiguration(env);
  if (!config.enabled) throw new MobileDeviceError("MOBILE_DISABLED", "Native device verification is not configured for this deployment.", 409);
  const raw = (dependencies.challenge ?? (() => randomBytes(32)))();
  if (raw.length !== 32) throw new MobileDeviceError("CHALLENGE_INVALID", "A secure device challenge could not be created.", 503);
  const challenge = raw.toString("base64url"); raw.fill(0);
  const id = (dependencies.id ?? randomUUID)();
  const now = (dependencies.now ?? (() => new Date()))();
  const expiresAt = new Date(now.getTime() + challengeLifetimeMs).toISOString();
  const query = dependencies.query ?? queryLocal801;
  const rows = await query<{ id: string }>(`
    INSERT INTO local801.mobile_attestation_challenges
      (id, organization_id, user_id, purpose, challenge_hash, expires_at)
    SELECT $1::uuid, $2::uuid, actor.id, 'device_registration', $4, $5::timestamptz
    FROM local801.users actor
    WHERE actor.organization_id = $2::uuid AND actor.id = $3::uuid AND actor.deactivated_at IS NULL
      AND EXISTS (SELECT 1 FROM local801.workspace_user_roles user_role JOIN local801.workspace_roles role
        ON role.id = user_role.role_id AND role.organization_id = $2::uuid
        WHERE user_role.user_id = actor.id AND role.code IN
          ('system_owner','local_admin','membership_data_manager','cat_admin','cat_lead','cat_member'))
    RETURNING id
  `, [id, context.organizationId, context.userId, sha256Hex(challenge), expiresAt]);
  if (rows.length !== 1) throw new MobileDeviceError("FORBIDDEN", "Native device verification is not authorized.", 403);
  return { challengeHandle: id, challenge, expiresAt, androidCloudProjectNumber: config.androidCloudProjectNumber } as const;
}

export async function registerAttestedMobileDevice(
  context: WorkspaceContext,
  input: { challengeHandle?: unknown; challenge?: unknown; platform?: unknown; evidence?: unknown; keyId?: unknown; evidenceKind?: unknown },
  dependencies: Dependencies = {},
) {
  requireMobileAccess(context);
  const env = dependencies.env ?? process.env;
  const challengeHandle = typeof input.challengeHandle === "string" && uuidPattern.test(input.challengeHandle) ? input.challengeHandle : null;
  const challenge = typeof input.challenge === "string" && /^[A-Za-z0-9_-]{43}$/.test(input.challenge) ? input.challenge : null;
  const evidence = typeof input.evidence === "string" && evidencePattern.test(input.evidence) ? input.evidence : null;
  const keyId = typeof input.keyId === "string" && keyIdPattern.test(input.keyId) ? input.keyId : null;
  const evidenceKind = input.evidenceKind === "app_attest" || input.evidenceKind === "app_assertion" || input.evidenceKind === "play_integrity"
    ? input.evidenceKind : null;
  const platform = normalizePlatform(input.platform);
  if (!challengeHandle || !challenge || !evidence || !keyId || !evidenceKind
    || (platform === "android" && evidenceKind !== "play_integrity")
    || (platform === "ios" && evidenceKind === "play_integrity")) {
    throw new MobileDeviceError("INVALID_ATTESTATION", "The native device evidence is invalid.", 400);
  }

  const verifier = dependencies.verify ?? callAttestationGateway;
  const verified = await verifier({
    platform, evidence, evidenceKind, keyId, challenge,
    expectedAppleAppId: getMobileDeviceConfiguration(env).appleAppId,
    expectedAndroidPackageName: "io.cyang.local801.engage",
    expectedAndroidCloudProjectNumber: getMobileDeviceConfiguration(env).androidCloudProjectNumber,
  }, env);
  if (!verified.valid || !keyIdPattern.test(verified.deviceKey)) throw new MobileDeviceError("ATTESTATION_REJECTED", "This application or device could not be verified.", 403);
  const deviceKeyHash = sha256Hex(`${platform}:${verified.deviceKey}`);
  const id = (dependencies.id ?? randomUUID)();
  const transaction = dependencies.transaction ?? withLocal801Transaction;
  const result = await transaction(async (query) => {
    const challenges = await query<{ id: string }>(`
      SELECT id FROM local801.mobile_attestation_challenges
      WHERE id = $1::uuid AND organization_id = $2::uuid AND user_id = $3::uuid
        AND purpose = 'device_registration' AND challenge_hash = $4
        AND used_at IS NULL AND expires_at > now()
      FOR UPDATE
    `, [challengeHandle, context.organizationId, context.userId, sha256Hex(challenge)]);
    if (challenges.length !== 1) throw new MobileDeviceError("CHALLENGE_STALE", "This device-verification request expired or was already used.", 409);
    await query(`UPDATE local801.mobile_attestation_challenges SET used_at = now() WHERE id = $1::uuid AND organization_id = $2::uuid`, [challengeHandle, context.organizationId]);
    const rows = await query<{ id: string }>(`
      INSERT INTO local801.mobile_devices
        (id, organization_id, user_id, platform, device_key_hash, integrity_level)
      VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6)
      ON CONFLICT (organization_id, user_id, platform, device_key_hash) WHERE disabled_at IS NULL
      DO UPDATE SET integrity_level = excluded.integrity_level, attested_at = now(), last_seen_at = now(), updated_at = now()
      RETURNING id
    `, [id, context.organizationId, context.userId, platform, deviceKeyHash, verified.integrityLevel]);
    if (rows.length !== 1) throw new MobileDeviceError("ATTESTATION_FAILED", "The verified mobile device could not be registered.", 503);
    const audit = await prepareAtomicAuditStatement({
      eventType: "session.mobile_device_attested", actorId: context.userId, organizationId: context.organizationId,
      subjectType: "mobile_device", subjectId: rows[0].id,
      payload: { platform, integrityLevel: verified.integrityLevel },
    }, query);
    await query(audit.sql, audit.parameters);
    return { deviceId: rows[0].id };
  });
  return { deviceHandle: deviceHandle(context.organizationId, result.deviceId), platform, integrityLevel: verified.integrityLevel } as const;
}

export async function saveNativePushToken(
  context: WorkspaceContext,
  input: { deviceHandle?: unknown; platform?: unknown; token?: unknown },
  dependencies: Dependencies = {},
) {
  requireMobileAccess(context);
  const platform = normalizePlatform(input.platform);
  const handle = typeof input.deviceHandle === "string" && handlePattern.test(input.deviceHandle) ? input.deviceHandle : null;
  const token = typeof input.token === "string" && tokenPattern.test(input.token) ? input.token : null;
  if (!handle || !token) throw new MobileDeviceError("INVALID_PUSH_TOKEN", "The native notification registration is invalid.", 400);
  const query = dependencies.query ?? queryLocal801;
  const [device] = await query<{ id: string }>(`
    SELECT id FROM local801.mobile_devices
    WHERE organization_id = $1::uuid AND user_id = $2::uuid AND platform = $3 AND disabled_at IS NULL
      AND encode(public.digest('local801-mobile-device:' || organization_id::text || ':' || id::text, 'sha256'), 'hex') = $4
    LIMIT 1
  `, [context.organizationId, context.userId, platform, handle]);
  if (!device) throw new MobileDeviceError("DEVICE_NOT_FOUND", "Verify this mobile application before enabling native notifications.", 409);
  const encrypted = encryptPiiField(token, { organizationId: context.organizationId, entity: "mobile-device", recordId: device.id, field: "push-token" }, getPiiKeyConfiguration(dependencies.env ?? process.env));
  const transaction = dependencies.transaction ?? withLocal801Transaction;
  await transaction(async (transactionQuery) => {
    const rows = await transactionQuery<{ id: string }>(`
      UPDATE local801.mobile_devices device SET
        push_token_encrypted_payload = $4, push_token_key_version = $5,
        push_token_format_version = $6::integer, push_token_updated_at = now(),
        last_seen_at = now(), updated_at = now()
      WHERE device.organization_id = $1::uuid AND device.user_id = $2::uuid AND device.id = $3::uuid
        AND device.disabled_at IS NULL
        AND EXISTS (SELECT 1 FROM local801.workspace_user_roles user_role JOIN local801.workspace_roles role
          ON role.id = user_role.role_id AND role.organization_id = $1::uuid
          WHERE user_role.user_id = $2::uuid AND role.code IN
            ('system_owner','local_admin','membership_data_manager','cat_admin','cat_lead','cat_member'))
      RETURNING device.id
    `, [context.organizationId, context.userId, device.id, encrypted.encryptedPayload, encrypted.encryptionKeyVersion, encrypted.encryptionFormatVersion]);
    if (rows.length !== 1) throw new MobileDeviceError("FORBIDDEN", "Native notification registration is not authorized.", 403);
    const audit = await prepareAtomicAuditStatement({
      eventType: "session.mobile_push_registered", actorId: context.userId, organizationId: context.organizationId,
      subjectType: "mobile_device", subjectId: device.id, payload: { platform },
    }, transactionQuery);
    await transactionQuery(audit.sql, audit.parameters);
  });
  return { registered: true } as const;
}

export async function sendGenericNativePushToCurrentUser(
  context: WorkspaceContext,
  dependencies: Pick<Dependencies, "query" | "env"> = {},
) {
  requireMobileAccess(context);
  const env = dependencies.env ?? process.env;
  const config = getMobileDeviceConfiguration(env);
  if (!config.enabled) return { delivered: 0 };
  const query = dependencies.query ?? queryLocal801;
  const rows = await query<{ id: string; platform: MobilePlatform; push_token_encrypted_payload: string; push_token_key_version: string; push_token_format_version: number }>(`
    SELECT id, platform, push_token_encrypted_payload, push_token_key_version, push_token_format_version
    FROM local801.mobile_devices
    WHERE organization_id = $1::uuid AND user_id = $2::uuid AND disabled_at IS NULL
      AND push_token_encrypted_payload IS NOT NULL
    ORDER BY last_seen_at DESC LIMIT 5
  `, [context.organizationId, context.userId]);
  const pii = getPiiKeyConfiguration(env);
  let delivered = 0;
  for (const row of rows) {
    const token = decryptPiiField({ encryptedPayload: row.push_token_encrypted_payload, encryptionKeyVersion: row.push_token_key_version, encryptionFormatVersion: row.push_token_format_version as 1 }, { organizationId: context.organizationId, entity: "mobile-device", recordId: row.id, field: "push-token" }, pii);
    const body = JSON.stringify({ platform: row.platform, token, category: "LOCAL801_GENERIC_WORK", route: "/notifications" });
    const timestamp = String(Date.now());
    try {
      const response = await fetch(`${config.pushGateway}/v1/send`, { method: "POST", headers: { "Content-Type": "application/json", "X-Local801-Timestamp": timestamp, "X-Local801-Signature": signature(config.pushSecret, timestamp, body) }, body, cache: "no-store", signal: AbortSignal.timeout(8_000) });
      const result = await response.json().catch(() => null) as { accepted?: unknown; invalidToken?: unknown } | null;
      if (response.ok && result?.accepted === true) delivered += 1;
      else if (result?.invalidToken === true) await query(`UPDATE local801.mobile_devices SET disabled_at = now(), updated_at = now() WHERE organization_id = $1::uuid AND id = $2::uuid`, [context.organizationId, row.id]);
    } catch { /* Delivery is best-effort; browser/in-app work remains authoritative. */ }
  }
  return { delivered };
}

export const __testing = { canonicalGateway, deviceHandle, sha256Hex, signature };
