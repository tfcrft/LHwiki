---
name: lhwiki-publish-pr
description: Publish accepted LHwiki website updates from the canonical campus-notes source to a safe GitHub pull request. Use after every LHwiki website change unless the user explicitly requests local-only, no-push, or no-PR work; do not use for production deployment or database operations.
---

# Publish LHwiki updates

Run the deterministic project script from the canonical source directory:

```powershell
pwsh.exe -NoProfile -File ".\scripts\publish-github-pr.ps1"
```

The script owns Syncthing and conflict checks, GitHub `main` refresh, release-branch creation, public-file allowlist synchronization, tests, sensitive-file checks, explicit staging, commit, push, and PR creation. It must stop on any failed guard. Do not reproduce those mechanics manually unless repairing the script itself.

Keep this workflow inside the current LHwiki project task. Report the PR URL, branch, commit, and checks. Do not deploy production, run migrations, copy backups, force-push, or merge the PR. Merging still requires the user's separate confirmation for the exact ready head.

For a read-only rehearsal that prepares an inspectable checkout without committing, pushing, or opening a PR, pass `-PrepareOnly`. If the user explicitly asks for local-only, no-push, or no-PR work, do not run the publishing mode.
