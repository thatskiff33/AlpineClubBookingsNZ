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
import { liveLines, type PostedAdjustmentLine } from "@/lib/booking-ledger-modification-posting";
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

export function planCancellationChargeLines({
  bookingId,
  lodgeId,
  keptCents,
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
  for (const line of liveLines(adjustmentLines)) {
    postings.push({
      ...anchor,
      side: "ADJUSTMENT",
      kind: "AGREED_ADJUSTMENT",
      sign: line.sign === 1 ? -1 : 1,
      quantity: line.quantity,
      unitCents: line.unitCents,
      narration: `Reversed: ${line.narration}`,
      reversesLineId: line.id,
      postingKey: reversalKey(line.id),
    });
  }
  const cancellationFeeCents = changeFeesReversed ? keptCents : keptCents - changeFeeCents;
  if (cancellationFeeCents > 0) {
    postings.push({
      ...anchor,
      side: "CHARGE",
      kind: "CANCELLATION_FEE",
      sign: 1,
      quantity: 1,
      unitCents: cancellationFeeCents,
      narration: "Cancellation fee retained",
      postingKey: cancellationFeeKey(bookingId),
    });
  }
  return { kind: "lines", postings, cancellationFeeCents, changeFeesReversed };
}
