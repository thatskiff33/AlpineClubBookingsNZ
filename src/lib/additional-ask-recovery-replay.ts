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
import { recordedFoldedReissuedAskCents } from "@/lib/unpaid-ask-offset-marker";

/** The `BookingModification` figures a failed mint's recovery re-derives from. */
export interface RecoveryReplayModification {
  priceDiffCents: number;
  changeFeeCents: number;
  /**
   * Its history row - REQUIRED, so no reader can forget it: an increase that
   * folded waiting re-issues in records them there (`recordedFoldedReissuedAskCents`),
   * and its replay asks for them again (#3954 review round 6).
   */
  newData: unknown;
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
  | { kind: "increase"; ask: AdditionalAsk; foldedCents: number }
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
      ask: sizeReissuedAskReplay({ frozenAmountCents, payment }),
      frozenCents: frozenAmountCents,
    };
  }
  // #3954 round 6: the waiting re-issues this increase folded in were closed
  // by the fold, so its replay is the only thing still able to ask for them.
  const foldedCents = recordedFoldedReissuedAskCents(modification.newData);
  return {
    kind: "increase",
    ask: sizeAdditionalAsk({
      priceDiffCents: modification.priceDiffCents,
      changeFeeCents: modification.changeFeeCents,
      payment,
      waitingReissuedAskCents: foldedCents,
    }),
    foldedCents,
  };
}

/**
 * A reduction's re-issued ask as any minter mints it - the door after commit
 * and the recovery's replay alike (`planReissuedAskMint`): the figure frozen at
 * the reducing edit, all carried, plus the unpaid balance of any ask minted
 * since, which this mint supersedes and so carries (#3954 review round 6).
 */
export function sizeReissuedAskReplay({
  frozenAmountCents,
  payment,
}: {
  frozenAmountCents: number;
  payment: AdditionalAskPayment | null | undefined;
}): AdditionalAsk {
  return reissueUnpaidAdditionalAsk({
    askLeftCents: frozenAmountCents + outstandingAdditionalAskCents(payment),
    payment,
  });
}

/**
 * What a pending recovery adds to the ask the `Payment` already shows: its whole
 * figure less the part it would carry from that ask, which a reduction counts
 * once, as the ask itself - so an increase's own money AND the re-issues it
 * folded in, which no row shows (round 6). Null for a `frozen` figure, whose
 * carried part nobody recorded - a reduction then nets nothing rather than guess.
 */
export function recoveryAskBeyondPaymentAskCents(
  replay: RecoveryReplayAsk,
): number | null {
  if (replay.kind === "frozen") return null;
  return replay.kind === "increase"
    ? replay.ask.amountCents - replay.ask.carriedCents + replay.foldedCents
    : replay.frozenCents;
}

/**
 * #3340's recency rule: an ADDITIONAL row written after the recovery was
 * queued. Since #4015 it settles only a `frozen` recovery
 * (`isRecoveryReplaySettled`) - a figure with no provenance, which the replay
 * cannot split into its own money and a balance it would carry.
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
 * reduction's, read from one place (#3954 review round 4; #4015).
 *
 * A recovery the replay can size - an INCREASE or a RE-ISSUE - is done only
 * once it has written ITS OWN row: the row carrying the intent its replay
 * recorded on the recovery (`holdAdditionalIntentRecoveryClaim`,
 * `writeReissuedAskUnderRecovery`).
 *
 * A LATER ASK NEVER SETTLES IT, because it never carries this money. A later
 * ask is sized off the `Payment` (`sizeAdditionalAsk`), and a failed mint never
 * reached the `Payment`; nor did the waiting re-issues an increase folded in,
 * whose own recoveries the fold closed. Only an edit that folded THIS recovery
 * in asked for it (`foldWaitingReissuedAsks`), and that fold closed it, so its
 * replay never runs. #3340 read any later row as an overtake, and so lost the
 * earlier increase whenever two increases' mints overlapped a Stripe failure
 * (#4015 cases 1 and 2, and a folded increase's replay writing first). The
 * replay instead mints its own money, what it folded and the later ask's unpaid
 * balance, and supersedes that ask (`sizeRecoveryReplayAsk`): the one ask left
 * is the booking's whole outstanding increase.
 *
 * A FROZEN figure keeps #3340's recency rule (`isRecoveryOvertakenByLaterAsk`).
 * Nobody recorded what part of it was carried, so carrying a later ask on top
 * of it could ask for that ask's money twice.
 */
export function isRecoveryReplaySettled(
  replay: RecoveryReplayAsk,
  operation: { createdAt: Date; paymentIntentId: string },
  transactions: readonly { kind: string; createdAt: Date; stripePaymentIntentId: string | null }[],
): boolean {
  if (replay.kind === "frozen") return isRecoveryOvertakenByLaterAsk(operation, transactions);
  return transactions.some(
    (transaction) =>
      transaction.kind === "ADDITIONAL" &&
      transaction.stripePaymentIntentId === operation.paymentIntentId,
  );
}
