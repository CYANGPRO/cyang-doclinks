# Engaging Local 801 deployment environment checklist

Do not record secret values in this file. Track configured/not configured status in the hosting provider.

| Variable | Purpose | Preview | Production |
| --- | --- | --- | --- |
| `LOCAL801_APP_URL` | Public CAT application URL | Required | Required |
| `NEXTAUTH_URL` | Auth callback base URL | Required | Required |
| `LOCAL801_DATABASE_URL` | Separate CAT PostgreSQL database | Required | Required |
| `LOCAL801_R2_ACCOUNT_ID` | Separate R2 account identifier | Required | Required |
| `LOCAL801_R2_ENDPOINT` | Separate R2 endpoint | Required | Required |
| `LOCAL801_R2_BUCKET` | Separate CAT private bucket | Required | Required |
| `LOCAL801_R2_ACCESS_KEY_ID` | Separate R2 access key | Required | Required |
| `LOCAL801_R2_SECRET_ACCESS_KEY` | Separate R2 secret key | Required | Required |
| `LOCAL801_ENCRYPTION_MASTER_KEYS` | CAT-only encryption master keys | Required | Required |
| `LOCAL801_ACTIVE_ENCRYPTION_KEY_VERSION` | Active CAT encryption key version | Required | Required |
| `NEXTAUTH_SECRET` | CAT-only auth/session secret | Required | Required |
| `SIGNUP_ENABLED` | Must remain `0` | Required | Required |
| `MFA_ENFORCE_ALL` | Must remain `1` before real users | Required | Required |
| `LOCAL801_PREVIEW_AUTH_ENABLED` | Preview-only synthetic auth flag | Optional `1` | Must be `0` |
| `LOCAL801_IMPORT_MAX_BYTES` | Import upload size limit | Required | Required |
| `LOCAL801_IMPORT_MAX_ROWS` | Import row limit | Required | Required |
| `LOCAL801_EXPORT_MAX_ROWS` | Export row limit | Required | Required |
| `LOCAL801_SMALL_CELL_THRESHOLD` | Small-cell suppression threshold | Required | Required |
| `LOCAL801_PUSH_ENABLED` | Push notification toggle | Optional | Required |
| `LOCAL801_VAPID_PUBLIC_KEY` | Web-push public key | If enabled | If enabled |
| `LOCAL801_VAPID_PRIVATE_KEY` | Web-push private key | If enabled | If enabled |
| `LOCAL801_POWER_BI_CONNECTION_ENABLED` | Power BI connection toggle | Must be `0` | Must be `0` until approved |
| `LOCAL801_SENTRY_DSN` | Separate monitoring DSN | Optional | Recommended |

## Authoritative import safety

- The legacy Stage 12 synthetic executor remains disabled in Production.
- Production roster changes use the Stage 14B protected authoritative import gate with protected database mode, protected preparation, and protected execution explicitly enabled.
- Apply and verify every pending Local 801 migration before enabling a newly deployed import schema.
- Migration `0018__member_contact_and_employment_fields.sql` must be applied before deploying the matching application build. It adds Hire Date, Job Status, and labeled protected work, cell, home, and home-email contact records.
- Verify both approved workbook shapes in Preview: the membership update workbook supplies employment and phone fields, and the personal-email workbook supplies Home Email enrichment. Confirm that no raw contact value appears in operational import JSON or logs.

## Encryption-key escrow and recovery

- Vercel `sensitive` variables are write-only operational inputs. The dashboard, owner-authenticated environment API, environment pull, and environment-run commands do not provide the stored value back. Vercel must not be treated as the only escrow for `LOCAL801_ENCRYPTION_MASTER_KEYS` or `LOCAL801_ACTIVE_ENCRYPTION_KEY_VERSION`.
- Generate and retain the exact keyring and active version in an owner-controlled secure vault before entering them in Vercel. Keep at least one independently controlled recovery copy, record a non-secret key fingerprint, and verify that the escrowed copy parses and matches the recorded fingerprint.
- Never commit the keyring, place it in documentation, paste it into issue or workflow logs, or store it in an unencrypted local file.
- For a recovery drill, transfer the escrowed values only to the temporary GitHub Actions drill secrets named by `.github/workflows/local801-r2-recovery.yml`; run `key-read-test`, retain only non-secret evidence, then delete those drill secrets immediately.
- Do not replace an unavailable Production keyring in place. If its independent escrow cannot be located, preserve the current Vercel values and require a separately reviewed in-runtime migration that decrypts each existing object with the still-running application and re-encrypts it under a new, independently escrowed keyring.
