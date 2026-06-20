# Issue #819: Xero Operational Outbox and Reconciliation Review

## Issue

Review operational Xero OAuth, token refresh, outbox idempotency, retry, reconciliation, object links, admin repair, stale/failed states, and provider/local consistency.

## Scope reviewed

- Static review of operational Xero connection, outbox, inbound reconciliation, retry, health, and admin repair surfaces.
- No live Xero calls, production credentials, production data, app-code edits, DAST, or load tests were run.

## Files/directories inspected

- `src/lib/xero-token-store.ts`
- `src/lib/xero-api-client.ts`
- `src/lib/xero-operation-outbox.ts`
- `src/lib/xero-operation-queue.ts`
- `src/lib/xero-operation-retry.ts`
- `src/lib/xero-inbound-reconciliation.ts`
- `src/lib/xero-admin-health.ts`
- `src/app/api/admin/xero/operations/route.ts`
- `src/app/api/admin/xero/operations/[id]/retry/route.ts`
- `src/app/api/admin/xero/operations/[id]/requeue/route.ts`
- `src/app/api/admin/xero/inbound-events/route.ts`
- `src/app/api/admin/xero/inbound-events/[id]/replay/route.ts`
- `src/app/(admin)/admin/xero/_components/inbound-events-panel.tsx`
- `src/app/(admin)/admin/xero/_components/health-diagnostics-panel.tsx`
- `prisma/schema.prisma`

## Main observations

- Operational Xero OAuth tokens are encrypted at rest and refreshed through a shared client path.
- Outbox operations carry status, queue type, idempotency key, correlation key, payload, error, and retry metadata.
- Outbox enqueue helpers try to avoid duplicate active work and existing object links.
- Admin routes and UI exist for Xero operation listing, retry/requeue, inbound-event listing, and inbound replay.
- Inbound Xero webhooks are persisted before asynchronous reconciliation and can be replayed manually when not processing.
- Xero object links model local/provider relationships and are used by repair and health checks.

## Top risks to verify

- `processQueuedXeroOutboxOperations` claims work as `RUNNING`; for many queue types, unexpected dispatch-level errors may log without marking the claimed operation failed.
- Xero inbound events claimed as `PROCESSING` do not appear to have a stale reset path; manual replay rejects currently processing rows.
- Xero health pending-operation counts appear to count only `PENDING` operations, while UI copy refers to queued or running work.
- Token refresh locking appears process-local. Verify multi-instance refresh behavior and stale-token recovery if more than one worker can run.
- Missing invoice/credit-note health checks may not fully prove active object links and provider amounts match local financial state.

## Likely follow-up issues

- Add stale `RUNNING` outbox recovery and include stale running operations in Xero health.
- Add stale `PROCESSING` inbound-event recovery or guarded admin takeover/replay.
- Align Xero health UI copy with backend counts, or expand backend counts to include running/stale work.
- Add multi-worker token refresh and outbox-claim tests if deployment can run more than one worker process.
- Add reconciliation checks that compare local payment/credit state, Xero object links, and provider document status.

## Recommended tests/static checks

- Unit tests for unexpected outbox handler errors after claim.
- Tests for stale inbound `PROCESSING` rows and manual replay behavior.
- Tests for duplicate enqueue prevention by idempotency/correlation key and existing object links.
- Admin health snapshot tests covering `PENDING`, `RUNNING`, `FAILED`, and stale states.
- Static check that new Xero queue types include retry metadata and failure-state transitions.

## Sensitive findings requiring private handling, if any

- Keep exact stuck-operation trigger paths and replay/repair mechanics private until triaged.
- Do not publish Xero tenant, token, or object identifiers.

## Uncertainty/to-verify list

- To verify: whether a separate cron resets stale Xero `RUNNING` or inbound `PROCESSING` rows.
- To verify: whether production runs a single worker or multiple worker-capable processes.
- To verify: whether failed Xero repair actions produce admin-visible alerts beyond logs.
- To verify: whether finance Xero sync and operational Xero object links are clearly separated for operators.

## Validation notes

- Static review only.
- No Xero calls or production-like reconciliation were performed.
