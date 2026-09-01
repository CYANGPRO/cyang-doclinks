import { createMemberEmailTemplate } from "@/lib/member-email-broadcasts";
import { authorizeMemberEmailMutation, memberEmailFailure, memberEmailJson, readMemberEmailJson } from "@/lib/member-email-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  const authorized = await authorizeMemberEmailMutation(request);
  if ("response" in authorized) return authorized.response;
  try {
    const body = await readMemberEmailJson(request);
    const template = await createMemberEmailTemplate(authorized.context, {
      name: body.name,
      subject: body.subject,
      body: body.body,
    });
    return memberEmailJson({ template: "ok", ...template }, 201);
  } catch (error) {
    return memberEmailFailure(error);
  }
}
