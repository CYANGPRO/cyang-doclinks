export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { sendHtmlEmail } from "@/lib/email";
import { readPreferredEnvText } from "@/lib/envConfig";
import { getPrivacyEmail, getSecurityEmail, getSupportEmail } from "@/lib/legal";
import { withRequestTelemetry } from "@/lib/perfTelemetry";
import { reportException } from "@/lib/observability";
import { getRouteTimeoutMs, isRouteTimeoutError, withRouteTimeout } from "@/lib/routeTimeout";
import { clientIpKey, enforceGlobalApiRateLimit, logSecurityEvent } from "@/lib/securityTelemetry";
import { INQUIRY_TOPIC_LABELS, normalizeInquiryTopic } from "@/lib/publicInquiry";

const MAX_BODY_BYTES = 12 * 1024;

const BodySchema = z.object({
  topic: z.string().min(1).max(64),
  source: z.enum(["contact", "procurement"]),
  name: z.string().min(2).max(120),
  email: z.string().email().max(320),
  company: z.string().min(2).max(160),
  message: z.string().min(24).max(4_000),
  sourcePage: z.string().min(1).max(220),
});

function parseJsonBodyLength(req: NextRequest): number {
  const raw = String(req.headers.get("content-length") || "").trim();
  const out = Number(raw);
  return Number.isFinite(out) ? Math.max(0, Math.floor(out)) : 0;
}

function getLegalEmail(): string {
  const raw = String(readPreferredEnvText("LEGAL_EMAIL") || "").trim().toLowerCase();
  if (!raw || /[\r\n\0]/.test(raw)) return "legal@cyang.io";
  return raw;
}

function esc(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function resolveRecipient(topic: NonNullable<ReturnType<typeof normalizeInquiryTopic>>): string {
  if (topic === "security_disclosure") return getSecurityEmail();
  if (topic === "privacy_legal" || topic === "procurement" || topic === "general") return getLegalEmail();
  return getSupportEmail();
}

export async function POST(req: NextRequest) {
  const timeoutMs = getRouteTimeoutMs("ROUTE_TIMEOUT_CONTACT_FORM_MS", 10_000);
  try {
    return await withRequestTelemetry(
      req,
      () =>
        withRouteTimeout(
          (async () => {
            if (parseJsonBodyLength(req) > MAX_BODY_BYTES) {
              return NextResponse.json({ ok: false, error: "PAYLOAD_TOO_LARGE" }, { status: 413 });
            }

            const rl = await enforceGlobalApiRateLimit({
              req,
              scope: "ip:public_contact_form",
              limit: Number(process.env.RATE_LIMIT_PUBLIC_CONTACT_PER_HOUR || 12),
              windowSeconds: 3600,
              strict: false,
            });
            if (!rl.ok) {
              return NextResponse.json(
                { ok: false, error: "RATE_LIMIT", message: "Too many contact attempts. Try again later." },
                { status: rl.status, headers: { "Retry-After": String(rl.retryAfterSeconds) } }
              );
            }

            const json = await req.json().catch(() => null);
            const parsed = BodySchema.safeParse(json);
            if (!parsed.success) {
              return NextResponse.json({ ok: false, error: "BAD_REQUEST", message: "Invalid request body." }, { status: 400 });
            }

            const topic = normalizeInquiryTopic(parsed.data.topic);
            if (!topic) {
              return NextResponse.json({ ok: false, error: "BAD_TOPIC", message: "Unknown request topic." }, { status: 400 });
            }

            const recipient = resolveRecipient(topic);
            const label = INQUIRY_TOPIC_LABELS[topic];
            const subject = `cyang.io ${label}: ${parsed.data.company}`;
            const text =
              `Topic: ${label}\n` +
              `Source: ${parsed.data.source}\n` +
              `Source page: ${parsed.data.sourcePage}\n` +
              `Name: ${parsed.data.name}\n` +
              `Email: ${parsed.data.email}\n` +
              `Company: ${parsed.data.company}\n\n` +
              `${parsed.data.message}\n`;
            const html = `
              <div style="font-family:Arial,sans-serif;line-height:1.6">
                <p><strong>Topic:</strong> ${esc(label)}</p>
                <p><strong>Source:</strong> ${esc(parsed.data.source)}</p>
                <p><strong>Source page:</strong> ${esc(parsed.data.sourcePage)}</p>
                <p><strong>Name:</strong> ${esc(parsed.data.name)}</p>
                <p><strong>Email:</strong> ${esc(parsed.data.email)}</p>
                <p><strong>Company:</strong> ${esc(parsed.data.company)}</p>
                <p><strong>Message:</strong></p>
                <p>${esc(parsed.data.message).replaceAll("\n", "<br />")}</p>
              </div>
            `;

            await sendHtmlEmail({
              to: recipient,
              subject,
              text,
              html,
              replyTo: parsed.data.email,
              tags: [
                { name: "channel", value: "public_contact" },
                { name: "topic", value: topic },
              ],
            });

            const { ip } = clientIpKey(req);
            await logSecurityEvent({
              type: "public_contact_request",
              severity: "low",
              ip,
              scope: `contact:${topic}`,
              message: `${parsed.data.name} from ${parsed.data.company}`,
              meta: {
                source: parsed.data.source,
                sourcePage: parsed.data.sourcePage,
                topic,
                recipient,
              },
            });

            return NextResponse.json({
              ok: true,
              message:
                topic === "procurement"
                  ? "Procurement request sent."
                  : topic === "security_disclosure"
                    ? "Security request sent."
                    : "Request sent.",
            });
          })(),
          timeoutMs
        ),
      { routeKey: "/api/contact" }
    );
  } catch (error: unknown) {
    if (isRouteTimeoutError(error)) {
      return NextResponse.json({ ok: false, error: "TIMEOUT", message: "Request timed out." }, { status: 504 });
    }
    await reportException({
      error,
      event: "public_contact_route_error",
      context: { route: "/api/contact" },
    });
    return NextResponse.json({ ok: false, error: "SERVER_ERROR", message: "Unable to send request right now." }, { status: 500 });
  }
}
