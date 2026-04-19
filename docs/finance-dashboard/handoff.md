# Finance Dashboard Handoff

Last updated: 2026-04-19

## Current State

- Phase 1 finance access boundary landed via task `#101`
- Merged implementation PR: `#102`
- Planning scaffold task `#103` landed via PR `#104`
- Phase `#93` is closed
- Active phase: `#94`
- Current in-flight task: `#105`
- No other finance task should start until `#105` is merged or explicitly redirected
- Operational Xero remains closed on `main`; `docs/XERO_HANDOFF.md` stays unchanged unless new evidence proves a new gap

## What Landed In Task #105

- Added finance-only Xero env names to `.env.example`:
  - `FINANCE_XERO_CLIENT_ID`
  - `FINANCE_XERO_CLIENT_SECRET`
  - `FINANCE_XERO_REDIRECT_URI`
- Added `src/lib/xero-config.ts` as the dedicated config boundary for operational vs finance Xero OAuth settings
- Updated `src/lib/xero.ts` to consume the operational config helper instead of reading operational OAuth config directly inline
- Added `docs/finance-dashboard/finance-xero-config-contract.md` and indexed it from `docs/finance-dashboard/README.md`
- Added narrow unit coverage in `src/lib/__tests__/xero-config.test.ts` for finance config separation, missing-config handling, and no-fallback behavior
- Kept finance token storage, finance routes, finance sync jobs, and finance usage persistence out of scope

## Implemented Guard Strategy

- `Member.financeAccessLevel` is the dedicated finance gate, separate from `role`
- finance access is checked server-side from the live `Member` row, not the JWT alone
- `/finance` lives outside the admin-only layout
- unauthenticated users are redirected to `/login` with a `/finance` callback
- users without finance access are redirected to `/dashboard`
- finance viewer and manager checks are separated in `src/lib/finance-auth.ts`

## Immediate Next Step

Done:
- Added finance-only Xero env scaffolding in `.env.example`
- Added a dedicated Xero config helper that separates finance config loading from operational config loading
- Refactored operational `src/lib/xero.ts` to use the helper without reopening operational behavior
- Documented the minimal finance Xero config contract for later token storage and route work
- Added targeted tests for finance config boundary behavior

Validation:
- `git diff --check`
- `npx vitest run src/lib/__tests__/xero-config.test.ts src/lib/__tests__/xero.test.ts`
- `npx eslint src/lib/xero-config.ts src/lib/xero.ts src/lib/__tests__/xero-config.test.ts`

Next:
- Review and merge the dedicated PR for task `#105`
- Keep any follow-up on `#105` limited to env/config helpers, related docs, and narrow tests only
- Leave finance token storage, finance connect/status/disconnect routes, finance sync jobs, and operational Xero behavior for later work

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
- the current PR for #105

2. Continue task #105 on its dedicated branch/PR only:
- review the finance Xero env/config boundary scaffold already added
- keep the change limited to config/docs/test scaffolding only
- do not add finance token storage, connect/disconnect routes, or sync jobs yet
- do not reopen operational Xero work unless current evidence proves a new gap

3. Before finishing:
- run only the targeted validation needed for touched files; run full build only if the changed files require it
- update the dedicated PR for `#105` if scope, docs, or validation evidence changed
- update docs/finance-dashboard/handoff.md with what landed, what remains, blockers, and the next exact Next Prompt block
- leave docs/XERO_HANDOFF.md unchanged unless new evidence forces it open

4. Work on exactly one task issue only.
```
