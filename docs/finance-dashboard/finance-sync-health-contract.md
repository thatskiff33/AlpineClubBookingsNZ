# Finance Sync Health Contract

This document defines the treasurer sync-confidence view (`/finance?view=sync-health`, labelled "Xero Sync").

It is intentionally narrow: the view **aggregates health signals the platform already tracks** into one traffic light. It adds no sync logic, no new mutations, and never calls Xero live.

## Boundary

- `src/lib/finance-sync-health.ts` is the aggregation boundary:
  - `buildFinanceSyncHealth({ currentMonth, now? })` gathers the sources in parallel (each guarded — a failed source degrades to an amber "Unavailable" signal, never a thrown page error) and classifies them.
  - `classifyFinanceSyncHealth(sourceData)` is the pure classifier; the traffic-light matrix tests target it directly.
- Sources composed (all DB/cache reads):
  - `getFinanceSyncDiagnosticsStatus()` — latest finance sync run + cron state.
  - `buildFinanceRevenueReconciliation()` — overall tie-out status.
  - `getXeroAdminHealthSnapshot()` — failed/pending outbox operations, bookings missing invoices, refunds missing credit notes.
  - `FinanceAccountMonthlyBalance` freshness per statement kind — max `syncedAt` and newest non-provisional month.
- `buildSyncHealthDashboard` in `finance-dashboard-page/sync-health-view.ts` maps sections onto the existing KPI-card/status-panel shapes; status-panel items may carry `href`/`linkLabel` (Xero admin console `/admin/xero`, setup mappings `/admin/setup/finance`).

## Traffic light

- **Red** — latest sync run `FAILED` within 24 hours; failed outbox operations; reconciliation `DOES_NOT_TIE`.
- **Amber** — pending outbox operations; facts `syncedAt` older than 36 hours (or none stored); a finished month whose facts are still provisional-only (or missing); reconciliation `XERO_UNAVAILABLE`; bookings missing invoices; refunds missing credit notes past grace; sync `PARTIAL`, never run, failed more than 24h ago, or any source that could not be loaded.
- **Green** — everything else (a `RUNNING` sync is green).

Overall tone is the worst signal; every non-green signal is also surfaced as a page warning.

## Tests

- `src/lib/__tests__/finance-sync-health.test.ts` — the red/amber/green matrix, one case per trigger, against the pure classifier.
- `src/lib/__tests__/finance-dashboard-page.test.ts` — the `sync-health` view builds panels/cards/warnings from a mocked health result.
