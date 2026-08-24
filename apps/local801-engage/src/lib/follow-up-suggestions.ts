export type FollowupSuggestion = {
  days: number;
  label: string;
  reason: string;
} | null;

export function followupSuggestionForOutcome(outcome: string): FollowupSuggestion {
  switch (outcome) {
    case "no_answer":
      return { days: 2, label: "Try again in 2 days", reason: "No answer was recorded." };
    case "left_message":
      return { days: 3, label: "Follow up in 3 days", reason: "A message was left and no conversation is recorded yet." };
    case "not_available":
      return { days: 3, label: "Try again in 3 days", reason: "The person was not available." };
    case "contacted":
      return { days: 7, label: "Check back in 7 days", reason: "A conversation was completed; use this only when another contact is actually needed." };
    case "wrong_contact":
      return null;
    case "declined_conversation":
      return null;
    default:
      return null;
  }
}

export function suggestedLocalDateTime(days: number, now = new Date()) {
  const future = new Date(now.getTime());
  future.setDate(future.getDate() + days);
  const shifted = new Date(future.getTime() - future.getTimezoneOffset() * 60_000);
  return shifted.toISOString().slice(0, 16);
}
