import { asRecord, readString } from "@/lib/xero-json";

export const XERO_OUTBOX_ORGANISER_EXTRA_ADJUSTMENT_TYPE = "ORGANISER_EXTRA_ADJUSTMENT";
export interface OrganiserExtraAdjustmentPayload {
  queueType: typeof XERO_OUTBOX_ORGANISER_EXTRA_ADJUSTMENT_TYPE;
  bookingId: string;
  scopeId: string;
  modificationId: string | null;
  invoiceId: string | null;
  amountCents: number;
  purpose: "waive" | "refund";
  /** Paid price removed by this change, before its policy percentage. */
  priceBasisCents?: number;
  cashAtPlanCents: number;
  refundPercentage: number;
  /** A refund is released only once this bank-transfer hand-back is completed. */
  handBackTaskId?: string;
}
export function readOrganiserExtraAdjustmentPayload(value: unknown): OrganiserExtraAdjustmentPayload | null {
  const p = asRecord(value);
  if (p?.queueType !== XERO_OUTBOX_ORGANISER_EXTRA_ADJUSTMENT_TYPE) return null;
  const bookingId = readString(p.bookingId);
  const scopeId = readString(p.scopeId);
  if (!bookingId || !scopeId || (p.purpose !== "waive" && p.purpose !== "refund") ||
    typeof p.amountCents !== "number" || !Number.isSafeInteger(p.amountCents) || p.amountCents < 0 ||
    typeof p.cashAtPlanCents !== "number" || !Number.isSafeInteger(p.cashAtPlanCents) || p.cashAtPlanCents < 0 ||
    typeof p.refundPercentage !== "number" || !Number.isFinite(p.refundPercentage) || p.refundPercentage < 0 || p.refundPercentage > 100) return null;
  if (p.amountCents === 0 && !(p.purpose === "refund" && typeof p.priceBasisCents === "number" && p.priceBasisCents > 0)) return null;
  if (p.priceBasisCents !== undefined && (typeof p.priceBasisCents !== "number" || !Number.isSafeInteger(p.priceBasisCents) || p.priceBasisCents < 0)) return null;
  const modificationId = readString(p.modificationId);
  const invoiceId = readString(p.invoiceId);
  if (!modificationId && !invoiceId) return null;
  return { queueType: XERO_OUTBOX_ORGANISER_EXTRA_ADJUSTMENT_TYPE, bookingId, scopeId, modificationId, invoiceId,
    amountCents: p.amountCents, purpose: p.purpose, ...(typeof p.priceBasisCents === "number" ? { priceBasisCents: p.priceBasisCents } : {}), cashAtPlanCents: p.cashAtPlanCents, refundPercentage: p.refundPercentage,
    ...(readString(p.handBackTaskId) ? { handBackTaskId: readString(p.handBackTaskId)! } : {}),
  };
}
