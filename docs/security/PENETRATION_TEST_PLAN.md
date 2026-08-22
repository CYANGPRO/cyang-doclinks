# CAT Penetration Test Plan

Automated regression tests and CodeQL are not penetration testing. CAT requires a later independent or dedicated test against an explicitly authorized non-production target that mirrors production controls and uses only synthetic data.

## Scope

- OIDC authentication, MFA assurance, session issuance/expiry/revocation and account disablement
- role/permission boundaries and privilege escalation across all seven roles
- organization isolation, IDOR/opaque handles and direct API access bypassing UI
- Membership, Imports, Directory, Outreach, Campaigns, CAT Actions, Documents, Reports and Team/administration
- protected PII hydration/search/import/report behavior and plaintext leakage
- document/import upload types, size/stream bypass, filenames, archives, scanner outage/malicious verdict and unsafe rendering/download
- report/export authorization, person-level rules, small-cell handling, cache controls and audit creation
- SQL/command/template/JSON/CSV injection, XSS, CSRF, SSRF, open redirect and unsafe deserialization
- CSP/security headers, error disclosure, source maps, cookies, browser caching and service worker
- R2 key/object access, private-bucket exposure and cross-organization object attempts
- rate/abuse behavior, repeated authorization failures, high-cost queries/uploads and monitoring visibility
- Vercel/Neon/R2/IdP trust boundaries and preview/production separation

## Rules of engagement

- Written owner authorization, target URLs, source addresses, test window, contacts, stop conditions and data rules are required.
- No production destructive exploitation, denial of service, social engineering, persistence, real member data, credential reuse, bulk extraction or third-party provider attack without separate written authorization.
- Test accounts cover every role in at least two synthetic organizations. Findings must include reproduction, impact, evidence, severity and remediation guidance without retaining protected content.
- Critical/high findings block production unless remediated and retested or explicitly accepted under the production gate. All findings enter vulnerability/risk tracking; material defects receive root-cause analysis and regression tests.

## Status

No independent penetration test is evidenced by this repository. Status: **Deferred / required before production approval unless the accountable owner records an explicit risk acceptance and bounded alternative test plan.**
