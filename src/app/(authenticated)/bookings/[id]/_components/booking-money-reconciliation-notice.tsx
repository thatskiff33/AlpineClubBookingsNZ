import {
  bookingMoneyEvidenceAbsentReasons,
  bookingMoneyUnreconciledCopy,
  bookingMoneyUnreconciledKind,
  BOOKING_MONEY_RECONCILIATION_REASON_TEXT,
  bookingMoneyNeedsOfficerReview,
  type BookingMoneyReconciliationView,
} from "@/lib/booking-money-reconciliation-audience";

/**
 * The banner above a booking whose stored money cannot be proved (#3278).
 *
 * It takes the GATED view, never the raw verdict: whether this viewer may read
 * one is decided by the loader, not here (owner decision, 20 September 2026 —
 * officer-only). The wording and the per-reason sentences come from the one
 * copy home, so this component names nothing of its own.
 */
export function BookingMoneyReconciliationNotice({
  view,
}: {
  view: BookingMoneyReconciliationView;
}) {
  // The guard narrows as well as decides, so there is no second test here that
  // could come to disagree with it.
  if (!bookingMoneyNeedsOfficerReview(view)) return null;
  const { reconciliation } = view;
  // Wording, and the weight the banner carries, both follow the kind: a
  // discrepancy is a task, absent records are a fact with nothing to action.
  const kind = bookingMoneyUnreconciledKind(reconciliation.reasons);
  const copy = bookingMoneyUnreconciledCopy(reconciliation.reasons);
  const evidenceAbsent = kind === "EVIDENCE_ABSENT";
  return (
    <div
      // An unactionable statement is not an alert; announcing it as one is
      // what trains an officer to skim the banner that IS actionable.
      role={evidenceAbsent ? "note" : "alert"}
      data-testid="booking-money-unreconciled"
      data-reconciliation-state={reconciliation.state}
      data-reconciliation-reasons={reconciliation.reasons.join(",")}
      data-reconciliation-kind={kind}
      className={`space-y-1 rounded-md border px-4 py-3 text-sm ${
        evidenceAbsent
          ? "border-border bg-muted text-muted-foreground"
          : "border-danger-6 bg-danger-3 text-danger-11"
      }`}
    >
      <p className="font-medium">
        {copy.noticeTitle}
      </p>
      <p>{copy.noticeBody}</p>
      <ul className="list-disc pl-5">
        {evidenceAbsent
          ? // Each line says WHY this booking cannot be checked, not just what
            // is missing — without the cause the reader cannot tell whether it
            // is theirs to fix.
            bookingMoneyEvidenceAbsentReasons(reconciliation.reasons).map(
              ({ reason, why }) => <li key={reason}>{why}</li>,
            )
          : reconciliation.reasons.map((reason) => (
              <li key={reason}>
                {BOOKING_MONEY_RECONCILIATION_REASON_TEXT[reason]}.
              </li>
            ))}
      </ul>
    </div>
  );
}
