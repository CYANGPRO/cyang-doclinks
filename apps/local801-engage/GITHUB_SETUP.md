# GitHub Repository Setup

Target repository: `cyang-cat-data`

Fallback repository name: `cat-data-management`

## Required Settings

Create the repository under Chang Yang's GitHub account or organization. The repository must be private and Chang Yang must have administrator and recovery access.

Settings to configure in GitHub:

1. Repository visibility: Settings -> General -> Danger Zone -> Change visibility -> Private.
2. Default branch: Settings -> Branches -> Default branch -> `main`.
3. Branch protection: Settings -> Branches -> Branch protection rules -> Add rule for `main`.
4. Enable "Require a pull request before merging" when practical.
5. Enable "Require status checks to pass before merging" and select the CI checks from `.github/workflows/ci.yml`.
6. Enable "Require branches to be up to date before merging" when practical.
7. Enable "Do not allow bypassing the above settings" unless Chang Yang chooses an emergency-owner bypass.
8. Disable force pushes for `main`.
9. Prevent branch deletion for `main`.
10. Enable secret scanning: Settings -> Code security and analysis -> Secret scanning.
11. Enable push protection if available.
12. Enable Dependabot alerts and security updates.

Do not commit deployment tokens, provider API keys, database URLs, R2 keys, authentication secrets, encryption keys, real member data, generated exports, uploaded spreadsheets, database dumps, or local logs.

## CLI Commands When GitHub CLI Is Installed

```bash
gh repo create cyang-cat-data --private --source . --remote origin --push
```

If the preferred name is unavailable:

```bash
gh repo create cat-data-management --private --source . --remote origin --push
```
