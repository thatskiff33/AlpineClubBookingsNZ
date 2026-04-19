# Finance Dashboard Handoff

Last updated: 2026-04-19

## Current State

- Phase 1 finance access boundary landed via task `#101`
- Merged implementation PR: `#102`
- Planning scaffold task `#103` landed via PR `#104`
- Phase `#93` is closed
- Next active phase: `#94`
- Next ready task: `#105`
- Operational Xero remains closed on `main`; `docs/XERO_HANDOFF.md` stays unchanged unless new evidence proves a new gap

## What Landed In Task #103

- Restored the repo-side finance planning scaffold under `docs/finance-dashboard/`
- Restored the finance agent runbook with dispatcher, build, and merge prompt patterns
- Restored finance ADRs, phase map, data contracts, and test-plan reference docs
- Added finance-specific GitHub issue templates plus a finance-only PR template
- Kept the change separate from the Phase 1 finance access-boundary implementation in PR `#102`
- Added one narrow test-only unblocker on PR `#104` after CI exposed an expired hardcoded nomination token date

## Implemented Guard Strategy

- `Member.financeAccessLevel` is the dedicated finance gate, separate from `role`
- finance access is checked server-side from the live `Member` row, not the JWT alone
- `/finance` lives outside the admin-only layout
- unauthenticated users are redirected to `/login` with a `/finance` callback
- users without finance access are redirected to `/dashboard`
- finance viewer and manager checks are separated in `src/lib/finance-auth.ts`

## Immediate Next Step

Done:
- Added the dedicated finance access field on `Member`
- Added finance authorization helpers for viewer and manager access
- Added the `/finance` route scaffold outside the admin-only layout
- Added handoff notes for the implemented guard strategy
- Restored the finance planning scaffold and minimal workflow docs in task `#103`
- Added finance-specific issue templates and a finance-only PR template
- Stabilized the time-dependent nomination expiry test that was failing PR `#104` CI
- Merged PR `#104` to `main`
- Closed task `#103` and closed phase `#93`
- Created task `#105` under phase `#94` and marked it `status: ready`

Validation:
- `git diff --check`
- Manual review of the restored markdown and template files for readability and scope
- `npx vitest run src/lib/__tests__/membership-nomination.test.ts`
- `npx eslint src/lib/__tests__/membership-nomination.test.ts`
- `npm test`
- GitHub Actions `verify` passed on PR `#104` before merge

Next:
- Start task `#105` under phase `#94`
- Keep the change limited to finance Xero env/config boundary scaffolding, related docs, and narrow tests
- Leave operational Xero behavior and `docs/XERO_HANDOFF.md` untouched unless new evidence forces a reopen

Blockers:
- None

## Next Prompt

```text
Use the GitHub workflow for TACBookings finance epic #92.

Work on exactly one task issue only.

1. Read only these sources first:
- docs/finance-dashboard/handoff.md
- docs/XERO_HANDOFF.md
- phase issue #94
- task issue #105
- the current PR for #105, if one exists

2. Start task #105 as the single `status: ready` finance task:
- add finance Xero env/config boundary scaffold
- keep the change limited to config/docs/test scaffolding only
- do not add finance token storage, connect/disconnect routes, or sync jobs yet
- do not reopen operational Xero work unless current evidence proves a new gap

3. Open or update the dedicated PR for #105:
- branch from `main` as `finance/issue-105-xero-config-boundary`
- keep scope tight to env/config helpers, related docs, and narrow tests
- run only the targeted validation needed for touched files; run full build only if the changed files require it

4. Before finishing:
- update docs/finance-dashboard/handoff.md with what landed, what remains, blockers, and the next exact Next Prompt block
- leave docs/XERO_HANDOFF.md unchanged unless new evidence forces it open

5. Work on exactly one task issue only.
```
