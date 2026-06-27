# Finance Sync Service Contract

This document defines the service boundary that sits on top of durable `FinanceSnapshot` and `FinanceSyncRun` storage.

It is intentionally narrow. The service owns finance sync orchestration through
the single operational Xero connection, but it does not register cron jobs, add
overlap guards, or build diagnostics UI.

## Service Boundary

`src/lib/finance-sync-service.ts` owns the first reusable finance sync entrypoint.

It currently owns:

- establishing a finance sync connection from the operational Xero token boundary
- creating a durable `FinanceSyncRun`
- executing finance dataset handlers sequentially
- writing snapshot payloads only through `upsertFinanceSnapshot`
- marking runs `SUCCEEDED`, `PARTIAL`, or `FAILED`

The daily scheduled layer now lives separately in `src/lib/finance-sync-cron.ts`; that cron runner calls this service and keeps overlap protection plus generic cron observability outside the service boundary.

## Dataset Contract

Each dataset handler must provide:

- `key`: stable dataset identifier for run summaries and diagnostics
- `sync(context)`: returns one snapshot or an array of snapshots

The `context` includes:

- `runId`
- `workflow`
- `trigger`
- `startedAt`
- `xeroTenantId`
- authenticated finance `xero` client

Each returned snapshot must provide:

- `snapshotType`
- `asOfDate`
- `rowCount`
- `payload`

Optional snapshot metadata:

- `scope`
- `periodStart`
- `periodEnd`
- `currency`
- `sourceUpdatedAt`

The first scheduled Xero dataset handlers now use the service contract to persist:

- monthly profit and loss report snapshots
- balance sheet report snapshots
- bank balance report snapshots
- organisation-level aged receivables snapshots derived from open receivable invoices
- organisation-level accounts receivable invoice snapshots derived from open receivable invoices
- organisation-level aged payables snapshots derived from open payable invoices
- organisation-level accounts payable invoice snapshots derived from open payable invoices

Those handlers still return `FinanceSyncSnapshotInput` objects and do not bypass `FinanceSyncRun` or `FinanceSnapshot`.

## Outcome Rules

- If all datasets succeed, the run is completed as `SUCCEEDED`.
- If at least one dataset succeeds and at least one dataset fails, the run is completed as `PARTIAL`.
- If the operational Xero connection cannot be established (not connected, token expired, or rate-limited), or every dataset fails, the run is marked `FAILED`.

## Explicit Non-goals

This service scaffold does not yet implement:

- the remaining finance dataset surface such as contacts and transaction snapshots
- cron registration
- overlap-safe execution
- diagnostics endpoints or UI
- reporting-page loaders
