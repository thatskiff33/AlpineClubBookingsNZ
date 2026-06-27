# Finance Data Contracts

This document defines the reporting contracts the finance dashboard must use.

If any metric definition changes, update this file in the same PR.

## Access Contract

### Finance Viewer

- Can access `/finance`
- Can view finance snapshots and reports, including profit and loss and revenue reconciliation
- Cannot trigger privileged sync or config changes

### Finance Manager

- Includes all viewer permissions
- Can trigger manual finance syncs and diagnostics from `/finance`
- Can save finance report mappings and run historical dashboard backfills from Admin Setup when also an admin
- Intended for selected admins only unless explicitly broadened

## Xero Connection Contract

- The finance sync uses the single operational Xero connection that bookings, payments, and subscriptions use.
- There is no separate finance Xero OAuth app, token store, or usage metering.
- The finance sync needs the `accounting.reports.read` scope; after deploy, reconnect Xero once from `/admin/xero` so existing tokens gain it. See `finance-xero-config-contract.md`.
- The `/finance` dashboard must not perform live Xero reads during render.

## Dashboard Selector Contract

`/finance` is a selector-driven dashboard, not a collection of finance subpages.

Primary range options:

- Last Month
- Last Quarter
- Year to Date
- Last 12 Months, meaning the last 12 completed calendar months ending with last month
- Custom

Comparison options:

- Previous Month
- Previous Quarter
- Previous Year
- Previous Year to Date
- Custom

Forward options:

- Next Month
- Next Quarter
- Next 12 Months
- Rest of Season
- Custom

`Rest of Season` uses the active or upcoming configured season. If no configured
season exists, the dashboard surfaces a warning instead of guessing a date
window.

The dashboard may expose `expenseCategoryId` and `expenseLine` filters only for
cost views.

## Report Mapping Contract

Treasurer-controlled P&L reporting groups are stored in
`FinanceReportCategory` and `FinanceReportCategoryMapping`.

Default revenue groups:

- Hut Fees
- Subscriptions
- Entrance Fees
- Other Revenue

Default expense groups:

- Accommodation Operations
- Catering
- Utilities
- Maintenance
- Insurance & Compliance
- Admin & Software
- Payment & Bank Fees
- Other Expenses

Mappings match Xero account codes first. When an account code is unavailable,
fallback matching uses P&L section and line labels. Unmapped revenue and expense
lines remain included in dashboard totals under `Unmapped`.

## Snapshot Contract

Production finance data is stored in Postgres-backed snapshots or normalized finance tables, not CSV files.

Finance snapshot storage persists generic snapshot payloads in `FinanceSnapshot` and sync lifecycle metadata in `FinanceSyncRun`; see `finance-snapshot-storage-contract.md` for the storage-level contract.

The minimum dataset surface is:

- profit and loss monthly snapshot
- accounts receivable invoices snapshot
- accounts payable invoices snapshot
- bank transactions snapshot
- aged receivables snapshot
- aged payables snapshot
- balance sheet snapshot
- bank balances snapshot
- contacts snapshot
- finance sync run history

## Aged Receivables Contract

- The organisation-level aged receivables snapshot is derived from operational Xero `ACCREC` invoices because the currently verified `AgedReceivablesByContact` report surface remains contact-scoped.
- Include only receivable invoices with a positive outstanding balance and an invoice date on or before the snapshot `asOfDate`.
- Age buckets are calculated from invoice `dueDate` relative to the snapshot `asOfDate` using:
  - `current` for invoices not yet due or without a valid due date
  - `1-30`
  - `31-60`
  - `61-90`
  - `91+`
- Preserve currency safety. Aggregate organisation totals by currency and group contact rollups by contact plus currency rather than summing mixed-currency balances into one amount.

## Accounts Receivable Invoices Contract

- The organisation-level accounts receivable invoice snapshot is derived from the operational Xero `ACCREC` invoice listing surface and reuses the same open-invoice fetch boundary as aged receivables.
- Include only receivable invoices with a positive outstanding balance and an invoice date on or before the snapshot `asOfDate`.
- Persist invoice-level detail suitable for downstream finance reporting, including customer contact metadata plus invoice status, invoice date, due date, expected payment date when present, currency, and outstanding balance components.
- Preserve currency safety. Aggregate organisation totals by currency and group customer contact rollups by contact plus currency rather than summing mixed-currency balances into one amount.

## Aged Payables Contract

- The organisation-level aged payables snapshot is derived from operational Xero `ACCPAY` invoices because the currently verified `AgedPayablesByContact` report surface remains contact-scoped.
- Include only payable invoices with a positive outstanding balance and an invoice date on or before the snapshot `asOfDate`.
- Age buckets are calculated from invoice `dueDate` relative to the snapshot `asOfDate` using:
  - `current` for invoices not yet due or without a valid due date
  - `1-30`
  - `31-60`
  - `61-90`
  - `91+`
- Preserve currency safety. Aggregate organisation totals by currency and group contact rollups by contact plus currency rather than summing mixed-currency balances into one amount.

## Accounts Payable Invoices Contract

- The organisation-level accounts payable invoice snapshot is derived from the operational Xero `ACCPAY` invoice listing surface and reuses the same open-invoice fetch boundary as aged payables.
- Include only payable invoices with a positive outstanding balance and an invoice date on or before the snapshot `asOfDate`.
- Persist bill-level detail suitable for downstream finance reporting, including supplier contact metadata plus invoice status, invoice date, due date, planned payment date when present, currency, and outstanding balance components.
- Preserve currency safety. Aggregate organisation totals by currency and group supplier contact rollups by contact plus currency rather than summing mixed-currency balances into one amount.

## Booking Metrics Contract

Booking-derived finance metrics come from AlpineClubBookingsNZ `Booking`, `BookingGuest`, and `Payment`.

### Realized Stay Metrics

Use for historical guest nights, average nightly revenue, and realized occupancy.

Include bookings only when all of the following are true:

- status is one of `CONFIRMED`, `PAID`, or `COMPLETED`
- the stay date being counted is before or equal to the reporting cutoff date
- stay nights are counted from `checkIn` inclusive to `checkOut` exclusive

Exclude:

- `DRAFT`
- `PENDING`
- `BUMPED`
- `CANCELLED`
- `WAITLISTED`
- `WAITLIST_OFFERED`

### Forward Booking Metrics

Use for future pipeline and forward occupancy views.

Track at least two categories:

- committed pipeline: `CONFIRMED`, `PAID`
- at-risk pipeline: `PENDING`
- count only stay dates strictly after the query `asOfDate`

Waitlist states must not be counted as occupied or committed future nights.

### Guest Nights

For each booking guest:

- nightly contribution is one occupied bed for each night from
  `BookingGuest.stayStart` inclusive to `BookingGuest.stayEnd` exclusive
- booking guest nights are the sum across all guests and nights
- if a booking spans a realized cutoff or forward `asOfDate`, the same booking may contribute realized nights before the boundary and forward nights after it
- the parent booking `checkIn`/`checkOut` remains the envelope for the stay, but
  reporting must use guest-level ranges when guests are added or removed for
  future-only in-progress edits

Do not infer guest counts from external system summaries if AlpineClubBookingsNZ guest rows exist.

## Revenue Contract

- Booking revenue uses AlpineClubBookingsNZ stored amounts for operational booking-facing totals.
- When booking revenue is exposed at nightly granularity, allocate `Booking.finalPriceCents` evenly across stay nights from `checkIn` inclusive to `checkOut` exclusive.
- Financial statement revenue uses snapshots synced from the operational Xero connection.
- Payment-derived cash summaries come from AlpineClubBookingsNZ `Payment` rows and must remain distinct from booking-derived revenue metrics.
- Any page combining booking-derived and Xero-derived metrics must state which source owns each number.

## Costs Reporting Contract

- Native costs reporting uses stored `PROFIT_AND_LOSS_MONTHLY` finance snapshots synced through the single operational Xero connection.
- Costs report figures represent stored expense detail from those snapshots and must remain distinct from AlpineClubBookingsNZ booking revenue, payment-derived cash summaries, and native balance-sheet totals.
- The costs dashboard view may compare stored monthly expense snapshots across selected periods and surface grouped visual summaries and export detail, but it must not make live Xero reads.

## Pricing Sensitivity Contract

- Native pricing sensitivity uses stored `PROFIT_AND_LOSS_MONTHLY` finance snapshots plus AlpineClubBookingsNZ realized booking metrics for the selected windows.
- Pricing sensitivity must keep source ownership explicit:
  - monthly costs come from finance snapshots
  - guest nights, occupancy, and booked revenue come from AlpineClubBookingsNZ booking metrics
  - payment-derived cash totals remain out of scope
- Actual revenue per guest night is `bookedRevenueCents / guestNights` for the selected window.
- Break-even revenue per guest night is `totalCostsCents / guestNights` for the selected window.
- Scenario rows may use explicit occupancy assumptions only when the assumptions are displayed in the UI and the implied guest nights are derived from the selected periods' average monthly capacity bed nights.
- The pricing-sensitivity dashboard view may surface summary cards and occupancy scenario charts, but it must not make live Xero reads or use undocumented legacy-dashboard formulas.

## Cash Reporting Contract

- Native cash reporting uses stored `BANK_BALANCES` finance snapshots synced through the single operational Xero connection.
- Cash report figures represent stored bank position detail from those snapshots and must remain distinct from AlpineClubBookingsNZ payment-derived cash summaries.
- The cash dashboard view may compare stored bank-balance snapshots across selected periods, but it must not make live Xero reads.

## Balance-Sheet Reporting Contract

- Native balance-sheet reporting uses stored `BALANCE_SHEET` finance snapshots synced through the single operational Xero connection.
- Balance-sheet figures represent stored assets, liabilities, and equity positions from those snapshots and must remain distinct from AlpineClubBookingsNZ booking metrics, payment-derived cash summaries, and the separate native cash report totals.
- The balance-sheet dashboard view may compare stored balance-sheet snapshots across selected periods and surface visual summaries and export detail, but it must not make live Xero reads.

## Working-Capital Reporting Contract

- Native working-capital reporting uses stored `BALANCE_SHEET` finance snapshots synced through the single operational Xero connection.
- Working-capital figures must keep source ownership explicit:
  - current assets come from stored balance-sheet sections explicitly labelled as current assets
  - current liabilities come from stored balance-sheet sections explicitly labelled as current liabilities
  - working capital is `currentAssetsCents - currentLiabilitiesCents`
  - current ratio is `currentAssetsCents / currentLiabilitiesCents` only when current liabilities are greater than zero
- Working-capital figures remain distinct from AlpineClubBookingsNZ booking metrics, payment-derived cash summaries, and the separate native cash report totals.
- The working-capital dashboard view may surface summary cards and trends across selected stored balance-sheet snapshots, but it must not make live Xero reads.

## Booking Type Note

`AlpineClubBookingsNZ` does not currently have a first-class `bookingType` field.

If finance reporting requires explicit booking type segmentation, define:

- the business categories
- who assigns them
- whether they are derived or stored
- backfill strategy

before adding schema.
