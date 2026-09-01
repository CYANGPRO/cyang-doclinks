import { createMemberEmailBroadcast } from "@/lib/member-email-broadcasts";
import {
  authorizeMemberEmailMutation,
  memberEmailFailure,
  memberEmailJson,
  readMemberEmailJson,
} from "@/lib/member-email-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  const authorized = await authorizeMemberEmailMutation(request);
  if ("response" in authorized) return authorized.response;
  try {
    const body = await readMemberEmailJson(request);
    const result = await createMemberEmailBroadcast(authorized.context, {
      subject: body.subject,
      body: body.body,
      audienceKey: body.audienceKey,
      scheduledFor: body.scheduledFor,
      attachmentHandles: body.attachmentHandles,
    });
    return memberEmailJson({ broadcast: "ok", ...result }, 201);
  } catch (error) {
    return memberEmailFailure(error);
  }
}
