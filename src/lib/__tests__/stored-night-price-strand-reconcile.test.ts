import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

// The reconcile module and the writer are both `server-only`; the rules half is
// not, which is the whole point of that split. All three are exercised here
// because what is being proved is a property of the DATA afterwards.
vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({ createAuditLog: vi.fn() }));
vi.mock("@/lib/audit", () => ({ createAuditLog: mocks.createAuditLog }));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { requireCalendarDate, type CalendarDate } from "@/lib/club-time";
import {
  countActiveGuestsForNight,
  getGuestBedNightKeys,
} from "@/lib/booking-guest-stay-ranges";
import { storedSoldPriceEvidenceForGuest } from "@/lib/stored-sold-price-evidence";
import {
  NIGHT_PRICE_REPAIR_AMOUNT_MESSAGE,
  NIGHT_PRICE_REPAIR_INCOMPLETE_MESSAGE,
  NIGHT_PRICE_REPAIR_UNKNOWN_NIGHT_MESSAGE,
  STRAND_RECONCILE_NOT_OFFERED_MESSAGE,
  STRAND_RECONCILE_REVIEW_OPEN_MESSAGE,
  STRAND_RECONCILE_WRONG_BOOKING_MESSAGE,
  type RecordedNightPrice,
} from "@/lib/stored-night-price-repair";
import { NIGHT_PRICE_REPAIR_RACED_MESSAGE } from "@/lib/stored-night-price-repair-store";
import {
  planStrandNightPriceReconcile,
  recordStrandNightPriceReconcile,
  strandNightPriceOffersForBooking,
} from "@/lib/stored-night-price-strand-reconcile";

/**
 * #3214 (epic #2797): an officer records what a guest strand's nights sold for,
 * on a booking with no open review.
 *
 * ## The property this file exists for
 *
 * #3214's refusal tells an officer that a booking's unpriced nights have to
 * carry a price before anything on it can be re-rated. Until this feature that
 * sentence was unsatisfiable on a quote-priced booking. The suite that proves it
 * is now true END TO END is
 * `booking-other-lodge-election-parked-edit.test.ts` -> "the refusal's sentence
 * is satisfiable"; what THIS file proves is the two things that make the act
 * safe enough to exist at all:
 *
 *  1. **the eligibility fence** - a strand whose rows already reconcile is
 *     refused, so this is not a general re-pricer;
 *  2. **the no-op** - `BookingGuest.priceCents` is byte-identical before and
 *     after, on every shape, so the act cannot change what anybody owes.
 *
 * Both are mutation-verified: deleting the fence, and re-basing the total to
 * `sum + 1`, each fail a named test here.
 *
 * ## Why a fake store rather than call-by-call mocks
 *
 * The same reason `stored-night-price-repair.test.ts` gives: the acceptance
 * question is what the DATA looks like afterwards, which
 * `toHaveBeenCalledWith` cannot see. The `where` is applied FIELD BY FIELD, so
 * a fence the writer omits is a fence that is not applied - reproducing it
 * inside the fake would make this suite pass for a writer that had dropped it.
 */

const day = (date: string) => new Date(`${date}T00:00:00.000Z`);
const on = (date: string): CalendarDate => requireCalendarDate(date);

type NightRow = { stayDate: Date; priceCents: number | null };
type GuestRow = {
  id: string;
  bookingId: string;
  firstName: string;
  lastName: string;
  priceCents: number;
  stayStart: Date | null;
  stayEnd: Date | null;
  nights: NightRow[];
  createdAt: Date;
};

const BOOKING_ID = "booking-1";
const OTHER_BOOKING_ID = "booking-2";
const CHECK_IN = day("2026-08-01");
const CHECK_OUT = day("2026-08-03");
/** The two lodge nights a stay from the 1st to the 3rd holds (INV-DATE-003). */
const HELD = [on("2026-08-01"), on("2026-08-02")];

function guest(overrides: Partial<GuestRow> = {}): GuestRow {
  return {
    id: "g1",
    bookingId: BOOKING_ID,
    firstName: "Vic",
    lastName: "Visitor",
    priceCents: 10_000,
    stayStart: CHECK_IN,
    stayEnd: CHECK_OUT,
    nights: [],
    createdAt: day("2026-07-01"),
    ...overrides,
  };
}

/** A fake that applies each `where` clause the way Postgres would. */
function makeStore(options: {
  guests: GuestRow[];
  openReviewTaskIds?: string[];
  /** Fired after a night write lands, for the concurrent-write cases. */
  afterNightWrite?: (store: ReturnType<typeof makeStore>) => void;
}) {
  const guests = options.guests;
  const writes: string[] = [];
  const booking = {
    id: BOOKING_ID,
    memberId: "member-1",
    checkIn: CHECK_IN,
    checkOut: CHECK_OUT,
  };
  const store = {
    guests,
    writes,
    booking: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        if (where.id !== BOOKING_ID) return null;
        return {
          ...booking,
          guests: guests
            .filter((row) => row.bookingId === BOOKING_ID)
            .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
        };
      },
    },
    bookingGuest: {
      findFirst: async ({
        where,
      }: {
        where: { id: string; bookingId: string };
      }) =>
        guests.find(
          (row) => row.id === where.id && row.bookingId === where.bookingId,
        ) ?? null,
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string; priceCents?: number };
        data: { priceCents: number };
      }) => {
        const row = guests.find((entry) => entry.id === where.id);
        if (!row) return { count: 0 };
        if ("priceCents" in where && where.priceCents !== row.priceCents) {
          return { count: 0 };
        }
        writes.push(`guest-total:${where.id}`);
        row.priceCents = data.priceCents;
        return { count: 1 };
      },
    },
    bookingGuestNight: {
      updateMany: async ({
        where,
        data,
      }: {
        where: {
          bookingGuestId: string;
          stayDate: Date;
          priceCents?: number | null;
        };
        data: { priceCents: number };
      }) => {
        const row = guests.find((entry) => entry.id === where.bookingGuestId);
        if (!row) return { count: 0 };
        const night = row.nights.find(
          (entry) =>
            entry.stayDate.getTime() === where.stayDate.getTime() &&
            (!("priceCents" in where) || entry.priceCents === where.priceCents),
        );
        if (!night) return { count: 0 };
        night.priceCents = data.priceCents;
        writes.push(
          `night-update:${where.bookingGuestId}:${where.stayDate.toISOString().slice(0, 10)}`,
        );
        options.afterNightWrite?.(store);
        return { count: 1 };
      },
      create: async ({
        data,
      }: {
        data: { bookingGuestId: string; stayDate: Date; priceCents: number };
      }) => {
        const row = guests.find((entry) => entry.id === data.bookingGuestId);
        if (!row) throw new Error("no such strand");
        if (
          row.nights.some(
            (entry) => entry.stayDate.getTime() === data.stayDate.getTime(),
          )
        ) {
          // The (bookingGuestId, stayDate) unique constraint, as Prisma raises
          // it. Constructed rather than faked with a bare Error, because the
          // writer narrows on the real class.
          throw new Prisma.PrismaClientKnownRequestError("Unique constraint", {
            code: "P2002",
            clientVersion: "test",
          });
        }
        // A NEW ARRAY rather than a push. `getGuestBedNightKeys` caches its key
        // set per `nights` array reference, so mutating the array in place would
        // hand every later read a stale set - and the capacity assertions below
        // would then be measuring the world before the write.
        row.nights = [
          ...row.nights,
          { stayDate: data.stayDate, priceCents: data.priceCents },
        ];
        writes.push(
          `night-create:${data.bookingGuestId}:${data.stayDate.toISOString().slice(0, 10)}`,
        );
        options.afterNightWrite?.(store);
        return { id: "night-new" };
      },
    },
    manualRefundTask: {
      findFirst: async () =>
        (options.openReviewTaskIds ?? []).length > 0
          ? { id: (options.openReviewTaskIds ?? [])[0] }
          : null,
    },
  };
  return store;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asStore = (store: unknown) => store as any;

const bookingRange = { checkIn: CHECK_IN, checkOut: CHECK_OUT };

/** What the classifier every edit path consults says about this strand now. */
const evidenceKind = (row: GuestRow) =>
  storedSoldPriceEvidenceForGuest(row, bookingRange).kind;

/** Beds held on each night of the stay, by the capacity predicate itself. */
function bedsPerNight(rows: GuestRow[]) {
  return ["2026-07-31", "2026-08-01", "2026-08-02", "2026-08-03"].map((date) =>
    countActiveGuestsForNight(rows, day(date), bookingRange),
  );
}

async function reconcile(
  store: ReturnType<typeof makeStore>,
  entries: readonly RecordedNightPrice[],
  bookingGuestId = "g1",
  bookingId = BOOKING_ID,
) {
  const plan = await planStrandNightPriceReconcile({
    bookingId,
    bookingGuestId,
    entries,
    store: asStore(store),
  });
  await recordStrandNightPriceReconcile({
    plan,
    actingMemberId: "admin-9",
    note: null,
    store: asStore(store),
  });
  return plan;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("only a strand whose stored rows cannot be read may be recorded", () => {
  it("refuses a strand that already reconciles, so this is not a re-pricer", async () => {
    /*
      THE ELIGIBILITY FENCE, and the mutation probe for it (#3214). Deleting the
      `kind === "exact"` refusal in `strandNightPriceOfferForGuest` makes this
      test fail, and nothing else in the tree fails with it - so without this
      case the feature would have no fence at all. A strand whose rows are
      readable and add up is priced; re-apportioning it is a re-price by another
      name, which is what epic #2797 exists to prevent.
    */
    const row = guest({
      nights: [
        { stayDate: day("2026-08-01"), priceCents: 4_000 },
        { stayDate: day("2026-08-02"), priceCents: 6_000 },
      ],
    });
    expect(evidenceKind(row)).toBe("exact");
    const store = makeStore({ guests: [row] });

    await expect(
      reconcile(store, [
        { date: HELD[0], priceCents: 5_000 },
        { date: HELD[1], priceCents: 5_000 },
      ]),
    ).rejects.toThrow(STRAND_RECONCILE_NOT_OFFERED_MESSAGE);
    expect(store.writes).toEqual([]);
    expect(row.nights.map((night) => night.priceCents)).toEqual([4_000, 6_000]);
  });

  it("refuses a strand whose stored total is not usable money", async () => {
    // A STATED LIMIT, not an oversight: there is nothing sound to reconcile
    // against, and what a negative or fractional stored figure should become is
    // #2745's audited decision rather than this act's.
    const row = guest({
      priceCents: -100,
      nights: [{ stayDate: day("2026-08-01"), priceCents: null }],
    });
    const store = makeStore({ guests: [row] });

    await expect(
      reconcile(store, [{ date: HELD[0], priceCents: 0 }]),
    ).rejects.toThrow(STRAND_RECONCILE_NOT_OFFERED_MESSAGE);
    expect(store.writes).toEqual([]);
  });

  it("offers a booking's unreadable strands and stays silent on the rest", async () => {
    const unreadable = guest({
      id: "g1",
      nights: [
        { stayDate: day("2026-08-01"), priceCents: 4_000 },
        { stayDate: day("2026-08-02"), priceCents: null },
      ],
    });
    const readable = guest({
      id: "g2",
      firstName: "Rea",
      lastName: "Readable",
      createdAt: day("2026-07-02"),
      nights: [
        { stayDate: day("2026-08-01"), priceCents: 4_000 },
        { stayDate: day("2026-08-02"), priceCents: 6_000 },
      ],
    });
    const store = makeStore({ guests: [unreadable, readable] });

    const offers = await strandNightPriceOffersForBooking(
      BOOKING_ID,
      asStore(store),
    );
    expect(offers.map((offer) => offer.bookingGuestId)).toEqual(["g1"]);
    expect(offers[0].guestName).toBe("Vic Visitor");
    // Every night the strand holds, not only the blank one, and nothing is
    // treated as already known - which is what makes the target the stored
    // total flat.
    expect(offers[0].summary).toEqual({
      dates: HELD,
      knownNightTotalCents: 0,
      storedGuestTotalCents: 10_000,
    });
    // "No stored price" and a stored figure are different things to a reader.
    expect(offers[0].storedByDate).toEqual([
      { date: HELD[0], priceCents: 4_000 },
      { date: HELD[1], priceCents: null },
    ]);
  });
});

describe("the shared rule is what refuses a bad answer", () => {
  /*
    Asserting the rule FLOWS THROUGH, not re-testing
    `checkStoredNightPriceRepair` - `stored-night-price-repair.test.ts` owns
    that. What is proved here is that this path applies it, against the nights
    the strand really holds, and writes nothing when it says no.
  */
  const blanks = () =>
    guest({
      nights: [
        { stayDate: day("2026-08-01"), priceCents: null },
        { stayDate: day("2026-08-02"), priceCents: null },
      ],
    });

  it("refuses a partial answer rather than working the rest out", async () => {
    const store = makeStore({ guests: [blanks()] });
    await expect(
      reconcile(store, [{ date: HELD[0], priceCents: 10_000 }]),
    ).rejects.toThrow(NIGHT_PRICE_REPAIR_INCOMPLETE_MESSAGE);
    expect(store.writes).toEqual([]);
  });

  it("refuses one date typed twice standing in for the other", async () => {
    const store = makeStore({ guests: [blanks()] });
    await expect(
      reconcile(store, [
        { date: HELD[0], priceCents: 5_000 },
        { date: HELD[0], priceCents: 5_000 },
      ]),
    ).rejects.toThrow(NIGHT_PRICE_REPAIR_INCOMPLETE_MESSAGE);
    expect(store.writes).toEqual([]);
  });

  it("refuses a night this booking does not hold, because the nights are RE-DERIVED", async () => {
    /*
      THE RE-READ FENCE, and the mutation probe for it. Make the plan take the
      night list from the request instead of deriving it from the strand on its
      own transaction, and this case passes: the posted vector is internally
      consistent and sums to the stored total, so the shared checker would bless
      it and a figure would be written against a night nobody is in.
    */
    const store = makeStore({ guests: [blanks()] });
    await expect(
      reconcile(store, [
        { date: HELD[0], priceCents: 3_000 },
        { date: HELD[1], priceCents: 3_000 },
        { date: on("2026-08-05"), priceCents: 4_000 },
      ]),
    ).rejects.toThrow(NIGHT_PRICE_REPAIR_UNKNOWN_NIGHT_MESSAGE);
    expect(store.writes).toEqual([]);
  });

  it("refuses an amount that is not whole non-negative cents", async () => {
    const store = makeStore({ guests: [blanks()] });
    await expect(
      reconcile(store, [
        { date: HELD[0], priceCents: -1 },
        { date: HELD[1], priceCents: 10_001 },
      ]),
    ).rejects.toThrow(NIGHT_PRICE_REPAIR_AMOUNT_MESSAGE);
    expect(store.writes).toEqual([]);
  });

  it("refuses figures that do not come to what the stay is stored as being worth", async () => {
    const store = makeStore({ guests: [blanks()] });
    await expect(
      reconcile(store, [
        { date: HELD[0], priceCents: 5_000 },
        { date: HELD[1], priceCents: 4_999 },
      ]),
    ).rejects.toThrow(/need to come to \$100\.00/);
    expect(store.writes).toEqual([]);
  });
});

describe("every unreadable shape becomes exact, and nothing owed moves", () => {
  /*
    THE THREE SHAPES `INV-MOD-028` CLASSES AS UNUSABLE, each proved by asking the
    SAME classifier every edit path consults, before and after. That is the
    property that makes #3214's refusal sentence true.

    Every case asserts `BookingGuest.priceCents` is byte-identical afterwards.
    THAT IS THE SECOND MUTATION PROBE: re-base the writer's total to
    `sum + 1` and all three fail here, and the module's own post-write assertion
    fails with them.
  */

  it("blank rows: the amounts are written and the strand prices exactly", async () => {
    const row = guest({
      nights: [
        { stayDate: day("2026-08-01"), priceCents: 4_000 },
        { stayDate: day("2026-08-02"), priceCents: null },
      ],
    });
    expect(evidenceKind(row)).toBe("unusable");
    const store = makeStore({ guests: [row] });
    const totalBefore = row.priceCents;

    await reconcile(store, [
      { date: HELD[0], priceCents: 4_000 },
      { date: HELD[1], priceCents: 6_000 },
    ]);

    expect(evidenceKind(row)).toBe("exact");
    expect(row.priceCents).toBe(totalBefore);
    expect(row.nights.map((night) => night.priceCents)).toEqual([4_000, 6_000]);
    // EVERY night is written, not only the blank one - the officer was asked
    // for all of them, and the already-priced night is fenced on the figure it
    // was read holding rather than skipped.
    //
    // And a strand that already has rows cannot GAIN a night: its held set IS
    // its rows, so nothing on this shape can reach bed allocation.
    expect(store.writes).toEqual([
      "night-update:g1:2026-08-01",
      "night-update:g1:2026-08-02",
      "guest-total:g1",
    ]);
    expect(getGuestBedNightKeys(row, bookingRange)).toEqual(HELD);
  });

  it("no rows at all: rows are created, and NO capacity count moves", async () => {
    /*
      #2739's own migration header records that a strand with no night rows is
      invisible to bed allocation - not on the board, not placed by the planner.
      Creating rows makes it visible, which is an `INV-CAP-032` consequence and
      is stated in the pull request rather than left for review to find.

      WHAT MUST NOT MOVE IS OCCUPANCY, and this proves it rather than asserting
      it: the created dates are exactly `getGuestBedNightKeys`, the nights the
      guest ALREADY occupies through the envelope fallback, so the capacity
      predicate counts the same beds on the same nights before and after.

      THE THIRD MUTATION PROBE. Widen the created night set - a `stayEnd`-
      inclusive expansion, an extra day either side - and the night-set
      assertion fails AND the bed count fails with it.
    */
    const row = guest({ nights: [] });
    expect(evidenceKind(row)).toBe("unusable");
    const store = makeStore({ guests: [row] });

    const nightsBefore = getGuestBedNightKeys(row, bookingRange);
    const bedsBefore = bedsPerNight([row]);
    expect(nightsBefore).toEqual(HELD);
    expect(bedsBefore).toEqual([0, 1, 1, 0]);

    await reconcile(store, [
      { date: HELD[0], priceCents: 4_500 },
      { date: HELD[1], priceCents: 5_500 },
    ]);

    // THE CAPACITY PROPERTY FIRST, because it is the one this case exists for:
    // the strand holds exactly the nights it held before, and the bed count on
    // every night of the window is unchanged.
    expect(getGuestBedNightKeys(row, bookingRange)).toEqual(nightsBefore);
    expect(bedsPerNight([row])).toEqual(bedsBefore);
    expect(row.nights.map((night) => night.stayDate.toISOString())).toEqual([
      CHECK_IN.toISOString(),
      day("2026-08-02").toISOString(),
    ]);
    expect(store.writes).toEqual([
      "night-create:g1:2026-08-01",
      "night-create:g1:2026-08-02",
      "guest-total:g1",
    ]);
    expect(row.priceCents).toBe(10_000);
    expect(evidenceKind(row)).toBe("exact");
  });

  it("rows that do not add up: they are rewritten within the same total", async () => {
    // The re-apportionment case. What each night is recorded as having sold for
    // changes; what the stay is worth does not.
    const row = guest({
      nights: [
        { stayDate: day("2026-08-01"), priceCents: 4_000 },
        { stayDate: day("2026-08-02"), priceCents: 4_000 },
      ],
    });
    expect(evidenceKind(row)).toBe("unusable");
    const store = makeStore({ guests: [row] });

    await reconcile(store, [
      { date: HELD[0], priceCents: 4_000 },
      { date: HELD[1], priceCents: 6_000 },
    ]);

    expect(row.priceCents).toBe(10_000);
    expect(row.nights.map((night) => night.priceCents)).toEqual([4_000, 6_000]);
    expect(evidenceKind(row)).toBe("exact");
  });
});

describe("a concurrent write is refused, never overwritten", () => {
  /*
    A REFUSAL ROLLS THE CALLER'S TRANSACTION BACK, so a partial write is not a
    reachable state in production. This fake has no rollback, which is what lets
    these cases assert the thing that matters instead: the fenced write matched
    NOTHING, and the strand's total was never re-based.
  */

  it("refuses when a night stopped holding what it was read holding", async () => {
    const row = guest({
      nights: [
        { stayDate: day("2026-08-01"), priceCents: 4_000 },
        { stayDate: day("2026-08-02"), priceCents: 4_000 },
      ],
    });
    const store = makeStore({ guests: [row] });
    const plan = await planStrandNightPriceReconcile({
      bookingId: BOOKING_ID,
      bookingGuestId: "g1",
      entries: [
        { date: HELD[0], priceCents: 4_000 },
        { date: HELD[1], priceCents: 6_000 },
      ],
      store: asStore(store),
    });
    // Somebody else moved it between the read and the write.
    row.nights[0].priceCents = 5_500;

    await expect(
      recordStrandNightPriceReconcile({
        plan,
        actingMemberId: "admin-9",
        note: null,
        store: asStore(store),
      }),
    ).rejects.toThrow(NIGHT_PRICE_REPAIR_RACED_MESSAGE);
    expect(row.nights[0].priceCents).toBe(5_500);
    expect(row.priceCents).toBe(10_000);
    expect(store.writes).toEqual([]);
  });

  it("refuses when the strand's stored total moved underneath it", async () => {
    const row = guest({
      nights: [
        { stayDate: day("2026-08-01"), priceCents: 4_000 },
        { stayDate: day("2026-08-02"), priceCents: 4_000 },
      ],
    });
    const store = makeStore({ guests: [row] });
    const plan = await planStrandNightPriceReconcile({
      bookingId: BOOKING_ID,
      bookingGuestId: "g1",
      entries: [
        { date: HELD[0], priceCents: 4_000 },
        { date: HELD[1], priceCents: 6_000 },
      ],
      store: asStore(store),
    });
    row.priceCents = 12_000;

    await expect(
      recordStrandNightPriceReconcile({
        plan,
        actingMemberId: "admin-9",
        note: null,
        store: asStore(store),
      }),
    ).rejects.toThrow(NIGHT_PRICE_REPAIR_RACED_MESSAGE);
    expect(row.priceCents).toBe(12_000);
  });

  it("turns the create arm's unique-constraint violation into the race refusal", async () => {
    // A row for a night this strand had none for appeared underneath us - an
    // edit re-writing the guest's nights is the realistic producer. It must read
    // as a race the officer can retry, never as a 500.
    const row = guest({ nights: [] });
    const store = makeStore({
      guests: [row],
      afterNightWrite: () => {
        if (row.nights.length === 1) {
          row.nights = [
            ...row.nights,
            { stayDate: day("2026-08-02"), priceCents: 9_999 },
          ];
        }
      },
    });

    await expect(
      reconcile(store, [
        { date: HELD[0], priceCents: 4_500 },
        { date: HELD[1], priceCents: 5_500 },
      ]),
    ).rejects.toThrow(NIGHT_PRICE_REPAIR_RACED_MESSAGE);
    expect(row.priceCents).toBe(10_000);
  });
});

describe("when the act is not available at all", () => {
  it("refuses while the booking has an OPEN financial review", async () => {
    // One home per situation: while a review is open the settle screen owns
    // these figures, because its target also includes the amount being settled.
    const row = guest({
      nights: [
        { stayDate: day("2026-08-01"), priceCents: null },
        { stayDate: day("2026-08-02"), priceCents: null },
      ],
    });
    const store = makeStore({ guests: [row], openReviewTaskIds: ["task-1"] });

    await expect(
      reconcile(store, [
        { date: HELD[0], priceCents: 4_000 },
        { date: HELD[1], priceCents: 6_000 },
      ]),
    ).rejects.toThrow(STRAND_RECONCILE_REVIEW_OPEN_MESSAGE);
    expect(store.writes).toEqual([]);
  });

  it("answers 404 for a strand belonging to a different booking, and writes nothing", async () => {
    const mine = guest({
      nights: [
        { stayDate: day("2026-08-01"), priceCents: null },
        { stayDate: day("2026-08-02"), priceCents: null },
      ],
    });
    const theirs = guest({
      id: "g9",
      bookingId: OTHER_BOOKING_ID,
      nights: [
        { stayDate: day("2026-08-01"), priceCents: null },
        { stayDate: day("2026-08-02"), priceCents: null },
      ],
    });
    const store = makeStore({ guests: [mine, theirs] });

    await expect(
      reconcile(
        store,
        [
          { date: HELD[0], priceCents: 4_000 },
          { date: HELD[1], priceCents: 6_000 },
        ],
        "g9",
      ),
    ).rejects.toThrow(STRAND_RECONCILE_WRONG_BOOKING_MESSAGE);
    expect(store.writes).toEqual([]);
    expect(theirs.nights[0].priceCents).toBeNull();
  });
});

describe("the audit entry", () => {
  it("records both totals, what each night held before, and the category", async () => {
    // A RE-APPORTIONMENT, which is the case the previous values exist for: what
    // each night is recorded as having sold for changes, what the stay is worth
    // does not, and the log is the only place the earlier split survives.
    const row = guest({
      nights: [
        { stayDate: day("2026-08-01"), priceCents: 4_000 },
        { stayDate: day("2026-08-02"), priceCents: 4_000 },
      ],
    });
    const store = makeStore({ guests: [row] });

    const plan = await planStrandNightPriceReconcile({
      bookingId: BOOKING_ID,
      bookingGuestId: "g1",
      entries: [
        { date: HELD[0], priceCents: 3_000 },
        { date: HELD[1], priceCents: 7_000 },
      ],
      store: asStore(store),
    });
    await recordStrandNightPriceReconcile({
      plan,
      actingMemberId: "admin-9",
      note: "From the quote emailed on 3 July.",
      store: asStore(store),
    });

    expect(mocks.createAuditLog).toHaveBeenCalledTimes(1);
    const [entry] = mocks.createAuditLog.mock.calls[0];
    expect(entry).toMatchObject({
      action: "booking-payment.stored-night-price.reconcile",
      category: "payment",
      severity: "important",
      outcome: "success",
      entityType: "BookingGuest",
      entityId: "g1",
      targetId: BOOKING_ID,
      memberId: "admin-9",
      actorMemberId: "admin-9",
      subjectMemberId: "member-1",
      details: "From the quote emailed on 3 July.",
    });
    // BOTH TOTALS, identical, because a pair of matching figures is what makes
    // the no-op visible to somebody reading the log rather than something they
    // have to take on trust.
    expect(entry.metadata).toMatchObject({
      bookingId: BOOKING_ID,
      cause: "STORED_TOTAL_MISMATCH",
      storedGuestTotalCents: 10_000,
      newGuestTotalCents: 10_000,
      rowsCreated: 0,
      nightPrices: [
        { date: HELD[0], priceCents: 3_000 },
        { date: HELD[1], priceCents: 7_000 },
      ],
      previousNightPrices: [
        { date: HELD[0], priceCents: 4_000, hadStoredRow: true },
        { date: HELD[1], priceCents: 4_000, hadStoredRow: true },
      ],
    });
  });

  it("says the rows did not exist when the strand had none", async () => {
    /*
      THE ONLY SHAPE THAT CREATES ROWS, and it is all-or-nothing rather than a
      per-night mixture. A strand's held nights ARE its rows whenever it has any
      (`getGuestBedNightKeys` takes the explicit set over the envelope), so a
      strand with some rows can never gain a night - only a strand with none
      can, and then every night is created.
    */
    const store = makeStore({ guests: [guest({ nights: [] })] });

    await reconcile(store, [
      { date: HELD[0], priceCents: 4_500 },
      { date: HELD[1], priceCents: 5_500 },
    ]);

    const [entry] = mocks.createAuditLog.mock.calls[0];
    expect(entry.metadata).toMatchObject({
      cause: "NO_STORED_NIGHT_PRICES",
      rowsCreated: 2,
      previousNightPrices: [
        { date: HELD[0], priceCents: null, hadStoredRow: false },
        { date: HELD[1], priceCents: null, hadStoredRow: false },
      ],
    });
  });
});
