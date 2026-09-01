import {
  approveMemberEmailBroadcast,
  sendMemberEmailRealTest,
  simulateMemberEmailSend,
  simulateMemberEmailTest,
  submitMemberEmailBroadcast,
} from "@/lib/member-email-broadcasts";
import { controlProductionMemberEmailDelivery, failProductionMemberEmailDelivery, prepareProductionMemberEmailDelivery } from "@/lib/member-email-production";
import { memberEmailRuntimeMode } from "@/lib/member-email-preview-policy";
import { deliverMemberEmailWorkflow } from "@/workflows/deliver-member-email";
import { start } from "workflow/api";
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
    const runtimeMode = memberEmailRuntimeMode();
    const result = action === "submit"
      ? await submitMemberEmailBroadcast(authorized.context, handle)
      : action === "approve"
        ? await approveMemberEmailBroadcast(authorized.context, handle)
        : action === "simulate_test"
          ? await simulateMemberEmailTest(authorized.context, handle)
          : action === "simulate_send"
            ? await simulateMemberEmailSend(authorized.context, handle)
            : action === "real_test"
              ? await sendMemberEmailRealTest(authorized.context, handle)
            : action === "send" && runtimeMode === "production"
              ? await (async () => {
                  const input = await prepareProductionMemberEmailDelivery(authorized.context, handle);
                  try {
                    const run = await start(deliverMemberEmailWorkflow, [input]);
                    return { action: "send", status: "queued", runId: run.runId };
                  } catch (error) {
                    await failProductionMemberEmailDelivery(input);
                    throw error;
                  }
                })()
            : (action === "pause" || action === "resume" || action === "cancel") && runtimeMode === "production"
              ? await controlProductionMemberEmailDelivery(authorized.context, handle, action)
            : null;
    if (!result) return memberEmailJson({ error: "INVALID_ACTION", message: "Choose a valid email notice action." }, 400);
    return memberEmailJson({ broadcast: "ok", ...result });
  } catch (error) {
    return memberEmailFailure(error);
  }
}
