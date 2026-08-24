import type { NewHireQueuePerson } from "./new-hires.ts";

export type NewHireLifecycleStage =
  | "new"
  | "assigned"
  | "contact_attempted"
  | "conversation_completed"
  | "membership_resolved";

export type NewHireLifecyclePresentation = {
  stage: NewHireLifecycleStage;
  label: string;
  detail: string;
  step: number;
  totalSteps: 5;
};

const successfulConversationOutcomes = new Set(["contacted"]);

export function newHireLifecycle(person: Pick<NewHireQueuePerson,
  "assigned" | "latestEngagementAt" | "latestOutcome" | "membershipStatus"
>): NewHireLifecyclePresentation {
  const conversationCompleted = Boolean(
    person.latestEngagementAt
      && person.latestOutcome
      && successfulConversationOutcomes.has(person.latestOutcome),
  );
  const membershipResolved = conversationCompleted && person.membershipStatus !== "unknown";

  if (membershipResolved) {
    return {
      stage: "membership_resolved",
      label: "Membership resolved",
      detail: `Conversation completed and membership recorded as ${person.membershipStatus}.`,
      step: 5,
      totalSteps: 5,
    };
  }
  if (conversationCompleted) {
    return {
      stage: "conversation_completed",
      label: "Conversation completed",
      detail: "A successful conversation is recorded; membership still needs resolution.",
      step: 4,
      totalSteps: 5,
    };
  }
  if (person.latestEngagementAt) {
    return {
      stage: "contact_attempted",
      label: "Contact attempted",
      detail: person.latestOutcome
        ? `Latest recorded outcome: ${person.latestOutcome.replaceAll("_", " ")}.`
        : "At least one contact attempt is recorded.",
      step: 3,
      totalSteps: 5,
    };
  }
  if (person.assigned) {
    return {
      stage: "assigned",
      label: "Assigned",
      detail: "An organizer is assigned; first contact has not been recorded.",
      step: 2,
      totalSteps: 5,
    };
  }
  return {
    stage: "new",
    label: "New",
    detail: "No open outreach assignment or engagement has been recorded yet.",
    step: 1,
    totalSteps: 5,
  };
}
