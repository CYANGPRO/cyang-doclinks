# Local 801 Engage Deployment

## Private Preview

Create a separate Vercel project with root directory `apps/local801-engage`.

Preview settings:
- Domain: Vercel preview URL until DNS is approved.
- App URL: preview deployment URL.
- Database: separate preview PostgreSQL database or isolated preview branch, not DocLinks production.
- Storage: separate preview R2 bucket or isolated namespace, not DocLinks production.
- Auth: separate `NEXTAUTH_SECRET`; preview auth may be enabled only for private testing with synthetic accounts.
- Monitoring: separate project/environment.

## Production

Production activation waits for explicit approval from Chang Yang.

Target:
- Dedicated subdomain: `cat.cyang.io`.
- Vercel project root: `apps/local801-engage`.
- Runtime environment: production-specific database, R2 bucket, auth secret, encryption keys, email credentials, VAPID keys, monitoring, and callback URLs.

Do not add CAT routes to the existing DocLinks deployment if that would couple databases, auth secrets, storage, release cycles, or failure domains.

## DNS

The current `cyang.io` nameservers resolve to Cloudflare:

- `gwen.ns.cloudflare.com`
- `dion.ns.cloudflare.com`

Do not guess the `cat.cyang.io` DNS record value. After adding `cat.cyang.io` to the separate CAT hosting project, copy the exact DNS requirement shown by the hosting provider into Cloudflare DNS.

For Vercel this is usually shown at Project -> Settings -> Domains -> `cat.cyang.io`. Use the record type, name, value, and proxy recommendation shown there.

## Transfer Before Production

Services to transfer or share with Chang Yang before production:
- Vercel project ownership and deployment permissions.
- DNS/domain management for `cat.cyang.io`.
- PostgreSQL project and backup access.
- Cloudflare R2 bucket, API tokens, and recovery access.
- Encryption-key custody.
- Auth provider and `NEXTAUTH_SECRET` custody.
- Email sender credentials.
- Web-push VAPID keys.
- Monitoring/Sentry project.
- Backup and restore jobs.
