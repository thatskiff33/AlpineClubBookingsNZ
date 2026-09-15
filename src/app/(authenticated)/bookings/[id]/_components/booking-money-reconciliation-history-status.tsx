import type { BookingMoneyReconciliation } from "@/lib/booking-money-reconciliation";

export function BookingMoneyReconciliationHistoryStatus({
  reconciliation,
}: {
  reconciliation: BookingMoneyReconciliation | null;
}) {
  if (!reconciliation) return null;
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
        Current money reconciliation: {unreconciled ? "Unreconciled" : "Reconciled"}
      </p>
      {unreconciled ? (
        <p>{reconciliation.reasons.join(", ")}</p>
      ) : (
        <p>The stored booking headline reconciles with its recorded build-up.</p>
      )}
      <p className="text-xs opacity-80">
        This is the current derived state, not a historical transaction.
      </p>
    </div>
  );
}
