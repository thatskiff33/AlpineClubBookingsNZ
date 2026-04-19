# Finance Dashboard Handoff

Last updated: 2026-04-20

## Current State

- Phase 1 finance access boundary landed via task `#101`
- Merged implementation PR: `#102`
- Planning scaffold task `#103` landed via PR `#104`
- Phase `#93` is closed
- Phase `#94` is closed
- Active phase: `#95`
- Most recent landed task: `#120`
- Merged implementation PR for `#120`: `#121`
- Finance task currently in flight: none
- Single `status: ready` finance task: `#122`
- Operational Xero remains closed on `main`; `docs/XERO_HANDOFF.md` stays unchanged unless new evidence proves a new gap

## What Landed Through Task #120

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
- Merged task `#110` to `main` via PR `#111`
- Closed task `#110` as completed
- Closed Phase `#94` as completed
- Created follow-up task `#112` under Phase `#95` for finance snapshot schema and sync-run storage scaffolding
- Marked `#112` as the single finance task with `status: ready`
- Added finance snapshot enums and Prisma models for `FinanceSyncRun` and `FinanceSnapshot`
- Added the Prisma migration `20260419140000_add_finance_snapshot_and_sync_run_storage`
- Added `src/lib/finance-sync-storage.ts` for finance-only snapshot upserts plus sync-run lifecycle storage helpers
- Added `src/lib/__tests__/finance-sync-storage.test.ts` for targeted finance snapshot and sync-run storage coverage
- Added `docs/finance-dashboard/finance-snapshot-storage-contract.md` and indexed it from `docs/finance-dashboard/README.md`
- Updated `docs/finance-dashboard/data-contracts.md` with the generic `FinanceSnapshot` / `FinanceSyncRun` storage boundary
- Merged task `#112` to `main` via PR `#114`
- Closed task `#112` as completed
- Created follow-up task `#113` under Phase `#95` for finance snapshot sync service scaffolding
- Marked `#113` as the single finance task with `status: ready`
- Added `src/lib/finance-sync-service.ts` as the finance-only sync service boundary on top of `FinanceSyncRun` and `FinanceSnapshot`
- Added `src/lib/__tests__/finance-sync-service.test.ts` for targeted service orchestration, partial-failure, and finance-Xero connection coverage
- Added `docs/finance-dashboard/finance-sync-service-contract.md` and indexed it from `docs/finance-dashboard/README.md`
- Updated `docs/finance-dashboard/finance-snapshot-storage-contract.md` to point future orchestration work at the landed finance sync service layer
- Merged task `#113` to `main` via PR `#116`
- Closed task `#113` as completed
- Created follow-up task `#115` under Phase `#95` for daily finance cron registration and overlap-safe runner wiring
- Marked `#115` as the single finance task with `status: ready`
- Added `src/lib/finance-sync-datasets.ts` as the scheduled finance dataset registry seam with a bootstrap zero-snapshot dataset
- Added `src/lib/finance-sync-cron.ts` for the daily finance sync schedule metadata, overlap-safe runner, Sentry check-ins, and `CronJobRun` recording around `runFinanceSync`
- Registered the daily finance sync cron entry in `src/instrumentation.ts`
- Added `src/lib/__tests__/finance-sync-cron.test.ts` for schedule registration, overlap skip, success, and partial-result mapping coverage
- Added `docs/finance-dashboard/finance-sync-cron-contract.md` and indexed it from `docs/finance-dashboard/README.md`
- Updated `docs/finance-dashboard/finance-sync-service-contract.md` to point scheduled execution at the separate cron layer
- Merged task `#115` to `main` via PR `#117`
- Closed task `#115` as completed
- Created follow-up task `#118` under Phase `#95` for first finance Xero snapshot dataset handlers
- Marked `#118` as the single finance task with `status: ready`
- Kept diagnostics UI, manual sync route handlers, reporting-page work, and `docs/XERO_HANDOFF.md` out of scope
- Replaced the bootstrap dataset seam in `src/lib/finance-sync-datasets.ts` with the first concrete finance Xero report handlers for:
  - `PROFIT_AND_LOSS_MONTHLY`
  - `BALANCE_SHEET`
  - `BANK_BALANCES`
- Added `src/lib/finance-sync-xero-datasets.ts` for finance-only report-window derivation, JSON-safe Xero report-to-snapshot mapping, and finance usage metering around scheduled report fetches
- Added `src/lib/__tests__/finance-sync-datasets.test.ts` for dataset registration, mapping, finance report window, and usage-metering coverage
- Extended `src/lib/__tests__/finance-sync-service.test.ts` with a targeted real-registry orchestration check to confirm the registered finance datasets still persist through `runFinanceSync` into `FinanceSnapshot`
- Updated `docs/finance-dashboard/finance-sync-service-contract.md` and `docs/finance-dashboard/finance-sync-cron-contract.md` for the landed first report-based dataset surface
- Fixed the finance sync build blockers that surfaced during PR `#119` by:
  - wrapping the new Xero report calls with `callXeroApi` so the wrapper audit stays green
  - normalizing finance sync run summaries into Prisma JSON-safe objects
  - relaxing the storage input status annotation to the generated `FinanceSyncRunStatus` union while keeping the runtime guard intact
- Merged task `#118` to `main` via PR `#119`
- Closed task `#118` as completed
- Created follow-up task `#120` under Phase `#95` for a single aged receivables dataset handler
- Marked `#120` as the single finance task with `status: ready`
- Investigated task `#120` against the current repo Xero client surface and kept diagnostics UI, manual sync APIs, reporting pages, booking-adapter work, and `docs/XERO_HANDOFF.md` out of scope
- Confirmed the generated Xero Accounting API client in this repo only exposes `getReportAgedReceivablesByContact(xeroTenantId, contactId, date?, fromDate?, toDate?)`
- Confirmed the generated client marks `contactId` as required, so the current task cannot fetch an organisation-wide aged receivables snapshot without either:
  - broadening into contact enumeration or invoice-detail precursor work, or
  - relying on unverified raw API behavior outside the generated client contract
- Verified the official Xero Node accounting docs still document `contactId` as required for `/Reports/AgedReceivablesByContact`
- Re-scoped issue `#120` so the next implementation session is expected to self-resolve the current Xero API mismatch instead of stopping at the first SDK-level blocker
- Restored `status: ready` to issue `#120` after tightening the task around autonomous, production-ready delivery
- Updated the finance epic/phase/task wording plus this handoff prompt so overnight runs are expected to keep working until the feature is mergeable unless a true external blocker remains after exhausting repo and official API evidence
- Landed task `#120` via PR `#121` for an organisation-level aged receivables finance snapshot
- Registered the `AGED_RECEIVABLES` scheduled dataset in `src/lib/finance-sync-datasets.ts`
- Extended `src/lib/finance-sync-xero-datasets.ts` with:
  - finance-only open-invoice pagination for Xero `ACCREC` invoices
  - currency-safe contact rollups and aged bucket totals for the organisation-level snapshot
  - finance-side rate-limit metering that preserves observed rate-limit categories on successful retries and daily-limit cooldown failures
- Extended `src/lib/__tests__/finance-sync-datasets.test.ts` and `src/lib/__tests__/finance-sync-service.test.ts` for aged receivables mapping, dataset registration, orchestration, and finance metering coverage
- Updated `docs/finance-dashboard/data-contracts.md` and `docs/finance-dashboard/finance-sync-service-contract.md` for the landed aged receivables derivation and scheduled dataset surface
- Opened draft PR `#121` for task `#120`
- Merged task `#120` to `main` via PR `#121`
- Closed task `#120` as completed
- Created follow-up task `#122` under Phase `#95` for aged payables finance snapshot sync end-to-end
- Marked `#122` as the single finance task with `status: ready`

Validation:
- Verified issue `#105` is closed as completed
- Verified PR `#107` is merged
- Verified issue `#108` is closed as completed
- Verified PR `#109` is merged
- Verified PR `#111` is merged
- Verified issue `#110` is closed as completed
- Verified issue `#94` is closed as completed
- Verified `npx prisma generate`
- Verified `npx vitest run src/lib/__tests__/finance-sync-storage.test.ts`
- Verified `npx eslint src/lib/finance-sync-storage.ts src/lib/__tests__/finance-sync-storage.test.ts`
- Verified PR `#114` is merged
- Verified issue `#112` is closed as completed
- Verified `npx vitest run src/lib/__tests__/finance-sync-service.test.ts`
- Verified `npx eslint src/lib/finance-sync-service.ts src/lib/__tests__/finance-sync-service.test.ts`
- Verified PR `#116` is merged
- Verified issue `#113` is closed as completed
- Verified `npx vitest run src/lib/__tests__/finance-sync-cron.test.ts src/lib/__tests__/finance-sync-service.test.ts`
- Verified `npx eslint src/instrumentation.ts src/lib/finance-sync-cron.ts src/lib/finance-sync-datasets.ts src/lib/__tests__/finance-sync-cron.test.ts`
- Verified PR `#117` is merged
- Verified issue `#115` is closed as completed
- Verified `npx vitest run src/lib/__tests__/finance-sync-datasets.test.ts src/lib/__tests__/finance-sync-service.test.ts`
- Verified `npx eslint src/lib/finance-sync-xero-datasets.ts src/lib/finance-sync-datasets.ts src/lib/__tests__/finance-sync-datasets.test.ts src/lib/__tests__/finance-sync-service.test.ts`
- Verified `npx vitest run src/lib/__tests__/finance-sync-datasets.test.ts src/lib/__tests__/finance-sync-service.test.ts src/lib/__tests__/xero-wrapper-audit.test.ts`
- Verified `npx vitest run src/lib/__tests__/finance-sync-storage.test.ts src/lib/__tests__/finance-sync-service.test.ts`
- Verified `npx eslint src/lib/finance-sync-service.ts src/lib/finance-sync-storage.ts src/lib/finance-sync-xero-datasets.ts src/lib/finance-sync-datasets.ts src/lib/__tests__/finance-sync-datasets.test.ts src/lib/__tests__/finance-sync-service.test.ts`
- Verified `npm run build`
- Verified PR `#119` is merged
- Verified issue `#118` is closed as completed
- Verified `npx vitest run src/lib/__tests__/finance-sync-datasets.test.ts src/lib/__tests__/finance-sync-service.test.ts`
- Verified `npx eslint src/lib/finance-sync-xero-datasets.ts src/lib/finance-sync-datasets.ts src/lib/__tests__/finance-sync-datasets.test.ts src/lib/__tests__/finance-sync-service.test.ts`
- Verified `npm run build`
- Verified PR `#121` is merged
- Verified issue `#120` is closed as completed
- Verified issue `#122` is open with labels `area: finance`, `type: task`, and `status: ready`
- Verified no other open finance task is marked `status: ready`
- `git diff --check`

What remains:
- Land task `#122` end-to-end in production-ready form using the smallest finance-only implementation that can produce an organisation-level aged payables snapshot with the current Xero surface
- Leave diagnostics UI, manual sync APIs, reporting pages, booking-adapter work, and operational Xero behavior for later work unless new evidence proves a gap

Blockers:
- None currently.

## Next Prompt

```text
Use the GitHub workflow for TACBookings finance epic #92.

Work on exactly one task issue only.

1. Read only these sources first:
- docs/finance-dashboard/handoff.md
- epic issue #92
- phase issue #95
- ready task issue #122
- merged PR #121

2. Land task `#122` end-to-end in this session:
- treat the goal as shipping a production-ready organisation-level aged payables finance snapshot, not merely documenting local SDK limitations
- use the smallest finance-only implementation that works against the current verified Xero surface
- if `AgedPayablesByContact` still requires `contactId`, keep working and solve that inside the task with the minimum necessary finance-only contact lookup/fan-out/aggregation rather than stopping at the mismatch
- if the task wording proves too narrow once implementation starts, update the GitHub task issue to the smallest safe production-ready scope and continue in the same session
- only stop without landing code if a true external blocker remains after exhausting repo code, merged PR context, and official Xero API/client documentation
- keep docs/XERO_HANDOFF.md unchanged unless current evidence proves a new operational Xero gap

3. Scope the next task tightly:
- do not combine the task with diagnostics UI, diagnostics route handlers, manual sync route handlers, or reporting-page work
- do not broaden the task beyond the minimum needed to ship aged payables safely; aged receivables, unrelated bank transaction work, booking-adapter work, and finance shell pages remain out of scope
- do not reopen operational Xero work unless current evidence proves a new gap

4. Before finishing:
- update docs/finance-dashboard/handoff.md with what landed, what remains, blockers, validation, and the next exact Next Prompt block
- run the targeted tests/lint for touched files and run `npm run build` if runtime paths changed
- do not finish with docs-only blocker notes if the feature can still be landed safely within the task/phase intent
- close task `#122` and create the next finance task only if `#122` fully lands
- otherwise leave the clearest possible external blocker with source evidence and do not start a second task in the same session
- ensure exactly one finance task carries `status: ready` when there is actionable work, and keep that label on the next smallest unblocked task only
- leave docs/XERO_HANDOFF.md unchanged unless new evidence forces it open

5. Work on exactly one task issue only.
```
