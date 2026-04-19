# Finance Data Contracts

This document defines the reporting contracts the finance dashboard must use.

If any metric definition changes, update this file in the same PR.

## Access Contract

### Finance Viewer

- Can access `/finance/*`
- Can view finance snapshots and reports
- Cannot connect/disconnect finance Xero
- Cannot trigger privileged sync or config changes

### Finance Manager

- Includes all viewer permissions
- Can connect/disconnect finance Xero
- Can trigger manual finance syncs and diagnostics
- Intended for selected admins only unless explicitly broadened

## Xero Boundary Contract

- Finance Xero uses a separate OAuth app/client from operational TACBookings Xero.
- Finance tokens, refresh state, usage metering, and sync history are stored separately.
- Finance usage budget must be observable independently from operational Xero usage.

## Snapshot Contract

Production finance data is stored in Postgres-backed snapshots or normalized finance tables, not CSV files.

Phase 3 storage scaffolding persists generic snapshot payloads in `FinanceSnapshot` and sync lifecycle metadata in `FinanceSyncRun`; see `finance-snapshot-storage-contract.md` for the storage-level contract.

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

- The organisation-level aged receivables snapshot is derived from finance-only Xero `ACCREC` invoices because the currently verified `AgedReceivablesByContact` report surface remains contact-scoped.
- Include only receivable invoices with a positive outstanding balance and an invoice date on or before the snapshot `asOfDate`.
- Age buckets are calculated from invoice `dueDate` relative to the snapshot `asOfDate` using:
  - `current` for invoices not yet due or without a valid due date
  - `1-30`
  - `31-60`
  - `61-90`
  - `91+`
- Preserve currency safety. Aggregate organisation totals by currency and group contact rollups by contact plus currency rather than summing mixed-currency balances into one amount.

## Aged Payables Contract

- The organisation-level aged payables snapshot is derived from finance-only Xero `ACCPAY` invoices because the currently verified `AgedPayablesByContact` report surface remains contact-scoped.
- Include only payable invoices with a positive outstanding balance and an invoice date on or before the snapshot `asOfDate`.
- Age buckets are calculated from invoice `dueDate` relative to the snapshot `asOfDate` using:
  - `current` for invoices not yet due or without a valid due date
  - `1-30`
  - `31-60`
  - `61-90`
- `91+`
- Preserve currency safety. Aggregate organisation totals by currency and group contact rollups by contact plus currency rather than summing mixed-currency balances into one amount.

## Accounts Payable Invoices Contract

- The organisation-level accounts payable invoice snapshot is derived from the finance-only Xero `ACCPAY` invoice listing surface and reuses the same open-invoice fetch boundary as aged payables.
- Include only payable invoices with a positive outstanding balance and an invoice date on or before the snapshot `asOfDate`.
- Persist bill-level detail suitable for downstream finance reporting, including supplier contact metadata plus invoice status, invoice date, due date, planned payment date when present, currency, and outstanding balance components.
- Preserve currency safety. Aggregate organisation totals by currency and group supplier contact rollups by contact plus currency rather than summing mixed-currency balances into one amount.

## Booking Metrics Contract

Booking-derived finance metrics come from TACBookings `Booking`, `BookingGuest`, and `Payment`.

### Realized Stay Metrics

Use for historical guest nights, average nightly revenue, and realized occupancy.

Include bookings only when all of the following are true:

- status is one of `CONFIRMED`, `PAID`, or `COMPLETED`
- the stay date being counted is before or equal to the reporting cutoff date

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

Waitlist states must not be counted as occupied or committed future nights.

### Guest Nights

For each booking guest:

- nightly contribution is one occupied bed for each night from `checkIn` inclusive to `checkOut` exclusive
- booking guest nights are the sum across all guests and nights

Do not infer guest counts from external system summaries if TACBookings guest rows exist.

## Revenue Contract

- Booking revenue uses TACBookings stored amounts for operational booking-facing totals.
- Financial statement revenue uses finance Xero snapshots.
- Any page combining booking-derived and Xero-derived metrics must state which source owns each number.

## Booking Type Note

`TACBookings` does not currently have a first-class `bookingType` field.

If finance reporting requires explicit booking type segmentation, define:

- the business categories
- who assigns them
- whether they are derived or stored
- backfill strategy

before adding schema.
