/**
 * #3954: CLOSING AN ASK THAT WAITS ON ITS FAILED MINT'S RECOVERY, under the
 * caller's locks and fenced on exactly the state read - split from
 * `additional-ask-reduction.ts` (review round 6) to keep that module inside its
 * size budget. A reduction nets such an ask off (`retireUnpaidAskChain`); a
 * later increase folds a waiting re-issue or increase retry in (`foldWaitingAsks`). The
 * rule is `INV-PAY-120`.
 */
import { PaymentRecoveryOperationStatus, type Prisma } from "@prisma/client";

import type { PendingAskRecovery } from "@/lib/additional-ask-reduction";
import {
  ADDITIONAL_ASK_BEING_RAISED_MESSAGE,
  AdditionalAskChangedDuringReductionError,
} from "@/lib/additional-ask-reduction-error";

/** What a recovery a reduction netted off says about itself (#3954). */
export const PENDING_ASK_NETTED_BY_REDUCTION_NOTE =
  "Not minted: a price reduction set this unminted card request against the booking's lower price before its retry ran; anything still owed was asked for afresh (#3954).";

/**
 * How long after its claim a retry minting an ask is presumed alive (#3954
 * review round 4). A claim this recent refuses the reduction with a 409 "try
 * again in a moment" - the mint takes seconds. An older claim is a worker that
 * stalled or died: the reduction closes it under the attempts and claim-time
 * fence rather than wait out the 30-minute stale reaper, and a slow worker
 * that wakes afterwards finds its claim gone and writes nothing
 * (`holdAdditionalIntentRecoveryClaim`). The owner's "no edit is blocked"
 * (9 Oct 2026) holds outside this window.
 */
export const RECENT_RECOVERY_CLAIM_MS = 2 * 60 * 1000;

/**
 * Close asks still waiting on their failed mint's recovery, under the caller's
 * locks, so the retry cannot mint their old figure: the reduction that nets
 * them off (`retireUnpaidAskChain`) and the increase that folds a waiting
 * re-issue or increase retry in (`foldWaitingAsks`). Throws
 * `AdditionalAskChangedDuringReductionError` (409) when one moved since it was
 * read, or was claimed moments ago and is minting now.
 */
export async function closeWaitingAskRecoveries(
  tx: Pick<Prisma.TransactionClient, "paymentRecoveryOperation">,
  recoveries: readonly PendingAskRecovery[],
  now: Date,
  note: string = PENDING_ASK_NETTED_BY_REDUCTION_NOTE,
): Promise<void> {
  for (const recovery of recoveries) {
    // THE RETRY NETS IT OFF (#3954, owner decision 9 Oct 2026): an ask whose
    // mint failed is closed here, under the edit's locks, and what is left of
    // it is minted after commit with the rest (`reissueUnpaidAdditionalAsk`).
    // A retry claimed moments ago is minting it right now and refuses the edit
    // for a moment: closing the row under it would leave its old figure live
    // beside the smaller ask. An older claim is a stalled or dead worker - it
    // is closed like any other, and the fence below is what stops it writing.
    if (
      recovery.status === PaymentRecoveryOperationStatus.PROCESSING &&
      (recovery.processingStartedAt === null ||
        now.getTime() - recovery.processingStartedAt.getTime() < RECENT_RECOVERY_CLAIM_MS)
    ) {
      throw new AdditionalAskChangedDuringReductionError(ADDITIONAL_ASK_BEING_RAISED_MESSAGE);
    }
    // THE FENCE: exactly the state read. A claim increments `attempts`, and a
    // terminal failure raises it to the ceiling as it sets FAILED and clears
    // `processingStartedAt` (#4081). A claimed runner re-stamps that in the
    // statement that lets it write its row (`holdAdditionalIntentRecoveryClaim`). So a retry
    // that claimed or wrote since the read rolls this edit back, and one that
    // comes after finds nothing to claim or to write.
    const closed = await tx.paymentRecoveryOperation.updateMany({
      where: {
        id: recovery.id,
        status: recovery.status,
        attempts: recovery.attempts,
        processingStartedAt: recovery.processingStartedAt,
      },
      data: {
        status: PaymentRecoveryOperationStatus.SUCCEEDED,
        nextRetryAt: null,
        processingStartedAt: null,
        succeededAt: now,
        lastError: note,
      },
    });
    if (closed.count !== 1) {
      throw new AdditionalAskChangedDuringReductionError();
    }
  }
}
