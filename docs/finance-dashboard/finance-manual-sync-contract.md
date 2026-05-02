# Finance Manual Sync Contract

This document defines the finance-manager manual sync trigger exposed from `/finance`.

It is intentionally narrow. The manual trigger lets a finance manager run the existing finance sync workflow on demand, but it does not add viewer access, background queue orchestration, new datasets, or live report reads.

## Boundary

- `src/app/api/finance/sync/run/route.ts` is the finance-manager-only POST route used by the `/finance` button.
- `src/lib/finance-sync-manual.ts` owns the manager-triggered orchestration and overlap check.
- `src/lib/finance-sync-service.ts` remains the durable execution boundary that creates `FinanceSyncRun` rows and stores snapshots.
- `src/lib/finance-sync-datasets.ts` remains the dataset registry used by both scheduled and manual syncs.

## Behavior

- Only finance managers may trigger the route.
- The manual trigger uses the existing `daily-finance-sync` workflow with `trigger = MANUAL`.
- The manual trigger records `requestedByMemberId` on the durable `FinanceSyncRun`.
- Manual sync metadata records `source = manual` and `initiatedFrom = /finance`.
- If the latest `daily-finance-sync` run is still `RUNNING`, the route must not start a second run and should redirect back to `/finance` with an “already running” notice.
- On success, the route redirects back to `/finance` with a success notice.
- On partial completion, the route redirects back to `/finance` with a warning notice so managers review diagnostics.
- On failure, the route redirects back to `/finance` with an error notice.

## Explicit Non-goals

- finance-viewer access to sync mutations
- background job queues or async fire-and-forget execution
- new finance datasets or snapshot schemas
- live Xero reads while rendering report pages
