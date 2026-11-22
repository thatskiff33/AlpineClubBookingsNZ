import {
  BookingStatus,
  type Prisma,
  type WaitlistCrossLodgeOrder,
} from "@prisma/client";
import { DEFAULT_BOOKING_DEFAULTS } from "@/config/club-settings-defaults";
import { bookingsOverlap } from "@/lib/booking-night-overlap";
import { compareOrdinal } from "@/lib/ordinal-order";

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
 * collation and code-unit order (`compareOrdinal`) agree; that agreement is what
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
 * email goes out after commit. If that email were withheld, the offer would run
 * its whole window with the member never told, then lapse via
 * `expireStaleOffers()`, and the admin board would show it as an undeliverable
 * offer email. (An offer holds no capacity, `INV-CAP-011`; the harm is the
 * offer nobody can answer.) Excluding the entry means the clock never starts: the
 * place goes to the next candidate, and the entry rejoins at its original join
 * time when the switch is cleared. It is not counted in anyone's position
 * meanwhile (owner decision, 22 Nov 2026, #5402; `INV-LOCKOUT-060`).
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
  return a.createdAt.getTime() - b.createdAt.getTime() || compareOrdinal(a.id, b.id);
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
 * opportunity, then every cross-lodge one; under `MERGED`, by `createdAt`, then
 * own-lodge before cross-lodge (so on an exact tie every own-lodge opportunity
 * still comes first, as it did before #5402), then `id`. Among own-lodge
 * opportunities that is exactly `WAITLIST_QUEUE_ORDER_BY`.
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
          a.candidate.createdAt.getTime() - b.candidate.createdAt.getTime() ||
          // An exact tie: own-lodge before cross-lodge, which also puts an
          // entry's own lodge before its own cross-lodge opportunity.
          Number(a.cross) - Number(b.cross) ||
          compareOrdinal(a.candidate.id, b.candidate.id),
      )
    : [...own, ...cross];
}

/**
 * One offer that lapsed (#5410): the booking, its join time (to order the
 * passes, `compareWaitlistJoinOrder`), and the lodge whose place it was offered
 * (`waitlistOfferedLodgeId` for a cross-lodge offer, else its own).
 */
export type WaitlistLapseKey = {
  id: string;
  createdAt: Date;
  offeredLodgeId: string;
};

/**
 * What `expireStaleOffers` hands one offer pass: the lapse whose place the pass
 * re-offers, and every lapse of the same run (`key` included).
 */
export type WaitlistLapse = {
  key: WaitlistLapseKey;
  run: readonly WaitlistLapseKey[];
};

/**
 * The order an offer pass walks: `orderWaitlistOpportunities`, then, for a pass
 * that re-offers a lapsed place, `rotateWaitlistOpportunitiesAfterLapse`. Every
 * caller but `expireStaleOffers` passes no lapse and walks the plain order.
 */
export function orderWaitlistOffers<T extends WaitlistQueueEntry>(
  opportunities: {
    own: readonly WaitlistOpportunity<T>[];
    cross: readonly WaitlistOpportunity<T>[];
  },
  crossLodgeOrder: WaitlistCrossLodgeOrder | null,
  lapse?: WaitlistLapse,
): WaitlistOpportunity<T>[] {
  return rotateWaitlistOpportunitiesAfterLapse(
    orderWaitlistOpportunities(opportunities, crossLodgeOrder),
    crossLodgeOrder,
    lapse,
  );
}

/**
 * #5410 (`INV-CAP-042`): the walk for a pass that re-offers a lapsed place.
 * It starts just after the lapsed opportunity, runs to the end, wraps to the
 * front and reaches the lapsed opportunity last, so everyone else who fits is
 * considered first and a queue of one is still re-offered. Any opportunity of
 * another booking whose offer lapsed in the same run, at any lodge, is moved to
 * just before it: those members have just had their turn too, so two lapsing
 * together cannot pass the places between them while the queue behind waits.
 *
 * The lapsed opportunity itself is matched by booking and offered lodge, so a
 * cross-lodge lapse moves only the opportunity at the offered lodge in its own
 * pass. Under `OWN_LODGE_FIRST` each part (own-lodge, then cross-lodge) is
 * rotated on its own, but the lapsed opportunities go after BOTH parts: a
 * member who just lapsed is behind everyone who has not had the offer, opt-ins
 * from other lodges included (owner decision, 23 Nov 2026, #5410). Under
 * `MERGED` the list is one part. A key that matches nothing rotates nothing,
 * but the run's other lapses still move to the end; with none, the order is
 * unchanged. Never applied by the position reader: positions (`INV-CAP-041`) do
 * not change when an offer lapses.
 */
function rotateWaitlistOpportunitiesAfterLapse<T extends WaitlistQueueEntry>(
  ordered: readonly WaitlistOpportunity<T>[],
  crossLodgeOrder: WaitlistCrossLodgeOrder | null,
  lapse?: WaitlistLapse,
): WaitlistOpportunity<T>[] {
  if (!lapse) return [...ordered];
  const matches = (opportunity: WaitlistOpportunity<T>, key: WaitlistLapseKey) =>
    opportunity.candidate.id === key.id && opportunity.offerLodgeId === key.offeredLodgeId;
  const isPivot = (opportunity: WaitlistOpportunity<T>) => matches(opportunity, lapse.key);
  // By booking alone (owner decision, 23 Nov 2026): a member whose offer lapsed
  // in this run is last for every place the run re-offers, at any lodge. The
  // pivot's own booking is left out, so its other opportunity stays in place.
  const isOtherLapse = (opportunity: WaitlistOpportunity<T>) =>
    opportunity.candidate.id !== lapse.key.id &&
    lapse.run.some((key) => key.id === opportunity.candidate.id);
  const parts =
    crossLodgeOrder === "MERGED"
      ? [ordered]
      : [ordered.filter((o) => !o.cross), ordered.filter((o) => o.cross)];
  const walk = parts.flatMap((part) => {
    const at = part.findIndex(isPivot);
    return at === -1 ? part : [...part.slice(at + 1), ...part.slice(0, at + 1)];
  });
  // The lapses leave their part for the end of the whole walk (owner decision,
  // 23 Nov 2026): "own lodge first" does not protect a member who just lapsed.
  return [
    ...walk.filter((o) => !isPivot(o) && !isOtherLapse(o)),
    ...walk.filter(isOtherLapse),
    ...walk.filter(isPivot),
  ];
}

/** What the position reader needs to place a booking in its lodge's queue. */
export type WaitlistPositionKey = {
  id: string;
  lodgeId: string;
  checkIn: Date;
  checkOut: Date;
  createdAt: Date;
};

type WaitlistPositionDb = Pick<
  Prisma.TransactionClient,
  "booking" | "bookingDefaults"
>;

/**
 * Each booking's true place in its own lodge's waitlist queue (#5402): one
 * plus the opportunities the offer pass would consider before the booking's
 * own if a bed freed at its lodge on all of its nights. That counts live,
 * offerable entries (`waitlistCandidateWhere`) at its lodge, overlapping its
 * nights, that joined earlier (`WAITLIST_QUEUE_ORDER_BY`); and under `MERGED`
 * only, entries from other lodges that named its lodge as an alternate and
 * joined earlier.
 *
 * Each key is placed by the key itself, whatever its stored status or "No
 * emails" switch: an email path may ask for a booking the offer pass would not
 * consider (one just offered, or silenced). `getDisplayedWaitlistPositions` is
 * the rule for what a screen shows.
 *
 * The number is an upper bound, not a promise: party size and the cross-lodge
 * gates can let a later entry be offered first.
 *
 * Takes no lock (`INV-CAP-041`): a writer passes its own `tx`, after its locks;
 * a reader passes `prisma`. Two or three statements, whatever `keys` holds.
 */
export async function getWaitlistPositions(
  db: WaitlistPositionDb,
  keys: readonly WaitlistPositionKey[],
): Promise<Map<string, number>> {
  const positions = new Map<string, number>();
  if (keys.length === 0) return positions;

  // One read for every key: the envelope of their nights, every entry that
  // joined no later than the latest of them, at their lodges or naming one of
  // their lodges as an alternate. Each key then keeps only what overlaps it.
  const lodgeIds = Array.from(new Set(keys.map((key) => key.lodgeId)));
  const queue = await db.booking.findMany({
    where: {
      ...waitlistCandidateWhere({
        checkIn: new Date(Math.min(...keys.map((key) => key.checkIn.getTime()))),
        checkOut: new Date(
          Math.max(...keys.map((key) => key.checkOut.getTime())),
        ),
      }),
      createdAt: {
        lte: new Date(Math.max(...keys.map((key) => key.createdAt.getTime()))),
      },
      OR: [
        { lodgeId: { in: lodgeIds } },
        { waitlistAlternateLodges: { some: { lodgeId: { in: lodgeIds } } } },
      ],
    },
    select: {
      id: true,
      lodgeId: true,
      checkIn: true,
      checkOut: true,
      createdAt: true,
      waitlistAlternateLodges: { select: { lodgeId: true } },
    },
    orderBy: WAITLIST_QUEUE_ORDER_BY,
  });

  let crossLodgeOrder: WaitlistCrossLodgeOrder | null = null;
  for (const key of keys) {
    // The key's own alternates never matter: its lodge is the freed lodge.
    const target: WaitlistQueueEntry = {
      id: key.id,
      lodgeId: key.lodgeId,
      createdAt: key.createdAt,
      waitlistAlternateLodges: [],
    };
    // In the read's own order, the target in its row's place when the read
    // returned it, otherwise inserted by the same order in memory.
    const entries: WaitlistQueueEntry[] = queue
      .filter((entry) => entry.id === key.id || bookingsOverlap(entry, key))
      .map((entry) => (entry.id === key.id ? target : entry));
    if (!entries.includes(target)) {
      const at = entries.findIndex(
        (entry) => compareWaitlistJoinOrder(target, entry) < 0,
      );
      entries.splice(at === -1 ? entries.length : at, 0, target);
    }

    const split = splitWaitlistOpportunities(entries, {
      freedLodgeId: key.lodgeId,
      // `Booking.lodgeId` is NOT NULL, so the offer pass's null fallback never
      // applies to a row read here.
      defaultLodgeId: key.lodgeId,
    });
    if (split.cross.length > 0 && crossLodgeOrder === null) {
      crossLodgeOrder = await getWaitlistCrossLodgeOrder(db);
    }
    const ordered = orderWaitlistOpportunities(
      split,
      split.cross.length > 0 ? crossLodgeOrder : null,
    );

    let ahead = 0;
    for (const opportunity of ordered) {
      if (opportunity.candidate === target && !opportunity.cross) break;
      if (opportunity.offerLodgeId === key.lodgeId) ahead += 1;
    }
    positions.set(key.id, ahead + 1);
  }
  return positions;
}

/** One booking's place, for a writer quoting it in an email or audit row. */
export async function getWaitlistPositionOf(
  db: WaitlistPositionDb,
  key: WaitlistPositionKey,
): Promise<number> {
  return (await getWaitlistPositions(db, [key])).get(key.id)!;
}

/**
 * Whether a screen shows a booking a waitlist position: only a `WAITLISTED`
 * entry the offer pass would consider. An offered entry shows its offer
 * instead, and a silenced one ("No emails" on) shows no number (owner decision,
 * 22 Nov 2026, #5402).
 */
export function isWaitlistPositionShown(row: {
  status: BookingStatus;
  noEmails: boolean;
}): boolean {
  return row.status === BookingStatus.WAITLISTED && !row.noEmails;
}

/**
 * The position each row shows, or `null` where `isWaitlistPositionShown` says
 * none. One batch read for the whole page.
 */
export async function getDisplayedWaitlistPositions(
  db: WaitlistPositionDb,
  rows: readonly (WaitlistPositionKey & {
    status: BookingStatus;
    noEmails: boolean;
  })[],
): Promise<Map<string, number | null>> {
  const positions = await getWaitlistPositions(
    db,
    rows.filter(isWaitlistPositionShown),
  );
  return new Map(rows.map((row) => [row.id, positions.get(row.id) ?? null]));
}
