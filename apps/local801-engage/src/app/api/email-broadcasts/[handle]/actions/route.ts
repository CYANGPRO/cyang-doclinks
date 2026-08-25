import {
  approveMemberEmailBroadcast,
  simulateMemberEmailSend,
  simulateMemberEmailTest,
  submitMemberEmailBroadcast,
} from "@/lib/member-email-broadcasts";
import {
  authorizeMemberEmailMutation,
  memberEmailFailure,
  memberEmailJson,
  readMemberEmailJson,
} from "@/lib/member-email-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RouteContext = { params: Promise<{ handle: string }> };

export async function POST(request: Request, { params }: RouteContext) {
  const authorized = await authorizeMemberEmailMutation(request);
  if ("response" in authorized) return authorized.response;
  try {
    const [{ handle }, body] = await Promise.all([params, readMemberEmailJson(request)]);
    const action = body.action;
    const result = action === "submit"
      ? await submitMemberEmailBroadcast(authorized.context, handle)
      : action === "approve"
        ? await approveMemberEmailBroadcast(authorized.context, handle)
        : action === "simulate_test"
          ? await simulateMemberEmailTest(authorized.context, handle)
          : action === "simulate_send"
            ? await simulateMemberEmailSend(authorized.context, handle)
            : null;
    if (!result) return memberEmailJson({ error: "INVALID_ACTION", message: "Choose a valid Preview broadcast action." }, 400);
    return memberEmailJson({ broadcast: "ok", ...result });
  } catch (error) {
    return memberEmailFailure(error);
  }
}
