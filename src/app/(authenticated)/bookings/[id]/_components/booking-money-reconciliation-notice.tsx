import {
  BOOKING_MONEY_RECONCILIATION_COPY,
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
  return (
    <div
      role="alert"
      data-testid="booking-money-unreconciled"
      data-reconciliation-state={reconciliation.state}
      data-reconciliation-reasons={reconciliation.reasons.join(",")}
      className="space-y-1 rounded-md border border-danger-6 bg-danger-3 px-4 py-3 text-sm text-danger-11"
    >
      <p className="font-medium">
        {BOOKING_MONEY_RECONCILIATION_COPY.noticeTitle}
      </p>
      <p>{BOOKING_MONEY_RECONCILIATION_COPY.noticeBody}</p>
      <ul className="list-disc pl-5">
        {reconciliation.reasons.map((reason) => (
          <li key={reason}>
            {BOOKING_MONEY_RECONCILIATION_REASON_TEXT[reason]}.
          </li>
        ))}
      </ul>
    </div>
  );
}
