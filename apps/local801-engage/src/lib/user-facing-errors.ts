export type UserFacingProblem = {
  category: "authentication" | "authorization" | "connectivity" | "conflict" | "validation" | "file" | "service";
  title: string;
  description: string;
  steps: readonly string[];
  reference: string;
};

const authenticationProblems: Record<string, UserFacingProblem> = {
  AccessDenied: {
    category: "authorization",
    title: "This account is not approved for this workspace",
    description: "Microsoft sign-in completed, but Engaging Local 801 could not grant access. For privacy, the site does not confirm which account check failed.",
    steps: [
      "Sign out of other Microsoft accounts, then use the exact account invited to Local 801.",
      "Confirm a Local 801 administrator has created an active CAT account with the same email and assigned one role.",
      "Complete the Microsoft MFA prompt. If access was just added or changed, start a new sign-in session.",
    ],
    reference: "SIGN_IN_ACCESS_DENIED",
  },
  OAuthCallback: {
    category: "authentication",
    title: "The Microsoft sign-in response could not be verified",
    description: "The secure return from Microsoft was incomplete, expired, or did not match the sign-in session that started in this browser.",
    steps: [
      "Close any other Local 801 sign-in tabs and begin again from this page.",
      "Allow required cookies for cat.cyang.io and avoid using the browser Back button during sign-in.",
      "If the problem continues, share the support reference below with the System Owner.",
    ],
    reference: "SIGN_IN_CALLBACK_FAILED",
  },
  OAuthSignin: {
    category: "service",
    title: "Microsoft sign-in could not be started",
    description: "The workspace could not open a secure sign-in session with Microsoft Entra ID.",
    steps: [
      "Check your internet connection and try again.",
      "If Microsoft or the workspace is undergoing maintenance, wait a few minutes before retrying.",
      "Contact the System Owner if the problem continues.",
    ],
    reference: "SIGN_IN_START_FAILED",
  },
  OAuthAccountNotLinked: {
    category: "authorization",
    title: "Use the Microsoft account originally approved for CAT",
    description: "This browser is signed in with a different Microsoft identity than the one linked to the approved Local 801 account.",
    steps: [
      "Sign out of Microsoft in this browser.",
      "Begin again with the exact account named in your Local 801 invitation.",
      "Ask a Local 801 administrator to review the account link if your approved email changed.",
    ],
    reference: "SIGN_IN_ACCOUNT_MISMATCH",
  },
  Configuration: {
    category: "service",
    title: "Organization sign-in is temporarily unavailable",
    description: "The workspace sign-in service needs administrator attention. Your password and MFA code were not stored by this site.",
    steps: [
      "Do not repeatedly enter your password.",
      "Try again later or contact the System Owner.",
      "Share the support reference below; never send your password or MFA code.",
    ],
    reference: "SIGN_IN_CONFIGURATION",
  },
  Verification: {
    category: "authentication",
    title: "The sign-in attempt expired",
    description: "The secure sign-in window was not completed in time or has already been used.",
    steps: [
      "Return to this page and start a new sign-in attempt.",
      "Complete the Microsoft and MFA prompts without reusing an older tab.",
    ],
    reference: "SIGN_IN_EXPIRED",
  },
};

const defaultAuthenticationProblem: UserFacingProblem = {
  category: "authentication",
  title: "Sign-in could not be completed",
  description: "No workspace access was granted and no protected member information was shown.",
  steps: [
    "Start a new sign-in attempt with the exact Microsoft account approved for Local 801.",
    "Complete MFA and keep the sign-in in one browser tab.",
    "Contact the System Owner if the problem continues.",
  ],
  reference: "SIGN_IN_FAILED",
};

export function authenticationProblemFor(error: string | string[] | undefined): UserFacingProblem | null {
  const code = Array.isArray(error) ? error[0] : error;
  if (!code) return null;
  return authenticationProblems[code] ?? defaultAuthenticationProblem;
}

export const signInStartProblem: UserFacingProblem = {
  ...authenticationProblems.OAuthSignin,
};

export const offlineProblem: UserFacingProblem = {
  category: "connectivity",
  title: "You are offline",
  description: "This workspace does not store protected member records for offline use. Unsaved changes may need to be entered again after the connection returns.",
  steps: [
    "Reconnect to a trusted network.",
    "Keep this page open, then retry the action after your browser reports that it is online.",
    "Do not copy protected records into another app as a workaround.",
  ],
  reference: "NETWORK_OFFLINE",
};

export const unexpectedClientProblem: UserFacingProblem = {
  category: "service",
  title: "This page encountered a problem",
  description: "The current action stopped before it could be confirmed. Do not assume a change was saved.",
  steps: [
    "Reload the page and verify the current status before repeating the action.",
    "If the problem continues, return home and share the support reference with the System Owner.",
  ],
  reference: "BROWSER_RUNTIME_ERROR",
};

export function actionProblemFor(message: string): UserFacingProblem {
  const normalized = message.toLowerCase();
  const importSupportReference = message.match(/\bIMPORT_EXECUTION_[0-9A-F]{12}\b/)?.[0];
  if (normalized.includes("applied roster did not exactly match the reviewed set")) {
    return {
      category: "conflict",
      title: "The reviewed roster did not reconcile",
      description: "The workspace compared the applied row counts with the exact reviewed set and safely rolled back the entire transaction. No roster changes were committed.",
      steps: [
        "Close this message and refresh the import to confirm its current status.",
        "If it still shows Ready to apply, retry once without uploading the file again.",
        "If the retry fails, stop and contact the System Owner with the reference below.",
      ],
      reference: "ATOMIC_RECONCILIATION_FAILED",
    };
  }
  if (normalized.includes("protected import was not committed") || importSupportReference) {
    return {
      category: "service",
      title: "The protected import was safely rolled back",
      description: "The workspace could not confirm the complete roster transaction, so it committed no roster changes. The uploaded file and review decisions remain available.",
      steps: [
        "Close this message, refresh the import, and confirm that it still shows Ready to apply.",
        "If it remains ready, retry once. Do not upload the file again.",
        "If the retry fails, stop and send only the support reference below to the System Owner.",
      ],
      reference: importSupportReference ?? "PROTECTED_IMPORT_EXECUTION_FAILED",
    };
  }
  if (normalized.includes("offline") || normalized.includes("network") || normalized.includes("connect")) return offlineProblem;
  if (normalized.includes("application-assignment query") && normalized.includes("no admin-consent change is required")) {
    return {
      category: "service",
      title: "CAT’s Microsoft Entra assignment check needs an application update",
      description: "Microsoft accepted the CAT service credentials but rejected the application-assignment query. The user’s Local 801 account remains saved.",
      steps: [
        "Do not change admin consent and do not add the user again.",
        "After the CAT application update is deployed, use Retry onboarding on the existing user.",
      ],
      reference: "ENTRA_ASSIGNMENT_QUERY_UNSUPPORTED",
    };
  }
  if (normalized.includes("microsoft entra") || normalized.includes("entra onboarding")) {
    return {
      category: "service",
      title: "Microsoft Entra onboarding needs administrator attention",
      description: "The Local 801 account is saved, but Microsoft did not complete the invitation or application-access assignment.",
      steps: [
        "An Entra administrator should confirm that the approved Microsoft Graph application permissions have admin consent.",
        "After the Entra configuration is corrected, use Retry onboarding on the existing user. Do not add the user again.",
      ],
      reference: "ENTRA_ONBOARDING_FAILED",
    };
  }
  if (normalized.includes("stale") || normalized.includes("conflict") || normalized.includes("changed") || normalized.includes("current review")) {
    return {
      category: "conflict",
      title: "The information changed before your action finished",
      description: "The workspace stopped the action rather than overwrite a newer change.",
      steps: ["Reload the page to see the current record.", "Review the latest values before trying the action again."],
      reference: "ACTION_CONFLICT",
    };
  }
  if (normalized.includes("forbidden") || normalized.includes("permission") || normalized.includes("authorized") || normalized.includes("access")) {
    return {
      category: "authorization",
      title: "Your current role cannot complete this action",
      description: "The permission check stopped the request before the protected change could be completed.",
      steps: ["Use an area available to your assigned role.", "Ask a Local 801 administrator to review your role if you believe it is incorrect."],
      reference: "ACTION_NOT_ALLOWED",
    };
  }
  if (normalized.includes("file") || normalized.includes("upload") || normalized.includes("malware") || normalized.includes("scanner")) {
    return {
      category: "file",
      title: "The file was not accepted",
      description: "The upload did not pass one of the workspace file, size, malware, or storage checks.",
      steps: ["Check the allowed file type and size, then select the file again.", "Do not bypass a malware or security rejection; contact the System Owner for review."],
      reference: "FILE_NOT_ACCEPTED",
    };
  }
  if (normalized.includes("choose") || normalized.includes("enter") || normalized.includes("required") || normalized.includes("valid")) {
    return {
      category: "validation",
      title: "Check the information you entered",
      description: "One or more required values are missing or not in the expected format. The change was not submitted.",
      steps: ["Correct the highlighted or missing information.", "Review the values once more before submitting."],
      reference: "INPUT_NEEDS_ATTENTION",
    };
  }
  return {
    category: "service",
    title: "The action could not be completed",
    description: "The workspace did not confirm this change. Verify the current status before trying again.",
    steps: ["Check the current record before trying again.", "If the problem continues, share the support reference with the System Owner."],
    reference: "ACTION_FAILED",
  };
}
