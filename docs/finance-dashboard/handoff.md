# Finance Dashboard Handoff

Last updated: 2026-04-19

## Current State

- Phase 1 finance access boundary landed via task `#101`
- Merged implementation PR: `#102`
- Planning scaffold task `#103` landed via PR `#104`
- Phase `#93` is closed
- Active phase: `#94`
- Most recent landed task: `#105`
- Merged implementation PR for `#105`: `#107`
- Current in-flight task: `#108`
- Dedicated branch for `#108`: `finance/issue-108-token-storage-metering`
- No finance task should remain `status: ready` while `#108` is in flight
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
- Confirmed task `#105` landed on `main` via merged PR `#107`
- Closed out the stale in-flight handoff state for `#105`
- Created task `#108` under phase `#94` for finance token storage and separate finance usage metering scaffolding
- Added `FINANCE_XERO_ENCRYPTION_KEY` to `.env.example`
- Added finance-only Prisma models for `FinanceXeroToken`, `FinanceXeroApiUsageDaily`, and `FinanceXeroApiUsageEvent`
- Added `src/lib/finance-xero-token-store.ts` for finance-only encrypted token persistence and connection-status scaffolding
- Added `src/lib/finance-xero-api-usage.ts` for finance-only usage event/daily metering scaffolding
- Extended `src/lib/xero-config.ts` and `src/lib/__tests__/xero-config.test.ts` with finance token-storage config validation and no-fallback checks
- Added targeted unit coverage for finance token storage and finance usage metering separation
- Updated `docs/finance-dashboard/finance-xero-config-contract.md` for the finance encryption key and storage/metering boundary
- Kept finance connect/callback/status/disconnect routes, finance sync jobs, and `docs/XERO_HANDOFF.md` out of scope

Validation:
- Verified issue `#105` is closed as completed
- Verified PR `#107` is merged
- `npx prisma generate`
- `npx vitest run src/lib/__tests__/xero-config.test.ts src/lib/__tests__/finance-xero-token-store.test.ts src/lib/__tests__/finance-xero-api-usage.test.ts`
- `npx eslint src/lib/xero-config.ts src/lib/finance-xero-token-store.ts src/lib/finance-xero-api-usage.ts src/lib/__tests__/xero-config.test.ts src/lib/__tests__/finance-xero-token-store.test.ts src/lib/__tests__/finance-xero-api-usage.test.ts`
- `git diff --check`

What remains:
- Open or update the dedicated PR for task `#108`
- Review the finance-only storage and metering scaffold for naming, migration shape, and test coverage
- Add finance connect/callback/status/disconnect routes in a later task once this storage boundary is merged
- Leave finance sync jobs and operational Xero behavior for later work

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
- closed task issue #105
- merged PR #107
- task issue #108
- the current branch or PR for #108, if one exists

2. Continue task #108 on its dedicated branch/PR only:
- review the finance-specific token storage and separate finance usage metering scaffold already added
- keep the diff limited to schema/storage/metering/docs/tests only
- do not add finance connect/callback/status/disconnect routes in this task
- do not reopen operational Xero work unless current evidence proves a new gap

3. Before finishing:
- run only the targeted validation needed for touched files; run full build only if the changed files require it
- update docs/finance-dashboard/handoff.md with what landed, what remains, blockers, and the next exact Next Prompt block
- ensure no other finance task is moved to `status: ready` while `#108` remains in flight
- leave docs/XERO_HANDOFF.md unchanged unless new evidence forces it open

4. Work on exactly one task issue only.
```
