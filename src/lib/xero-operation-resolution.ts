// #3635: the one home of what an officer's "resolved in Xero" mark means.
// Pure and dependency-free, so the admin operations panel (a client
// component) and the server retry machinery read the same predicate.

/**
 * #4421 (`INV-SSOT`): the bounds of the reason an officer gives for acting on
 * a Xero operation by hand - Resolve, Mark failed and Mark non-replayable -
 * as each route's schema checks it and the panel's dialogs enforce it. Here,
 * in this dependency-free module, because the panel (a client component)
 * reads it too.
 */
export const XERO_OPERATION_REASON_MIN = 3;
export const XERO_OPERATION_REASON_MAX = 500;

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
 * link repair, the review charge's still-coming read,
 * `supplementaryInvoiceStillComingWhere`, #3947, and the deleted-payment
 * retire's hold-back, `rerunnableOperationWhere`, #4531) or `manuallyResolvedAt: { not: null }` (the enqueue fences in
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

/**
 * #4220 (owner decision, 24 Oct 2026): choosing Status = Failed in the admin
 * Xero operations panel also selects Failure = Active, so rows an officer or a
 * later run has already dealt with stop crowding out the ones that still need
 * attention (`status` stays FAILED on those rows by design, `INV-INT-025`). The
 * choice is visible in the Failure selector and the URL, and the API default
 * stays "all", so a saved `opStatus=FAILED` link keeps its literal meaning.
 *
 * Returns the Failure selection to use after the Status selector changes:
 * - an untouched "all" becomes "ACTIVE" on the way into Failed (a choice the
 *   officer already made is kept);
 * - the "ACTIVE" default is undone on the way out of Failed;
 * - choosing a status other than Failed or "all" clears a failure-state filter,
 *   because the route lists FAILED rows for any failure-state filter and would
 *   show failed rows beneath the wrong status.
 */
export function failureStateAfterStatusChange({
  previousStatus,
  nextStatus,
  failureState,
}: {
  previousStatus: string;
  nextStatus: string;
  failureState: string;
}): string {
  if (previousStatus !== "FAILED" && nextStatus === "FAILED" && failureState === "all") {
    return "ACTIVE";
  }
  if (previousStatus === "FAILED" && nextStatus !== "FAILED" && failureState === "ACTIVE") {
    return "all";
  }
  if (nextStatus !== "FAILED" && nextStatus !== "all") return "all";
  return failureState;
}

/**
 * #4338: a row the converge closed itself (no officer, the #4219 reason), as
 * opposed to an officer's "resolved in Xero" mark. Only such a close leaves the
 * work to a fresh attempt; an officer's mark is done (`INV-INT-025`).
 */
export function isClosedByCreditSpentOutsideApp(operation: {
  manuallyResolvedById: string | null;
  manuallyResolvedReason: string | null;
}): boolean {
  return (
    operation.manuallyResolvedById === null &&
    Boolean(operation.manuallyResolvedReason?.startsWith(CREDIT_SPENT_OUTSIDE_APP_REASON_PREFIX))
  );
}
