/**
 * The bounded-read ceilings the hosting-coverage reads apply, and what happens
 * when one binds.
 *
 * Split verbatim out of `adult-member-hosting-review.ts` (#3128). The first two
 * limits sit at the same number for OPPOSITE reasons and the docblocks below
 * are the whole point of keeping them together: a truncated source read errs
 * towards the rule, a truncated dependent read hides a stranded booking. The
 * third, `SAME_GROUP_TRIP_COVERAGE_SOURCE_LIMIT` (#3038), sits at a DIFFERENT
 * number for a third reason, and keeping all three here is what makes the
 * comparison readable. The engine imports this module; this module imports
 * nothing back from it.
 */
import { Prisma } from "@prisma/client";

import logger from "@/lib/logger";

/**
 * A hard ceiling on how many same-owner source bookings one evaluation reads
 * (#2576 §10: "use suitable indexes and bounded result limits").
 *
 * Generous rather than tight, because it is a guard and not a policy: a member
 * with more than this many CONFIRMED-or-PAID bookings at ONE lodge overlapping ONE
 * stay is a data problem, not a club member. Twenty-five is far beyond anything the
 * split-booking and family shapes produce (a #738 split pair is two), and the read
 * is already narrowed to one owner, one lodge and one date window before the limit
 * applies.
 *
 * FAILING SAFE MEANS FAILING TOWARDS THE RULE: if the ceiling ever truncated, fewer
 * hosts are seen, so a night reads as uncovered and the booking is flagged or
 * refused rather than quietly allowed.
 */
export const SAME_OWNER_COVERAGE_SOURCE_LIMIT = 25;

/**
 * The ceiling on the DEPENDENT reads, which needs its own name because the
 * safe-failure argument above INVERTS for them.
 *
 * A truncated SOURCE read sees fewer hosts, so it errs towards flagging. A
 * truncated DEPENDENT read misses a booking entirely: it is neither refused under
 * `BLOCK` nor escalated, and the drain silently skips it — the failure direction is
 * "a stranded booking nobody hears about". Same number, opposite meaning, so it is a
 * separate constant that cannot be tuned by somebody reasoning about the other one.
 *
 * A DETERMINISTIC ORDER AND A WARNING WHEN IT BINDS. `take` with no `orderBy` leaves
 * Postgres free to return any 25 of the matching rows, so an over-limit account
 * could refuse a change on one request and allow it on the next. Ordering by
 * `checkIn` then `id` makes the truncation reproducible, and
 * `warnIfCoverageDependentCeilingBound` makes it visible — reaching 26 active
 * same-owner bookings at ONE lodge over ONE overlapping window is a data problem
 * rather than a member, and it must not be a silent one.
 */
export const SAME_OWNER_COVERAGE_DEPENDENT_LIMIT = 25;

/**
 * DETERMINISTIC TRUNCATION FOR EVERY BOUNDED COVERAGE READ — both dependent
 * reads and both cross-booking source reads.
 *
 * One constant rather than one per read, because the argument for it does not
 * vary by read (`INV-SSOT-001`): `take` with no `orderBy` lets Postgres return
 * ANY N of the matching rows, so the same booking can be answered differently on
 * two runs with nothing on the row to say which N each saw.
 *
 * IT APPLIES TO WRITERS TOO, WHICH IS NOT THE OBVIOUS CALL (#3038). The source
 * loaders used to order only when an evidence caller passed a ceiling, on the
 * reasoning that a writer's truncation errs towards the rule and so buys nothing
 * from reproducibility. That reasoning is about the ANSWER and misses the
 * SNAPSHOT: an unordered truncation makes `adultMemberHostingStateKey` unstable
 * above the bound, so the review row is rewritten, and the officer notified,
 * every time the evaluation happens to see a different N. Ordering costs a
 * writer nothing on a read that is already narrowed to one owner or one Group
 * Trip and already indexed, so the two reads take it unconditionally.
 *
 * WHAT ORDERING DOES NOT FIX, stated so nobody reads it as more than it is. It
 * changes WHICH rows a truncation returns, never how many, and never gives a
 * result below the bound — but above the bound the bias becomes SYSTEMATIC
 * rather than arbitrary: the earliest-arriving bookings are kept and the latest
 * dropped, every time. That is the right trade (a reproducible answer beats a
 * lottery, and the truncation still errs towards opening a review rather than
 * suppressing one), and it is not a substitute for the ceilings being high
 * enough that a real party never reaches them.
 */
export const COVERAGE_READ_ORDER = [
  { checkIn: "asc" },
  { id: "asc" },
] as const satisfies readonly Prisma.BookingOrderByWithRelationInput[];

/**
 * Say so when a bounded dependent read filled its ceiling.
 *
 * Not an error: the read is still correct for everything it returned, and throwing
 * would turn a data anomaly into a failed member request. But a truncation here can
 * hide a stranded booking, so it must reach the logs with enough context
 * (owner, lodge) for an operator to find the account.
 */
export function warnIfCoverageDependentCeilingBound(
  where: { memberId: string; lodgeId: string },
  returned: number,
  read: string,
): void {
  if (returned < SAME_OWNER_COVERAGE_DEPENDENT_LIMIT) return;
  logger.warn(
    {
      memberId: where.memberId,
      lodgeId: where.lodgeId,
      limit: SAME_OWNER_COVERAGE_DEPENDENT_LIMIT,
      read,
    },
    "Same-owner hosting coverage dependent read hit its ceiling; a dependent booking may not have been evaluated",
  );
}

/**
 * Raised when an evidence caller's sibling ceiling binds.
 *
 * A NAMED ERROR rather than a truncated list, because the two readings are
 * different answers: a short list says "these are the hosts", and this says "I
 * cannot tell you". Only a caller that passed a ceiling can see it.
 */
export class HostingSiblingCeilingExceededError extends Error {
  constructor(ceiling: number) {
    super(
      `Adult-member hosting evidence: more than ${ceiling} sibling bookings could cover these nights; refusing an inconclusive answer`,
    );
    this.name = "HostingSiblingCeilingExceededError";
  }
}

/**
 * The same refusal for the OTHER host population, and a separate class rather than
 * a shared one.
 *
 * The two populations are different questions with different remedies: a bound
 * sibling read means a #738 split family has grown implausibly wide, and a bound
 * same-owner read means one member holds more than the ceiling of active bookings
 * at ONE lodge overlapping ONE stay. An operator handed "I cannot tell you" needs to
 * know which, and a single message naming both would name the wrong one half the
 * time. It is the same reason the writer keeps `SAME_OWNER_COVERAGE_SOURCE_LIMIT`
 * and `SAME_OWNER_COVERAGE_DEPENDENT_LIMIT` apart at the same number.
 */
export class HostingSameOwnerSourceCeilingExceededError extends Error {
  constructor(ceiling: number) {
    super(
      `Adult-member hosting evidence: more than ${ceiling} same-owner bookings at this lodge could cover these nights; refusing an inconclusive answer`,
    );
    this.name = "HostingSameOwnerSourceCeilingExceededError";
  }
}

/**
 * The ceiling on the `SAME_GROUP_TRIP` source read (#3038, epic #2943;
 * `INV-HOST-044` is the rule and states the bound's place in it).
 *
 * A SEPARATE CONSTANT AT A DIFFERENT NUMBER, and the difference is the whole
 * reason it exists. `SAME_OWNER_COVERAGE_SOURCE_LIMIT` is 25 because a member
 * holding twenty-six live bookings at ONE lodge over ONE overlapping window is a
 * data problem rather than a club member. A Group Trip is the opposite shape: it
 * is a travelling party that is MEANT to be many separate bookings, one per
 * family, and a club trip filling the lodge can legitimately be dozens of them.
 * Borrowing the same-owner number would truncate a perfectly ordinary large trip
 * and, because truncation errs towards the rule, would open reviews on bookings
 * that really were covered.
 *
 * ONE BOOKING NEEDS AT LEAST ONE BED, so a Group Trip's bookings are bounded
 * above by the lodge's capacity on the overlapping nights, and one booking
 * usually holds several. A hundred separate bookings overlapping one stay is
 * therefore a very large trip at a very large lodge — far enough above the shape
 * this bound exists to catch (a runaway read) to leave ordinary club trips
 * untouched, without any claim about how big THIS club's lodge is. That claim
 * would not be ours to make: the codebase must never encode which club it serves
 * (`INV-CONFIG-001`), and a 120-bed lodge is a deployment, not a data problem.
 * The bound is deliberately NOT derived from the lodge's configured capacity
 * either: that would put a settings read inside a hosting evaluation that
 * already runs on every booking write, and a ceiling that moves when an operator
 * edits a bed count is a ceiling nobody can reason about. If a club ever meets
 * it, the writer's truncation errs towards the rule and the evidence read
 * refuses outright, so the failure is visible rather than silent.
 *
 * FAILING SAFE STILL MEANS FAILING TOWARDS THE RULE for a writer: fewer hosts
 * are seen, so a night reads as uncovered and the booking is flagged or refused
 * rather than quietly allowed. It inverts for evidence, which is why an evidence
 * caller passes its own ceiling and gets the refusal below instead.
 */
export const SAME_GROUP_TRIP_COVERAGE_SOURCE_LIMIT = 100;

/**
 * The same refusal for the THIRD host population, and a third class rather than
 * a shared one, for the reason its two siblings are separate.
 *
 * An operator handed "I cannot tell you" needs to know WHICH population was too
 * wide, because the three have different remedies: a bound sibling read means a
 * #738 split family has grown implausibly wide, a bound same-owner read means
 * one member holds too many active bookings at one lodge over one stay, and this
 * one means a Group Trip has more overlapping live bookings than the diagnostic
 * may read (`INV-HOST-044`). A single message naming all three would name the
 * wrong one twice as often as it named the right one.
 */
export class HostingGroupTripSourceCeilingExceededError extends Error {
  constructor(ceiling: number) {
    super(
      `Adult-member hosting evidence: more than ${ceiling} bookings in this Group Trip could cover these nights; refusing an inconclusive answer`,
    );
    this.name = "HostingGroupTripSourceCeilingExceededError";
  }
}
