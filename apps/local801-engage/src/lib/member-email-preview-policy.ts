import { previewAuthEnabled } from "./preview-auth-policy.ts";
import { getProductionLaunchState } from "./production-launch-policy.ts";

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

export function memberEmailProductionEnabled(env: NodeJS.ProcessEnv = process.env) {
  return getProductionLaunchState(env).ready
    && env.LOCAL801_EMAIL_BROADCAST_PRODUCTION_ENABLED === "1";
}

export function memberEmailRuntimeEnabled(env: NodeJS.ProcessEnv = process.env) {
  return memberEmailPreviewEnabled(env) || memberEmailProductionEnabled(env);
}

export function requireMemberEmailRuntime(env: NodeJS.ProcessEnv = process.env) {
  if (!memberEmailRuntimeEnabled(env)) {
    throw new MemberEmailPreviewPolicyError("NOT_FOUND", "Member email broadcasts are unavailable.");
  }
}

export function memberEmailRuntimeMode(env: NodeJS.ProcessEnv = process.env) {
  requireMemberEmailRuntime(env);
  return memberEmailProductionEnabled(env) ? "production" as const : "preview" as const;
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

export type MemberEmailProductionBoundary = Readonly<{
  mode: "production_member_notice";
  provider: "resend";
  from: string;
  replyTo: string;
  apiKey: string;
  webhookSecret: string;
  maxRecipients: 1000;
  memberDeliveryAllowed: true;
  webhookAllowed: true;
}>;

export function memberEmailProductionBoundary(env: NodeJS.ProcessEnv = process.env): MemberEmailProductionBoundary {
  if (!memberEmailProductionEnabled(env)) {
    throw new MemberEmailPreviewPolicyError("PRODUCTION_EMAIL_DISABLED", "Production member notices are disabled.", 404);
  }
  const apiKey = env.LOCAL801_RESEND_API_KEY?.trim();
  const webhookSecret = env.LOCAL801_RESEND_WEBHOOK_SECRET?.trim();
  if (!apiKey?.startsWith("re_") || !webhookSecret?.startsWith("whsec_")) {
    throw new MemberEmailPreviewPolicyError("PRODUCTION_EMAIL_CONFIG_INVALID", "The independent CAT Production email credentials are unavailable.", 503);
  }
  const from = env.LOCAL801_EMAIL_BROADCAST_FROM?.trim() ?? "";
  const replyTo = singleEmail(env.LOCAL801_EMAIL_BROADCAST_REPLY_TO, "The Production Reply-To address");
  const fromEmail = senderEmail(from);
  if (fromEmail.slice(fromEmail.lastIndexOf("@") + 1).toLowerCase() !== CAT_EMAIL_SENDER_DOMAIN) {
    throw new MemberEmailPreviewPolicyError("PRODUCTION_EMAIL_CONFIG_INVALID", `The Production sender must use ${CAT_EMAIL_SENDER_DOMAIN}.`, 503);
  }
  return Object.freeze({
    mode: "production_member_notice",
    provider: "resend",
    from,
    replyTo,
    apiKey,
    webhookSecret,
    maxRecipients: 1000,
    memberDeliveryAllowed: true,
    webhookAllowed: true,
  });
}

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

export function memberEmailRuntimeSummary(env: NodeJS.ProcessEnv = process.env) {
  if (memberEmailProductionEnabled(env)) {
    try {
      const boundary = memberEmailProductionBoundary(env);
      return Object.freeze({ mode: "production" as const, providerReady: true, from: boundary.from, replyTo: boundary.replyTo, recipient: null });
    } catch {
      return Object.freeze({ mode: "production" as const, providerReady: false, from: null, replyTo: null, recipient: null });
    }
  }
  const preview = memberEmailRealTestSummary(env);
  return Object.freeze({ mode: "preview" as const, providerReady: preview.enabled, from: preview.from, replyTo: preview.replyTo, recipient: preview.recipient });
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
