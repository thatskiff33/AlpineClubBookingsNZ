/** Pure reservation plan for an officer deduction (#5241). Loader order is retained. */
import { MemberCreditValidationError } from "@/lib/policies/member-credit";

export interface DeductionLot {
  memberCreditId: string;
  xeroCreditNoteId: string;
  remainingCents: number;
  totalCents: number;
  hasSlices: boolean;
  writtenDownCents: number;
  /** Another positive credit row is funded by the same Xero note, free or not. */
  sharesNote: boolean;
}

/** One per Xero note: its reference and idempotency keys name the request and the note alone. */
export interface DeductionLine {
  /** The first lot the line draws on. */
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
    remaining -= amountCents;
    const sameNote = lines.find((line) => line.xeroCreditNoteId === lot.xeroCreditNoteId);
    if (sameNote) {
      sameNote.amountCents += amountCents;
      sameNote.mode = "INVOICE";
      continue;
    }
    // Voiding takes the whole note, so only a lot that is the whole note may plan it.
    const wholeNote = !lot.sharesNote && !lot.hasSlices && lot.writtenDownCents === 0 && amountCents === lot.totalCents;
    lines.push({
      memberCreditId: lot.memberCreditId,
      xeroCreditNoteId: lot.xeroCreditNoteId,
      amountCents,
      mode: wholeNote ? "VOID" : "INVOICE",
    });
  }
  if (remaining > 0) {
    throw new MemberCreditValidationError("This deduction would take credit backed by a Xero overpayment or prepayment. Correct that cash credit through its own Xero workflow.");
  }
  return { notelessCents, lines };
}
