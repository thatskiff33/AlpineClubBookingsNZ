# Finance Snapshot Storage Contract

This document defines the Phase 3 storage seam added for finance snapshots and finance sync-run history.

Future sync services, cron registration, and diagnostics must build on this contract instead of introducing CSV files, local disk state, or ad hoc production tables.

## Durable Tables

### `FinanceSyncRun`

One row per finance sync attempt.

Required fields:

- `workflow`: stable workflow name such as `daily-finance-sync`
- `trigger`: `MANUAL`, `SCHEDULED`, or `BACKFILL`
- `status`: `RUNNING`, `SUCCEEDED`, `FAILED`, or `PARTIAL`
- `startedAt`

Observability/supporting fields:

- `completedAt`
- `snapshotCount`
- `totalRowCount`
- `xeroTenantId`
- `requestedByMemberId`
- `resultSummary`
- `errorSummary`
- `errorDetails`
- `metadata`

### `FinanceSnapshot`

One durable snapshot payload per `snapshotType + scope + asOfDate`.

Required fields:

- `snapshotType`
- `scope`
- `asOfDate`
- `rowCount`
- `payload`

Optional metadata:

- `periodStart`
- `periodEnd`
- `currency`
- `sourceUpdatedAt`
- `syncRunId`

## Snapshot Types

The initial storage boundary supports these dataset types:

- `PROFIT_AND_LOSS_MONTHLY`
- `ACCOUNTS_RECEIVABLE_INVOICES`
- `ACCOUNTS_PAYABLE_INVOICES`
- `BANK_TRANSACTIONS`
- `AGED_RECEIVABLES`
- `AGED_PAYABLES`
- `BALANCE_SHEET`
- `BANK_BALANCES`
- `CONTACTS`

Later work may add more types only when the reporting contract requires them.

## Helper Boundary

`src/lib/finance-sync-storage.ts` is the storage-adjacent helper layer for this phase.

It currently owns:

- creating finance sync runs
- marking finance sync runs complete or failed
- reading the latest finance sync run
- upserting finance snapshots
- listing finance snapshot headers without loading full payload JSON

Future services should use this helper or extend it, rather than bypassing the contract with direct file-based or mixed operational-finance storage.

## Explicit Non-goals

This contract does not, by itself, implement:

- Xero snapshot ingestion
- daily cron registration
- overlap guards
- diagnostics UI
- reporting-page queries
