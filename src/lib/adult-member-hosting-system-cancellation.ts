/**
 * The hosting seam for a cancellation NO PERSON ASKED FOR (#3209, #2576 §8).
 *
 * Its own module rather than another export on the 3,000-line engine, for the
 * reason #3128 split the coverage ceilings out: this is a caller-facing policy
 * about who may be refused, not part of the evaluation.
 */
import {
  reconcileAdultMemberHostingReviewWithSiblings,
  type AdultMemberHostingReviewDb,
} from "@/lib/adult-member-hosting-review";

/**
 * Reconcile a booking a SYSTEM path has just cancelled, with the refusal
 * REMOVED rather than caught.
 *
 * WHY A NAMED SEAM RATHER THAN THE BARE CALL AT EACH SITE. The writers that call
 * `reconcileAdultMemberHostingReviewWithSiblings` directly all have somewhere to
 * put a refusal: a member, an officer, or a request that can be answered 409. The
 * callers of this one do not. An organiser's group cancellation, an expired
 * Internet Banking hold, a capacity-failed Stripe void and a price-drift unwind
 * are authoritative transitions with no actor at all, and §8 lists those shapes —
 * "automated status transitions", "payment or booking lifecycle failure" — among
 * the changes that cannot reasonably be blocked. `HostingDependentCoverageDisposition`
 * in `adult-member-hosting-review.ts` states the same rule from the other end, in
 * as many words: "§8's list of changes that cannot reasonably be blocked includes
 * every automated path". Written at each site as a local argument it would be one
 * policy living in four files.
 *
 * WHAT COULD REFUSE, AND WHY `REVIEW_ONLY` IS THE WHOLE FIX. The dependent
 * disposition here is the default `ESCALATE` — no `hostingCoverageActorOptions`, no
 * actor — so `settleSameOwnerDependentCoverage` raises neither
 * `SameOwnerCoverageWouldBreakError` nor `SameOwnerCoverageOverrideRequiredError`,
 * and `resolveDependentDisposition` cannot promote it to `BLOCK` without an actor
 * member id to compare. The booking being reconciled is already CANCELLED in the
 * caller's transaction, so it has no hazard of its own and its own reconcile clears
 * the review rather than refusing. What is left is the SIBLING loop: a #738 split
 * sibling of the same member can be left uncovered by this very cancellation, and
 * that sibling reconciles under whatever `enforcement` travels from here. Under the
 * default `REFUSE` it throws `AdultMemberHostingRequiredError` from inside the
 * caller's transaction, which would roll the cancellation back — on the Internet
 * Banking cron wedging the hold, because the next run re-reads the same rows and
 * throws again, deterministically, forever. Neither outcome protects anybody: the
 * club is left holding beds for a stay nobody is paying for.
 *
 * So the enforcement is `REVIEW_ONLY`, and the sibling RECORDS its hazard in the
 * same transaction instead of refusing it. That is §8's answer verbatim: allow the
 * change, record the consequence durably.
 *
 * `REVIEW_ONLY` HERE IS NOT THE §13 SCHOOL CARVE-OUT, and `INV-HOST-020`'s census
 * exists to make a new user of it say which it is. It is the SECOND reason the
 * engine already uses it, and the same one: `reconcileSameOwnerCoverageIncident`
 * passes `REVIEW_ONLY` because "refusing here would throw inside a background drain
 * and roll back the incident that is the whole point". Refusing here would roll back
 * a cancellation that has already been decided. In both positions there is nothing
 * left to refuse — the booking whose write the refusal exists to prevent is not
 * being written — and the recorded hazard is the entire point of the call. Nothing
 * member-facing is exempted: the sibling still gets its review snapshot, its
 * officer-visible PENDING status and, through the settle step below, its incident,
 * its owner email and its officer task.
 *
 * WHAT IS DELIBERATELY NOT CAUGHT. Nothing is. There is no `try` here on purpose:
 * with the one refusal removed, every remaining error is one the callers' existing
 * re-drive boundaries must own — `HostingCoverageParticipantRetryError` is a
 * deliberate "somebody else holds the participant rows, come back" signal, and a
 * database error has already put PostgreSQL's transaction into its aborted state, so
 * nothing after it could commit anyway. Both propagate, exactly as
 * `adult-member-hosting-retry-boundaries.test.ts` requires of automated paths.
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
  await reconcileAdultMemberHostingReviewWithSiblings(bookingId, tx, {
    enforcement: "REVIEW_ONLY",
  });
}
