# Finance Dashboard

The finance dashboard is the native AlpineClubBookingsNZ reporting workspace under
`/finance`. It uses AlpineClubBookingsNZ credentials, explicit finance access levels,
first-party booking data, and the single operational Xero connection.

## Access Model

- `Member.financeAccessLevel = NONE` cannot access finance pages or finance
  APIs.
- `VIEWER` can read the finance workspace and reports.
- `MANAGER` can trigger a manual finance sync from `/finance`.
- Admin Setup owns finance report mappings and historical backfill actions.
- Operational Xero setup remains an admin setup concern; `/finance` does not
  link to Xero connection management.
- `ADMIN` alone does not grant finance access.

## Xero Connection

Finance reporting uses the single operational Xero connection that bookings,
payments, and subscriptions already use. There are no finance-specific Xero env
vars, token storage, callback routes, or usage metering. The connection is
managed through admin setup tooling, not from `/finance`.

The finance sync needs the `accounting.reports.read` scope. After deploy, Xero
must be reconnected once from `/admin/xero` so existing tokens gain this scope.
See `finance-xero-config-contract.md`.

Normal finance report navigation reads stored snapshots or first-party
AlpineClubBookingsNZ booking/payment data. It must not make live Xero calls on
page render.

## Dashboard Surface

`/finance` is the only finance UI route. It is controlled by query selectors:
`view`, `range`, custom `from`/`to`, `compare`, custom comparison dates,
`forward`, custom forward dates, and the costs-only `expenseCategoryId` and
`expenseLine` filters.

The default dashboard state is:

- view: Bookings
- range: Last Month
- compare: Previous Month
- forward: Next Month

The dashboard renders visual summaries only: KPI cards, trend charts, mix
charts, reconciliation/status panels, compact source notes, warnings, and
PDF/CSV exports for the active selection. It does not render daily detail tables
or route users to the removed `/finance/*` report pages.

## Data Model

- Xero-derived accounting datasets are persisted as `FinanceSnapshot` rows.
- Daily sync is handled by the finance sync cron and durable service layer.
- Treasurer-controlled report groups are stored in `FinanceReportCategory` and
  `FinanceReportCategoryMapping`. Unmapped P&L lines remain included in totals
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
- [finance-sync-service-contract.md](finance-sync-service-contract.md)
- [finance-sync-cron-contract.md](finance-sync-cron-contract.md)
- [finance-sync-diagnostics-contract.md](finance-sync-diagnostics-contract.md)
- [finance-manual-sync-contract.md](finance-manual-sync-contract.md)
- [finance-booking-metrics-contract.md](finance-booking-metrics-contract.md)
- [test-plan.md](test-plan.md)

Historical per-report contracts remain in this directory for calculation
background, but their old `/finance/bookings`, `/finance/revenue`,
`/finance/costs`, `/finance/pricing-sensitivity`, `/finance/working-capital`,
`/finance/cash`, and `/finance/balance-sheet` page routes are superseded by the
single `/finance` dashboard.

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
