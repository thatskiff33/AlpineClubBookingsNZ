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
import { isProviderCapturedIntentStatus, readOpenProviderIntent } from "@/lib/additional-payment-chase";
import {
  bookingModificationIdForAdditionalIntentRecoveryKey,
  isEditFinancialReviewAdditionalIntentRecoveryKey,
} from "@/lib/payment-recovery-keys";
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

/** A recovery, as `findOwnRecoveryRow` and `isRecoveryReplaySettled` read it. */
export type ReplayRecovery = {
  createdAt: Date;
  /** The Stripe key until its replay records an intent, then that intent's id. */
  paymentIntentId: string;
  /** Names the edit whose ask it is (`bookingModificationIdForAdditionalIntentRecoveryKey`). */
  idempotencyKey: string;
};

/**
 * A ledger row, as the own-row rule reads it. `bookingModificationId` and
 * `withdrawnAt` are REQUIRED, so no reader can drop the second half of the rule.
 */
export type ReplayLedgerRow = {
  kind: string;
  createdAt: Date;
  stripePaymentIntentId: string | null;
  bookingModificationId: string | null;
  withdrawnAt: Date | null;
};

/**
 * THE RECOVERY'S OWN ROW - the one rule for the replay's resume
 * (`processCreateAdditionalPaymentIntentOperation`) and for whether it is
 * settled (`isRecoveryReplaySettled`), so the two can never disagree
 * (`INV-SSOT`, #4015 review L5). An ADDITIONAL row is its own when:
 *
 * - it carries the intent its replay recorded on the recovery
 *   (`holdAdditionalIntentRecoveryClaim` stamps it in the row's transaction); or
 * - it is stamped with the recovery's own edit
 *   (`PaymentTransaction.bookingModificationId`, which every ordinary ask write
 *   names, #3954 round 8). The door can write that row and still enqueue the
 *   recovery - a step after the write threw, or the commit's reply was lost -
 *   and the recovery then holds only the Stripe key. Without this half its
 *   replay carried that row as a later ask and asked for the edit's money twice.
 *
 * Withdrawn or not, in both halves: a price reduction that retired the row has
 * already netted its money, and the replay finishes it as such (#4442). A live
 * row is preferred where both exist (a currency re-issue keeps the stamp).
 *
 * Never by the edit stamp for an officer's review charge: its key names the
 * edit too, but its ask is not that edit's ordinary row, and it replays by its
 * own rules.
 */
export function findOwnRecoveryRow<R extends ReplayLedgerRow>(
  operation: Pick<ReplayRecovery, "paymentIntentId" | "idempotencyKey">,
  transactions: readonly R[],
): R | null {
  const additional = transactions.filter((transaction) => transaction.kind === "ADDITIONAL");
  const byIntent = additional.find((transaction) => transaction.stripePaymentIntentId === operation.paymentIntentId);
  if (byIntent) return byIntent;
  if (isEditFinancialReviewAdditionalIntentRecoveryKey(operation.idempotencyKey)) return null;
  const bookingModificationId = bookingModificationIdForAdditionalIntentRecoveryKey(operation.idempotencyKey);
  if (!bookingModificationId) return null;
  const stamped = additional.filter((transaction) => transaction.bookingModificationId === bookingModificationId);
  return stamped.find((transaction) => transaction.withdrawnAt === null) ?? stamped[0] ?? null;
}

/**
 * WHETHER A RECOVERY HAS NOTHING LEFT TO MINT - the replay's rule and a price
 * reduction's, read from one place (#3954 review round 4; #4015).
 *
 * A recovery the replay can size - an INCREASE or a RE-ISSUE - is done only
 * once ITS OWN row exists (`findOwnRecoveryRow`).
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
  operation: ReplayRecovery,
  transactions: readonly ReplayLedgerRow[],
): boolean {
  if (findOwnRecoveryRow(operation, transactions)) return true;
  return replay.kind === "frozen" && isRecoveryOvertakenByLaterAsk(operation, transactions);
}

/**
 * #4015 review C1: the live ask a replay would carry and supersede is being paid
 * at Stripe right now (`isProviderCapturedIntentStatus`), and our rows have not
 * caught up. An ordinary, RETRYABLE failure: the replay backs off and, once the
 * capture's webhook lands, carries nothing of that ask.
 */
export class CarriedAskBeingPaidError extends Error {
  constructor(
    readonly paymentIntentId: string,
    readonly status: string,
  ) {
    super(
      `Additional intent recovery deferred: the unpaid ask it would carry (${paymentIntentId}) is ${status} at Stripe; retrying once that payment is recorded`,
    );
    this.name = "CarriedAskBeingPaidError";
  }
}

/**
 * A REPLAY NEVER SUPERSEDES AN ASK THE MEMBER IS PAYING (#4015 review C1).
 *
 * A replay mints the edit's money plus the unpaid balance of the `Payment`'s
 * live ask, then cancels that ask. Since #4015 a later edit's ask no longer
 * settles a waiting increase, so the replay can now carry an ask the member is
 * paying this minute: confirmed, or through 3DS, with the webhook not yet in.
 * Cancelling it then fails their confirmation, or refunds a capture
 * (`REFUND_SUPERSEDED_PAYMENT`) only to ask again. So, before the mint and
 * outside any transaction, Stripe's own state of that ask is read, and one that
 * is taking money throws `CarriedAskBeingPaidError`.
 *
 * A window remains: a confirmation landing between this read and the hold's
 * cancel still takes the superseded-capture refund (`INV-PAY-120`).
 * `retrieve` is injected so this module stays pure.
 */
export async function refuseSupersedingAskBeingPaid(
  payment: AdditionalAskPayment & { additionalPaymentIntentId: string | null },
  retrieve: (paymentIntentId: string) => Promise<{ status: string }>,
): Promise<void> {
  const liveAsk = payment.additionalPaymentIntentId;
  if (!liveAsk || outstandingAdditionalAskCents(payment) <= 0) return;
  const intent = await readOpenProviderIntent(liveAsk, retrieve);
  if (intent && isProviderCapturedIntentStatus(intent.status)) {
    throw new CarriedAskBeingPaidError(liveAsk, intent.status);
  }
}
