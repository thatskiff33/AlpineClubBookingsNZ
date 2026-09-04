# Finance Dashboard

> Part of the [documentation hub](../README.md).

The finance dashboard is the native AlpineClubBookingsNZ reporting workspace under
`/finance`. It uses AlpineClubBookingsNZ credentials, explicit finance access
roles, first-party booking data, and the single operational Xero connection.

## Access Model

- `FINANCE_USER` can read the finance workspace, reports, and finance viewer
  APIs.
- `FINANCE_ADMIN` can read finance data and trigger manager-only actions such
  as manual finance sync and finance report mapping writes.
- `USER`, `ADMIN`, and `LODGE` do not grant finance access by themselves.
- Mixed-role accounts are intentional: for example, `LODGE` plus
  `FINANCE_USER` can use lodge tools and read finance data, while lodge-only
  accounts remain blocked from finance pages and APIs.
- Admin Setup owns finance report mappings and historical backfill actions.
- Operational Xero setup remains an admin setup concern; `/finance` does not
  link to Xero connection management.
- `Member.financeAccessLevel` remains synchronized as `NONE`, `VIEWER`, or
  `MANAGER` only for compatibility visibility. Finance authorization reads
  `MemberAccessRole` rows only.

## Xero Connection

Finance reporting uses the single operational Xero connection that bookings,
payments, and subscriptions already use. There are no finance-specific Xero env
vars, token storage, callback routes, or usage metering. The connection is
managed through admin setup tooling, not from `/finance`.

The finance sync needs the granular `accounting.reports.profitandloss.read`,
`accounting.reports.balancesheet.read`, and
`accounting.reports.banksummary.read` scopes. After deploy, update the Xero
developer app allowed scopes, verify the redirect URI, then reconnect Xero once
from `/admin/xero` so existing tokens are replaced with tokens carrying the
current scope set. See `finance-xero-config-contract.md`.

Normal finance report navigation reads stored snapshots or first-party
AlpineClubBookingsNZ booking/payment data. It must not make live Xero calls on
page render.

The finance-permission **Base Reports** page is a separate, lighter operator
surface at `/admin/reports`; see the [Reports guide](../guides/reports.md). Its
booking and booked-revenue figures follow overlapping lodge stay nights, while
its payment-derived net collected cash remains explicitly separate. The richer
`/finance` dashboard contracts below continue to own Xero snapshots, comparisons,
forward views, and reconciliation.

## Dashboard Surface

`/finance` is the only finance UI route. It is controlled by query selectors:
`view`, `range`, custom `from`/`to` months, `compare`, custom comparison
months, `forward` (bookings view only), custom forward months, and the
costs-only `expenseCategoryId` and `expenseLine` filters.

The dashboard is **month-granular**: ranges are whole-month windows over the
monthly fact table (`last-month`, `last-3-months`, `last-6-months`,
`last-12-months`, `financial-year-to-date`, `last-financial-year`, or a custom
month range), and comparisons are `previous-period`, `same-period-last-year`,
`none`, or custom months. Financial-year ranges use the club's configured
year-end month (override → Xero organisation → 31 March default). Custom
params accept `YYYY-MM`; legacy `YYYY-MM-DD` bookmarks are clamped to their
containing month with a warning, and legacy option values (`last-quarter`,
`previous-month`, …) map onto their month-granular equivalents. The
in-progress month appears only in ranges that include it (e.g. financial year
to date) and is flagged as month-to-date. Day-level detail lives in Xero.

The page model behind the route is built server-side by `buildFinanceDashboardPageModel` in `src/lib/finance-dashboard-page.ts`, which resolves the club zone, the reporting lodge, the seasons, the sync status and the selection, then dispatches to one view builder per `view` under `src/lib/finance-dashboard-page/` (`bookings-view.ts`, `pnl-view.ts` for revenue and costs, `ratios-view.ts`, `pricing-sensitivity-view.ts`, `balance-sheet-views.ts` for cash, balance sheet and working capital, `sync-health-view.ts`). The shared view-model shapes live in `model.ts` and the derived chart palette in `series-colors.ts` (#2957).

The default dashboard state is:

- view: Bookings
- range: Last Month
- compare: Previous Period
- forward: Next Month

The always-visible **Reset** action restores those range, comparison, forward,
and expense-filter defaults. It keeps the current reporting **View**, lodge
scope, Ratio Explorer inputs, and unknown query keys, and replaces the current
URL entry so Reset does not add another step to browser history.

The dashboard renders visual summaries only: KPI cards, trend charts (one
point per month, with the comparison period overlaid as a second series), mix
charts, reconciliation/status panels, compact source notes (the Xero-derived
views link to Xero's report centre for day-level drill-down), warnings, and
PDF/CSV exports for the active selection. Dashboard displays show whole
dollars with thousands separators; exact cents appear only where tie-out
matters (the reconciliation panel and CSV/PDF export rows). It does not render
daily detail tables or route users to the removed `/finance/*` report pages.

**Download PDF** and the browser print dialog always render the light colour
scheme — dark text on a white page — even when you are browsing the dashboard in
dark mode (#2146). No theme switch is needed before exporting.

The revenue, costs, pricing-sensitivity, cash, working-capital, and
balance-sheet views read `FinanceAccountMonthlyBalance` facts (see
[finance-monthly-facts-contract.md](finance-monthly-facts-contract.md));
the bookings view reads local booking/payment data. The cash view's "latest
bank balance" KPI is the one figure still read from the daily bank-summary
snapshot, since it is a point-in-time value rather than a monthly one.

The **Ratios** view is the committee's comparison tool: a numerator dropdown
(any treasurer category, or Total income/expenses), an "as a percentage of"
denominator dropdown, and financial-year/range chips — e.g. catering cost as a
share of hut-fee income for this FY, last FY, and the FY before. The server
ships the full category-month matrix (`finance-ratio-insights.ts` /
client-safe helpers in `finance-ratio-shared.ts`), so switching pairings or
ranges recomputes instantly in the browser; the selection syncs to
`ratioNumerator`/`ratioDenominator`/`ratioRange` query params for shareable
links.
Divide-by-zero renders as "—". The revenue and costs views carry a compact
"Financial years" panel (this FY YTD vs the two prior FYs per group) that
links conceptually to the same data.

The **Xero Sync** view (`view=sync-health`) is the treasurer's
sync-confidence page: one traffic light aggregating the health signals the
platform already tracks — latest daily sync run, revenue reconciliation,
Xero operation outbox (failed/pending writes, bookings missing invoices,
refunds missing credit notes), and monthly fact freshness (latest sync time
and newest finalised month per statement kind). Red means a sync failed in
the last 24 hours, outbox operations have failed, or reconciliation does not
tie; amber covers pending operations, staleness over 36 hours, a finished
month still provisional-only, or an unavailable signal; green otherwise.
Signals link to the Xero admin console or the setup mappings panel. The view
is aggregation-only (`finance-sync-health.ts`) — it adds no sync logic and
never calls Xero live — and has no range/compare selectors.

## Data Model

- Xero-derived accounting datasets are persisted as `FinanceSnapshot` rows.
- Monthly per-account reporting facts (one row per statement kind, month, and
  Xero GL account code) are persisted in `FinanceAccountMonthlyBalance`,
  derived from multi-period profit-and-loss and balance-sheet pulls in the
  same daily sync. Historical coverage comes from the re-runnable backfill
  (`POST /api/finance/sync/backfill-monthly-facts` or
  `npm run finance:backfill-monthly-facts`). See
  [finance-monthly-facts-contract.md](finance-monthly-facts-contract.md).
- Daily sync is handled by the finance sync cron and durable service layer.
- Treasurer-controlled report groups are stored in `FinanceReportCategory` and
  `FinanceReportCategoryMapping`. Each group carries an optional `subtype`
  sub-heading and pins one or more Xero account codes; P&L lines are matched to
  groups by account code only. Unmapped P&L lines remain included in totals
  under `Unmapped`.
- Booking, occupancy, guest-night, and pricing-sensitivity reports use
  AlpineClubBookingsNZ booking/payment data directly.
- Finance API and page contracts are described in this directory so report
  definitions stay explicit.

## Contract Index

- [data-contracts.md](data-contracts.md)
- [finance-xero-config-contract.md](finance-xero-config-contract.md)
- [finance-revenue-reconciliation-contract.md](finance-revenue-reconciliation-contract.md)
- [finance-snapshot-storage-contract.md](finance-snapshot-storage-contract.md)
- [finance-monthly-facts-contract.md](finance-monthly-facts-contract.md)
- [finance-sync-service-contract.md](finance-sync-service-contract.md)
- [finance-sync-cron-contract.md](finance-sync-cron-contract.md)
- [finance-sync-diagnostics-contract.md](finance-sync-diagnostics-contract.md)
- [finance-sync-health-contract.md](finance-sync-health-contract.md)
- [finance-manual-sync-contract.md](finance-manual-sync-contract.md)
- [finance-booking-metrics-contract.md](finance-booking-metrics-contract.md)
- [test-plan.md](test-plan.md)

Per-report contracts remain in this directory where they still document active
dashboard calculations, but their old `/finance/*` page routes are superseded by
the single `/finance` dashboard.

## ADRs

- [ADR-001: Native finance dashboard in AlpineClubBookingsNZ](decisions/ADR-001-native-finance-dashboard-in-tacbookings.md)
- [ADR-002: Finance access control](decisions/ADR-002-finance-access-control.md)
- [ADR-003: Separate finance Xero boundary (superseded by ADR-005)](decisions/ADR-003-separate-finance-xero-boundary.md)
- [ADR-004: PostgreSQL snapshots over CSV](decisions/ADR-004-postgres-snapshots-over-csv.md)
- [ADR-005: Single operational Xero connection](decisions/ADR-005-single-operational-xero-connection.md)

## Maintenance Rules

- Update `data-contracts.md` before changing metric definitions.
- Do not grant finance access by broadening `ADMIN`; update ADR-002 first if
  the access model changes.
- The finance sync uses the single operational Xero connection; update ADR-005
  first if that changes.
- Keep report pages backed by snapshots or first-party AlpineClubBookingsNZ data unless a
  contract explicitly allows a live integration call.
