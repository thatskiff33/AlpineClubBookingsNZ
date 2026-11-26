import type { PrismaClient } from "@prisma/client";

import type { AdultMemberHostingPolicyExceptionViolation } from "@/lib/booking-policy-exceptions";
import { stableStringify } from "@/lib/stable-digest";

/**
 * What `Booking.adultMemberHostingReview` holds, read back and written (#5239).
 *
 * Split out of `adult-member-hosting-review.ts`, which is past its size ceiling.
 * Two readers need the stored column and neither should have to reach into the
 * reconciler for it: the reconciler compares and rewrites it, and the kiosk
 * reads it as cover evidence (`kiosk-adult-cover.ts`). The column is the
 * evaluator's violation snapshot plus, since #5239, the Group Trip freshness it
 * was evaluated under.
 */

/**
 * Read a stored snapshot back without trusting it.
 *
 * The column is JSON, so a hand-edited or partially-written value is possible.
 * A value that does not carry the two fields the comparison actually reads is
 * treated as "no snapshot", which reopens the review rather than silently
 * comparing against nonsense.
 */
export function parseStoredHostingReview(
  value: unknown,
): AdultMemberHostingPolicyExceptionViolation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.reasonCode !== "ADULT_MEMBER_HOSTING_REQUIRED") return null;
  if (typeof row.policyId !== "string") return null;
  if (typeof row.policyVersion !== "number") return null;
  const requirements = row.requirements;
  if (!requirements || typeof requirements !== "object") return null;
  const uncovered = (requirements as Record<string, unknown>).uncovered;
  if (!Array.isArray(uncovered)) return null;
  return value as AdultMemberHostingPolicyExceptionViolation;
}

/**
 * The Group Trip a stored snapshot's `SAME_GROUP_TRIP` cover was evaluated in,
 * and that trip's cover-invalidation revision at the time (`INV-HOST-045`).
 *
 * `GroupBooking.coverageInvalidationRevision` moves on, by database trigger,
 * every time a trip's re-evaluation fan-out is truncated at
 * `GROUP_TRIP_COVERAGE_DEPENDENT_LIMIT` — the one way a dependent booking can be
 * left without the queued re-check it was owed. A snapshot is written with the
 * revision it was evaluated under, so a matching revision says no truncated
 * fan-out has happened since, and the absence of a queued row then says
 * nothing else changed either. The kiosk compares the two before it shows cover
 * resting on a sibling (`deriveKioskAdultCoverSource`).
 *
 * INTERNAL EVIDENCE, NOT PART OF THE VIOLATION. It rides on the stored column
 * beside the evaluator's snapshot, is never part of `adultMemberHostingStateKey`
 * (so refreshing it reopens no review and sends no notice), and never reaches a
 * refusal body, which is built from the evaluator's own violation.
 *
 * A type alias, not an interface: Prisma's JSON input needs the implicit index
 * signature only an alias gets.
 */
export type GroupTripCoverFreshness = {
  groupBookingId: string;
  revision: number;
};

/** The stored column's shape: the evaluator's snapshot plus its freshness stamp. */
type StoredHostingReview = AdultMemberHostingPolicyExceptionViolation & {
  groupTripCoverFreshness?: GroupTripCoverFreshness;
};

/** The value the reconciler writes for a violation evaluated under `freshness`. */
export function storedHostingReviewOf(
  violation: AdultMemberHostingPolicyExceptionViolation,
  freshness: GroupTripCoverFreshness | null,
): StoredHostingReview {
  return freshness ? { ...violation, groupTripCoverFreshness: freshness } : violation;
}

/**
 * Does the column differ from what would be written now? Compared canonically,
 * because PostgreSQL hands JSONB back with its keys re-ordered, and a byte
 * comparison would rewrite every unchanged snapshot on every evaluation.
 */
export function storedHostingReviewDiffers(
  current: unknown,
  next: StoredHostingReview,
): boolean {
  return stableStringify(current) !== stableStringify(next);
}

/**
 * The trip's current revision, read by the WRITER inside its trip-key callback
 * (`evaluateBookingAdultMemberHosting`), before any sibling is read as cover.
 *
 * WHY THE STAMP IS NEVER NEWER THAN THE FACTS. A truncating fan-out bumps the
 * revision while holding the same trip key, and the key is fail-fast. So either
 * the fan-out committed first — and this evaluation reads both its revision and
 * its booking changes — or it waits for this transaction, and the bump it then
 * makes leaves this stamp behind. `null` when the trip row has gone, which
 * every reader treats as unverifiable.
 */
export async function readGroupTripCoverFreshness(
  db: Pick<PrismaClient, "groupBooking">,
  groupBookingId: string,
): Promise<GroupTripCoverFreshness | null> {
  const row = await db.groupBooking.findUnique({
    where: { id: groupBookingId },
    select: { coverageInvalidationRevision: true },
  });
  return row ? { groupBookingId, revision: row.coverageInvalidationRevision } : null;
}

/**
 * Read a stored snapshot's freshness stamp without trusting it: anything but
 * the exact shape is `null`, which every reader treats as "cannot be verified".
 */
export function readStoredGroupTripCoverFreshness(
  review: unknown,
): GroupTripCoverFreshness | null {
  if (!review || typeof review !== "object" || Array.isArray(review)) return null;
  const stamp = (review as Record<string, unknown>).groupTripCoverFreshness;
  if (!stamp || typeof stamp !== "object" || Array.isArray(stamp)) return null;
  const { groupBookingId, revision } = stamp as Record<string, unknown>;
  if (typeof groupBookingId !== "string" || groupBookingId.length === 0) return null;
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) {
    return null;
  }
  return { groupBookingId, revision };
}
