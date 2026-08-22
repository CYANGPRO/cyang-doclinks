# CAT Security Architecture

## Trust boundaries and data flow

```text
Managed user device
  | HTTPS + OIDC redirects; no sensitive offline cache
  v
Vercel edge / CAT Next.js server  <---- GitHub Actions deployment pipeline
  | server-derived identity, organization, role, scope
  | TLS PostgreSQL                         | HMAC-authenticated bounded scan
  v                                        v
Neon CAT database                    scan.cyang.io malware scanner
  | metadata / encrypted PII envelopes
  |
  | S3 API over HTTPS; CAT-only bucket token; ciphertext objects
  v
Cloudflare R2 CAT private bucket

Recovery boundary: GitHub scheduled workflow -> Neon TLS pg_dump -> separate R2 recovery bucket
```

## Interfaces

| Interface | Exposure | Authentication/authorization | Data |
| --- | --- | --- | --- |
| `https://cat.cyang.io` | Public HTTPS | OIDC MFA, active CAT account, server RBAC/org/scope checks | UI/API responses, protected data only after checks |
| Preview deployment | Internet address but must be Deployment Protected | Synthetic preview role only; no real data | Synthetic data |
| NextAuth callback | Public HTTPS | OIDC state/PKCE, provider subject, verified email, MFA assurance | Identity claims and opaque session state |
| Neon connection | Server/service only | CAT-only credential, TLS, database authorization | Relational data and audit events |
| R2 S3 endpoint | Server/service only | CAT-only bucket token; private bucket | Encrypted objects only |
| Malware scanner | Server/service HTTPS | Per-application HMAC, bounded request, fail closed | Uploaded bytes transiently for verdict |
| GitHub Actions | Provider-managed | Repository/environment secrets and permissions | Source, builds, SBOMs; backup stream in dedicated job |
| Provider admin consoles | Administrator path | Individual MFA accounts and provider RBAC | Infrastructure/security settings |

The browser never receives database/R2 credentials, encryption keys, raw storage keys, or organization/role override inputs. The service worker caches only fixed non-sensitive assets and a generic offline page. CAT does not expose R2 through a public custom domain, `r2.dev`, or presigned object URL.
