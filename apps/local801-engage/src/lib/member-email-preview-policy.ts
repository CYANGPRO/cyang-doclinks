import { previewAuthEnabled } from "./preview-auth-policy.ts";

export class MemberEmailPreviewPolicyError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 404) {
    super(message);
    this.name = "MemberEmailPreviewPolicyError";
    this.code = code;
    this.status = status;
  }
}

export function memberEmailPreviewEnabled(env: NodeJS.ProcessEnv = process.env) {
  if (env.VERCEL_ENV === "production" || env.LOCAL801_PRODUCTION_LAUNCH_ENABLED === "1") return false;
  return previewAuthEnabled(env) && env.LOCAL801_EMAIL_BROADCAST_PREVIEW_ENABLED === "1";
}

export function requireMemberEmailPreview(env: NodeJS.ProcessEnv = process.env) {
  if (!memberEmailPreviewEnabled(env)) {
    throw new MemberEmailPreviewPolicyError("NOT_FOUND", "Member email broadcasts are unavailable.");
  }
}

export function memberEmailDeliveryBoundary(env: NodeJS.ProcessEnv = process.env) {
  requireMemberEmailPreview(env);
  return Object.freeze({
    mode: "preview_simulation" as const,
    provider: null,
    outboundNetworkAllowed: false,
    webhookAllowed: false,
    recipientDomain: "example.test" as const,
  });
}

export function isSyntheticMemberEmail(value: string) {
  const at = value.lastIndexOf("@");
  return at > 0 && value.slice(at + 1).toLowerCase() === "example.test";
}

export function requireSyntheticMemberEmail(value: string) {
  if (!isSyntheticMemberEmail(value)) {
    throw new MemberEmailPreviewPolicyError(
      "NON_SYNTHETIC_RECIPIENT",
      "Preview email broadcasts are locked to synthetic example.test recipients.",
      409,
    );
  }
  return value;
}
