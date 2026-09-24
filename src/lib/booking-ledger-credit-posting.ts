/**
 * WHICH SETTLEMENT LINES A BOOKING'S ACCOUNT-CREDIT ROWS AND HAND-BACKS IMPLY
 * (#3599, programme #3527; design `docs/design/booking-ledger.md` §5.2).
 *
 * Pure: it reads nothing and writes nothing. The store-facing halves are
 * `booking-ledger-credit-sync.ts` (credit rows) and
 * `booking-ledger-hand-back-posting.ts` (a completed hand-back).
 *
 * INSERT-ONLY IS SOUND HERE, and that was checked at source rather than
 * assumed — the opposite of #3581, where a captured transaction can stop being
 * captured. No writer changes a `MemberCredit` row's amount, type or booking
 * link after it is written (every update touches only `xeroCreditNoteId` or
 * `description`); a correction is always a NEW row — the clamp's positive
 * give-back, a Xero allocation repair's offset, a cancellation's restore. So
 * each booking-linked row posts exactly one line, keyed by its id, and nothing
 * here is ever reversed.
 *
 * ONE SIGN RULE: the booking-side amount is the NEGATION of the row's. Credit
 * consumed is a negative `BOOKING_APPLIED` row and settles the booking (+);
 * a clamp give-back is a positive one and un-settles it (−). Credit minted to
 * the member — on a cancellation, a reduction, or a restore — is a positive
 * row and returns value from the booking (−). The account itself stays in
 * `MemberCredit` alone (`INV-PAY-019`); the ledger posts the booking's leg.
 *
 * A RESTORE IS NOT A REVERSAL (correcting the design as first written). The
 * cancel path restores applied credit TIERED by the cancellation policy
 * (`calculateAppliedCreditRestore`, #1164), so a restore can be less than what
 * was applied, and it is one row for however many `BOOKING_APPLIED` rows the
 * booking holds. A reversal copies the line it reverses in full, so it would
 * over-state every tiered restore. A restore therefore posts `CREDIT_ISSUED`
 * for exactly what was restored, and is told apart from a cancellation credit
 * on the LINE — anchored on the `CANCELLATION` (the booking id; there is at
 * most one restore per booking, by the unique `restoredFromBookingId`) — because
 * the two differ in money terms: a cancellation credit moves the payment's
 * `refundedAmountCents`, a restore never does (`stripe-cash-refund-evidence.ts`).
 */
import type { CreditType } from "@prisma/client";

import { creditKey, handBackKey } from "@/lib/booking-ledger-posting-keys";
import type { BookingLedgerPosting } from "@/lib/booking-ledger-write";

/** One `MemberCredit` row linked to the booking, as the sync reads it. */
export type BookingCreditRow = {
  id: string;
  type: CreditType;
  amountCents: number;
  restoredFromBookingId: string | null;
};

/** A credit line already on the ledger: its key and the figure it posted. */
export type PostedCreditLine = { postingKey: string | null; amountCents: number };

export type CreditPlan = {
  postings: BookingLedgerPosting[];
  /**
   * A line already posted for a row whose amount no longer matches it. Cannot
   * happen while rows are immutable; surfaced rather than corrected, for the
   * caller to log and C4's census (#3583) to count, should that ever change.
   */
  amountDrift: Array<{ postingKey: string; postedCents: number; sourceCents: number }>;
};

function creditShape(
  row: BookingCreditRow,
  bookingId: string,
  bookingSideCents: number,
): Pick<BookingLedgerPosting, "kind" | "anchorKind" | "anchorId" | "narration"> {
  switch (row.type) {
    case "BOOKING_APPLIED":
      return {
        kind: "CREDIT_APPLIED",
        anchorKind: "MEMBER_CREDIT",
        anchorId: row.id,
        narration:
          bookingSideCents > 0 ? "Account credit applied" : "Applied account credit returned to the member",
      };
    case "CANCELLATION_REFUND":
      return row.restoredFromBookingId === null
        ? {
            kind: "CREDIT_ISSUED",
            anchorKind: "MEMBER_CREDIT",
            anchorId: row.id,
            narration: "Credited to account on cancellation",
          }
        : {
            kind: "CREDIT_ISSUED",
            anchorKind: "CANCELLATION",
            anchorId: bookingId,
            narration: "Applied account credit restored on cancellation",
          };
    case "BOOKING_MODIFICATION_REFUND":
      return {
        kind: "CREDIT_ISSUED",
        anchorKind: "MEMBER_CREDIT",
        anchorId: row.id,
        narration: "Credited to account after a booking change",
      };
    default:
      // `ADMIN_ADJUSTMENT` names no booking, so the sync never reads one. If a
      // row of it ever arrives, that is a reader bug, refused in pure code.
      throw new Error(`INV-MONEY-035: a ${row.type} credit row is not a booking's settlement`);
  }
}

export function planCreditLines(input: {
  bookingId: string;
  lodgeId: string;
  credits: readonly BookingCreditRow[];
  postedLines: readonly PostedCreditLine[];
}): CreditPlan {
  const posted = new Map<string, number>();
  for (const line of input.postedLines) {
    if (line.postingKey) posted.set(line.postingKey, line.amountCents);
  }

  const postings: BookingLedgerPosting[] = [];
  const amountDrift: CreditPlan["amountDrift"] = [];
  for (const row of input.credits) {
    const bookingSideCents = -row.amountCents;
    // A $0 row moves nothing, so it posts nothing (the sign would be a guess).
    if (bookingSideCents === 0) continue;
    const postingKey = creditKey(row.id);
    const postedCents = posted.get(postingKey);
    if (postedCents !== undefined) {
      if (postedCents !== bookingSideCents) {
        amountDrift.push({ postingKey, postedCents, sourceCents: bookingSideCents });
      }
      continue;
    }
    postings.push({
      bookingId: input.bookingId,
      lodgeId: input.lodgeId,
      side: "SETTLEMENT",
      ...creditShape(row, input.bookingId, bookingSideCents),
      sign: bookingSideCents > 0 ? 1 : -1,
      quantity: 1,
      unitCents: Math.abs(bookingSideCents),
      settlementMethod: "ACCOUNT_CREDIT",
      postingKey,
    });
  }
  return { postings, amountDrift };
}

/**
 * The line for money an officer handed back outside the card rails, recorded by
 * completing a task on the `local-allocation` route. The method is the one
 * `refundMethodForEditReviewRoute` gives that route — internet banking, "the
 * only way a club sends money it holds" (`INV-PAY-101`) — passed in by the
 * caller from there rather than restated here.
 */
export function planHandBackLine(input: {
  bookingId: string;
  lodgeId: string;
  manualRefundTaskId: string;
  amountCents: number;
  settlementMethod: NonNullable<BookingLedgerPosting["settlementMethod"]>;
  officerMemberId: string;
}): BookingLedgerPosting {
  return {
    bookingId: input.bookingId,
    lodgeId: input.lodgeId,
    side: "SETTLEMENT",
    kind: "BANK_REFUND",
    sign: -1,
    quantity: 1,
    unitCents: input.amountCents,
    anchorKind: "REVIEW_TASK",
    anchorId: input.manualRefundTaskId,
    settlementMethod: input.settlementMethod,
    narration: "Refund handed back by an officer",
    postedByMemberId: input.officerMemberId,
    postingKey: handBackKey(input.manualRefundTaskId),
  };
}
