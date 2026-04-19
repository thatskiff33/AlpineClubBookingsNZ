# Finance Dashboard Handoff

Last updated: 2026-04-19

## Current State

- Phase 1 finance access boundary landed via task `#101`
- Merged implementation PR: `#102`
- Planning scaffold task `#103` landed via PR `#104`
- Phase `#93` is closed
- Active phase: `#94`
- Most recent landed task: `#108`
- Merged implementation PR for `#108`: `#109`
- No finance task is currently in flight
- No finance task is currently marked `status: ready`
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
- Landed task `#108` via PR `#109` for finance token storage and separate finance usage metering scaffolding
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
- Verified PR `#109` is merged
- `npx prisma generate`
- `npx vitest run src/lib/__tests__/xero-config.test.ts src/lib/__tests__/finance-xero-token-store.test.ts src/lib/__tests__/finance-xero-api-usage.test.ts`
- `npx eslint src/lib/xero-config.ts src/lib/finance-xero-token-store.ts src/lib/finance-xero-api-usage.ts src/lib/__tests__/xero-config.test.ts src/lib/__tests__/finance-xero-token-store.test.ts src/lib/__tests__/finance-xero-api-usage.test.ts`
- `git diff --check`

What remains:
- Identify the next smallest remaining Phase 2 gap under issue `#94`
- Create exactly one new finance task issue for that next gap and make it the only `status: ready` finance task
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
- closed task issue #108
- merged PR #109

2. Close out the #108 handoff state and prepare the next Phase 2 task:
- update docs/finance-dashboard/handoff.md so it reflects that task #108 landed via PR #109 and is no longer in flight
- identify the next smallest remaining Phase 2 gap under issue #94
- create exactly one new finance task issue under phase #94 for that next gap
- make that new issue the single `status: ready` finance task
- keep docs/XERO_HANDOFF.md unchanged unless current evidence proves a new operational Xero gap

3. Scope the next task tightly:
- prefer the next slice to be finance connect/status/disconnect route scaffolding on top of the separate finance storage boundary
- do not combine that task with finance sync jobs unless current issue evidence requires it
- do not reopen operational Xero work unless current evidence proves a new gap

4. Before finishing:
- run only the targeted validation needed for touched files; run full build only if the changed files require it
- update docs/finance-dashboard/handoff.md with what landed, what remains, blockers, and the next exact Next Prompt block
- ensure only one finance task carries `status: ready`
- leave docs/XERO_HANDOFF.md unchanged unless new evidence forces it open

5. Work on exactly one task issue only.
```
