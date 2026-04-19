# Finance Dashboard Handoff

Last updated: 2026-04-19

## Current State

- Phase 1 finance access boundary landed via task `#101`
- Merged implementation PR: `#102`
- Parent phase: `#93`
- Follow-up planning scaffold task: `#103`
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

Validation:
- `git diff --check`
- Manual review of the restored markdown and template files for readability and scope
- `npx vitest run src/lib/__tests__/membership-nomination.test.ts`
- `npx eslint src/lib/__tests__/membership-nomination.test.ts`
- `npm test`

Next:
- Watch the new `verify` run on PR `#104`
- Re-run merge review for task `#103` once the current PR head is green
- Decide whether to keep the nomination-test unblocker on `#104` or split it out if strict docs/templates-only scope is still required
- After `#103` merges, create the next narrow finance task under phase `#94`

Blockers:
- PR `#104` is waiting on the new `verify` run for the current head commit

## Next Prompt

```text
Use the GitHub workflow for TACBookings finance epic #92.

Work on exactly one task issue only.

1. Read only these sources first:
- docs/finance-dashboard/handoff.md
- docs/XERO_HANDOFF.md
- phase issue #93
- task issue #103
- the current PR for #103

2. Run the merge-review stage for task #103 only:
- verify the diff is limited to the finance scaffold changes plus the narrow nomination-test CI unblocker now on the branch
- verify the handoff and prompt pattern are updated
- inspect the current `verify` workflow status on the PR head
- merge only if the PR is clean and all required checks are satisfied

3. If the PR is not merge-ready:
- leave it open
- note the blocker briefly on the PR
- update docs/finance-dashboard/handoff.md with the blocker and the next exact Next Prompt block

4. If the PR is merge-ready:
- squash merge it
- update task #103 and phase #93 with short progress notes
- set the next narrow finance task under phase `#94` as the single `status: ready` task
- update docs/finance-dashboard/handoff.md with what landed and the next exact Next Prompt block

5. Leave docs/XERO_HANDOFF.md unchanged unless new evidence forces it open.
```
