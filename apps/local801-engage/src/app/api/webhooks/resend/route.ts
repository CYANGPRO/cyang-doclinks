import { applyResendWebhook } from "@/lib/member-email-production";
import { memberEmailFailure, memberEmailJson } from "@/lib/member-email-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_WEBHOOK_BYTES = 256 * 1024;

export async function POST(request: Request) {
  try {
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (declared > MAX_WEBHOOK_BYTES) return memberEmailJson({ error: "REQUEST_TOO_LARGE" }, 413);
    const rawBody = await request.text();
    if (Buffer.byteLength(rawBody, "utf8") > MAX_WEBHOOK_BYTES) return memberEmailJson({ error: "REQUEST_TOO_LARGE" }, 413);
    const id = request.headers.get("svix-id");
    const timestamp = request.headers.get("svix-timestamp");
    const signature = request.headers.get("svix-signature");
    if (!id || !timestamp || !signature) return memberEmailJson({ error: "INVALID_WEBHOOK_SIGNATURE" }, 401);
    await applyResendWebhook(rawBody, { id, timestamp, signature });
    return memberEmailJson({ received: true });
  } catch (error) {
    return memberEmailFailure(error);
  }
}
