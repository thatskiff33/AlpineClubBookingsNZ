# Finance Dashboard Handoff

Last updated: 2026-04-16

## Current State

- Phase 1 finance access boundary is ready to land via task `#101`
- Merged implementation target: PR `#102`
- Parent phase: `#93`
- Follow-up planning scaffold task created: `#103`

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
- Start task `#103` next to restore the repo-side planning scaffold and agent workflow docs in a separate PR

Blockers:
- None

## Next Prompt

```text
Use the GitHub workflow for TACBookings finance epic #92.

Work on exactly one task issue only.

1. Read only these sources first:
- docs/finance-dashboard/handoff.md
- phase issue #93
- task issue #103
- the current PR for #103, if one exists

2. Start task #103 as the single `status: ready` finance task:
- restore the repo-side finance planning scaffold in a dedicated PR
- add the minimal agent workflow docs and prompt pattern there
- keep that work separate from the Phase 1 access-boundary implementation

3. Open or update the dedicated PR for #103 and keep the diff scoped to docs/templates only.

4. Update handoff with the next exact Next Prompt block before ending the session.
```
