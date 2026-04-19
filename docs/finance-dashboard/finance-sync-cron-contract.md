# Finance Sync Cron Contract

This document defines the scheduled execution layer that sits on top of the reusable finance sync service boundary.

It is intentionally narrow. The cron layer owns schedule metadata, in-process overlap protection, generic cron observability, and the handoff into the durable finance sync service. It does not own concrete finance dataset fetchers, diagnostics UI, or reporting pages.

## Registration Boundary

- `src/instrumentation.ts` registers the daily finance sync job exactly once when the Node.js server starts.
- `src/lib/finance-sync-cron.ts` owns the schedule constants, Sentry monitor check-ins, overlap-safe runner, and `CronJobRun` recording for the finance sync cron.
- `src/lib/finance-sync-service.ts` remains the durable workflow boundary for `FinanceSyncRun` creation and snapshot persistence.

## Schedule

- job name: `finance-daily-sync`
- monitor slug: `finance-daily-sync`
- schedule: `15 10 * * *`
- timezone: `Pacific/Auckland`

## Runner Behavior

- The scheduled runner calls `runFinanceSync` with `FinanceSyncRunTrigger.SCHEDULED`.
- The runner records generic cron outcomes in `CronJobRun` as `SUCCESS`, `FAILURE`, or `SKIPPED`.
- `FinanceSyncRun` remains the source of truth for the detailed finance workflow result (`SUCCEEDED`, `PARTIAL`, or `FAILED`).
- If another finance sync cron run is already active in the same process, the overlapping invocation is skipped and recorded as `SKIPPED` without creating a second `FinanceSyncRun`.
- If the finance sync service returns `PARTIAL`, the cron layer records a generic cron `FAILURE` while preserving the detailed `PARTIAL` status in `FinanceSyncRun`.

## Dataset Registration Seam

- `src/lib/finance-sync-datasets.ts` is the narrow seam where scheduled finance datasets are registered.
- The registry now includes the first concrete finance Xero report handlers for:
  - monthly profit and loss snapshots
  - balance sheet snapshots
  - bank balance snapshots
- Each handler still hands snapshot persistence back to `runFinanceSync`, so scheduled runs continue through the durable `FinanceSyncRun` / `FinanceSnapshot` boundary.
- Future dataset work should extend that registry rather than bypassing the cron or service boundaries.

## Explicit Non-goals

This cron layer does not yet implement:

- the remaining finance Xero dataset handlers beyond the first report-based snapshots
- finance diagnostics UI or route handlers
- reporting-page loaders
- booking-derived finance adapters
