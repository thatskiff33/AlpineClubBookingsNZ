// The operator instruction for a group-settlement invoice the app did not
// apply, moved verbatim from `invoice-paid-effects.ts` to keep that file under
// its size ceiling (#5145).
import type { ClubFormat } from "@/lib/club-format";
import type { GroupSettlementMismatch } from "@/lib/group-settlement";
import { formatCents } from "@/lib/utils";

/** The operator instruction for a paid invoice the app did not apply (#1033, #3642). */
export function groupSettlementMismatchMessage(
  invoiceId: string,
  mismatch: GroupSettlementMismatch | undefined,
  format: ClubFormat
): string {
  if (mismatch?.reason === "collected") {
    return `Group settlement invoice ${invoiceId} was paid ${formatCents(mismatch.collectedCents, format)}, but the settlement it pays is ${formatCents(mismatch.recordedCents, format)}. No bookings were settled; reconcile manually (collect or refund the difference, then settle the group).`;
  }
  if (
    mismatch?.reason === "invoice_superseded" ||
    mismatch?.reason === "intent_superseded"
  ) {
    return `Group settlement invoice ${invoiceId} was paid, but the settlement no longer uses that invoice. No bookings were settled; refund or credit the organiser in Xero, or apply the payment by hand.`;
  }
  return `Group settlement invoice ${invoiceId} was paid, but a child booking changed while it was open so the total no longer matches. No bookings were settled; reconcile manually (short-pay/refund the difference or re-issue the settlement).`;
}
