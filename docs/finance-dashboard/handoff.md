# Finance Dashboard Handoff

Last updated: 2026-04-16

## Current State

- Phase 1 task `#101` implements the finance access boundary inside TACBookings
- Active PR: `#102`
- Parent phase: `#93`

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

Validation:
- `npx prisma format`
- `npx prisma generate`
- `npx vitest run src/lib/__tests__/finance-auth.test.ts`
- `npx eslint src/lib/finance-auth.ts 'src/app/(authenticated)/layout.tsx' 'src/app/(finance)/finance/layout.tsx' 'src/app/(finance)/finance/page.tsx' src/components/nav-bar.tsx src/lib/__tests__/finance-auth.test.ts`
- `npm run build`

Next:
- Merge PR `#102` if the diff remains scoped to task `#101`
- After merge, create a separate task for the broader finance planning scaffold and repo workflow docs

Blockers:
- None

## Next Prompt

```text
Use the GitHub workflow for TACBookings finance epic #92.

Run the merge-review stage for task #101 and PR #102 only.

1. Read only these sources first:
- docs/finance-dashboard/handoff.md
- phase issue #93
- task issue #101
- PR #102

2. Verify all merge gates:
- task acceptance criteria for #101 are complete
- local validation in PR #102 is still valid for the current diff
- PR checks are green
- no unresolved blocker comments or requested changes remain
- branch is up to date with main
- diff is scoped to #101

3. If any gate fails:
- do not merge
- leave the PR open
- update handoff with blockers and write the next exact Next Prompt block

4. If all gates pass:
- squash merge PR #102 to main
- delete the remote branch
- sync local main
- close #101 with a short completion comment
- add a short progress comment to #93
- create a separate narrow finance task for the planning scaffold and repo workflow docs
- mark that next task as status: ready
- update handoff with the next exact Next Prompt block
```
