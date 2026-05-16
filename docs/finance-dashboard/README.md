# Finance Dashboard

The finance dashboard is the native AlpineClubBookingsNZ reporting workspace under
`/finance`. It uses AlpineClubBookingsNZ credentials, explicit finance access levels,
first-party booking data, and a separate finance Xero integration.

## Access Model

- `Member.financeAccessLevel = NONE` cannot access finance pages or finance
  APIs.
- `VIEWER` can read the finance workspace and reports.
- `MANAGER` can connect or disconnect finance Xero and run manual finance sync
  actions.
- `ADMIN` alone does not grant finance access.

## Xero Boundary

Finance reporting does not reuse the operational booking/member Xero OAuth
client or token store. It has separate environment variables, token storage,
tenant linkage, encryption key/versioning, usage metering, callback route, and
sync services.

Normal finance report navigation reads stored snapshots or first-party
AlpineClubBookingsNZ booking/payment data. It should not make live Xero calls on page
render.

## Data Model

- Xero-derived accounting datasets are persisted as `FinanceSnapshot` rows.
- Daily sync is handled by the finance sync cron and durable service layer.
- Booking, occupancy, guest-night, and pricing-sensitivity reports use
  AlpineClubBookingsNZ booking/payment data directly.
- Finance API and page contracts are described in this directory so report
  definitions stay explicit.

## Contract Index

- [data-contracts.md](data-contracts.md)
- [finance-xero-config-contract.md](finance-xero-config-contract.md)
- [finance-snapshot-storage-contract.md](finance-snapshot-storage-contract.md)
- [finance-sync-service-contract.md](finance-sync-service-contract.md)
- [finance-sync-cron-contract.md](finance-sync-cron-contract.md)
- [finance-sync-diagnostics-contract.md](finance-sync-diagnostics-contract.md)
- [finance-manual-sync-contract.md](finance-manual-sync-contract.md)
- [finance-booking-metrics-contract.md](finance-booking-metrics-contract.md)
- [finance-landing-page-contract.md](finance-landing-page-contract.md)
- [finance-bookings-report-contract.md](finance-bookings-report-contract.md)
- [finance-revenue-report-contract.md](finance-revenue-report-contract.md)
- [finance-costs-report-contract.md](finance-costs-report-contract.md)
- [finance-pricing-sensitivity-report-contract.md](finance-pricing-sensitivity-report-contract.md)
- [finance-working-capital-report-contract.md](finance-working-capital-report-contract.md)
- [finance-cash-report-contract.md](finance-cash-report-contract.md)
- [finance-balance-sheet-report-contract.md](finance-balance-sheet-report-contract.md)
- [test-plan.md](test-plan.md)

## ADRs

- [ADR-001: Native finance dashboard in AlpineClubBookingsNZ](decisions/ADR-001-native-finance-dashboard-in-tacbookings.md)
- [ADR-002: Finance access control](decisions/ADR-002-finance-access-control.md)
- [ADR-003: Separate finance Xero boundary](decisions/ADR-003-separate-finance-xero-boundary.md)
- [ADR-004: PostgreSQL snapshots over CSV](decisions/ADR-004-postgres-snapshots-over-csv.md)

## Maintenance Rules

- Update `data-contracts.md` before changing metric definitions.
- Do not grant finance access by broadening `ADMIN`; update ADR-002 first if
  the access model changes.
- Do not reuse operational Xero token storage, OAuth clients, or API budget for
  finance reporting.
- Keep report pages backed by snapshots or first-party AlpineClubBookingsNZ data unless a
  contract explicitly allows a live integration call.
