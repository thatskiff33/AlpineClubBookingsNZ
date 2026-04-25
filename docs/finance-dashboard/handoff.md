# Finance Dashboard Handoff

Last updated: 2026-04-25

## Current State

- Phase 1 finance access boundary landed via task `#101`
- Merged implementation PR: `#102`
- Planning scaffold task `#103` landed via PR `#104`
- Phase `#93` is closed
- Phase `#94` is closed
- Phase `#95` is closed
- Phase `#96` is closed
- Phase `#97` is closed
- Phase `#98` is closed
- Phase `#99` is closed
- Active phase: `#100`
- Most recent landed task: `#153`
- Most recent merged implementation PR: `#156`
- Most recent published implementation PR: `#156`
- Finance task currently in flight: none
- Single `status: ready` finance task: `#158`
- Operational Xero remains closed on `main`; `docs/XERO_HANDOFF.md` stays unchanged unless new evidence proves a new gap

## What Landed Through Task #138

- Added `src/lib/__tests__/finance-report-output-validation.test.ts` with representative end-to-end validation coverage that exercises the native bookings and revenue report loaders against the landed booking-metrics and finance-snapshot boundaries
- Hardened `src/lib/finance-revenue-report-page.ts` so malformed `periods` query values such as `6abc`, `3.5`, and `1e2` now fail closed to the default six-period window instead of silently truncating into the wrong snapshot range
- Tightened singular report copy in `src/lib/finance-bookings-report-page.ts` so viewer-facing payment and at-risk pipeline messages stay grammatically correct when validation fixtures cover single-booking cases
- Captured durable phase `#98` validation evidence for representative `/finance/bookings` realized/forward totals and `/finance/revenue` snapshot-backed totals without broadening into phase `#99` reporting work

## What Landed Through Task #140

- Added `src/lib/finance-cash-report-page.ts` as the finance cash report loader/model boundary for durable `BANK_BALANCES` snapshot reads, safe period-filter fallback handling, bank-balance parsing, and viewer-safe unavailable states
- Added `src/app/(finance)/finance/cash/page.tsx` for a native `/finance/cash` report page with summary cards, stored snapshot detail, and bank-account comparison tables
- Updated `src/app/(finance)/finance/page.tsx` so the finance landing page links directly into the new cash report
- Added `src/lib/__tests__/finance-cash-report-page.test.ts` for targeted cash-report loader coverage, invalid-period fallback handling, and safe unavailable states
- Added `docs/finance-dashboard/finance-cash-report-contract.md` and indexed it from `docs/finance-dashboard/README.md`
- Updated `docs/finance-dashboard/data-contracts.md` with the native cash-reporting source-ownership boundary for `BANK_BALANCES`
- Published task `#140` via PR `#142` and merged it to `main`
- Closed task `#140` as completed and created follow-up task `#143` as the single open finance task carrying `status: ready`

## What Landed Through Task #143

- Added `src/lib/finance-balance-sheet-report-page.ts` as the finance balance-sheet report loader/model boundary for durable `BALANCE_SHEET` snapshot reads, safe period-filter fallback handling, section-total parsing, line-item aggregation, and viewer-safe unavailable states
- Added `src/app/(finance)/finance/balance-sheet/page.tsx` for a native `/finance/balance-sheet` report page with summary cards, stored snapshot detail, and grouped balance-sheet line-item comparisons
- Updated `src/app/(finance)/finance/page.tsx` so the finance landing page links directly into the new balance-sheet report
- Added `src/lib/__tests__/finance-balance-sheet-report-page.test.ts` for targeted balance-sheet report loader coverage, invalid-period fallback handling, and safe unavailable states
- Added `docs/finance-dashboard/finance-balance-sheet-report-contract.md` and updated `docs/finance-dashboard/data-contracts.md` for the landed balance-sheet reporting boundary
- Closed task `#143` as completed and created follow-up task `#144` as the single open finance task carrying `status: ready`

## What Landed Through Task #144

- Added `src/lib/finance-costs-report-page.ts` as the finance costs report loader/model boundary for durable `PROFIT_AND_LOSS_MONTHLY` snapshot reads, safe period-filter fallback handling, cost-section parsing, grouped line-item aggregation, and viewer-safe unavailable states
- Added `src/app/(finance)/finance/costs/page.tsx` for a native `/finance/costs` report page with summary cards, monthly snapshot detail, and grouped cost line-item comparisons
- Updated `src/app/(finance)/finance/page.tsx` so the finance landing page links directly into the new costs report
- Added `src/lib/__tests__/finance-costs-report-page.test.ts` for targeted costs-report loader coverage, invalid-period fallback handling, and safe unavailable states
- Added `docs/finance-dashboard/finance-costs-report-contract.md`, indexed it from `docs/finance-dashboard/README.md`, and updated `docs/finance-dashboard/data-contracts.md` with the native costs-reporting source-ownership boundary
- Closed task `#144` as completed and created follow-up task `#146` as the single open finance task carrying `status: ready`

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
- Investigated task `#133` against the landed finance route, access, sync diagnostics, and booking metrics seams and kept report pages, charts, manual sync work, and `docs/XERO_HANDOFF.md` out of scope
- Landed task `#133` via PR `#135` for a native finance landing page shell
- Added `src/lib/finance-landing-page.ts` as the finance landing-page loader/model boundary for NZ-local realized and forward windows plus section-level fallbacks
- Replaced the old `/finance` placeholder in `src/app/(finance)/finance/page.tsx` with live sync-health, realized-stays, forward-pipeline, and data-source sections
- Updated `src/app/(finance)/finance/layout.tsx` copy to reflect the landed finance workspace shell instead of the earlier phase-1 placeholder wording
- Added `src/lib/__tests__/finance-landing-page.test.ts` for manager/viewer affordances, default windows, and degraded-section behavior when a finance boundary fails
- Added `docs/finance-dashboard/finance-landing-page-contract.md` and updated `docs/finance-dashboard/README.md` for the landed finance shell boundary
- Opened draft PR `#135` for task `#133`
- Removed `status: ready` from task `#133` once the work moved in flight to PR `#135`
- Merged task `#133` to `main` via PR `#135`
- Closed task `#133` as completed
- Closed Phase `#97` as completed
- Created follow-up task `#134` under Phase `#98` for the finance bookings report page shell
- Marked `#134` as the single finance task with `status: ready`
- Investigated task `#134` against the landed finance route, access, landing-page, and booking metrics seams and kept charts, finance snapshot-backed revenue pages, manual sync work, and `docs/XERO_HANDOFF.md` out of scope
- Landed task `#134` via PR `#136` for a native finance bookings report page
- Added `src/lib/finance-bookings-report-page.ts` as the finance bookings report loader/model boundary for default windows, query fallback handling, explicit source notes, and realized/forward detail tables
- Added `src/app/(finance)/finance/bookings/page.tsx` for native summary cards, date-filter controls, daily detail tables, and status breakdown tables on `/finance/bookings`
- Updated `src/app/(finance)/finance/page.tsx` so the finance landing page links into the new bookings report with aligned default windows
- Hardened `src/lib/finance-landing-page.ts` to keep viewer-facing finance shell failures on safe fallback copy instead of raw exception text
- Added `src/lib/__tests__/finance-bookings-report-page.test.ts` and updated `src/lib/__tests__/finance-landing-page.test.ts` for bookings-report loader coverage and safe unavailable states
- Added `docs/finance-dashboard/finance-bookings-report-contract.md` and updated `docs/finance-dashboard/README.md` for the landed bookings report boundary
- Opened PR `#136` for task `#134`
- Removed `status: ready` from task `#134` once the work moved in flight to PR `#136`
- Merged task `#134` to `main` via PR `#136`
- Closed task `#134` as completed
- Created follow-up task `#137` under Phase `#98` for the finance revenue report page shell
- Marked `#137` as the single finance task with `status: ready`
- Investigated task `#137` against the landed finance route, access, landing-page, bookings-report, and snapshot-storage seams and kept charts, balance-sheet pages, cash reporting, manual sync work, and `docs/XERO_HANDOFF.md` out of scope
- Landed task `#137` via PR `#139` for a native finance revenue report page
- Added `src/lib/finance-revenue-report-page.ts` as the finance revenue report loader/model boundary for durable monthly snapshot reads, period filter fallback handling, revenue line-item parsing, and viewer-safe unavailable states
- Added `src/app/(finance)/finance/revenue/page.tsx` for native summary cards, monthly snapshot detail, and revenue line-item tables on `/finance/revenue`
- Extended `src/lib/finance-sync-storage.ts` and `src/lib/__tests__/finance-sync-storage.test.ts` with a finance-only payload-bearing snapshot read helper for report pages
- Updated `src/app/(finance)/finance/page.tsx` so the finance landing page links into the new revenue report
- Added `src/lib/__tests__/finance-revenue-report-page.test.ts` for revenue-report loader coverage, invalid period fallback handling, and safe unavailable states
- Added `docs/finance-dashboard/finance-revenue-report-contract.md` and updated `docs/finance-dashboard/README.md` for the landed revenue report boundary
- Opened draft PR `#139` for task `#137`
- Removed `status: ready` from task `#137` once the work moved in flight to PR `#139`
- Merged task `#137` to `main` via PR `#139`
- Closed task `#137` as completed
- Created follow-up task `#138` under Phase `#98` for validation of the native bookings and revenue report outputs
- Marked `#138` as the single finance task with `status: ready`

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
- Verified `npx vitest run src/lib/__tests__/finance-landing-page.test.ts`
- Verified `npx eslint 'src/app/(finance)/finance/page.tsx' 'src/app/(finance)/finance/layout.tsx' src/lib/finance-landing-page.ts src/lib/__tests__/finance-landing-page.test.ts`
- Verified `npm run build`
- Verified PR `#135` is merged
- Verified issue `#133` is closed as completed
- Verified issue `#97` is closed as completed
- Verified `npx vitest run src/lib/__tests__/finance-bookings-report-page.test.ts src/lib/__tests__/finance-landing-page.test.ts`
- Verified `npx eslint 'src/app/(finance)/finance/page.tsx' 'src/app/(finance)/finance/bookings/page.tsx' src/lib/finance-landing-page.ts src/lib/finance-bookings-report-page.ts src/lib/__tests__/finance-landing-page.test.ts src/lib/__tests__/finance-bookings-report-page.test.ts`
- Verified `npm run build`
- Verified PR `#136` is merged
- Verified issue `#134` is closed as completed
- Verified `npx vitest run src/lib/__tests__/finance-revenue-report-page.test.ts src/lib/__tests__/finance-sync-storage.test.ts`
- Verified `npx eslint 'src/app/(finance)/finance/page.tsx' 'src/app/(finance)/finance/revenue/page.tsx' src/lib/finance-revenue-report-page.ts src/lib/finance-sync-storage.ts src/lib/__tests__/finance-revenue-report-page.test.ts src/lib/__tests__/finance-sync-storage.test.ts`
- Verified `git diff --check`
- Verified `npm run build`
- Verified PR `#139` is merged
- Verified issue `#137` is closed as completed
- Verified `npx vitest run src/lib/__tests__/finance-bookings-report-page.test.ts src/lib/__tests__/finance-revenue-report-page.test.ts src/lib/__tests__/finance-booking-metrics.test.ts src/lib/__tests__/finance-sync-storage.test.ts src/lib/__tests__/finance-report-output-validation.test.ts`
- Verified `npx eslint src/lib/finance-bookings-report-page.ts src/lib/finance-revenue-report-page.ts src/lib/__tests__/finance-report-output-validation.test.ts`
- Verified `git diff --check`
- Verified `npm run build`
- Verified PR `#141` is merged
- Verified issue `#138` is closed as completed
- Verified issue `#98` is closed as completed
- Verified `npx vitest run src/lib/__tests__/finance-cash-report-page.test.ts`
- Verified `npx eslint 'src/app/(finance)/finance/page.tsx' 'src/app/(finance)/finance/cash/page.tsx' src/lib/finance-cash-report-page.ts src/lib/__tests__/finance-cash-report-page.test.ts`
- Verified `git diff --check`
- Verified `npm run build`
- Verified PR `#142` is merged
- Verified issue `#140` is closed as completed
- Verified `npx vitest run src/lib/__tests__/finance-balance-sheet-report-page.test.ts`
- Verified `npx eslint 'src/app/(finance)/finance/balance-sheet/page.tsx' src/app/'(finance)'/finance/page.tsx src/lib/finance-balance-sheet-report-page.ts src/lib/__tests__/finance-balance-sheet-report-page.test.ts`
- Verified `git diff --check`
- Verified `npm run build`
- Verified issue `#143` is closed as completed
- Verified `npx vitest run src/lib/__tests__/finance-costs-report-page.test.ts`
- Verified `npx eslint 'src/app/(finance)/finance/costs/page.tsx' src/app/'(finance)'/finance/page.tsx src/lib/finance-costs-report-page.ts src/lib/__tests__/finance-costs-report-page.test.ts`
- Verified `git diff --check`
- Verified `npm run build`
- Verified issue `#144` is closed as completed
- Verified `npx vitest run src/lib/__tests__/finance-cash-report-page.test.ts src/lib/__tests__/finance-balance-sheet-report-page.test.ts src/lib/__tests__/finance-costs-report-page.test.ts src/lib/__tests__/finance-phase99-report-output-validation.test.ts`
- Verified `npx eslint src/lib/__tests__/finance-phase99-report-output-validation.test.ts`
- Verified `git diff --check`
- Verified draft PR `#148` is published for task `#146`
- Verified issue `#146` is closed as completed
- Verified no other open finance task is marked `status: ready`

What landed:
- Published task `#146` via draft PR `#148`
- Closed issue `#146` as completed after publishing the validation-only change
- Added `src/lib/__tests__/finance-phase99-report-output-validation.test.ts` with representative phase `#99` validation coverage for the native `/finance/cash`, `/finance/balance-sheet`, and `/finance/costs` report loaders
- Captured durable in-repo evidence that the landed cash report output stays aligned with stored `BANK_BALANCES` snapshot totals and account-level summary rows for representative periods
- Captured durable in-repo evidence that the landed balance-sheet report output stays aligned with stored `BALANCE_SHEET` snapshot totals and grouped line-item detail for representative periods
- Captured durable in-repo evidence that the landed costs report output stays aligned with stored `PROFIT_AND_LOSS_MONTHLY` snapshot totals and grouped cost-line detail for representative periods
- Confirmed the representative phase `#99` validation pass did not expose a narrow loader discrepancy, so no runtime report-page changes were required in the same slice
- Reassessed the next smallest phase `#99` follow-up after `#146` and created task `#151` as the smallest implementation-ready pricing-sensitivity slice
- Added `src/lib/finance-pricing-sensitivity-page.ts` as the native pricing-sensitivity loader/model boundary that combines stored `PROFIT_AND_LOSS_MONTHLY` finance snapshots with TACBookings realized booking metrics
- Added `src/app/(finance)/finance/pricing-sensitivity/page.tsx` for a native `/finance/pricing-sensitivity` report page with summary cards, monthly comparison detail, and explicit occupancy-assumption scenario rows
- Updated `src/app/(finance)/finance/page.tsx` so the finance landing page links into the new pricing-sensitivity report
- Reused the landed monthly cost parsing seam by exporting the narrow snapshot summary helper from `src/lib/finance-costs-report-page.ts`
- Added `src/lib/__tests__/finance-pricing-sensitivity-page.test.ts` for matched monthly window coverage, scenario math, invalid-filter fallback handling, and fail-soft month skipping
- Added `docs/finance-dashboard/finance-pricing-sensitivity-report-contract.md` and updated `docs/finance-dashboard/README.md` plus `docs/finance-dashboard/data-contracts.md` for the explicit pricing-sensitivity contract and non-goals
- Opened draft PR `#152` for task `#151`
- Removed `status: ready` from issue `#151` and moved it to `status: in-progress` once the work was pushed to PR `#152`
- Validated the task diff with:
  - `npx vitest run src/lib/__tests__/finance-pricing-sensitivity-page.test.ts src/lib/__tests__/finance-costs-report-page.test.ts`
  - `npx eslint 'src/app/(finance)/finance/pricing-sensitivity/page.tsx' src/app/'(finance)'/finance/page.tsx src/lib/finance-pricing-sensitivity-page.ts src/lib/finance-costs-report-page.ts src/lib/__tests__/finance-pricing-sensitivity-page.test.ts`
  - `git diff --check`
  - `npm run build` after temporarily stashing unrelated local admin-Xero workspace changes that are outside task `#151` and not part of PR `#152`
- Merged PR `#152` into `main`
- Closed task `#151` as completed with a minimal Done/Validation/Next/Blockers issue comment
- Added a short phase-progress comment to issue `#99`
- Reassessed the next smallest concrete phase `#99` follow-up and created task `#153` as the single `status: ready` finance task for the native working-capital report shell
- Added `src/lib/finance-working-capital-report-page.ts` as the native working-capital loader/model boundary backed by stored `BALANCE_SHEET` finance snapshots and the landed balance-sheet parsing seam
- Added `src/app/(finance)/finance/working-capital/page.tsx` for a native `/finance/working-capital` report page with summary cards, explicit current-section assumptions, and stored period comparison detail
- Extended `src/lib/finance-balance-sheet-report-page.ts` with the narrow exported snapshot parser reused by the new working-capital page for current-asset and current-liability section totals
- Updated `src/app/(finance)/finance/page.tsx` so the finance landing page links into the new working-capital report
- Added `src/lib/__tests__/finance-working-capital-report-page.test.ts` for current-section parsing, current-ratio handling, invalid-filter fallback, and fail-soft snapshot skipping coverage
- Added `docs/finance-dashboard/finance-working-capital-report-contract.md` and updated `docs/finance-dashboard/README.md` plus `docs/finance-dashboard/data-contracts.md` for the explicit working-capital contract and non-goals
- Opened draft PR `#156` for task `#153`
- Added `status: in-progress` to issue `#153` and left a minimal implementation-progress comment there
- Validated the task diff with:
  - `npx vitest run src/lib/__tests__/finance-working-capital-report-page.test.ts src/lib/__tests__/finance-balance-sheet-report-page.test.ts`
  - `npx eslint 'src/app/(finance)/finance/working-capital/page.tsx' src/app/'(finance)'/finance/page.tsx src/lib/finance-working-capital-report-page.ts src/lib/finance-balance-sheet-report-page.ts src/lib/__tests__/finance-working-capital-report-page.test.ts`
  - `git diff --check`
  - `npm run build` after temporarily applying the finance diff in the main checkout because Turbopack rejects a worktree-local `node_modules` symlink outside the project root, then restoring the unrelated admin-Xero WIP state
- Merged PR `#156` into `main` as commit `8b970c8`
- Deleted remote branch `finance/issue-153-working-capital-report-shell` after the squash merge
- Closed task `#153` as completed and removed its `status: in-progress` label
- Closed phase `#99` as completed now that the native finance reporting slice is landed
- Created task `#158` as the single `status: ready` finance task for the phase `#100` rollout and cutover checklist boundary

What remains:
- Pick up task `#158` from current `main` and keep the slice documentation-first unless repo evidence forces a narrow supporting change

Blockers:
- None on the finance dashboard path itself
- The shared local workspace still contains unrelated admin-Xero changes on a separate WIP branch; keep them out of finance follow-up work and prefer a clean checkout or worktree for task `#158`

## Next Prompt

```text
Use the GitHub workflow for TACBookings finance epic #92.

Implement the current ready finance task only.

1. Read only these sources first:
- docs/finance-dashboard/README.md
- docs/finance-dashboard/handoff.md
- phase issue #100
- task issue #158
- docs/finance-dashboard/phases.md
- docs/finance-dashboard/test-plan.md

Read docs/finance-dashboard/data-contracts.md only if the rollout checklist needs an exact source-of-truth reference for a landed finance surface.
Read docs/XERO_HANDOFF.md only if current repo evidence forces finance rollout notes to reopen Xero-specific operational scope.

2. Reconfirm scope before editing:
- task `#158` stays focused on a concrete rollout or cutover checklist for phase `#100`
- keep the slice documentation-first unless current repo evidence proves a narrow supporting docs update is required
- do not broaden into executing rollout steps, changing access, or retiring the legacy dashboard in the same task

3. Implement task `#158` end-to-end:
- add the smallest production-ready finance rollout or cutover checklist under `docs/finance-dashboard/`
- capture explicit UAT gates across finance access, sync health, and the landed native report surfaces from phases `#93`-`#99`
- document the minimum rollback notes and legacy-dashboard freeze criteria needed before cutover
- update `docs/finance-dashboard/README.md` and this handoff so the rollout checklist is indexed and the next run starts from current reality
- use a clean checkout or worktree if local validation needs to avoid the unrelated admin-Xero WIP branch

4. Validate lightly and publish:
- run only the lightweight docs validation the touched paths actually require
- open a scoped PR linked to `#158`
- keep notes explicit about UAT gates, rollback assumptions, and non-goals

5. Keep handoff minimal:
- Done:
- Validation:
- Next:
- Blockers:
```
