// #3635: the one home of what an officer's "resolved in Xero" mark means.
// Pure and dependency-free, so the admin operations panel (a client
// component) and the server retry machinery read the same predicate.

/**
 * #3635 (owner decision, 28 Sep 2026): "Every repair path treats a manually
 * resolved operation as done and never offers to re-run it." An officer's
 * "resolved in Xero" mark (`POST /api/admin/xero/operations/[id]/resolve`)
 * leaves the row FAILED/PARTIAL and `replayable`, so status alone still reads
 * it as live; this predicate is the one home of the rule that it is done.
 *
 * Its callers: `getXeroOperationRetryMeta` (so no retry, requeue, queued-retry
 * drain or repair auto-apply can run it), the repair tool's
 * `getBlockingOperation` / `toRetryableOperationMatch`, the cancelled
 * open-invoice clearing-note check, the refund-note link repair's blocker, the
 * booking invoice sync fault, the reconciliation report's unsupported
 * partials, the resolve route, and the admin operations panel. The query-side
 * spelling of the same rule is a `manuallyResolvedAt: null` filter (the
 * failure overview, the operations list's failure-state filter, contact-create
 * recovery, the retry claims in `xero-operation-retry.ts`, the resolve route,
 * the outbox cooldown hand-back, the repeated-failure alert, the refund-note
 * link repair and the review charge's still-coming read,
 * `supplementaryInvoiceStillComingWhere`, #3947) or `manuallyResolvedAt: { not: null }` (the enqueue fences in
 * `xero-resolved-in-xero-fences.ts`, `hasInvoiceClearingNote`, and the review
 * charge's done read, `resolvedSupplementaryInvoiceOperationsWhere`, #3947) - a `where`
 * clause cannot call a function, so those stay spelled out (`INV-INT-025`).
 */
export function isResolvedInXero(operation: {
  // A string on the admin client, which receives the row as JSON.
  manuallyResolvedAt: Date | string | null;
}): boolean {
  return Boolean(operation.manuallyResolvedAt);
}

export const RESOLVED_IN_XERO_RETRY_REASON =
  "An officer marked this operation resolved in Xero; it is treated as done and is never re-run.";

/**
 * #4219: the reason a failure the app itself closed carries (a credit note spent
 * in Xero outside the app, the credit ledger brought into line). It opens
 * `manuallyResolvedReason`, so the panel can tell it from an officer's mark.
 */
export const CREDIT_SPENT_OUTSIDE_APP_REASON_PREFIX = "CREDIT_SPENT_OUTSIDE_APP";

/** What the panel calls a closed row: an officer's mark says Xero, the app's own close says what happened. */
export function resolutionLabel(reason: string | null | undefined): string {
  return reason?.startsWith(CREDIT_SPENT_OUTSIDE_APP_REASON_PREFIX)
    ? "Closed: credit used outside the app"
    : "Resolved in Xero";
}
