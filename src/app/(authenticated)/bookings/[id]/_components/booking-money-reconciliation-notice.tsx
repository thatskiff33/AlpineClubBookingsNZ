import type {
  BookingMoneyReconciliation,
  BookingMoneyReconciliationReason,
} from "@/lib/booking-money-reconciliation";

const REASON_TEXT: Record<BookingMoneyReconciliationReason, string> = {
  NO_SURVIVING_STRANDS: "no surviving guest price strands are recorded",
  STRAND_EVIDENCE_UNREADABLE:
    "at least one guest strand has incomplete or inexact stored price evidence",
  HEADLINE_TOTAL_MISMATCH:
    "the stored booking total differs from the recorded guest totals",
  PROMO_BUILD_UP_NOT_KNOWN:
    "the recorded promotion build-up is missing or not knowable",
  PROMO_BUILD_UP_MISMATCH:
    "the stored promotion adjustment differs from its recorded build-up",
  DISCOUNT_COMPONENT_MISMATCH:
    "the legacy discount component differs from the signed promotion adjustment",
  FINAL_PRICE_RELATION_MISMATCH:
    "the stored final price differs from the booking total plus its promotion adjustment",
};

export function BookingMoneyReconciliationNotice({
  reconciliation,
}: {
  reconciliation: BookingMoneyReconciliation;
}) {
  if (reconciliation.state === "RECONCILED") return null;
  return (
    <div
      role="alert"
      data-testid="booking-money-unreconciled"
      data-reconciliation-state={reconciliation.state}
      data-reconciliation-reasons={reconciliation.reasons.join(",")}
      className="space-y-1 rounded-md border border-danger-6 bg-danger-3 px-4 py-3 text-sm text-danger-11"
    >
      <p className="font-medium">Recorded booking money needs officer review</p>
      <p>
        Do not treat the stored total as reconciled until an officer has checked
        the recorded parts. No amount has been changed automatically.
      </p>
      <ul className="list-disc pl-5">
        {reconciliation.reasons.map((reason) => (
          <li key={reason}>{REASON_TEXT[reason]}.</li>
        ))}
      </ul>
    </div>
  );
}

