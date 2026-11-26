/** Pure reservation plan for an officer deduction (#5241). Loader order is retained. */
import { MemberCreditValidationError } from "@/lib/policies/member-credit";

export interface DeductionLot {
  memberCreditId: string;
  xeroCreditNoteId: string;
  remainingCents: number;
  totalCents: number;
  hasSlices: boolean;
  writtenDownCents: number;
}

export interface DeductionLine {
  memberCreditId: string;
  xeroCreditNoteId: string;
  amountCents: number;
  mode: "VOID" | "INVOICE";
}

/**
 * Net balance, rather than positive noteless lots, proves unbacked availability:
 * those lots otherwise still include old deductions and credit promised to bookings.
 * Cash backing is never silently converted into a credit-note correction.
 */
export function planAdminCreditDeduction(
  cents: number,
  balanceCents: number,
  cashBackedCents: number,
  lots: readonly DeductionLot[],
): { notelessCents: number; lines: DeductionLine[] } {
  if (!Number.isSafeInteger(cents) || cents <= 0) {
    throw new MemberCreditValidationError("A deduction must be a positive whole number of cents.");
  }
  if (cents > balanceCents) {
    throw new MemberCreditValidationError("This deduction exceeds the member's available credit balance.");
  }
  const notedCents = lots.reduce((sum, lot) => sum + lot.remainingCents, 0);
  const notelessCents = Math.min(cents, Math.max(0, balanceCents - notedCents - cashBackedCents));
  let remaining = cents - notelessCents;
  const lines: DeductionLine[] = [];
  for (const lot of lots) {
    const amountCents = Math.min(remaining, lot.remainingCents);
    if (amountCents <= 0) continue;
    lines.push({
      memberCreditId: lot.memberCreditId,
      xeroCreditNoteId: lot.xeroCreditNoteId,
      amountCents,
      mode: !lot.hasSlices && lot.writtenDownCents === 0 && amountCents === lot.totalCents ? "VOID" : "INVOICE",
    });
    remaining -= amountCents;
  }
  if (remaining > 0) {
    throw new MemberCreditValidationError("This deduction would take credit backed by a Xero overpayment or prepayment. Correct that cash credit through its own Xero workflow.");
  }
  return { notelessCents, lines };
}
