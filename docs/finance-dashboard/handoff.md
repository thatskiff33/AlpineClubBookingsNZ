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
- Active finance task in flight: `#110`
- Working branch: `finance/issue-110-route-scaffold`
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
- Landed task `#108` via PR `#109` for finance token storage and separate finance usage metering scaffolding
- Closed out the stale in-flight handoff state for `#105`
- Closed out the `#108` in-flight handoff state now that PR `#109` is merged on `main`
- Added `FINANCE_XERO_ENCRYPTION_KEY` to `.env.example`
- Added finance-only Prisma models for `FinanceXeroToken`, `FinanceXeroApiUsageDaily`, and `FinanceXeroApiUsageEvent`
- Added `src/lib/finance-xero-token-store.ts` for finance-only encrypted token persistence and connection-status scaffolding
- Added `src/lib/finance-xero-api-usage.ts` for finance-only usage event/daily metering scaffolding
- Extended `src/lib/xero-config.ts` and `src/lib/__tests__/xero-config.test.ts` with finance token-storage config validation and no-fallback checks
- Added targeted unit coverage for finance token storage and finance usage metering separation
- Updated `docs/finance-dashboard/finance-xero-config-contract.md` for the finance encryption key and storage/metering boundary
- Created follow-up task `#110` for finance connect/status/disconnect route scaffolding on top of the landed finance storage boundary
- Picked up task `#110` and removed its `status: ready` label while the work is in flight
- Added `src/lib/finance-api-auth.ts` for finance-manager API route authorization without reusing admin-only route guards
- Added `src/lib/finance-xero.ts` for finance-only consent URL, callback token exchange, status summary, and disconnect behavior
- Added `src/lib/finance-xero-oauth-state.ts` for a finance-only OAuth state cookie name and `/api/finance/xero` cookie scope
- Added finance-only manager routes:
  - `src/app/api/finance/xero/connect/route.ts`
  - `src/app/api/finance/xero/status/route.ts`
  - `src/app/api/finance/xero/disconnect/route.ts`
  - `src/app/api/finance/xero/callback/route.ts`
- Added targeted route coverage in `src/lib/__tests__/finance-xero-routes.test.ts` for finance manager authorization, config-gated connect behavior, finance-scoped OAuth state cookies, and callback redirects
- Kept finance sync jobs and `docs/XERO_HANDOFF.md` out of scope

Validation:
- Verified issue `#105` is closed as completed
- Verified PR `#107` is merged
- Verified issue `#108` is closed as completed
- Verified PR `#109` is merged
- Verified issue `#110` is open and no longer carries `status: ready`
- Verified no open finance task is marked `status: ready` while `#110` is in flight
- `npx vitest run src/lib/__tests__/finance-xero-routes.test.ts src/lib/__tests__/finance-auth.test.ts src/lib/__tests__/finance-xero-token-store.test.ts src/lib/__tests__/xero-config.test.ts`
- `npx eslint src/lib/finance-api-auth.ts src/lib/finance-xero-oauth-state.ts src/lib/finance-xero.ts src/app/api/finance/xero/connect/route.ts src/app/api/finance/xero/status/route.ts src/app/api/finance/xero/disconnect/route.ts src/app/api/finance/xero/callback/route.ts src/lib/__tests__/finance-xero-routes.test.ts`
- `git diff --check`

What remains:
- Review and land task `#110`
- Keep any follow-up fixes scoped to the finance manager route/auth/status/disconnect surface plus the minimal callback hook that supports it
- Leave finance sync jobs, broader finance callback/sync orchestration, and operational Xero behavior for later work unless new evidence proves a gap

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
- in-flight task issue #110
- merged PR #109

2. Finish task #110 and keep it tightly scoped:
- keep the work on finance connect/status/disconnect route scaffolding on top of the separate finance token-store boundary from PR #109
- keep finance manager authorization on those routes
- keep finance route wiring separate from operational Xero routes and helpers
- allow only the minimal finance callback hook needed to support the finance connect route; do not pull in finance sync jobs
- run targeted validation for finance route authorization and connection-state behavior
- keep docs/XERO_HANDOFF.md unchanged unless current evidence proves a new operational Xero gap

3. Scope the next task tightly:
- do not combine the task with finance sync jobs
- do not broaden the task into reporting UI or wider finance sync orchestration beyond the minimal finance callback hook already introduced
- do not reopen operational Xero work unless current evidence proves a new gap

4. Before finishing:
- run only the targeted validation needed for touched files; run full build only if the changed files require it
- update docs/finance-dashboard/handoff.md with what landed, what remains, blockers, and the next exact Next Prompt block
- ensure no finance task carries `status: ready` while `#110` is in flight
- close task #110 if it lands and create exactly one new finance task issue under phase #94 for the next smallest remaining gap
- make that new issue the single `status: ready` finance task only after `#110` is fully landed
- leave docs/XERO_HANDOFF.md unchanged unless new evidence forces it open

5. Work on exactly one task issue only.
```
