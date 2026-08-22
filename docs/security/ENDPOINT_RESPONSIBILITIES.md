# Endpoint, Browser, Email, and Malware Responsibilities

The CAT application can secure its responses and uploads but cannot administer a user’s personal or organizational endpoint.

## Organization / endpoint owner

- Maintain supported browsers, operating systems and email clients with automatic security updates.
- Enforce device lock, full-disk encryption, approved anti-malware/behavior protection, host firewall, DNS/URL filtering, restricted browser extensions, removable-media policy and remote wipe where managed-device risk requires it.
- Use VPN/central authentication for remote access only if organization network policy requires it; CAT itself is a public HTTPS SaaS endpoint protected by OIDC MFA.
- Prevent automatic execution/autoplay and scan removable media. CAT does not require removable media.
- Configure organizational email-domain SPF/DKIM/DMARC when CAT email is introduced. No production CAT email provider/runtime is currently approved.

## CAT application

- Sends restrictive security headers, attachment downloads, no-store responses and safe filenames.
- Does not render uploaded office/PDF/HTML content inline; supported documents are downloaded as attachments.
- Blocks executable/archive/HTML upload types, validates extension and MIME, bounds bytes/streams, normalizes filenames and requires a clean scanner verdict before encrypted storage.
- Uses no user-controlled external redirect or server-fetch destination in the reviewed routes.

Endpoint safeguards are marked shared/provider responsibility in the CIS matrix, not falsely implemented by CAT.
