import { getWorkflowMetadata, sleep } from "workflow";
import {
  claimProductionMemberEmailDelivery,
  completeProductionMemberEmailDelivery,
  failProductionMemberEmailDelivery,
  productionDeliveryDirective,
  sendNextProductionEmailBatch,
  type ProductionEmailWorkflowInput,
} from "../lib/member-email-production.ts";

async function claimDeliveryStep(input: ProductionEmailWorkflowInput, workflowRunId: string) {
  "use step";
  return claimProductionMemberEmailDelivery(input, workflowRunId);
}

async function deliveryDirectiveStep(input: ProductionEmailWorkflowInput) {
  "use step";
  return productionDeliveryDirective(input);
}

async function sendBatchStep(input: ProductionEmailWorkflowInput) {
  "use step";
  return sendNextProductionEmailBatch(input);
}

async function completeDeliveryStep(input: ProductionEmailWorkflowInput) {
  "use step";
  return completeProductionMemberEmailDelivery(input);
}

async function recordFailureStep(input: ProductionEmailWorkflowInput) {
  "use step";
  return failProductionMemberEmailDelivery(input);
}

export async function deliverMemberEmailWorkflow(input: ProductionEmailWorkflowInput) {
  "use workflow";
  const { workflowRunId } = getWorkflowMetadata();
  try {
    const claim = await claimDeliveryStep(input, workflowRunId);
    if (claim.status === "cancelled" || claim.status === "sent") return { status: claim.status };
    if (claim.scheduledFor && new Date(claim.scheduledFor).getTime() > Date.now()) {
      await sleep(new Date(claim.scheduledFor));
    }
    for (;;) {
      const directive = await deliveryDirectiveStep(input);
      if (directive === "cancelled") return { status: "cancelled" as const };
      if (directive === "complete") break;
      if (directive === "paused") {
        await sleep("30s");
        continue;
      }
      await sendBatchStep(input);
    }
    await completeDeliveryStep(input);
    return { status: "sent" as const };
  } catch (error) {
    await recordFailureStep(input);
    throw error;
  }
}
