import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  actionProblemFor,
  authenticationProblemFor,
} from "../src/lib/user-facing-errors.ts";

function source(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

test("authentication errors use fixed safe guidance without reflecting unknown query values", () => {
  const denied = authenticationProblemFor("AccessDenied");
  assert.equal(denied?.reference, "SIGN_IN_ACCESS_DENIED");
  assert.match(denied?.description ?? "", /does not identify which access check failed/);
  assert.match(denied?.steps.join(" ") ?? "", /one role/);

  const callback = authenticationProblemFor("OAuthCallback");
  assert.equal(callback?.reference, "SIGN_IN_CALLBACK_FAILED");

  const unknown = authenticationProblemFor("private-database-error-with-person-name");
  assert.equal(unknown?.reference, "SIGN_IN_FAILED");
  assert.doesNotMatch(JSON.stringify(unknown), /private-database-error-with-person-name/);
  assert.equal(authenticationProblemFor(undefined), null);
});

test("action errors classify safe recovery guidance for conflicts, permissions, files, and validation", () => {
  assert.equal(actionProblemFor("This record is stale.").category, "conflict");
  assert.equal(actionProblemFor("Permission denied.").category, "authorization");
  assert.equal(actionProblemFor("Microsoft Entra rejected the onboarding request. Review Team & Access.").reference, "ENTRA_ONBOARDING_FAILED");
  const unsupportedAssignmentQuery = actionProblemFor("Microsoft Entra rejected CAT’s application-assignment query. No admin-consent change is required. The CAT application must be updated before onboarding is retried.");
  assert.equal(unsupportedAssignmentQuery.reference, "ENTRA_ASSIGNMENT_QUERY_UNSUPPORTED");
  assert.match(unsupportedAssignmentQuery.steps.join(" "), /do not change admin consent/i);
  assert.equal(actionProblemFor("The upload scanner rejected this file.").category, "file");
  assert.equal(actionProblemFor("Enter a valid date.").category, "validation");
  assert.equal(actionProblemFor("The action failed.").category, "service");
});

test("sign-in clearly explains approval, MFA, server roles, and common failure recovery", () => {
  const signIn = source("src/app/sign-in/page.tsx");
  const signInButton = source("src/components/ProductionSignInButton.tsx");
  assert.match(signIn, /private workspace for approved Local 801 users/i);
  assert.match(signIn, /does not offer public sign-up/);
  assert.match(signIn, /give it one role/);
  assert.match(signIn, /cannot choose a Production role during sign-in/);
  assert.doesNotMatch(signIn, /What each role can access/);
  assert.doesNotMatch(signIn, /roleSummaries/);
  assert.match(signIn, /Having trouble signing in/);
  assert.match(signIn, /authenticationProblemFor\(input\?\.error\)/);
  assert.match(signIn, /SignInErrorDialog/);
  assert.match(signIn, /Sign-in reset/);
  assert.match(signIn, /forceAccountSelection=\{resetRequested\}/);
  assert.match(signInButton, /Sign out and reset sign-in/);
  assert.match(signInButton, /signOut\(\{ callbackUrl: resetUrl \}\)/);
  assert.match(signInButton, /prompt: "select_account"/);
});

test("the shared popup is accessible and existing inline failures feed the global recovery experience", () => {
  const dialog = source("src/components/UserFacingErrorDialog.tsx");
  const global = source("src/components/GlobalErrorExperience.tsx");
  const layout = source("src/app/layout.tsx");
  assert.match(dialog, /<dialog/);
  assert.match(dialog, /aria-describedby/);
  assert.match(dialog, /aria-labelledby/);
  assert.match(dialog, /showModal\(\)/);
  assert.match(dialog, /onCancel/);
  assert.match(dialog, /Never send anyone your password, MFA code, recovery code, or encryption key/);
  assert.match(global, /MutationObserver/);
  assert.match(global, /form-message\[role="alert"\]/);
  assert.match(global, /addEventListener\("offline"/);
  assert.match(global, /addEventListener\("unhandledrejection"/);
  assert.match(layout, /<GlobalErrorExperience \/>/);
});

test("route and root failures provide screens with safe recovery and support references", () => {
  const routeError = source("src/app/error.tsx");
  const globalError = source("src/app/global-error.tsx");
  const notFound = source("src/app/not-found.tsx");
  assert.match(routeError, /check the current record before repeating an action/);
  assert.match(routeError, /UserFacingErrorDialog/);
  assert.match(globalError, /CAT couldn’t start/);
  assert.match(globalError, /APPLICATION_START_FAILED/);
  assert.match(notFound, /There’s nothing to show at this address/);
});
