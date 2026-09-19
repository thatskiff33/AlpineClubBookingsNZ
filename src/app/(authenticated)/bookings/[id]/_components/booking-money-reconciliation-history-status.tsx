import {
  BOOKING_MONEY_RECONCILIATION_COPY,
  bookingMoneyReviewReasonText,
  type BookingMoneyReconciliationView,
} from "@/lib/booking-money-reconciliation-audience";

/**
 * The transaction-history panel's line for the booking's CURRENT derived money
 * state (#3278) — the one surface that reports "reconciled" as well as
 * "unreconciled", because an officer reading a booking's history wants to know
 * the check ran and passed.
 *
 * A `WITHHELD` view renders nothing at all: the loader has already decided
 * this viewer is not an officer, and there is no null here to mistake for a
 * booking that simply reconciles.
 */
export function BookingMoneyReconciliationHistoryStatus({
  view,
}: {
  view: BookingMoneyReconciliationView;
}) {
  if (view.visibility !== "VISIBLE") return null;
  const { reconciliation } = view;
  const unreconciled = reconciliation.state === "UNRECONCILED";
  return (
    <div
      data-testid="booking-history-money-reconciliation"
      data-reconciliation-state={reconciliation.state}
      data-reconciliation-reasons={reconciliation.reasons.join(",")}
      className={`mb-3 space-y-1 rounded-md border px-3 py-2 text-sm ${
        unreconciled
          ? "border-danger-6 bg-danger-3 text-danger-11"
          : "border-success-6 bg-success-3 text-success-11"
      }`}
    >
      <p className="font-medium">
        {BOOKING_MONEY_RECONCILIATION_COPY.currentStateLabel}:{" "}
        {
          BOOKING_MONEY_RECONCILIATION_COPY.stateLabel[
            reconciliation.state
          ]
        }
      </p>
      {unreconciled ? (
        <p>{bookingMoneyReviewReasonText(reconciliation.reasons)}.</p>
      ) : (
        <p>{BOOKING_MONEY_RECONCILIATION_COPY.reconciledDetail}</p>
      )}
      <p className="text-xs opacity-80">
        {BOOKING_MONEY_RECONCILIATION_COPY.derivedStateNote}
      </p>
    </div>
  );
}
