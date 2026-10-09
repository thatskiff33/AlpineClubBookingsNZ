/**
 * WHAT A FAILED MINT'S RECOVERY WILL ASK FOR, said once for the replay that
 * mints it (`processCreateAdditionalPaymentIntentOperation`) and for a price
 * reduction that nets it off before it runs (`readUnpaidPriceAsk`; #3954, owner
 * decision 9 Oct 2026, "retry nets it off"; `INV-PAY-120`).
 *
 * Pure, like the arithmetic it builds on (`additional-payment-ask.ts`): no
 * client, so the replay, the reduction and the tests all import it.
 */
import {
  outstandingAdditionalAskCents,
  reissueUnpaidAdditionalAsk,
  sizeAdditionalAsk,
  type AdditionalAsk,
  type AdditionalAskPayment,
} from "@/lib/additional-payment-ask";

/** The `BookingModification` figures a failed mint's recovery re-derives from. */
export interface RecoveryReplayModification {
  priceDiffCents: number;
  changeFeeCents: number;
}

/**
 * The three ways a replay sizes its ask (#3340, #3954):
 *
 * - `increase`: the edit's own net plus the unpaid balance of the ask it will
 *   supersede, re-derived against the `Payment` as it stands
 *   (`sizeAdditionalAsk`), so a frozen moment never over-asks.
 * - `reissue`: a reduction's smaller re-issued ask, frozen at that edit and all
 *   carried (`reissueUnpaidAdditionalAsk`) - the ask it replaced was retired in
 *   that edit's transaction, so nothing on the `Payment` re-derives it. PLUS
 *   the unpaid balance of any later ask on the `Payment` (#3954 review round 4):
 *   a later minter that did not fold this waiting re-issue in asked only for its
 *   own money, and the replay supersedes that ask, so it carries it. With no
 *   later ask the balance is 0 - the reduction retired every ask before it.
 * - `frozen`: no modification to read, or one whose own net is zero, which an
 *   ordinary edit's row never is. The frozen figure, with no provenance.
 */
export type RecoveryReplayAsk =
  | { kind: "increase"; ask: AdditionalAsk }
  | { kind: "reissue"; ask: AdditionalAsk; frozenCents: number }
  | { kind: "frozen"; amountCents: number };

export function sizeRecoveryReplayAsk({
  frozenAmountCents,
  modification,
  payment,
}: {
  frozenAmountCents: number;
  modification: RecoveryReplayModification | null;
  payment: AdditionalAskPayment | null | undefined;
}): RecoveryReplayAsk {
  const ownCents = modification
    ? modification.priceDiffCents + modification.changeFeeCents
    : 0;
  if (!modification || ownCents === 0) {
    return { kind: "frozen", amountCents: frozenAmountCents };
  }
  if (ownCents < 0) {
    return {
      kind: "reissue",
      ask: reissueUnpaidAdditionalAsk({
        askLeftCents: frozenAmountCents + outstandingAdditionalAskCents(payment),
      }),
      frozenCents: frozenAmountCents,
    };
  }
  return {
    kind: "increase",
    ask: sizeAdditionalAsk({
      priceDiffCents: modification.priceDiffCents,
      changeFeeCents: modification.changeFeeCents,
      payment,
    }),
  };
}

/**
 * What a pending recovery adds to the ask the `Payment` already shows: its whole
 * figure less the part it would carry from that ask, which a reduction counts
 * once, as the ask itself. Null for a `frozen` figure, whose carried part
 * nobody recorded - a reduction then nets nothing rather than guess.
 */
export function recoveryAskBeyondPaymentAskCents(
  replay: RecoveryReplayAsk,
): number | null {
  if (replay.kind === "frozen") return null;
  return replay.kind === "increase"
    ? replay.ask.amountCents - replay.ask.carriedCents
    : replay.frozenCents;
}

/**
 * A recovery whose edit was overtaken: an ADDITIONAL row written after the
 * recovery was queued means a later mint priced the booking, so the replay
 * completes without minting. The replay and a reduction read the same rule.
 */
export function isRecoveryOvertakenByLaterAsk(
  operation: { createdAt: Date },
  transactions: readonly { kind: string; createdAt: Date }[],
): boolean {
  return transactions.some(
    (transaction) =>
      transaction.kind === "ADDITIONAL" &&
      transaction.createdAt > operation.createdAt,
  );
}

/**
 * WHETHER A RECOVERY HAS NOTHING LEFT TO MINT - the replay's rule and a price
 * reduction's, read from one place (#3954 review round 4).
 *
 * An INCREASE's recovery is done once any later ask exists: that ask re-priced
 * the booking from the `Payment` as it stood (`isRecoveryOvertakenByLaterAsk`,
 * #3340's rule, unchanged).
 *
 * A RE-ISSUE's is done only once it has written ITS OWN row - the row carrying
 * the intent its replay recorded on the recovery
 * (`holdAdditionalIntentRecoveryClaim`, `writeReissuedAskUnderRecovery`). A
 * later ask from a minter that did not fold the waiting re-issue in
 * (`foldWaitingReissuedAsks`) asked only for its own money, so treating it as
 * an overtake would drop the re-issue's whole figure; the replay instead
 * carries that later ask and supersedes it (`sizeRecoveryReplayAsk`).
 */
export function isRecoveryReplaySettled(
  replay: RecoveryReplayAsk,
  operation: { createdAt: Date; paymentIntentId: string },
  transactions: readonly { kind: string; createdAt: Date; stripePaymentIntentId: string | null }[],
): boolean {
  if (replay.kind === "reissue") {
    return transactions.some(
      (transaction) =>
        transaction.kind === "ADDITIONAL" &&
        transaction.stripePaymentIntentId === operation.paymentIntentId,
    );
  }
  return isRecoveryOvertakenByLaterAsk(operation, transactions);
}
