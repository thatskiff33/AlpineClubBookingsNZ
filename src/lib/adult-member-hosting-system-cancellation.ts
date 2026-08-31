/**
 * The hosting seam for a cancellation NO PERSON ASKED FOR (#3209, #2576 §8).
 *
 * Its own module rather than another export on the 3,000-line engine, for the
 * reason #3128 split the coverage ceilings out: this is a caller-facing policy
 * about who may be refused, not part of the evaluation, and a test that has to
 * make the reconciler refuse can only reach it here — inside the engine the call
 * is a local binding no test can stand in for.
 */
import { AdultMemberHostingRequiredError } from "@/lib/adult-member-hosting-refusal";
import {
  enqueueOwnHostingCoverageReevaluation,
  reconcileAdultMemberHostingReviewWithSiblings,
  type AdultMemberHostingReviewDb,
} from "@/lib/adult-member-hosting-review";
import logger from "@/lib/logger";

/**
 * Reconcile a booking a SYSTEM path has just cancelled, and never let that
 * reconciliation refuse the cancellation.
 *
 * WHY A NAMED SEAM RATHER THAN THE BARE CALL AT EACH SITE. The writers that call
 * `reconcileAdultMemberHostingReviewWithSiblings` directly all have somewhere to
 * put a refusal: a member, an officer, or a request that can be answered 409. The
 * two callers of this one do not. An organiser's group cancellation and an expired
 * Internet Banking hold are authoritative transitions with no actor at all, and §8
 * lists both shapes — "automated status transitions", "payment or booking lifecycle
 * failure" — among the changes that cannot reasonably be blocked. `INV-HOST-028`
 * says the same thing from the other end: nothing automated can ever be gated by
 * this machinery. Written twice as a local `try`/`catch` it would be one policy
 * living in two files.
 *
 * WHAT CAN ACTUALLY REFUSE, AND WHY IT IS NOT THE SETTLE STEP. The dependent
 * disposition here is the default `ESCALATE` — no `hostingCoverageActorOptions`, no
 * actor — so `settleSameOwnerDependentCoverage` raises neither
 * `SameOwnerCoverageWouldBreakError` nor `SameOwnerCoverageOverrideRequiredError`,
 * and `resolveDependentDisposition` cannot promote it to `BLOCK` without an actor
 * member id to compare. The booking being reconciled is already CANCELLED in the
 * caller's transaction, so `bookingAttendanceIsTerminal` answers "no hazard" and its
 * own reconcile clears the review rather than refusing. What is left is the SIBLING
 * loop: a #738 split sibling of the same member can be left uncovered by this very
 * cancellation, and that sibling reconciles under the default `REFUSE`. At an
 * ENFORCED lodge it throws `AdultMemberHostingRequiredError` from inside the
 * caller's transaction, which would roll the cancellation back. On the Internet
 * Banking cron that wedges the hold permanently — the next run re-reads the same
 * rows and throws again — and on a group cancel it strands a CONFIRMED child
 * holding beds after the group is already fenced CANCELLED, which no re-drive
 * recovers. Neither outcome protects anybody: the club is left holding beds for a
 * stay nobody is paying for.
 *
 * SO THE REFUSAL IS CAUGHT — AND THE OBLIGATION IT INTERRUPTED IS STILL RECORDED.
 * Swallowing it alone would lose the escalation, because the refusal is raised
 * before `settleSameOwnerDependentCoverage` ever runs. The catch therefore falls
 * back to the enqueue-only seam, which never evaluates and so cannot refuse: the
 * bounded queue item commits with the cancellation, and the caller's post-commit
 * drain — or the cron behind it — opens the incident, notifies the owner and raises
 * the officer task. That is §8's answer verbatim: allow the change, record the
 * consequence durably.
 *
 * CATCHING INSIDE A TRANSACTION IS SAFE HERE, AND ONLY FOR THIS ERROR.
 * `AdultMemberHostingRequiredError` is raised by `reconcileAdultMemberHostingReview`
 * BEFORE any review write, off reads alone, so no statement has failed and
 * PostgreSQL has not put the transaction into its aborted state — the enqueue below
 * and the caller's remaining writes still commit. That is not true of a database
 * error, and it is not true of `HostingCoverageParticipantRetryError`, which is a
 * deliberate "somebody else holds the participant rows, come back" signal. Both are
 * re-thrown, so the callers' existing re-drive boundaries keep owning them, exactly
 * as `adult-member-hosting-retry-boundaries.test.ts` requires of automated paths.
 *
 * The caller MUST pass its own transaction client, so the obligation commits with
 * the cancellation, and MUST call `settleHostingCoverageAfterCommit` once that
 * transaction has committed.
 */
export async function reconcileHostingReviewForSystemCancellation(
  bookingId: string,
  // Named `tx` rather than `db`, and the name is load-bearing: the caller's own
  // transaction client is the whole contract here, and the census in
  // `adult-member-hosting-call-sites.test.ts` reads the argument name to prove it.
  tx: AdultMemberHostingReviewDb,
): Promise<void> {
  try {
    await reconcileAdultMemberHostingReviewWithSiblings(bookingId, tx);
  } catch (err) {
    if (!(err instanceof AdultMemberHostingRequiredError)) throw err;
    logger.error(
      { err, bookingId },
      "Adult-member hosting refused a system cancellation; allowing the cancellation and escalating instead",
    );
    await enqueueOwnHostingCoverageReevaluation(bookingId, tx, {
      cause: "SYSTEM_CHANGE",
    });
  }
}
