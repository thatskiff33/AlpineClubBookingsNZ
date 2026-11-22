import {
  BookingStatus,
  type Prisma,
  type WaitlistCrossLodgeOrder,
} from "@prisma/client";
import { DEFAULT_BOOKING_DEFAULTS } from "@/config/club-settings-defaults";

// The waitlist queue order (#5402): who the offer pass considers first, and
// the position a member or officer is shown, both come from this module.
//
// A LEAF, on purpose. It imports no booking writer, no email module and
// neither `waitlist.ts` nor `waitlist-cross-lodge.ts`: the second imports
// `booking-create.ts`, which reads positions from here, so any of those
// imports would close a cycle.

/**
 * Join order, the queue's only ordering: oldest first, `id` breaking an exact
 * `createdAt` tie so the order is total. The offer pass's candidate read and
 * every position read use this, and `compareWaitlistJoinOrder` is the same
 * order in memory.
 *
 * Booking ids are lower-case alphanumeric cuids, for which the database's
 * collation and JavaScript's string comparison agree; that agreement is what
 * keeps the in-memory sort and the SQL `orderBy` from tie-breaking differently.
 */
export const WAITLIST_QUEUE_ORDER_BY: Prisma.BookingOrderByWithRelationInput[] = [
  { createdAt: "asc" },
  { id: "asc" },
];

/**
 * The offer pass's candidate filter: a `WAITLISTED` entry whose nights overlap
 * the range (half-open: a stay checking out on the range's first night does not
 * overlap it), at any lodge.
 *
 * #2258: an entry with the "No emails" switch on is NOT a candidate. Making an
 * offer stamps `waitlistOfferExpiresAt` and starts the offer clock; the offer
 * email goes out after commit. If that email were withheld, the entry would hold
 * a bed for the whole offer window with the member never told, then lapse via
 * `expireStaleOffers()`, and the admin board would show it as an undeliverable
 * offer email. Excluding the entry means the clock never starts: the place goes
 * to the next candidate, and the entry rejoins at its original join time when
 * the switch is cleared. It is not counted in anyone's position meanwhile
 * (owner decision, 22 Nov 2026, #5402; `INV-LOCKOUT-060`).
 */
export function waitlistCandidateWhere(range: {
  checkIn: Date;
  checkOut: Date;
}) {
  return {
    status: BookingStatus.WAITLISTED,
    noEmails: false,
    checkIn: { lt: range.checkOut },
    checkOut: { gt: range.checkIn },
  } satisfies Prisma.BookingWhereInput;
}

type CrossLodgeOrderDb = Pick<Prisma.TransactionClient, "bookingDefaults">;

/**
 * Club-wide queue-order policy (ADR-004 owner decision 1). A missing settings
 * row falls back to the schema default, so pre-seed databases behave like
 * `OWN_LODGE_FIRST`.
 */
export async function getWaitlistCrossLodgeOrder(
  db: CrossLodgeOrderDb,
): Promise<WaitlistCrossLodgeOrder> {
  const defaults = await db.bookingDefaults.findUnique({
    where: { id: "default" },
    select: { waitlistCrossLodgeOrder: true },
  });
  return (
    defaults?.waitlistCrossLodgeOrder ??
    DEFAULT_BOOKING_DEFAULTS.waitlistCrossLodgeOrder
  );
}

/** What the ordering reads from a queue entry. */
export type WaitlistQueueEntry = {
  id: string;
  lodgeId: string;
  createdAt: Date;
  waitlistAlternateLodges: ReadonlyArray<{ lodgeId: string }>;
};

/** One queue entry considered at one lodge. */
export type WaitlistOpportunity<T> = {
  candidate: T;
  offerLodgeId: string;
  cross: boolean;
};

/** `WAITLIST_QUEUE_ORDER_BY`, in memory. */
export function compareWaitlistJoinOrder(
  a: Pick<WaitlistQueueEntry, "id" | "createdAt">,
  b: Pick<WaitlistQueueEntry, "id" | "createdAt">,
): number {
  return (
    a.createdAt.getTime() - b.createdAt.getTime() ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/**
 * Every candidate gets an own-lodge opportunity (pre-ADR-004 behaviour);
 * a candidate from another lodge that named the freed lodge as an alternate
 * also gets a cross-lodge opportunity there.
 *
 * `candidates` must already be in `WAITLIST_QUEUE_ORDER_BY` order: the
 * own-lodge list keeps the order it is given.
 */
export function splitWaitlistOpportunities<T extends WaitlistQueueEntry>(
  candidates: readonly T[],
  lodges: { freedLodgeId: string; defaultLodgeId: string },
): { own: WaitlistOpportunity<T>[]; cross: WaitlistOpportunity<T>[] } {
  const own = candidates.map((candidate) => ({
    candidate,
    offerLodgeId: candidate.lodgeId ?? lodges.defaultLodgeId,
    cross: false,
  }));
  const cross = candidates
    .filter(
      (candidate) =>
        (candidate.lodgeId ?? lodges.defaultLodgeId) !== lodges.freedLodgeId &&
        candidate.waitlistAlternateLodges.some(
          (alternate) => alternate.lodgeId === lodges.freedLodgeId,
        ),
    )
    .map((candidate) => ({
      candidate,
      offerLodgeId: lodges.freedLodgeId,
      cross: true,
    }));
  return { own, cross };
}

/**
 * The order the offer pass walks. Under `OWN_LODGE_FIRST`, every own-lodge
 * opportunity, then every cross-lodge one; under `MERGED`, by join order, an
 * entry's own lodge before its cross-lodge opportunity.
 *
 * `crossLodgeOrder` may be `null` only when there are no cross-lodge
 * opportunities, so a caller reads the club setting only when it matters.
 */
export function orderWaitlistOpportunities<T extends WaitlistQueueEntry>(
  opportunities: {
    own: readonly WaitlistOpportunity<T>[];
    cross: readonly WaitlistOpportunity<T>[];
  },
  crossLodgeOrder: WaitlistCrossLodgeOrder | null,
): WaitlistOpportunity<T>[] {
  const { own, cross } = opportunities;
  if (cross.length === 0) return [...own];
  if (crossLodgeOrder === null) {
    throw new Error(
      "The waitlist queue order needs the club's cross-lodge order when a cross-lodge opportunity exists (#5402).",
    );
  }
  return crossLodgeOrder === "MERGED"
    ? [...own, ...cross].sort(
        (a, b) =>
          compareWaitlistJoinOrder(a.candidate, b.candidate) ||
          // Same entry considered at two lodges: its own lodge first.
          Number(a.cross) - Number(b.cross),
      )
    : [...own, ...cross];
}
