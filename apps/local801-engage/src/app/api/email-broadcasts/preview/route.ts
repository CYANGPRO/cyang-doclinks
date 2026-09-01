import { previewMemberEmailAudience } from "@/lib/member-email-broadcasts";
import { authorizeMemberEmailMutation, memberEmailFailure, memberEmailJson, readMemberEmailJson } from "@/lib/member-email-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  const authorized = await authorizeMemberEmailMutation(request);
  if ("response" in authorized) return authorized.response;
  try {
    const body = await readMemberEmailJson(request);
    const audience = await previewMemberEmailAudience(authorized.context, {}, body.audienceKey);
    return memberEmailJson({ preview: "ok", audience });
  } catch (error) {
    return memberEmailFailure(error);
  }
}
