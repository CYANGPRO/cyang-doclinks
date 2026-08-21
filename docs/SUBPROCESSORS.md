# Subprocessors
Effective Date: March 01, 2026
Last Updated: March 16, 2026

This page lists subprocessors used to deliver cyang.io and Doclinks services. Subprocessors are selected for operational necessity and are expected to maintain appropriate security and privacy controls.

## 1. How We Use Subprocessors
Subprocessors are engaged to support infrastructure, storage, delivery, billing, communications, and operational security.

## 2. Subprocessor Selection Principles
We evaluate subprocessors for:

- security posture,
- reliability and operational maturity,
- privacy and contractual safeguards,
- service fit for controlled document delivery.

## 3. Current Subprocessors

| Provider | Purpose | Data categories processed | Primary region relevance | Trust / privacy reference |
|---|---|---|---|---|
| Vercel Inc. | Primary application hosting, build pipeline, static asset delivery, and serverless execution | IP address, request metadata, deployment metadata, application telemetry | US and global edge footprint | https://vercel.com/legal/privacy-policy |
| Neon, Inc. | Managed Postgres database hosting, branching, backup, and restore operations | Account data, document metadata, audit logs, billing state, operational telemetry | US-hosted managed database infrastructure | https://neon.tech/privacy-policy |
| Cloudflare, Inc. | DNS, CDN caching, WAF/rate limiting, R2 object storage, and scheduled worker execution | IP address, request metadata, security telemetry, stored document objects, backup artifacts | Global edge network and storage footprint | https://www.cloudflare.com/trust-hub/ |
| GitHub, Inc. | Source control, CI/CD automation, and scheduled backup workflows | Source code metadata, deployment metadata, backup artifacts, operational run metadata | US-hosted and regional automation infrastructure | https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement |
| Google LLC | Google OAuth authentication for supported sign-in flows | Email address, profile identifier, authentication metadata | Global infrastructure | https://policies.google.com/privacy |
| Functional Software, Inc. (Sentry) | Error monitoring, crash diagnostics, and request-level observability | Error events, request metadata, limited operational telemetry | US and global processing footprint | https://sentry.io/privacy/ |
| OVH US LLC dba OVHcloud | Owner-operated malware scanning and supporting compute | Transient document bytes submitted for malware scanning and limited operational scanner telemetry; the scanner is configured for no file-content retention | Owner-selected OVHcloud region | https://us.ovhcloud.com/legal/privacy-policy/ |
| Stripe, Inc. | Subscription billing and payment processing | Billing identifiers, transaction metadata, business contact details | US and regional processing infrastructure | https://stripe.com/privacy |
| Resend, Inc. | Transactional email delivery | Email addresses, email event metadata, support communications metadata | US and regional delivery infrastructure | https://resend.com/legal/privacy-policy |

## 4. Data Protection Expectations
Subprocessors are bound by contractual and operational requirements appropriate to their role, including confidentiality and data protection obligations.

## 5. Change Management
We may update this list as vendors are added, replaced, or removed for operational reasons. Material changes are reflected in this document's Last Updated date.

## 6. Vendor Questions
For subprocessor and data handling questions:

- privacy@cyang.io
- legal@cyang.io
