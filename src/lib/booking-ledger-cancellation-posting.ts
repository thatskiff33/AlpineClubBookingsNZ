/**
 * THE CHARGE LINES A CANCELLATION POSTS (#3611, programme #3527; design
 * `docs/design/booking-ledger.md` §5.1, owner decision B of 24 Sep 2026).
 *
 * A cancellation takes the stay back and keeps what the policy keeps:
 *
 *   - one reversal of every LIVE `GUEST_NIGHT` and `PROMOTION` line, after
 *     walking every earlier edit's reversals (`liveLines`), so no line is
 *     reversed twice;
 *   - one `CANCELLATION_FEE` for what the club keeps, when that is above zero.
 *
 * `CHANGE_FEE` lines stay: a change fee is not refundable (`INV-PAY-018`), and
 * the paid path's refundable base already leaves it out.
 *
 * Every line is anchored on the `CANCELLATION` (the booking id). Once the
 * refund, credit and hand-back that follow post their own settlement lines
 * (§5.2), `owed(b)` is zero.
 *
 * Pure: it reads nothing and writes nothing. `booking-ledger-cancellation-sync.ts`
 * asks the ledger what it holds and writes the plan inside the cancel path's
 * own transaction.
 */
import { chargeLineReversal, type ChargeLineAnchor } from "@/lib/booking-ledger-charge-line";
import { liveLines, type PostedChargeLine } from "@/lib/booking-ledger-modification-posting";
import { cancellationFeeKey, reversalKey } from "@/lib/booking-ledger-posting-keys";
import type { BookingLedgerPosting } from "@/lib/booking-ledger-write";

/**
 * What the club keeps on a paid cancellation, from the figures the cancel path
 * already computed: the part of the refundable card or cash slice it did not
 * refund, plus the part of the applied credit it did not restore. The tier's
 * fixed fee is in there once, card-first, because `calculateRefundAmount` and
 * `calculateAppliedCreditRestore` already put it there.
 *
 * An unpaid cancellation keeps nothing and passes 0 rather than calling this.
 */
export function cancellationKeptCents({
  refundableBaseCents,
  refundAmountCents,
  creditAppliedCents,
  creditRestoredCents,
}: {
  /** The slice the tier applied to (`cancelRefundableBaseCents`, or a group child's price). */
  refundableBaseCents: number;
  /** What the policy returns from that slice — by card, as credit or by hand. */
  refundAmountCents: number;
  /** The account credit the booking had applied. */
  creditAppliedCents: number;
  /** What the cancellation restored of it. */
  creditRestoredCents: number;
}): number {
  return refundableBaseCents - refundAmountCents + (creditAppliedCents - creditRestoredCents);
}

export type CancellationPostingPlan =
  | { kind: "lines"; postings: BookingLedgerPosting[] }
  | { kind: "none"; reason: "INVALID_KEPT_AMOUNT" };

export function planCancellationChargeLines({
  bookingId,
  lodgeId,
  keptCents,
  postedLines,
}: {
  bookingId: string;
  lodgeId: string;
  /** What the club keeps under the policy; 0 for an unpaid cancellation. */
  keptCents: number;
  /** Every GUEST_NIGHT and PROMOTION line the booking holds, live or not. */
  postedLines: readonly PostedChargeLine[];
}): CancellationPostingPlan {
  // A kept figure below zero is not a fee: it means the slice the policy tiered
  // was smaller than what it says it returned (a payment that never covered its
  // change fee). Nothing posts, so the stay and the fee stand or go together.
  if (!Number.isSafeInteger(keptCents) || keptCents < 0) {
    return { kind: "none", reason: "INVALID_KEPT_AMOUNT" };
  }
  const anchor: ChargeLineAnchor = {
    bookingId,
    lodgeId,
    anchorKind: "CANCELLATION",
    anchorId: bookingId,
  };
  const postings = liveLines(postedLines).map((line) =>
    chargeLineReversal(anchor, line, reversalKey(line.id)),
  );
  if (keptCents > 0) {
    postings.push({
      ...anchor,
      side: "CHARGE",
      kind: "CANCELLATION_FEE",
      sign: 1,
      quantity: 1,
      unitCents: keptCents,
      narration: "Cancellation fee retained",
      postingKey: cancellationFeeKey(bookingId),
    });
  }
  return { kind: "lines", postings };
}
