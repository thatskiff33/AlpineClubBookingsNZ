# Finance Sync Service Contract

This document defines the Phase 3 service scaffold that sits on top of the durable `FinanceSnapshot` and `FinanceSyncRun` storage seam.

It is intentionally narrow. The service owns finance-only sync orchestration, but it does not register cron jobs, add overlap guards, or build diagnostics UI.

## Service Boundary

`src/lib/finance-sync-service.ts` owns the first reusable finance sync entrypoint.

It currently owns:

- establishing a finance-only Xero sync connection from the finance token boundary
- creating a durable `FinanceSyncRun`
- executing finance dataset handlers sequentially
- writing snapshot payloads only through `upsertFinanceSnapshot`
- marking runs `SUCCEEDED`, `PARTIAL`, or `FAILED`

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

## Outcome Rules

- If all datasets succeed, the run is completed as `SUCCEEDED`.
- If at least one dataset succeeds and at least one dataset fails, the run is completed as `PARTIAL`.
- If the finance Xero connection cannot be established, or every dataset fails, the run is marked `FAILED`.

## Explicit Non-goals

This service scaffold does not yet implement:

- concrete Xero dataset fetchers beyond the handler contract
- cron registration
- overlap-safe execution
- diagnostics endpoints or UI
- reporting-page loaders
