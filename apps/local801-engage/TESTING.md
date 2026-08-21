# Local 801 Engage Testing

Run from the repository root:

```bash
npm run local801:lint
npm run local801:typecheck
npm run local801:test
npm run local801:db:migrations:verify
npm run local801:build
```

Current tests cover:
- Local `0801` filtering.
- Header mapping.
- Spreadsheet formula neutralization.
- Legacy worksheet classification.
- Missing authoritative identifiers.
- Duplicate identifiers.
- Conflicting duplicate records.
- Formula-safe validation-error CSV.
- Role permission guardrails.
- Audit payload redaction.

Next preview tests should add Playwright coverage for sign-in, protected pages, import upload UI, mobile layout, service-worker cache contents, and unauthorized direct API requests.
