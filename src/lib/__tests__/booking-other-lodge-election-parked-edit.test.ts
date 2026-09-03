import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Role } from "@prisma/client";

/*
  #3214 (epic #2797) — AN OTHER-LODGE ELECTION IS REFUSED ON THE EDIT THAT PARKS
  THE MONEY, and the whole request is refused with it.

  WHAT WAS BROKEN, and how narrow it really was. On a booking whose money is
  ALREADY under review the election was refused outright and always had been: an
  election is never price-preserving, so the request is money-affecting, so
  `assertNoPendingEditFinancialReview` throws. The defect lived on exactly one
  edge — the edit that CREATES the park — where the request was half-applied in
  both directions:

    * a tick resolved to `false`, because a parked edit runs no rate resolver
      and so rates nobody at the other-lodge rate, while the SAME edit still
      saved a change of lodge. The officer got a success, a partner lodge on the
      booking, and no ticks;
    * an untick cleared the flag (unconditionally, by design — else a stale flag
      could never be removed) while the nights stayed sold at the other club's
      member rate, leaving the column and the money disagreeing about what was
      charged.

  The owner's decision (2 September 2026) is refusal, not disclosure: refusing
  removes no ability anybody has, because it is already refused everywhere else,
  and it prevents the untick disagreement rather than describing it.

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
  const actual = await importOriginal<typeof import("@/lib/capacity")>();
  return { ...actual, acquireLodgeCapacityLock: h.acquireLodgeCapacityLock };
});

// Partial-mocked with `importOriginal`, never replaced: `resolveTargetDates`,
// `assertBookingModifiable` and `resolveGuestNameUpdates` are left real, and a
// wholesale mock would also drop the exports this module's import graph reads
// at load time.
vi.mock("@/lib/booking-modify", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/booking-modify")>();
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
    await importOriginal<typeof import("@/lib/edit-financial-review")>();
  return {
    ...actual,
    assertNoPendingEditFinancialReview: h.assertNoPendingEditFinancialReview,
  };
});

vi.mock("@/lib/member-guest-add-policy", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/member-guest-add-policy")>();
  return { ...actual, loadMemberGuestAddPolicy: h.loadMemberGuestAddPolicy };
});

vi.mock("@/lib/xero-period-lock-guard", () => ({
  assertProposedCheckInClearsXeroLockDate:
    h.assertProposedCheckInClearsXeroLockDate,
  assertProposedDateEditClearsXeroLockDate:
    h.assertProposedDateEditClearsXeroLockDate,
}));

vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { modifyBookingBatch } from "@/lib/booking-batch-modification-service";
import { OTHER_LODGE_RATE_AMOUNT_UNDER_REVIEW_MESSAGE } from "@/lib/booking-other-lodge-rate";
import { addDaysDateOnly, getTodayDateOnly } from "@/lib/date-only";
import { requireCalendarDate } from "@/lib/club-time";

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
 */
function election(options: {
  requested: boolean;
  flagged?: string[];
  reprice?: string[];
  otherLodgeId?: string | null;
}) {
  return {
    requested: options.requested,
    otherLodgeId: options.otherLodgeId ?? null,
    otherLodgeIdChanged: Boolean(options.otherLodgeId),
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
          otherLodgeId: "lodge-partner",
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
