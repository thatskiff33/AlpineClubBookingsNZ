# Finance Dashboard Handoff

Last updated: 2026-04-21

## Current State

- Phase 1 finance access boundary landed via task `#101`
- Merged implementation PR: `#102`
- Planning scaffold task `#103` landed via PR `#104`
- Phase `#93` is closed
- Phase `#94` is closed
- Phase `#95` is closed
- Phase `#96` is closed
- Active phase: `#97`
- Most recent landed task: `#130`
- Merged implementation PR for `#130`: `#132`
- Finance task currently in flight: none
- Single `status: ready` finance task: `#133`
- Operational Xero remains closed on `main`; `docs/XERO_HANDOFF.md` stays unchanged unless new evidence proves a new gap

## What Landed Through Task #130

- Added `src/lib/finance-booking-metrics.ts` as the finance-only TACBookings booking metrics query layer over `Booking`, `BookingGuest`, and `Payment`
- Added the finance-viewer booking metrics route `src/app/api/finance/bookings/metrics/route.ts`
- Extended `src/lib/finance-api-auth.ts` with finance-viewer API authorization alongside the existing finance-manager checks
- Added `src/lib/__tests__/finance-booking-metrics.test.ts` and `src/lib/__tests__/finance-booking-metrics-route.test.ts` for realized status handling, guest-night math, forward pipeline categorisation, viewer authorization, and query validation coverage
- Added `docs/finance-dashboard/finance-booking-metrics-contract.md` and indexed it from `docs/finance-dashboard/README.md`
- Updated `docs/finance-dashboard/data-contracts.md` with the landed nightly revenue allocation and realized/forward date-boundary rules

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
- Investigated task `#122` against the current repo Xero client surface and kept diagnostics UI, manual sync APIs, reporting pages, booking-adapter work, and `docs/XERO_HANDOFF.md` out of scope
- Confirmed the generated Xero Accounting API client in this repo only exposes `getReportAgedPayablesByContact(xeroTenantId, contactId, date?, fromDate?, toDate?)` for aged payables reporting
- Confirmed the official Xero Node accounting docs still document `contactId` as required for `/Reports/AgedPayablesByContact`
- Landed task `#122` via PR `#123` for an organisation-level aged payables finance snapshot
- Registered the `AGED_PAYABLES` scheduled dataset in `src/lib/finance-sync-datasets.ts`
- Extended `src/lib/finance-sync-xero-datasets.ts` so the finance-only open-invoice pagination, currency-safe contact rollups, aged bucket totals, and finance-side rate-limit metering now cover both:
  - `AGED_RECEIVABLES` from open Xero `ACCREC` invoices
  - `AGED_PAYABLES` from open Xero `ACCPAY` invoices
- Extended `src/lib/__tests__/finance-sync-datasets.test.ts` and `src/lib/__tests__/finance-sync-service.test.ts` for aged payables mapping, dataset registration, orchestration, and finance metering coverage
- Updated `docs/finance-dashboard/data-contracts.md` and `docs/finance-dashboard/finance-sync-service-contract.md` for the landed aged payables derivation and scheduled dataset surface
- Opened PR `#123` for task `#122`
- Removed `status: ready` from task `#122` once the work moved in flight to PR `#123`
- Merged task `#122` to `main` via PR `#123`
- Closed task `#122` as completed
- Created follow-up task `#124` under Phase `#95` for accounts payable invoice snapshot sync end-to-end
- Marked `#124` as the single finance task with `status: ready`
- Investigated task `#124` against the current repo Xero invoice surface and kept diagnostics UI, manual sync APIs, reporting pages, booking-adapter work, and `docs/XERO_HANDOFF.md` out of scope
- Landed task `#124` via PR `#127` for an organisation-level accounts payable invoice finance snapshot
- Registered the `ACCOUNTS_PAYABLE_INVOICES` scheduled dataset in `src/lib/finance-sync-datasets.ts`
- Extended `src/lib/finance-sync-xero-datasets.ts` with finance-only accounts payable invoice snapshot mapping from open Xero `ACCPAY` invoices, supplier contact rollups, currency-safe totals, and shared per-run open-invoice caching so payable detail and aged payables reuse the same invoice fetch path
- Extended `src/lib/__tests__/finance-sync-datasets.test.ts` and `src/lib/__tests__/finance-sync-service.test.ts` for payable invoice mapping, dataset registration, shared-fetch orchestration, and finance metering coverage
- Updated `docs/finance-dashboard/data-contracts.md` and `docs/finance-dashboard/finance-sync-service-contract.md` for the landed accounts payable invoice dataset contract
- Opened draft PR `#127` for task `#124`
- Removed `status: ready` from task `#124` once the work moved in flight to PR `#127`
- Merged task `#124` to `main` via PR `#127`
- Closed task `#124` as completed
- Created follow-up task `#126` under Phase `#95` for accounts receivable invoice snapshot sync end-to-end
- Marked `#126` as the single finance task with `status: ready`
- Investigated task `#126` against the current repo Xero invoice surface and kept diagnostics UI, manual sync APIs, reporting pages, booking-adapter work, and `docs/XERO_HANDOFF.md` out of scope
- Landed task `#126` via PR `#128` for an organisation-level accounts receivable invoice finance snapshot
- Registered the `ACCOUNTS_RECEIVABLE_INVOICES` scheduled dataset in `src/lib/finance-sync-datasets.ts`
- Extended `src/lib/finance-sync-xero-datasets.ts` with finance-only accounts receivable invoice snapshot mapping from open Xero `ACCREC` invoices, customer contact rollups, expected payment dates, currency-safe totals, and shared per-run open-invoice caching so receivable detail and aged receivables reuse the same fetch path
- Extended `src/lib/__tests__/finance-sync-datasets.test.ts` and `src/lib/__tests__/finance-sync-service.test.ts` for receivable invoice mapping, dataset registration, shared-fetch orchestration, and finance metering coverage
- Updated `docs/finance-dashboard/data-contracts.md` and `docs/finance-dashboard/finance-sync-service-contract.md` for the landed accounts receivable invoice dataset contract
- Opened draft PR `#128` for task `#126`
- Removed `status: ready` from task `#126` once the work moved in flight to PR `#128`
- Merged task `#126` to `main` via PR `#128`
- Closed task `#126` as completed
- Created follow-up task `#129` under Phase `#95` for finance sync diagnostics status read path end-to-end
- Marked `#129` as the single finance task with `status: ready`
- Investigated task `#129` against the current durable finance sync and cron observability seams and kept diagnostics UI, manual sync APIs, reporting pages, booking-adapter work, and `docs/XERO_HANDOFF.md` out of scope
- Landed task `#129` via PR `#131` for a finance-only sync diagnostics status read path
- Added `src/lib/finance-sync-diagnostics.ts` to compose the latest durable `FinanceSyncRun`, finance cron `CronJobRun`, dataset result summaries, and recent failure context into a stable JSON-safe payload
- Added the finance-manager diagnostics route `src/app/api/finance/sync/status/route.ts`
- Added `src/lib/__tests__/finance-sync-diagnostics.test.ts` and `src/lib/__tests__/finance-sync-diagnostics-route.test.ts` for diagnostics helper normalization, finance-manager authorization, and route response coverage
- Added `docs/finance-dashboard/finance-sync-diagnostics-contract.md` and indexed it from `docs/finance-dashboard/README.md`
- Opened draft PR `#131` for task `#129`
- Removed `status: ready` from task `#129` once the work moved in flight to PR `#131`
- Merged task `#129` to `main` via PR `#131`
- Closed task `#129` as completed
- Closed Phase `#95` as completed
- Created follow-up task `#130` under Phase `#96` for a finance booking metrics adapter query layer
- Marked `#130` as the single finance task with `status: ready`
- Investigated task `#130` against the current TACBookings booking, guest, payment, and finance auth boundaries and kept finance UI pages, charts, reporting-page components, and `docs/XERO_HANDOFF.md` out of scope
- Re-scoped issue `#130` to allow the smallest finance-only read route required to make the booking metrics boundary genuinely queryable in production
- Landed task `#130` via PR `#132` for a finance-only booking metrics adapter and read path
- Added `src/lib/finance-booking-metrics.ts` for JSON-safe realized stay metrics, forward pipeline categorisation, occupancy, and payment-summary queries over TACBookings `Booking`, `BookingGuest`, and `Payment` rows
- Added `src/app/api/finance/bookings/metrics/route.ts` as a finance-viewer read route for the landed booking metrics boundary
- Extended `src/lib/finance-api-auth.ts` with a finance-viewer API guard without broadening manager-only finance mutations
- Added `src/lib/__tests__/finance-booking-metrics.test.ts` and `src/lib/__tests__/finance-booking-metrics-route.test.ts` for status inclusion/exclusion, guest-night math, forward pipeline categorisation, viewer auth, and query validation coverage
- Added `docs/finance-dashboard/finance-booking-metrics-contract.md` and updated `docs/finance-dashboard/README.md` and `docs/finance-dashboard/data-contracts.md` for the landed finance booking metrics boundary
- Opened draft PR `#132` for task `#130`
- Removed `status: ready` from task `#130` once the work moved in flight to PR `#132`
- Merged task `#130` to `main` via PR `#132`
- Closed task `#130` as completed
- Closed Phase `#96` as completed
- Created follow-up task `#133` under Phase `#97` for the finance landing page shell
- Marked `#133` as the single finance task with `status: ready`

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
- Verified `node_modules/xero-node/dist/gen/api/accountingApi.d.ts` exposes only `getReportAgedPayablesByContact(xeroTenantId, contactId, date?, fromDate?, toDate?)` for aged payables reporting
- Verified official Xero Node accounting docs at `https://xeroapi.github.io/xero-node/accounting/index.html#getReportAgedPayablesByContact` list `contactId` as required for `/Reports/AgedPayablesByContact`
- Verified `npx vitest run src/lib/__tests__/finance-sync-datasets.test.ts src/lib/__tests__/finance-sync-service.test.ts`
- Verified `npx eslint src/lib/finance-sync-xero-datasets.ts src/lib/finance-sync-datasets.ts src/lib/__tests__/finance-sync-datasets.test.ts src/lib/__tests__/finance-sync-service.test.ts`
- Verified `npm run build`
- Verified PR `#123` is merged
- Verified issue `#122` is closed as completed
- Verified `npx vitest run src/lib/__tests__/finance-sync-datasets.test.ts src/lib/__tests__/finance-sync-service.test.ts`
- Verified `npx eslint src/lib/finance-sync-xero-datasets.ts src/lib/finance-sync-datasets.ts src/lib/__tests__/finance-sync-datasets.test.ts src/lib/__tests__/finance-sync-service.test.ts`
- Verified `npm run build`
- Verified PR `#127` is merged
- Verified issue `#124` is closed as completed
- Verified `npx vitest run src/lib/__tests__/finance-sync-datasets.test.ts src/lib/__tests__/finance-sync-service.test.ts`
- Verified `npx eslint src/lib/finance-sync-xero-datasets.ts src/lib/finance-sync-datasets.ts src/lib/__tests__/finance-sync-datasets.test.ts src/lib/__tests__/finance-sync-service.test.ts`
- Verified `npm run build`
- Verified PR `#128` is merged
- Verified issue `#126` is closed as completed
- Verified `npx vitest run src/lib/__tests__/finance-sync-diagnostics.test.ts src/lib/__tests__/finance-sync-diagnostics-route.test.ts`
- Verified `npx eslint src/lib/finance-sync-diagnostics.ts src/app/api/finance/sync/status/route.ts src/lib/__tests__/finance-sync-diagnostics.test.ts src/lib/__tests__/finance-sync-diagnostics-route.test.ts`
- Verified `npm run build`
- Verified PR `#131` is merged
- Verified issue `#129` is closed as completed
- Verified issue `#95` is closed as completed
- Verified `npx vitest run src/lib/__tests__/finance-booking-metrics.test.ts src/lib/__tests__/finance-booking-metrics-route.test.ts`
- Verified `npx eslint src/lib/finance-booking-metrics.ts src/lib/finance-api-auth.ts src/app/api/finance/bookings/metrics/route.ts src/lib/__tests__/finance-booking-metrics.test.ts src/lib/__tests__/finance-booking-metrics-route.test.ts`
- Verified `npm run build`
- Verified PR `#132` is merged
- Verified issue `#130` is closed as completed
- Verified issue `#96` is closed as completed
- Verified issue `#133` is open with labels `area: finance`, `type: task`, and `status: ready`
- Verified no other open finance task is marked `status: ready`
- `git diff --check`

What remains:
- Land task `#133` end-to-end in production-ready form using the smallest finance landing page shell that surfaces the landed finance sync and booking metrics boundaries without broadening into full report pages
- Leave revenue/booking report pages, charts, manual sync mutations, and operational Xero behavior for later work unless new evidence proves a gap

Blockers:
- None currently.

## Next Prompt

```text
Use the GitHub workflow for TACBookings finance epic #92.

Work on exactly one task issue only.

1. Read only these sources first:
- docs/finance-dashboard/handoff.md
- docs/finance-dashboard/data-contracts.md
- epic issue #92
- phase issue #97
- ready task issue #133
- merged PR #132

2. Land task `#133` end-to-end in this session:
- treat the goal as shipping a production-ready finance landing page shell, not merely adding placeholder finance copy or navigation links without live finance data
- use the smallest finance-only implementation that turns the landed finance sync diagnostics and booking metrics boundaries into a native `/finance` landing page for viewers and managers
- reuse the landed finance access boundaries, sync-status route, and booking metrics query path where that keeps the implementation smaller and production ready
- if the task wording proves too narrow once implementation starts, update the GitHub task issue to the smallest safe production-ready scope and continue in the same session
- only stop without landing code if a true external blocker remains after exhausting repo code, merged PR context, and any relevant official documentation
- keep docs/XERO_HANDOFF.md unchanged unless current evidence proves a new operational Xero gap

3. Scope the next task tightly:
- do not combine the task with full reporting pages, charts, or speculative phase `#98` work
- do not broaden the task beyond the minimum needed to ship the finance landing shell safely; report implementation, booking type schema changes, manual sync work, and operational Xero changes remain out of scope
- do not reopen operational Xero work unless current evidence proves a new gap

4. Before finishing:
- update docs/finance-dashboard/handoff.md with what landed, what remains, blockers, validation, and the next exact Next Prompt block
- run the targeted tests/lint for touched files and run `npm run build` if runtime paths changed
- do not finish with docs-only blocker notes if the feature can still be landed safely within the task/phase intent
- close task `#133` and create the next finance task only if `#133` fully lands
- otherwise leave the clearest possible external blocker with source evidence and do not start a second task in the same session
- ensure exactly one finance task carries `status: ready` when there is actionable work, and keep that label on the next smallest unblocked task only
- leave docs/XERO_HANDOFF.md unchanged unless new evidence forces it open

5. Work on exactly one task issue only.
```
