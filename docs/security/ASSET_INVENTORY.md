# CAT Enterprise Asset Inventory

Owner names and private account identifiers are intentionally excluded. The system owner must map each owner category below to a current person in the private operational register. Review at least every six months and after provider or environment changes.

| Asset | Environment | Purpose / data | Responsibility | Evidence / discovery source | Authorized state |
| --- | --- | --- | --- | --- | --- |
| Local 801 Engage Vercel project | Production | Public CAT web/API edge and server runtime; protected data transiently in memory | CAT + Vercel | `apps/local801-engage`, Vercel project inventory | Required; production launch remains gated |
| Local 801 Engage Vercel project | Preview | Synthetic-only review environment | CAT + Vercel | Preview deployments; `LOCAL801_PREVIEW_AUTH_ENABLED` policy | Authorized only behind Deployment Protection |
| Developer workstations | Development | Source, synthetic data, local build/test artifacts | Operator + endpoint owner | GitHub access list and managed-device inventory | Approved devices only; no real member samples outside `local-sensitive-samples/` |
| GitHub repository | All | Source, documentation, workflows, history | CAT + GitHub | Repository settings and this inventory | Authorized |
| GitHub Actions runners | CI/backup | Ephemeral builds, tests, SBOMs, database backup process | CAT + GitHub | `.github/workflows/` | Authorized; secrets environment-scoped |
| Neon production project/branch | Production | CAT relational data, audit events, protected PII envelopes and indexes | CAT + Neon | `LOCAL801_DATABASE_URL` target recorded privately | Must be distinct from DocLinks; exact target verification required |
| Neon preview branch/project | Preview | Synthetic CAT data | CAT + Neon | Preview environment inventory | Must be distinct from production and DocLinks |
| Cloudflare R2 CAT object bucket | Production | Encrypted imports, documents, and generated reports | CAT + Cloudflare | `LOCAL801_R2_*`; private bucket settings | Must be private and CAT-only |
| Cloudflare R2 CAT recovery bucket | Production recovery | Database dumps/checksums and any separately designed object backups | CAT + Cloudflare | `backup-local801-neon-to-r2.yml` plus provider settings | Configuration and restore evidence pending |
| Cloudflare R2 preview bucket | Preview | Encrypted synthetic objects | CAT + Cloudflare | Preview environment inventory | Must be separate from production and DocLinks |
| `cat.cyang.io` DNS/TLS | Production | Public application hostname and TLS termination | CAT + DNS operator + Vercel/Cloudflare | Vercel domain and Cloudflare DNS settings | Exact live record/TLS acceptance pending |
| Production identity provider | Production | OIDC identity, verified email, MFA assurance | Organization + provider + CAT | `LOCAL801_OIDC_*`; provider admin inventory | Owner-controlled provider selection/configuration pending acceptance |
| Shared malware scanner | All upload environments | Receives bounded uploaded bytes for scanning; no retention expected | CAT + scanner operator | `src/lib/import-scanner.ts`; `scan.cyang.io` HMAC configuration | Required and fail-closed |
| GitHub security services | Repository | Dependency, secret, and code findings | CAT + GitHub | Dependabot, CodeQL workflow, repository security settings | Settings verification required |
| Vercel observability/logs | Runtime | Request/runtime/security diagnostic metadata | CAT + Vercel | Vercel Logs/Drains configuration | Central alerting and retention pending |
| Administrator browser/device | End user | Displays and may download protected member data | Organization + endpoint owner | Managed-device/account register | Outside application enforcement; approved device required |
| CAT user browser/device | End user | Displays assigned/member data | Organization + endpoint owner | Managed-device/account register | Outside application enforcement; approved device required |

## Inventory process

1. Compare this register with GitHub collaborators/environments, Vercel projects/domains, Neon projects/branches, Cloudflare buckets/tokens/domains, IdP clients/groups, and the managed-device list.
2. Record new assets before use and remove access or data from retired assets.
3. Investigate any unlisted production deployment, database, bucket, identity client, domain, token, or integration within one week.
4. Cloud-provider network discovery and end-user DHCP/MDM discovery are provider/organization responsibilities; CAT has no private corporate network or DHCP server to scan.
