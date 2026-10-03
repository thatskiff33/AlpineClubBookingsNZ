/**
 * THE LINES A CANCELLATION POSTS (#3611, programme #3527). The rule lives in
 * design `docs/design/booking-ledger.md` §5.1 ("How C3b posts a cancellation");
 * this module implements it and states only what the code itself must know.
 *
 * Pure: it takes what the club keeps and every line the booking holds, and
 * returns the lines to post. `booking-ledger-cancellation-sync.ts` reads and
 * writes. The chain walk is `liveLines`, shared with an edit, so a line an
 * earlier edit or closure already reversed is never reversed again.
 */
import {
  chargeLineReversal,
  type ChargeLineAnchor,
  type ReversibleChargeLine,
} from "@/lib/booking-ledger-charge-line";
import {
  agreedAdjustmentReversal,
  liveLines,
  type PostedAdjustmentLine,
} from "@/lib/booking-ledger-modification-posting";
import { cancellationFeeKey, reversalKey } from "@/lib/booking-ledger-posting-keys";
import { ledgerLineAmountCents, type BookingLedgerPosting } from "@/lib/booking-ledger-write";

export type CancellationPostingPlan =
  | {
      kind: "lines";
      postings: BookingLedgerPosting[];
      /** The `CANCELLATION_FEE` posted; 0 where none is. */
      cancellationFeeCents: number;
      /** True where the change fees were taken back too (§5.1: kept below them). */
      changeFeesReversed: boolean;
    }
  | { kind: "none"; reason: "INVALID_KEPT_AMOUNT" };

/** The decision's narration, for a kept figure that is the policy's own (owner decision B). */
export const CANCELLATION_FEE_NARRATION = "Cancellation fee retained";

/**
 * What the kept line says (review D1): the decision's narration where the kept
 * figure is the policy's own, and what it is where it also holds money no
 * policy tier decided. Narration only, never read for money.
 */
export function cancellationFeeNarration(keptCents: number, policyKeptCents: number): string {
  if (keptCents === policyKeptCents) return CANCELLATION_FEE_NARRATION;
  return keptCents > policyKeptCents
    ? "Cancellation: amount retained (policy fee plus earlier charges)"
    : "Cancellation: amount retained (less than the policy fee)";
}

export function planCancellationChargeLines({
  bookingId,
  lodgeId,
  keptCents,
  policyKeptCents = keptCents,
  chargeLines,
  adjustmentLines,
}: {
  bookingId: string;
  lodgeId: string;
  /**
   * What the club keeps of the booking's money, change fees included: the paid
   * path's `ledgerKeptCents` (`paid-cancellation-money.ts`), or 0.
   */
  keptCents: number;
  /**
   * What the policy alone keeps (`paidCancellationMoney`'s `policyKeptCents`);
   * omitted where nothing is kept, so it equals `keptCents`. Changes only the
   * kept line's narration.
   */
  policyKeptCents?: number;
  /** Every GUEST_NIGHT, PROMOTION and CHANGE_FEE line the booking holds, live or not. */
  chargeLines: readonly ReversibleChargeLine[];
  /** Every AGREED_ADJUSTMENT the booking holds, live or not. */
  adjustmentLines: readonly PostedAdjustmentLine[];
}): CancellationPostingPlan {
  if (!Number.isSafeInteger(keptCents) || keptCents < 0) {
    return { kind: "none", reason: "INVALID_KEPT_AMOUNT" };
  }
  const anchor: ChargeLineAnchor = { bookingId, lodgeId, anchorKind: "CANCELLATION", anchorId: bookingId };
  const live = liveLines(chargeLines);
  const changeFees = live.filter((line) => line.kind === "CHANGE_FEE");
  const changeFeeCents = changeFees.reduce((sum, line) => sum + ledgerLineAmountCents(line), 0);
  // The change fees stay charged while what the club keeps covers them; below
  // that, they are taken back and the fee carries all of it (never below zero).
  const changeFeesReversed = keptCents < changeFeeCents;
  const reversed = live.filter((line) => line.kind !== "CHANGE_FEE" || changeFeesReversed);

  const postings: BookingLedgerPosting[] = reversed.map((line) =>
    chargeLineReversal(anchor, line, reversalKey(line.id)),
  );
  // A live stand-in for money the charge lines did not carry (§5.3) goes with
  // the stay: the kept figure already counts every cent the club holds.
  for (const line of liveLines(adjustmentLines)) postings.push(agreedAdjustmentReversal(anchor, line));
  const cancellationFeeCents = changeFeesReversed ? keptCents : keptCents - changeFeeCents;
  if (cancellationFeeCents > 0) {
    postings.push({
      ...anchor,
      side: "CHARGE",
      kind: "CANCELLATION_FEE",
      sign: 1,
      quantity: 1,
      unitCents: cancellationFeeCents,
      narration: cancellationFeeNarration(keptCents, policyKeptCents),
      postingKey: cancellationFeeKey(bookingId),
    });
  }
  return { kind: "lines", postings, cancellationFeeCents, changeFeesReversed };
}
