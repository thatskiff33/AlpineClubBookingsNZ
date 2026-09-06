import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Role } from "@prisma/client";

/*
  #3214 (epic #2797) — AN OTHER-LODGE ELECTION IS REFUSED ON THE EDIT THAT PARKS
  THE MONEY, and the whole request is refused with it.

  WHAT WAS BROKEN, WHY REFUSAL RATHER THAN DISCLOSURE, and what each direction of
  the flag used to do: `OTHER_LODGE_RATE_AMOUNT_UNDER_REVIEW_MESSAGE`'s docblock
  in `src/lib/booking-other-lodge-rate.ts`, which is the one home for all of it
  (`INV-MOD-028`). Restating it here is how the two copies come to disagree.

  HOW THIS SUITE PROVES "NOTHING IS WRITTEN". `applyGuestChanges` is the first
  write the service performs after the pricing pass, so it is stubbed with a
  sentinel: reaching it means the request cleared the guard. Every method on the
  transaction client that could write is a spy as well, so "the lodge did not
  save either" is asserted directly rather than inferred.
*/

const h = vi.hoisted(() => ({
  transaction: vi.fn(),
  executeRaw: vi.fn(),
  bookingFindUnique: vi.fn(),
  acquireLodgeCapacityLock: vi.fn(),
  isQuotePricedBooking: vi.fn(),
  isMemberWholeLodgeBooking: vi.fn(),
  prepareGuestPlan: vi.fn(),
  calculateModifiedPricing: vi.fn(),
  applyGuestChanges: vi.fn(),
  loadActiveSeasonRates: vi.fn(),
  loadMemberGuestAddPolicy: vi.fn(),
  assertNoPendingEditFinancialReview: vi.fn(),
  assertProposedDateEditClearsXeroLockDate: vi.fn(),
  assertProposedCheckInClearsXeroLockDate: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: { $transaction: h.transaction } }));

vi.mock("@/lib/capacity", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/capacity");
  return { ...actual, acquireLodgeCapacityLock: h.acquireLodgeCapacityLock };
});

// Partial-mocked with `importOriginal`, never replaced: `resolveTargetDates`,
// `assertBookingModifiable` and `resolveGuestNameUpdates` are left real, and a
// wholesale mock would also drop the exports this module's import graph reads
// at load time.
vi.mock("@/lib/booking-modify", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/booking-modify");
  return {
    ...actual,
    isQuotePricedBooking: h.isQuotePricedBooking,
    isMemberWholeLodgeBooking: h.isMemberWholeLodgeBooking,
    prepareGuestPlan: h.prepareGuestPlan,
    calculateModifiedPricing: h.calculateModifiedPricing,
    applyGuestChanges: h.applyGuestChanges,
    loadActiveSeasonRates: h.loadActiveSeasonRates,
  };
});

vi.mock("@/lib/edit-financial-review", async (importOriginal) => {
  const actual =
    (await importOriginal()) as typeof import("@/lib/edit-financial-review");
  return {
    ...actual,
    assertNoPendingEditFinancialReview: h.assertNoPendingEditFinancialReview,
  };
});

vi.mock("@/lib/member-guest-add-policy", async (importOriginal) => {
  const actual =
    (await importOriginal()) as typeof import("@/lib/member-guest-add-policy");
  return { ...actual, loadMemberGuestAddPolicy: h.loadMemberGuestAddPolicy };
});

vi.mock("@/lib/xero-period-lock-guard", () => ({
  assertProposedCheckInClearsXeroLockDate:
    h.assertProposedCheckInClearsXeroLockDate,
  assertProposedDateEditClearsXeroLockDate:
    h.assertProposedDateEditClearsXeroLockDate,
  // #3232: the narrow guard is now three named pieces rather than one call — the
  // row it decides from, the single predicate that says whether a decision is owed
  // at all, and the decision itself over club/Xero facts resolved before the
  // transaction. These fixtures are a club with the Xero module off, which is what
  // `not-applicable` means; answering `null` for the row is the same "nothing to
  // decide" these suites always had.
  readXeroLockGuardDateEditBooking: async () => null,
  checkInNeedingLockDateCheck: () => null,
  resolveXeroLockDateFacts: async () => ({ kind: "not-applicable" as const }),
  assertDateEditClearsXeroLockDateFromFacts: () => undefined,
}));

vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

// The acceptance lane at the foot of this file drives the REAL reconcile path,
// whose module is `server-only` and which writes one audit entry.
vi.mock("server-only", () => ({}));
vi.mock("@/lib/audit", () => ({ createAuditLog: vi.fn() }));

import { modifyBookingBatch } from "@/lib/booking-batch-modification-service";
import { OTHER_LODGE_RATE_AMOUNT_UNDER_REVIEW_MESSAGE } from "@/lib/booking-other-lodge-rate";
import { addDaysDateOnly, getTodayDateOnly } from "@/lib/date-only";
import { requireCalendarDate } from "@/lib/club-time";
import { getGuestBedNightKeys } from "@/lib/booking-guest-stay-ranges";
import { storedSoldPriceEvidenceForGuest } from "@/lib/stored-sold-price-evidence";
import {
  planStrandNightPriceReconcile,
  recordStrandNightPriceReconcile,
} from "@/lib/stored-night-price-strand-reconcile";

/*
 * #3123 (`INV-LOCK-004`) — the CLUB's day, resolved by the caller before it
 * opens its transaction. Pinned to the frozen clock's club day, and every
 * relative fixture below is built in the zone the service itself falls back to
 * under test (this suite serves no `ClubTimeSettings` row).
 */
const FIXTURE_CLUB_DAY = requireCalendarDate("2026-07-01");
const CLUB_ZONE = "Pacific/Auckland";

const storedCheckIn = addDaysDateOnly(getTodayDateOnly(CLUB_ZONE), 30);
const storedCheckOut = addDaysDateOnly(getTodayDateOnly(CLUB_ZONE), 33);
const LODGE = "lodge-1";
const APPLY_SENTINEL = new Error("reached-the-writer");

/** One non-member guest, currently NOT flagged as another club's member. */
const GUEST = {
  id: "g1",
  firstName: "Vic",
  lastName: "Visitor",
  ageTier: "ADULT",
  isMember: false,
  memberId: null,
  otherLodgeMember: false,
  stayStart: storedCheckIn,
  stayEnd: storedCheckOut,
  priceCents: 9600,
};

function loadedBooking(overrides: Record<string, unknown> = {}) {
  return {
    id: "booking-1",
    memberId: "member-1",
    lodgeId: LODGE,
    status: "CONFIRMED",
    checkIn: storedCheckIn,
    checkOut: storedCheckOut,
    wholeLodgeHold: false,
    finalPriceCents: 30_000,
    totalPriceCents: 30_000,
    discountCents: 0,
    promoAdjustmentCents: 0,
    creditElectionCents: null,
    organiserSettled: false,
    otherLodgeId: null,
    guests: [GUEST],
    payment: null,
    member: { id: "member-1" },
    promoRedemption: null,
    ...overrides,
  };
}

/**
 * The election as `resolveOtherLodgeRateElection` resolves it — the SAME object
 * `applyGuestChanges` is handed, which is what the guard fences on.
 *
 * `otherLodgeIdChanged` IS DERIVED THE WAY THE RESOLVER DERIVES IT, against the
 * lodge the stored booking already carries, and that is load-bearing rather than
 * tidiness. It used to be `Boolean(options.otherLodgeId)`, which is true of
 * every `requested: true` case in this file because they all name a partner
 * lodge. A guard mutated to fence on `otherLodgeIdChanged` instead of
 * `requested` therefore left all five tests green — while letting through the
 * commonest real election of all, ticking a guest on a booking whose partner
 * lodge is ALREADY stored. The untick case below is exactly that shape and now
 * resolves `false` here, so it fails that mutation.
 */
function election(options: {
  requested: boolean;
  flagged?: string[];
  reprice?: string[];
  otherLodgeId?: string | null;
  /** What the loaded booking carries; the resolver compares against it. */
  storedOtherLodgeId?: string | null;
}) {
  const otherLodgeId = options.otherLodgeId ?? null;
  return {
    requested: options.requested,
    otherLodgeId,
    otherLodgeIdChanged: otherLodgeId !== (options.storedOtherLodgeId ?? null),
    flaggedGuestIds: new Set(options.flagged ?? []),
    repriceGuestIds: new Set(options.reprice ?? []),
  };
}

function guestPlan(electionValue: ReturnType<typeof election>) {
  return {
    otherLodgeElection: electionValue,
    guestsForPricing: [{ bookingGuestId: GUEST.id, ageTier: "ADULT" }],
    normalizedAddGuests: undefined,
    removedGuests: [],
    remainingGuests: [GUEST],
    proposedRemainingGuests: [{ guest: GUEST }],
    guestMemberLinks: [],
    guestMemberLinkNames: new Map(),
    guestMemberLinkColumns: new Map(),
    guestAuthorizationIsAdmin: true,
    memberGuestEntries: new Map(),
  };
}

/** The pricing verdict for a booking whose stored sold prices cannot be read. */
const PARKED_RESULT = {
  kind: "financial_review_required" as const,
  occurrences: [
    {
      bookingId: "booking-1",
      bookingGuestId: GUEST.id,
      cause: "PARTIAL_STORED_NIGHT_PRICES",
    },
  ],
  parkedPlan: null,
  parkedGuestRows: {
    guests: [{ priceCents: null, perNightCents: [], nightDates: [] }],
  },
  capacityOverridden: false,
};

/** The ordinary verdict, for the control cases. */
const PRICED_RESULT = {
  kind: "priced" as const,
  inProgressPlan: null,
  capacityOverridden: false,
  newTotalPriceCents: 30_000,
  priceBreakdown: {
    totalPriceCents: 30_000,
    guests: [{ priceCents: 30_000, perNightCents: [], nightDates: [] }],
  },
  guestNightRates: [],
  otherLodgeRatedGuestIds: new Set<string>([GUEST.id]),
};

let txClient: Record<string, unknown>;
let writes: Array<{ model: string; op: string }>;

/** Every write-shaped method the service could reach, as a recording spy. */
function writeSpy(model: string, op: string) {
  return vi.fn(async () => {
    writes.push({ model, op });
    return {};
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  writes = [];
  txClient = {
    $executeRaw: h.executeRaw,
    booking: {
      findUnique: h.bookingFindUnique,
      update: writeSpy("booking", "update"),
      updateMany: writeSpy("booking", "updateMany"),
    },
    bookingGuest: {
      create: writeSpy("bookingGuest", "create"),
      update: writeSpy("bookingGuest", "update"),
      updateMany: writeSpy("bookingGuest", "updateMany"),
      delete: writeSpy("bookingGuest", "delete"),
      deleteMany: writeSpy("bookingGuest", "deleteMany"),
    },
    bookingGuestNight: {
      createMany: writeSpy("bookingGuestNight", "createMany"),
      deleteMany: writeSpy("bookingGuestNight", "deleteMany"),
    },
    bookingModification: { create: writeSpy("bookingModification", "create") },
    manualRefundTask: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: writeSpy("manualRefundTask", "create"),
    },
    choreAssignment: {
      findMany: vi.fn().mockResolvedValue([]),
      deleteMany: writeSpy("choreAssignment", "deleteMany"),
    },
  };
  h.transaction.mockImplementation(
    async (callback: (tx: unknown) => Promise<unknown>) => callback(txClient),
  );
  h.bookingFindUnique
    .mockResolvedValueOnce({ lodgeId: LODGE })
    .mockResolvedValueOnce(loadedBooking());
  h.acquireLodgeCapacityLock.mockResolvedValue(undefined);
  h.loadMemberGuestAddPolicy.mockResolvedValue({});
  h.assertNoPendingEditFinancialReview.mockResolvedValue(undefined);
  h.assertProposedDateEditClearsXeroLockDate.mockResolvedValue(undefined);
  h.assertProposedCheckInClearsXeroLockDate.mockResolvedValue(undefined);
  h.isQuotePricedBooking.mockResolvedValue(false);
  h.isMemberWholeLodgeBooking.mockResolvedValue(false);
  h.loadActiveSeasonRates.mockResolvedValue([]);
  h.applyGuestChanges.mockRejectedValue(APPLY_SENTINEL);
});

async function save(input: Record<string, unknown>) {
  return modifyBookingBatch({
    todayAtClub: FIXTURE_CLUB_DAY,
    bookingId: "booking-1",
    actor: { id: "admin-9", role: "ADMIN" as Role },
    input,
    ipAddress: "127.0.0.1",
  });
}

describe("modifyBookingBatch: an other-lodge election on the edit that parks", () => {
  it("REFUSES a tick, and writes nothing at all — not even the lodge", async () => {
    // The reported shape: the lodge landed and the ticks did not, over an HTTP
    // 200 the officer read as success.
    h.prepareGuestPlan.mockResolvedValue(
      guestPlan(
        election({
          requested: true,
          flagged: [GUEST.id],
          reprice: [GUEST.id],
          otherLodgeId: "lodge-partner",
        }),
      ),
    );
    h.calculateModifiedPricing.mockResolvedValue(PARKED_RESULT);

    await expect(
      save({
        otherLodgeId: "lodge-partner",
        otherLodgeMemberGuestIds: [GUEST.id],
      }),
    ).rejects.toThrow(OTHER_LODGE_RATE_AMOUNT_UNDER_REVIEW_MESSAGE);

    expect(h.applyGuestChanges).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it("REFUSES an untick, which used to clear the flag while the nights stayed sold at the other club's rate", async () => {
    h.bookingFindUnique.mockReset();
    h.bookingFindUnique
      .mockResolvedValueOnce({ lodgeId: LODGE })
      .mockResolvedValueOnce(
        loadedBooking({
          otherLodgeId: "lodge-partner",
          guests: [{ ...GUEST, otherLodgeMember: true }],
        }),
      );
    h.prepareGuestPlan.mockResolvedValue(
      guestPlan(
        election({
          requested: true,
          flagged: [],
          reprice: [GUEST.id],
          otherLodgeId: "lodge-partner",
          // The booking ALREADY carries this lodge, so the resolver sets
          // `otherLodgeIdChanged: false` — the case that proves the guard fences
          // on `requested` and not on the lodge moving.
          storedOtherLodgeId: "lodge-partner",
        }),
      ),
    );
    h.calculateModifiedPricing.mockResolvedValue(PARKED_RESULT);

    await expect(
      save({ otherLodgeId: "lodge-partner", otherLodgeMemberGuestIds: [] }),
    ).rejects.toThrow(OTHER_LODGE_RATE_AMOUNT_UNDER_REVIEW_MESSAGE);

    expect(h.applyGuestChanges).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it("REFUSES an election that changes nothing, exactly as an already-parked booking does", async () => {
    // A re-assertion writes no flag, so nothing is half-applied by it — but the
    // refusal has to match the already-open case, which fences on whether the
    // request MENTIONS the rate and not on what it would change.
    h.prepareGuestPlan.mockResolvedValue(
      guestPlan(
        election({
          requested: true,
          flagged: [],
          reprice: [],
          // The request names no lodge, so the resolver keeps the booking's
          // stored one — which is `null` here. Nothing moves at all.
          otherLodgeId: null,
        }),
      ),
    );
    h.calculateModifiedPricing.mockResolvedValue(PARKED_RESULT);

    await expect(save({ otherLodgeMemberGuestIds: [] })).rejects.toThrow(
      OTHER_LODGE_RATE_AMOUNT_UNDER_REVIEW_MESSAGE,
    );

    expect(h.applyGuestChanges).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it("leaves a parked edit that mentions the rate NOT AT ALL free to save", async () => {
    // The guard is narrow: parking is not itself a refusal. Reaching the writer
    // is what proves the request cleared it.
    h.prepareGuestPlan.mockResolvedValue(
      guestPlan(election({ requested: false })),
    );
    h.calculateModifiedPricing.mockResolvedValue(PARKED_RESULT);

    await expect(save({ guestUpdates: [] })).rejects.toThrow(APPLY_SENTINEL);

    expect(h.applyGuestChanges).toHaveBeenCalledTimes(1);
  });

  it("leaves an election on an edit that PRICES normally free to save", async () => {
    // The other half of the fence. An ordinary booking's tick is untouched by
    // this change; only the parked edge moves.
    h.prepareGuestPlan.mockResolvedValue(
      guestPlan(
        election({
          requested: true,
          flagged: [GUEST.id],
          reprice: [GUEST.id],
          otherLodgeId: "lodge-partner",
        }),
      ),
    );
    h.calculateModifiedPricing.mockResolvedValue(PRICED_RESULT);

    await expect(
      save({
        otherLodgeId: "lodge-partner",
        otherLodgeMemberGuestIds: [GUEST.id],
      }),
    ).rejects.toThrow(APPLY_SENTINEL);

    expect(h.applyGuestChanges).toHaveBeenCalledTimes(1);
  });
});

/*
  THE ACCEPTANCE TEST FOR THE WHOLE OF #3214.

  The refusal above ends by telling an officer that the booking's unpriced
  nights have to carry a price before anything on it can be re-rated, and names
  where they do that. Until #3214 built the route, that sentence was
  UNSATISFIABLE on exactly the population it most often meets: a booking
  converted from a public request is quote-priced by origin, and on such a
  booking nothing could reach the settle-time repair, because nothing could
  raise the review that repair runs inside.

  So this lane runs the sentence. One booking, one strand, three saves:

    1. the election-only edit is refused, because the strand cannot be read;
    2. the officer records what the nights sold for, through the REAL plan and
       the REAL writer;
    3. the same edit is made again and prices normally, and the tick reaches the
       writer.

  WHAT MAKES IT AN ACCEPTANCE TEST RATHER THAN THREE STUBS. The pricing verdict
  is not hard-coded per save: `calculateModifiedPricing` answers from
  `storedSoldPriceEvidenceForGuest` over the strand's LIVE rows - the same
  classifier the real pricing pass consults. So step 3 prices normally only
  because step 2 really changed the data. Delete the reconcile and step 3 fails.

  The booking is QUOTE-PRICED here, unlike the cases above, because that is the
  population the refusal names - and it is what proves the route needs no
  exemption from `assertBookingNotQuotePriced`: the election-only exemption is
  what carries the edit, and the reconcile never touches the pricing engine at
  all.
*/
describe("#3214 acceptance: the refusal's sentence is satisfiable", () => {
  /** The strand, mutable, as the database would hold it. */
  type Strand = {
    id: string;
    bookingId: string;
    firstName: string;
    lastName: string;
    priceCents: number;
    stayStart: Date | null;
    stayEnd: Date | null;
    nights: Array<{ stayDate: Date; priceCents: number | null }>;
  };

  const bookingRange = { checkIn: storedCheckIn, checkOut: storedCheckOut };

  function reconcileStore(strand: Strand) {
    return {
      booking: {
        findUnique: async ({ where }: { where: { id: string } }) =>
          where.id === "booking-1"
            ? { memberId: "member-1", ...bookingRange }
            : null,
      },
      bookingGuest: {
        findFirst: async ({
          where,
        }: {
          where: { id: string; bookingId: string };
        }) =>
          where.id === strand.id && where.bookingId === strand.bookingId
            ? strand
            : null,
        updateMany: async ({
          where,
          data,
        }: {
          where: { id: string; priceCents?: number };
          data: { priceCents: number };
        }) => {
          if (where.id !== strand.id) return { count: 0 };
          if ("priceCents" in where && where.priceCents !== strand.priceCents) {
            return { count: 0 };
          }
          strand.priceCents = data.priceCents;
          return { count: 1 };
        },
      },
      bookingGuestNight: {
        updateMany: async () => ({ count: 0 }),
        create: async ({
          data,
        }: {
          data: { stayDate: Date; priceCents: number };
        }) => {
          // A NEW ARRAY, never a push: the night-key helper caches its set per
          // `nights` array reference, so a mutation in place would hand every
          // later read the world as it was before the write.
          strand.nights = [
            ...strand.nights,
            { stayDate: data.stayDate, priceCents: data.priceCents },
          ];
          return { id: "night-new" };
        },
      },
      // No review is open: this booking's edit was REFUSED, so it raised none -
      // which is the deadlock the route exists to break.
      manualRefundTask: { findFirst: async () => null },
    };
  }

  it("is refused, then recorded, then priced normally", async () => {
    const strand: Strand = {
      id: GUEST.id,
      bookingId: "booking-1",
      firstName: GUEST.firstName,
      lastName: GUEST.lastName,
      priceCents: GUEST.priceCents,
      stayStart: GUEST.stayStart,
      stayEnd: GUEST.stayEnd,
      // NO NIGHT ROWS AT ALL - the #2739 backfill skipped a request-derived
      // guest whose stored stay was degenerate, so the strand holds its nights
      // through the envelope and the settle-time repair cannot touch it.
      nights: [],
    };

    h.isQuotePricedBooking.mockResolvedValue(true);
    h.prepareGuestPlan.mockResolvedValue(
      guestPlan(
        election({
          requested: true,
          flagged: [GUEST.id],
          reprice: [GUEST.id],
          otherLodgeId: "lodge-partner",
        }),
      ),
    );
    // The verdict follows the DATA, through the same classifier the real
    // pricing pass consults. This is what makes step 3 evidence rather than a
    // restated assumption.
    h.calculateModifiedPricing.mockImplementation(async () =>
      storedSoldPriceEvidenceForGuest(strand, bookingRange).kind === "exact"
        ? PRICED_RESULT
        : PARKED_RESULT,
    );

    const election1 = {
      otherLodgeId: "lodge-partner",
      otherLodgeMemberGuestIds: [GUEST.id],
    };

    // 1. REFUSED, and nothing saved - not the ticks, not the lodge.
    await expect(save(election1)).rejects.toThrow(
      OTHER_LODGE_RATE_AMOUNT_UNDER_REVIEW_MESSAGE,
    );
    expect(h.applyGuestChanges).not.toHaveBeenCalled();
    expect(writes).toEqual([]);

    // 2. The officer records what the nights sold for. Three figures they
    //    supplied, not an even split of the total - which 9600 over three
    //    nights would have been, and is not what this is.
    const heldNights = getGuestBedNightKeys(strand, bookingRange).map((key) =>
      requireCalendarDate(key),
    );
    expect(heldNights).toHaveLength(3);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const store = reconcileStore(strand) as any;
    const plan = await planStrandNightPriceReconcile({
      bookingId: "booking-1",
      bookingGuestId: GUEST.id,
      entries: [
        { date: heldNights[0], priceCents: 3_000 },
        { date: heldNights[1], priceCents: 3_000 },
        { date: heldNights[2], priceCents: 3_600 },
      ],
      store,
    });
    await recordStrandNightPriceReconcile({
      plan,
      actingMemberId: "admin-9",
      note: null,
      store,
    });

    // What the stay is worth did not move, and the strand now reads back.
    expect(strand.priceCents).toBe(GUEST.priceCents);
    expect(storedSoldPriceEvidenceForGuest(strand, bookingRange).kind).toBe(
      "exact",
    );

    // 3. The SAME edit now prices normally and the tick reaches the writer.
    h.bookingFindUnique.mockReset();
    h.bookingFindUnique
      .mockResolvedValueOnce({ lodgeId: LODGE })
      .mockResolvedValueOnce(loadedBooking());

    await expect(save(election1)).rejects.toThrow(APPLY_SENTINEL);
    expect(h.applyGuestChanges).toHaveBeenCalledTimes(1);
    const [, applyArgs] = h.applyGuestChanges.mock.calls[0];
    expect(applyArgs.otherLodgeElection.flaggedGuestIds).toEqual(
      new Set([GUEST.id]),
    );
  });
});
