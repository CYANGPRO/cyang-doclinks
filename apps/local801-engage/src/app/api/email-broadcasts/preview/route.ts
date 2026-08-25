import { previewMemberEmailAudience } from "@/lib/member-email-broadcasts";
import { authorizeMemberEmailMutation, memberEmailFailure, memberEmailJson } from "@/lib/member-email-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  const authorized = await authorizeMemberEmailMutation(request);
  if ("response" in authorized) return authorized.response;
  try {
    const audience = await previewMemberEmailAudience(authorized.context);
    return memberEmailJson({ preview: "ok", audience });
  } catch (error) {
    return memberEmailFailure(error);
  }
}
