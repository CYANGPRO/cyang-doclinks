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

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CAT_EMAIL_SENDER_DOMAIN = "cat.cyang.io";

function singleEmail(value: string | undefined, label: string) {
  const normalized = value?.trim() ?? "";
  if (!normalized || normalized.includes(",") || normalized.includes(";") || !EMAIL_RE.test(normalized)) {
    throw new MemberEmailPreviewPolicyError("REAL_TEST_CONFIG_INVALID", `${label} must contain exactly one valid email address.`, 503);
  }
  return normalized;
}

function senderEmail(value: string) {
  const match = value.match(/<([^<>]+)>\s*$/);
  return singleEmail(match?.[1] ?? value, "The Preview test sender");
}

export type MemberEmailRealTestBoundary = Readonly<{
  mode: "preview_single_recipient";
  provider: "resend";
  recipient: string;
  from: string;
  replyTo: string;
  apiKey: string;
  maxRecipients: 1;
  memberDeliveryAllowed: false;
  webhookAllowed: false;
}>;

export function memberEmailRealTestBoundary(env: NodeJS.ProcessEnv = process.env): MemberEmailRealTestBoundary {
  requireMemberEmailPreview(env);
  if (env.LOCAL801_EMAIL_BROADCAST_REAL_TEST_ENABLED !== "1") {
    throw new MemberEmailPreviewPolicyError("REAL_TEST_DISABLED", "The one-address Resend test is disabled.", 404);
  }
  const apiKey = env.RESEND_API_KEY?.trim();
  if (!apiKey) throw new MemberEmailPreviewPolicyError("REAL_TEST_CONFIG_INVALID", "The CAT Preview Resend credential is unavailable.", 503);
  const recipient = singleEmail(env.LOCAL801_EMAIL_BROADCAST_TEST_RECIPIENT, "The Preview test recipient");
  const from = env.LOCAL801_EMAIL_BROADCAST_FROM?.trim() ?? "";
  const replyTo = singleEmail(env.LOCAL801_EMAIL_BROADCAST_REPLY_TO, "The Preview Reply-To address");
  const fromEmail = senderEmail(from);
  if (fromEmail.slice(fromEmail.lastIndexOf("@") + 1).toLowerCase() !== CAT_EMAIL_SENDER_DOMAIN) {
    throw new MemberEmailPreviewPolicyError(
      "REAL_TEST_CONFIG_INVALID",
      `The Preview test sender must use the verified ${CAT_EMAIL_SENDER_DOMAIN} domain.`,
      503,
    );
  }
  return Object.freeze({
    mode: "preview_single_recipient",
    provider: "resend",
    recipient,
    from,
    replyTo,
    apiKey,
    maxRecipients: 1,
    memberDeliveryAllowed: false,
    webhookAllowed: false,
  });
}

export function memberEmailRealTestSummary(env: NodeJS.ProcessEnv = process.env) {
  try {
    const boundary = memberEmailRealTestBoundary(env);
    return Object.freeze({ enabled: true as const, recipient: boundary.recipient, from: boundary.from, replyTo: boundary.replyTo });
  } catch {
    return Object.freeze({ enabled: false as const, recipient: null, from: null, replyTo: null });
  }
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
