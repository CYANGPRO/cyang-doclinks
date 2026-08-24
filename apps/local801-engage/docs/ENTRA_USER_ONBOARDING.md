# Microsoft Entra user onboarding

## Outcome

Team & Access is the single user-entry point. An authorized System Owner or Local Administrator enters a name, exact sign-in email, and CAT role once. The server then:

1. creates the role-limited CAT account and durable audit record;
2. creates a Microsoft Entra B2B guest invitation;
3. assigns the guest to the Engaging Local 801 enterprise application;
4. asks Microsoft to send the customized onboarding email; and
5. tracks the non-PII provisioning state for operator visibility and safe retry.

CAT never creates, stores, displays, or emails a password. The invitee uses an existing supported identity or Microsoft Entra's email one-time-passcode fallback, completes MFA, and accepts the current CAT privacy and acceptable-use policy before entering the workspace.

## One-time Entra configuration

Use the existing confidential `Local 801 CAT Production` app registration unless a separate owner-controlled provisioning registration is deliberately created later.

1. In Microsoft Entra admin center, open **App registrations → Local 801 CAT Production → API permissions → Add a permission → Microsoft Graph → Application permissions**.
2. Add the least-privileged permissions used by this workflow:
   - `User.Invite.All`
   - `AppRoleAssignment.ReadWrite.All`
   - `Application.Read.All`
3. Select **Grant admin consent for Local 801 CAT** and confirm that all three permissions show granted status.
4. Open **Enterprise applications → Local 801 CAT Production → Overview** and copy the enterprise application's **Object ID**. Do not copy the Application (client) ID.
5. Keep **Assignment required?** set to **Yes**. The CAT workflow now performs that assignment automatically.
6. Keep tenant MFA enforcement and B2B email one-time passcode enabled. Add the Local 801 privacy URL to the Entra external-collaboration privacy experience when available.

## Production variables

Add these values to the Vercel Production environment before deploying migration 0025 and the corresponding application commit:

```text
LOCAL801_ENTRA_USER_PROVISIONING_ENABLED=1
LOCAL801_ENTRA_ENTERPRISE_APP_OBJECT_ID=<enterprise-application-object-id>
LOCAL801_ENTRA_ENTERPRISE_APP_ROLE_ID=00000000-0000-0000-0000-000000000000
LOCAL801_ACCESS_SUPPORT_EMAIL=<monitored-support-address>
```

The workflow reuses the existing server-only `LOCAL801_OIDC_TENANT_ID`, `LOCAL801_OIDC_CLIENT_ID`, and `LOCAL801_OIDC_CLIENT_SECRET`. Never place those values in browser-visible variables, source control, screenshots, tickets, or email.

## Invitation content and acceptance

The Microsoft-delivered invitation names the assigned CAT role, summarizes its access, identifies the exact sign-in email, explains MFA and one-time-passcode behavior, links to `cat.cyang.io`, and states the protected-data, authorized-use, no-sharing, no-unapproved-offline-copy, auditing, revocation, and incident-reporting requirements. The email does not itself record policy acceptance. On first successful CAT sign-in, the existing versioned policy gate records explicit acceptance in `local801.user_policy_acknowledgements`.

## Failure and retry behavior

The CAT account and role are committed before the external call. A Microsoft timeout or rejected assignment therefore cannot erase the local audit trail. Team & Access shows `Onboarding needs attention`, and an authorized administrator can use **Retry onboarding**. The retry is idempotent after an Entra user ID has been recorded: it checks for an existing enterprise-app assignment before creating one.

Raw Graph response bodies, access tokens, invitation redemption URLs, client secrets, names, and email addresses are never stored in the onboarding-state table or application logs. Only the Entra user UUID, bounded status, timestamps, attempt count, and safe error code are retained.

## Acceptance test

1. Add a synthetic `example.test` user in Preview with Graph calls mocked and verify the role-specific message and state transitions.
2. In Production, add one approved real pilot address from Team & Access.
3. Confirm the recipient gets one Microsoft invitation and can redeem it with the exact invited email.
4. Confirm MFA is required, policy acceptance appears, and the resulting CAT navigation/actions match the assigned role.
5. Confirm the enterprise application shows the user assignment without manual portal entry.
6. Deactivate the CAT account and confirm existing CAT sessions are revoked and a new sign-in is denied.
