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
    description: "Microsoft finished signing you in, but CAT could not approve this account. To protect account privacy, this message does not identify which access check failed.",
    steps: [
      "Sign out of other Microsoft accounts, then use the exact account invited to Local 801.",
      "Ask a Local 801 administrator to confirm that CAT has an active account with the same email and one role.",
      "Complete the Microsoft MFA prompt. If access was just added or changed, start a new sign-in session.",
    ],
    reference: "SIGN_IN_ACCESS_DENIED",
  },
  OAuthCallback: {
    category: "authentication",
    title: "CAT could not verify the Microsoft sign-in",
    description: "The reply from Microsoft was incomplete, expired, or did not match the sign-in that started in this browser.",
    steps: [
      "Close any other Local 801 sign-in tabs and begin again from this page.",
      "Allow required cookies for cat.cyang.io and avoid using the browser Back button during sign-in.",
      "If the problem continues, share the support reference below with application support.",
    ],
    reference: "SIGN_IN_CALLBACK_FAILED",
  },
  OAuthSignin: {
    category: "service",
    title: "Microsoft sign-in could not be started",
    description: "CAT could not open a new sign-in with Microsoft Entra ID.",
    steps: [
      "Check your internet connection and try again.",
      "If Microsoft or the workspace is undergoing maintenance, wait a few minutes before retrying.",
      "Contact application support if the problem continues.",
    ],
    reference: "SIGN_IN_START_FAILED",
  },
  OAuthAccountNotLinked: {
    category: "authorization",
    title: "Use the Microsoft account originally approved for CAT",
    description: "This browser used a different Microsoft account from the one approved for CAT.",
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
    description: "CAT sign-in needs administrator attention. CAT did not store your password or MFA code.",
    steps: [
      "Do not repeatedly enter your password.",
      "Try again later or contact application support.",
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
  description: "CAT did not open the workspace or show protected member information.",
  steps: [
    "Start a new sign-in attempt with the exact Microsoft account approved for Local 801.",
    "Complete MFA and keep the sign-in in one browser tab.",
    "Contact application support if the problem continues.",
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
  description: "CAT does not keep protected member records offline. When your connection returns, check the current record before entering anything again.",
  steps: [
    "Reconnect to a trusted network.",
    "Keep this page open, then retry the action after your browser reports that it is online.",
    "Do not copy protected records into another app as a workaround.",
  ],
  reference: "NETWORK_OFFLINE",
};

export const unexpectedClientProblem: UserFacingProblem = {
  category: "service",
  title: "Something went wrong on this page",
  description: "CAT stopped before it could confirm the result. Do not assume the change was saved.",
  steps: [
    "Reload the page and verify the current status before repeating the action.",
      "If the problem continues, return home and share the support reference with application support.",
  ],
  reference: "BROWSER_RUNTIME_ERROR",
};

export function actionProblemFor(message: string): UserFacingProblem {
  const normalized = message.toLowerCase();
  const importSupportReference = message.match(/\bIMPORT_EXECUTION_[0-9A-F]{12}\b/)?.[0];
  if (normalized.includes("applied roster did not exactly match the reviewed set")) {
    return {
      category: "conflict",
      title: "The applied roster did not match the review",
      description: "CAT found a mismatch between the approved rows and the rows being applied, so it reversed the whole update. No roster changes were saved.",
      steps: [
        "Close this message and refresh the import to confirm its current status.",
        "If it still shows Ready to apply, retry once without uploading the file again.",
        "If the retry fails, stop and contact application support with the reference below.",
      ],
      reference: "ATOMIC_RECONCILIATION_FAILED",
    };
  }
  if (normalized.includes("protected import was not committed") || importSupportReference) {
    return {
      category: "service",
      title: "CAT reversed the import before it changed the roster",
      description: "CAT could not confirm the complete update, so no roster changes were saved. The uploaded file and review decisions are still available.",
      steps: [
        "Close this message, refresh the import, and confirm that it still shows Ready to apply.",
        "If it remains ready, retry once. Do not upload the file again.",
        "If the retry fails, stop and send only the support reference below to application support.",
      ],
      reference: importSupportReference ?? "PROTECTED_IMPORT_EXECUTION_FAILED",
    };
  }
  if (normalized.includes("offline") || normalized.includes("network") || normalized.includes("connect")) return offlineProblem;
  if (normalized.includes("application-assignment query") && normalized.includes("no admin-consent change is required")) {
    return {
      category: "service",
      title: "CAT needs an update before it can check Microsoft access",
      description: "Microsoft accepted CAT’s connection but could not complete the application-access check. The user’s Local 801 account is still saved.",
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
      title: "Microsoft could not finish setting up this user",
      description: "The Local 801 account is saved, but Microsoft did not finish the invitation or CAT access assignment.",
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
      description: "CAT stopped instead of overwriting a newer change.",
      steps: ["Reload the page to see the current record.", "Review the latest values before trying the action again."],
      reference: "ACTION_CONFLICT",
    };
  }
  if (normalized.includes("forbidden") || normalized.includes("permission") || normalized.includes("authorized") || normalized.includes("access")) {
    return {
      category: "authorization",
      title: "Your current role cannot complete this action",
      description: "CAT stopped the request before making the protected change.",
      steps: ["Use an area available to your assigned role.", "Ask a Local 801 administrator to review your role if you believe it is incorrect."],
      reference: "ACTION_NOT_ALLOWED",
    };
  }
  if (normalized.includes("file") || normalized.includes("upload") || normalized.includes("malware") || normalized.includes("scanner")) {
    return {
      category: "file",
      title: "The file was not accepted",
      description: "The upload did not pass a file type, size, malware, or storage check.",
      steps: ["Check the allowed file type and size, then select the file again.", "Do not bypass a malware or security rejection; contact the System Owner for review."],
      reference: "FILE_NOT_ACCEPTED",
    };
  }
  if (normalized.includes("choose") || normalized.includes("enter") || normalized.includes("required") || normalized.includes("valid")) {
    return {
      category: "validation",
      title: "Check the information you entered",
      description: "A required answer is missing or in the wrong format. CAT did not submit the change.",
      steps: ["Correct the highlighted or missing information.", "Review the values once more before submitting."],
      reference: "INPUT_NEEDS_ATTENTION",
    };
  }
  return {
    category: "service",
    title: "The action could not be completed",
    description: "CAT did not confirm this change. Check the current record before trying again.",
    steps: ["Check the current record before trying again.", "If the problem continues, share the support reference with application support."],
    reference: "ACTION_FAILED",
  };
}
