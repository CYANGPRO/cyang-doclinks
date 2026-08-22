import "server-only";

export type SecuritySignalEvent =
  | "authorization.denied"
  | "rate_limit.denied"
  | "rate_limit.failure"
  | "scanner.failure"
  | "integrity.failure"
  | "protected_access"
  | "administrative_change"
  | "backup.failure";

const allowedMetadata = new Set([
  "outcome", "reason", "permission", "policy", "organizationId", "actorId", "subjectId",
  "component", "operation", "safeCode", "retryAfterSeconds", "status",
]);
const safeValue = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

export function buildSecuritySignal(event: SecuritySignalEvent, metadata: Record<string, unknown> = {}) {
  const safe: Record<string, string | number | boolean | null> = { event };
  for (const [key, value] of Object.entries(metadata)) {
    if (!allowedMetadata.has(key)) throw new Error("Security signal metadata key is not allowlisted.");
    if (value === null || typeof value === "boolean" || (typeof value === "number" && Number.isSafeInteger(value))) {
      safe[key] = value;
    } else if (typeof value === "string" && safeValue.test(value)) {
      safe[key] = value;
    } else {
      throw new Error("Security signal metadata value is unsafe.");
    }
  }
  return Object.freeze(safe);
}

export function writeSecuritySignal(level: "warn" | "error", event: SecuritySignalEvent, metadata: Record<string, unknown> = {}) {
  const serialized = JSON.stringify(buildSecuritySignal(event, metadata));
  if (level === "error") console.error("[local801-security]", serialized);
  else console.warn("[local801-security]", serialized);
}
