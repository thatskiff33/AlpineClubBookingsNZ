# Finance Sync Diagnostics Contract

This document defines the finance-only diagnostics status read path added on top of the durable finance sync and cron observability boundaries.

It is intentionally narrow. The diagnostics read path exposes the latest finance sync status as JSON for finance managers, but it does not add diagnostics UI, manual sync mutations, or reporting-page loaders.

## Boundary

- `src/lib/finance-sync-diagnostics.ts` loads finance diagnostics state from durable `FinanceSyncRun` rows plus `CronJobRun` records for the finance daily sync job.
- `src/app/api/finance/sync/status/route.ts` exposes that state through a finance-manager-only route handler.
- `src/lib/finance-api-auth.ts` remains the authorization boundary for finance manager API access.

## Response Shape

The diagnostics response includes:

- `workflow`: the finance sync workflow name, currently `daily-finance-sync`
- `latestRun`: the latest durable `FinanceSyncRun`, or `null` when no finance sync has run yet
- `cron`:
  - `jobName`
  - `schedule`
  - `timezone`
  - `latestRun`: the latest durable `CronJobRun` for the finance sync cron, or `null`
- `recentFailures`:
  - `syncRuns`: recent `FAILED` or `PARTIAL` finance sync runs, excluding the current `latestRun`
  - `cronRuns`: recent cron `FAILURE` records for the finance sync job, excluding the current cron `latestRun`

Each `latestRun` / `recentFailures.syncRuns` item includes:

- run identity and lifecycle metadata: `id`, `workflow`, `trigger`, `status`, `startedAt`, `completedAt`, `durationMs`
- durable finance sync counts: `snapshotCount`, `totalRowCount`
- dataset summary counts: `datasetCount`, `successfulDatasetCount`, `failedDatasetCount`
- dataset-level summaries from durable `resultSummary.datasets`
- `errorSummary` and normalized `failureDetails` derived from durable `resultSummary` and `errorDetails`

Each `cron.latestRun` / `recentFailures.cronRuns` item includes:

- cron run identity and lifecycle metadata: `id`, `jobName`, `status`, `startedAt`, `completedAt`, `durationMs`
- linked finance sync summary fields when present in durable `resultSummary`, including `financeSyncRunId`, `financeSyncStatus`, `snapshotCount`, `totalRowCount`, and dataset failure counts
- generic cron `error` plus any stored `reason`

## JSON Safety Rules

- All timestamps are returned as ISO-8601 strings.
- Dataset summaries and failure details are normalized to plain JSON-safe arrays and strings.
- The diagnostics helper must tolerate missing `resultSummary` / `errorDetails` values so failed or pre-diagnostics runs remain queryable.

## Explicit Non-goals

This diagnostics read path does not implement:

- diagnostics UI pages
- manual finance sync route handlers
- new finance datasets
- reporting-page data loaders
