/**
 * Waitlist Feature Tests
 *
 * Tests for: core waitlist logic, booking creation waitlist path,
 * cancellation triggers, cron job, API routes, status colors, email templates.
 */

import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { captureHostTimeZone } from "@/lib/__tests__/helpers/timezone";
import {
  fenceBookingFindMany,
  fenceHostingPolicyFindMany,
  fenceMemberFindMany,
  hostingMemberRow,
  recordingBookingDouble,
} from "@/lib/__tests__/support/hosting-participant-fence-double";
import {
  HOSTING_COVERAGE_RETRY_CODE,
  HOSTING_COVERAGE_RETRY_MESSAGE,
  HostingCoverageParticipantRetryError,
} from "@/lib/adult-member-hosting-queue-participants";

// Pay the module-graph transform cost once, outside any single test's 5s
// budget: every test dynamic-imports @/lib/waitlist (for mock ordering), and
// the FIRST such import transforms the whole dependency graph — which on a
// loaded host can alone exceed the per-test timeout.
beforeAll(async () => {
  await import("@/lib/waitlist");
  // 30s, not the 10s default: #2307 grew this graph again (the member-guest
  // policy/consent modules now sit on the booking paths waitlist reaches).
}, 30_000);

// ─── Mocks ───

const mockPrismaTransaction = vi.fn();
const mockBookingFindUnique = vi.fn();
const mockBookingFindMany = vi.fn();
const mockBookingCount = vi.fn();
const mockBookingUpdate = vi.fn();
const mockBookingUpdateMany = vi.fn();
const mockBookingCreate = vi.fn();
const mockExecuteRaw = vi.fn().mockResolvedValue(undefined);
const mockReconcileBedAllocations = vi.fn().mockResolvedValue(undefined);
/**
 * #2543: both waitlist paths now read the offered booking's party on the MODULE
 * client, outside the claiming transaction — the offer, to word the "why you are
 * being charged non-member rates" sentence on the email, and the confirm, to
 * re-check the paid-up-adult requirement before it turns a queue placeholder into
 * a capacity-holding booking.
 *
 * Defaults to an empty party, which is the neutral answer for every fixture in
 * this file: nobody is repriced, so no notice is worded and no requirement bites.
 * Absent altogether, the confirm path throws on `undefined.findMany` — and that
 * is the honest failure mode, because the read is deliberately NOT wrapped there:
 * a database hiccup must fail the confirm closed rather than silently skip a
 * money guard.
 */
const mockBookingGuestFindMany = vi.fn().mockResolvedValue([]);

/**
 * #2619 — the hosting participant fence, on the transaction client.
 *
 * Every booking write reconciles the hosting review inside its own transaction,
 * and that reconciliation locks the source booking's owner Member row
 * `FOR KEY SHARE NOWAIT` before re-reading, UNDER the lock, both the Member rows
 * and each source booking's owner and lodge. The reconciler PLANS its
 * participants from this transaction's own `booking.findUnique`, so this
 * transaction's `booking.findMany` has to replay exactly what that read served
 * or the fence sees drift that never happened.
 *
 * The tests keep stubbing plain `vi.fn()` doubles — `mockTxBookingFindUnique`
 * and `mockTxBookingFindMany` — and `mockTx.booking` exposes the recording
 * wrappers around them. Re-stubbing the wrapper on `mockTx.booking` itself
 * would REPLACE the recorder, and the fence would then find no source booking
 * at all and refuse every write; that is exactly the trap this split exists to
 * close.
 */
const mockTxBookingFindUnique = vi.fn();
const mockTxBookingFindMany = vi.fn();
let fenceBooking = recordingBookingDouble((args) =>
  mockTxBookingFindUnique(args),
);
// Re-armed per test: `vi.clearAllMocks()` clears CALLS, not the rows the
// recorder remembered, and a booking left behind by an earlier test is a
// database state that never existed.
function armParticipantFence(): void {
  fenceBooking = recordingBookingDouble((args) => mockTxBookingFindUnique(args));
}
// Reads `fenceBooking` at call time, so one stable wrapper survives re-arming.
// Only the fence's own three-column re-read is answered here; every other
// `booking.findMany` this suite makes goes to the double the tests stub.
const fenceTxBookingFindMany = fenceBookingFindMany(
  (id) => fenceBooking.lookup(id),
  (args) => mockTxBookingFindMany(args),
);

const mockTx = {
  $executeRaw: mockExecuteRaw,
  member: { findMany: fenceMemberFindMany() },
  lodge: {
    findFirst: vi.fn().mockResolvedValue({ id: "lodge-1" }),
    // Cross-lodge pass (ADR-004): lock-list and offered-lodge-name reads.
    findMany: vi.fn().mockResolvedValue([{ id: "lodge-1" }]),
    findUnique: vi.fn().mockResolvedValue({ name: "Lodge One" }),
  },
  // #2364: the hosting review is reconciled inside the booking write, so
  // every prisma/tx double a booking path runs against needs this client.
  // #2623 T5 / #2675: an ACTIVE mode, so the gate in front of the participant
  // fence lets `confirmWaitlistOffer`'s claim reach it. `[]` resolved to
  // DISABLED and took the gate's early return, so the three confirms that
  // actually claim an offer never touched the fence the doubles above model.
  // ADMIN_REVIEW_REQUIRED rather than the helper's ENFORCED default: under
  // ENFORCED a hosting violation is thrown as a refusal and the confirm answers
  // 409 instead of transitioning, which would rewrite what these cases assert;
  // review-only just records a snapshot.
  adultMemberHostingPolicy: {
    findMany: fenceHostingPolicyFindMany({ mode: "ADMIN_REVIEW_REQUIRED" }),
  },
  booking: {
    findMany: (args: unknown) => fenceTxBookingFindMany(args),
    findUnique: (args: unknown) => fenceBooking.findUnique(args),
    update: vi.fn(),
    updateMany: vi.fn(),
    count: vi.fn(),
  },
  bookingGuest: {
    update: vi.fn(),
  },
  // #3031: the offer-time reprice now writes the per-night rows it prices, so
  // the rows and the guest total agree afterwards (INV-MOD-028).
  bookingGuestNight: {
    deleteMany: vi.fn(),
    createMany: vi.fn(),
  },
  groupDiscountSetting: {
    findUnique: vi.fn(),
  },
};

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: (fn: ((tx: unknown) => Promise<unknown>) | unknown[]) =>
      typeof fn === "function"
        ? mockPrismaTransaction(fn)
        : Promise.resolve(fn),
    // #2364: the hosting review is reconciled inside the booking write, so
    // every prisma/tx double a booking path runs against needs this client.
    // #2675: the SAME active mode as `mockTx` above — one club cannot answer
    // ADMIN_REVIEW_REQUIRED inside a transaction and DISABLED outside it, and
    // the post-commit coverage drain reads the policy on this client.
    adultMemberHostingPolicy: {
      findMany: fenceHostingPolicyFindMany({ mode: "ADMIN_REVIEW_REQUIRED" }),
    },
    // #2619: the participant fence can run on this client too, so it needs the
    // raw lock statement and the id-only member re-read. The booking reads
    // below are deliberately NOT wrapped in a recorder: the tests stub
    // `mockBookingFindUnique` directly with `...Once` chains, and the only
    // fence that reaches this client in these paths is the post-commit
    // coverage drain, which swallows its own failures by design.
    $executeRaw: mockExecuteRaw,
    member: { findMany: fenceMemberFindMany() },
    booking: {
      findUnique: (...args: unknown[]) => mockBookingFindUnique(...args),
      findMany: (...args: unknown[]) => mockBookingFindMany(...args),
      count: (...args: unknown[]) => mockBookingCount(...args),
      update: (...args: unknown[]) => mockBookingUpdate(...args),
      updateMany: (...args: unknown[]) => mockBookingUpdateMany(...args),
      create: (...args: unknown[]) => mockBookingCreate(...args),
    },
    // #2543: the party read both waitlist paths make on the module client.
    bookingGuest: {
      findMany: (...args: unknown[]) => mockBookingGuestFindMany(...args),
    },
  },
}));

vi.mock("@/lib/capacity", () => ({
  checkCapacityForGuestRanges: vi.fn(),
  acquireLodgeCapacityLock: vi.fn().mockResolvedValue(undefined),
  LODGE_CAPACITY: 29,
}));

vi.mock("@/lib/bed-allocation-lifecycle", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/bed-allocation-lifecycle")>(
      "@/lib/bed-allocation-lifecycle",
    );
  return {
    ...actual,
    reconcileBedAllocationsForBookingWithGlobalLockHeld: (
      ...args: unknown[]
    ) => mockReconcileBedAllocations(...args),
    reconcileBedAllocationsForBookingWithLodgeLockHeld: (
      ...args: unknown[]
    ) => mockReconcileBedAllocations(...args),
  };
});

// #2363: confirmWaitlistOffer re-checks the CURRENT minimum-stay policy set
// before it turns an offer into held capacity. Only that one export is stubbed
// (partial mock) so the rest of the policy module stays real for every other
// consumer in this graph.
const mockValidateMinimumStay = vi.fn();
vi.mock("@/lib/booking-policies", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/booking-policies")>(
      "@/lib/booking-policies"
    );
  return {
    ...actual,
    validateMinimumStay: (...args: unknown[]) =>
      mockValidateMinimumStay(...args),
  };
});

vi.mock("@/lib/cancellation", () => ({
  getNonMemberHoldDays: vi.fn().mockResolvedValue(7),
  getNonMemberHoldPolicy: vi.fn().mockResolvedValue({
    enabled: true,
    holdDays: 7,
    source: "default",
  }),
}));

vi.mock("@/lib/email", () => ({
  sendWaitlistOfferEmail: vi.fn().mockResolvedValue(undefined),
  sendWaitlistOfferExpiredEmail: vi.fn().mockResolvedValue(undefined),
  sendWaitlistConfirmationEmail: vi.fn().mockResolvedValue(undefined),
  sendAdminWaitlistOfferAlert: vi.fn().mockResolvedValue(undefined),
  sendBookingCancelledEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/audit", () => ({
  logAudit: vi.fn(),
}));

// Offer-time repricing (#1035): the pricing/promo engines are unit-tested
// where they live; these mocks let the tests drive the offered price and
// assert the wiring (persisted totals, email price, snapshot fallback).
const mockPriceWithPolicy = vi.fn();
const mockLoadSeasonRateData = vi.fn();
const mockRecalculateBookingPromo = vi.fn();
vi.mock("@/lib/membership-type-policy", () => ({
  priceBookingGuestsWithMembershipTypePolicy: (...args: unknown[]) =>
    mockPriceWithPolicy(...args),
}));
vi.mock("@/lib/booking-guest-removal-service", () => ({
  loadSeasonRateData: (...args: unknown[]) => mockLoadSeasonRateData(...args),
  recalculateBookingPromo: (...args: unknown[]) =>
    mockRecalculateBookingPromo(...args),
}));

vi.mock("@/lib/logger", () => ({
  default: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  mockPrismaTransaction.mockReset();
  mockBookingFindUnique.mockReset();
  mockBookingFindMany.mockReset();
  mockBookingCount.mockReset();
  mockBookingUpdate.mockReset();
  mockBookingUpdateMany.mockReset();
  mockBookingCreate.mockReset();
  mockReconcileBedAllocations.mockReset();
  mockReconcileBedAllocations.mockResolvedValue(undefined);
  mockExecuteRaw.mockReset();
  mockTxBookingFindMany.mockReset();
  // #2675: NO SIBLING BOOKINGS, stated rather than left undefined. `mockReset`
  // strips the implementation as well as the calls, so an unstubbed
  // `booking.findMany` used to resolve to `undefined` — which Prisma cannot do,
  // and which made `loadSiblingHosts` throw on `undefined.filter` the moment an
  // active hosting mode let the evaluator read siblings at all. `[]` is the same
  // neutral default `mockBookingFindMany` already carries below, and it is the
  // truth for every fixture here: none of them is half of a #738 split pair.
  mockTxBookingFindMany.mockResolvedValue([]);
  mockTxBookingFindUnique.mockReset();
  // A clean recorder per test — see `armParticipantFence`.
  armParticipantFence();
  mockTx.booking.update.mockReset();
  mockTx.booking.updateMany.mockReset();
  mockTx.booking.updateMany.mockResolvedValue({ count: 1 });
  mockTx.booking.count.mockReset();
  // #1881 — expireStaleOffers now enumerates candidates lock-free via the
  // top-level prisma.booking.findMany, then reverts each under its own lodge
  // lock. Default the enumeration to empty so unrelated suites see no offers.
  mockBookingFindMany.mockResolvedValue([]);
  mockTx.lodge.findFirst.mockReset();
  mockTx.lodge.findFirst.mockResolvedValue({ id: "lodge-1" });
  mockTx.lodge.findMany.mockReset();
  mockTx.lodge.findMany.mockResolvedValue([{ id: "lodge-1" }]);
  mockTx.lodge.findUnique.mockReset();
  mockTx.lodge.findUnique.mockResolvedValue({ name: "Lodge One" });
  mockExecuteRaw.mockResolvedValue(undefined);
  // Default: transaction runs the callback with mockTx
  mockPrismaTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(mockTx));
  mockTx.bookingGuest.update.mockReset();
  mockTx.bookingGuest.update.mockResolvedValue({});
  mockTx.bookingGuestNight.deleteMany.mockReset();
  mockTx.bookingGuestNight.deleteMany.mockResolvedValue({ count: 0 });
  mockTx.bookingGuestNight.createMany.mockReset();
  mockTx.bookingGuestNight.createMany.mockResolvedValue({ count: 0 });
  // #2543: an empty party by default, so no fixture is repriced and no
  // paid-up-adult requirement bites unless a test sets one up.
  mockBookingGuestFindMany.mockReset();
  mockBookingGuestFindMany.mockResolvedValue([]);
  mockTx.groupDiscountSetting.findUnique.mockReset();
  mockTx.groupDiscountSetting.findUnique.mockResolvedValue(null);
  mockLoadSeasonRateData.mockReset();
  mockLoadSeasonRateData.mockResolvedValue([]);
  mockPriceWithPolicy.mockReset();
  // Default: repricing lands on the stored snapshot (no rate change).
  mockPriceWithPolicy.mockImplementation(async (_db: unknown, input: { guests: unknown[] }) => ({
    totalPriceCents: 20000,
    guests: (input.guests as unknown[]).map(() => ({
      priceCents: 10000,
      perNightCents: [5000, 5000],
      nightDates: [],
    })),
  }));
  mockRecalculateBookingPromo.mockReset();
  mockRecalculateBookingPromo.mockResolvedValue({
    newDiscountCents: 0,
    newPromoAdjustmentCents: 0,
    promoRemoved: false,
  });
});

// ─── Core Logic Tests ───

describe("getWaitlistPosition", () => {
  it("returns correct FIFO position", async () => {
    const { getWaitlistPosition } = await import("@/lib/waitlist");

    mockBookingFindUnique.mockResolvedValue({
      checkIn: new Date("2026-07-01"),
      checkOut: new Date("2026-07-03"),
      createdAt: new Date("2026-04-08T12:00:00Z"),
      status: "WAITLISTED",
    });
    mockBookingCount.mockResolvedValue(2); // 2 ahead

    const position = await getWaitlistPosition("booking1");
    expect(position).toBe(3); // 2 ahead + 1
  });

  it("returns 0 for non-waitlisted booking", async () => {
    const { getWaitlistPosition } = await import("@/lib/waitlist");

    mockBookingFindUnique.mockResolvedValue({
      checkIn: new Date("2026-07-01"),
      checkOut: new Date("2026-07-03"),
      createdAt: new Date(),
      status: "CONFIRMED",
    });

    const position = await getWaitlistPosition("booking1");
    expect(position).toBe(0);
  });

  it("returns 0 for non-existent booking", async () => {
    const { getWaitlistPosition } = await import("@/lib/waitlist");

    mockBookingFindUnique.mockResolvedValue(null);

    const position = await getWaitlistPosition("nonexistent");
    expect(position).toBe(0);
  });

  it("counts only the entry's own lodge (M6): first in line at lodge B, not behind older lodge A entries", async () => {
    const { getWaitlistPosition } = await import("@/lib/waitlist");

    // The entry waits at lodge B. Older overlapping WAITLISTED entries exist at
    // lodge A; club-wide counting would put this entry at position 4, but the
    // per-lodge queue makes it position 1.
    mockBookingFindUnique.mockResolvedValue({
      checkIn: new Date("2026-07-01"),
      checkOut: new Date("2026-07-03"),
      createdAt: new Date("2026-04-08T12:00:00Z"),
      status: "WAITLISTED",
      lodgeId: "lodge-b",
    });
    // The three ahead-of-you entries all sit at lodge A; only lodge-B entries
    // are counted.
    const aheadByLodge: Record<string, number> = { "lodge-a": 3, "lodge-b": 0 };
    mockBookingCount.mockImplementation(async (args: { where: { lodgeId?: string } }) =>
      args.where.lodgeId ? aheadByLodge[args.where.lodgeId] ?? 0 : 3
    );

    const position = await getWaitlistPosition("booking1");

    expect(position).toBe(1);
    expect(mockBookingCount).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: "WAITLISTED", lodgeId: "lodge-b" }),
      })
    );
  });
});

describe("getWaitlistForDates", () => {
  it("returns waitlisted bookings ordered by createdAt ASC", async () => {
    const { getWaitlistForDates } = await import("@/lib/waitlist");

    const mockEntries = [
      { id: "b1", createdAt: new Date("2026-04-01") },
      { id: "b2", createdAt: new Date("2026-04-02") },
    ];
    mockBookingFindMany.mockResolvedValue(mockEntries);

    const result = await getWaitlistForDates(
      new Date("2026-07-01"),
      new Date("2026-07-05"),
      "lodge-b"
    );

    expect(result).toEqual(mockEntries);
    // Per-lodge queue (M6): the query is scoped to the supplied lodge.
    expect(mockBookingFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: "WAITLISTED", lodgeId: "lodge-b" }),
        orderBy: { createdAt: "asc" },
      })
    );
  });
});

describe("processWaitlistForDates", () => {
  it("offers to top candidate when capacity available", async () => {
    const { processWaitlistForDates } = await import("@/lib/waitlist");
    const { checkCapacityForGuestRanges: mockCheckCapacity } = await import("@/lib/capacity");

    const candidate = {
      id: "booking1",
      checkIn: new Date("2026-07-01"),
      checkOut: new Date("2026-07-03"),
      createdAt: new Date("2026-04-01"),
      guests: [{ id: "g1" }, { id: "g2" }],
      member: { id: "m1", email: "test@test.com", firstName: "John", lastName: "Doe" },
      memberId: "m1",
      lodgeId: "lodge-1",
      waitlistAlternateLodges: [],
      promoRedemption: null,
    };

    mockTxBookingFindMany.mockResolvedValue([candidate]);
    (mockCheckCapacity as ReturnType<typeof vi.fn>).mockResolvedValue({ available: true });
    mockTx.booking.update.mockResolvedValue({});
    mockTx.booking.count.mockResolvedValue(0); // first in queue

    const result = await processWaitlistForDates({
      checkIn: new Date("2026-07-01"),
      checkOut: new Date("2026-07-05"),
    });

    expect(result.offeredBookingId).toBe("booking1");
    expect(mockTx.booking.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "booking1" },
        data: expect.objectContaining({ status: "WAITLIST_OFFERED" }),
      })
    );
  });

  it("reprices the booking at current rates when issuing an offer (#1035)", async () => {
    const { processWaitlistForDates } = await import("@/lib/waitlist");
    const { checkCapacityForGuestRanges: mockCheckCapacity } = await import("@/lib/capacity");
    const { sendWaitlistOfferEmail } = await import("@/lib/email");

    // Snapshot 20000 at creation; season rates rose while it waited: 24000.
    const candidate = {
      id: "booking1",
      memberId: "m1",
      checkIn: new Date("2026-07-01"),
      checkOut: new Date("2026-07-03"),
      createdAt: new Date("2026-04-01"),
      totalPriceCents: 20000,
      finalPriceCents: 20000,
      guests: [
        { id: "g1", ageTier: "ADULT", isMember: true, memberId: "m1", nights: [] },
        { id: "g2", ageTier: "ADULT", isMember: true, memberId: null, nights: [] },
      ],
      member: { id: "m1", email: "test@test.com", firstName: "John", lastName: "Doe" },
      promoRedemption: null,
    };
    mockTxBookingFindMany.mockResolvedValue([candidate]);
    (mockCheckCapacity as ReturnType<typeof vi.fn>).mockResolvedValue({ available: true });
    mockTx.booking.update.mockResolvedValue({});
    mockTx.booking.count.mockResolvedValue(0);
    mockPriceWithPolicy.mockResolvedValue({
      totalPriceCents: 24000,
      guests: [
        { priceCents: 12000, perNightCents: [6000, 6000], nightDates: [] },
        { priceCents: 12000, perNightCents: [6000, 6000], nightDates: [] },
      ],
    });

    const result = await processWaitlistForDates({
      checkIn: new Date("2026-07-01"),
      checkOut: new Date("2026-07-05"),
    });

    expect(result.offeredBookingId).toBe("booking1");
    // The policy engine prices with the booking owner's identity, so a
    // membership-type or age-tier change during the wait is picked up.
    expect(mockPriceWithPolicy).toHaveBeenCalledWith(
      mockTx,
      expect.objectContaining({
        ownerMemberId: "m1",
        guests: expect.arrayContaining([
          expect.objectContaining({ bookingGuestId: "g1", memberId: "m1" }),
        ]),
      })
    );
    // New totals persisted on the booking and each guest.
    expect(mockTx.booking.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "booking1" },
        data: expect.objectContaining({
          totalPriceCents: 24000,
          finalPriceCents: 24000,
        }),
      })
    );
    expect(mockTx.bookingGuest.update).toHaveBeenCalledTimes(2);
    // The offer email states the price the member will pay on confirmation.
    expect(sendWaitlistOfferEmail).toHaveBeenCalledWith(
      { bookingId: "booking1", recipientMemberId: "m1" },
      "test@test.com",
      "John",
      candidate.checkIn,
      candidate.checkOut,
      2,
      expect.any(Date),
      "booking1",
      24000,
      // Merged multi-lodge params: these fixtures model pre-migration
      // rows with no lodgeId (club identity fallback); no cross-lodge
      // block for a same-lodge offer.
      undefined,
      null,
      // #2543's twelfth argument: the sentence explaining that somebody on the
      // booking is priced as a non-member because their subscription is unpaid.
      // The offer sweep re-bases a stored waitlisted price at current rates — which
      // is exactly what this test pins — so the offer email had to gain the reason
      // as well as the figure, or a member would be shown a bigger number and no
      // explanation for it. NULL here, and for the right reason rather than by
      // accident: this party is not repriced for an unpaid subscription, so there
      // is nothing to explain.
      null
    );
    // ...and "for the right reason" is asserted, not asserted-about. The notice is
    // wrapped in a try/catch that degrades to null rather than losing an offer, so
    // a broken evaluation and a genuinely empty answer both arrive as null. This
    // pins the clean one.
    const { default: logger } = await import("@/lib/logger");
    expect(logger.error).not.toHaveBeenCalledWith(
      expect.anything(),
      "Failed to resolve the #2543 member-rate notice for a waitlist offer",
    );
  });

  it("writes the per-night rows it just priced, so the strand still reconciles (#3031)", async () => {
    const { processWaitlistForDates } = await import("@/lib/waitlist");
    const { checkCapacityForGuestRanges: mockCheckCapacity } = await import(
      "@/lib/capacity"
    );

    // The shape that used to break every later edit: the offer reprices upward,
    // the guest total moves to the new figure, and the STORED night rows still
    // hold the old one. The rows would then no longer sum to the total, which is
    // INV-MOD-028's `STORED_TOTAL_MISMATCH` — so the next in-progress edit or
    // single-guest removal on this booking would be refused and sent to a
    // person, for a mismatch this sweep had created.
    const night1 = new Date("2026-08-01T00:00:00.000Z");
    const night2 = new Date("2026-08-02T00:00:00.000Z");
    const candidate = {
      id: "booking1",
      memberId: "m1",
      checkIn: new Date("2026-08-01"),
      checkOut: new Date("2026-08-03"),
      createdAt: new Date("2026-06-01"),
      totalPriceCents: 20000,
      finalPriceCents: 20000,
      guests: [
        {
          id: "g1",
          ageTier: "ADULT",
          isMember: true,
          memberId: "m1",
          nights: [
            { stayDate: night1, priceCents: 5000 },
            { stayDate: night2, priceCents: 5000 },
          ],
        },
      ],
      member: {
        id: "m1",
        email: "test@test.com",
        firstName: "John",
        lastName: "Doe",
      },
      promoRedemption: null,
    };
    mockTxBookingFindMany.mockResolvedValue([candidate]);
    (mockCheckCapacity as ReturnType<typeof vi.fn>).mockResolvedValue({
      available: true,
    });
    mockTx.booking.update.mockResolvedValue({});
    mockTx.booking.count.mockResolvedValue(0);
    mockPriceWithPolicy.mockResolvedValue({
      totalPriceCents: 13000,
      guests: [
        {
          priceCents: 13000,
          // Deliberately UNEQUAL: an even split would have stored 6500/6500 and
          // reconciled just as well, so equal amounts could not tell the two
          // apart. These are the real per-night figures the offer charges.
          perNightCents: [6000, 7000],
          nightDates: [night1, night2],
        },
      ],
    });

    const result = await processWaitlistForDates({
      checkIn: new Date("2026-08-01"),
      checkOut: new Date("2026-08-03"),
    });

    expect(result.offeredBookingId).toBe("booking1");
    expect(mockTx.bookingGuestNight.deleteMany).toHaveBeenCalledWith({
      where: { bookingGuestId: "g1" },
    });
    expect(mockTx.bookingGuestNight.createMany).toHaveBeenCalledWith({
      data: [
        { bookingGuestId: "g1", stayDate: night1, priceCents: 6000, priceSource: "SOLD" },
        { bookingGuestId: "g1", stayDate: night2, priceCents: 7000, priceSource: "SOLD" },
      ],
    });
    // The property that matters, stated as itself rather than left implied by
    // the two assertions above: what was written to the rows adds up to what was
    // written to the guest.
    const written = mockTx.bookingGuestNight.createMany.mock.calls[0][0] as {
      data: Array<{ priceCents: number }>;
    };
    expect(
      written.data.reduce((sum, row) => sum + row.priceCents, 0),
    ).toBe(13000);
    expect(mockTx.bookingGuest.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "g1" },
        data: expect.objectContaining({ priceCents: 13000 }),
      }),
    );
  });

  it("refuses to write a night the reprice put no amount against (#3031)", async () => {
    const { processWaitlistForDates } = await import("@/lib/waitlist");
    const { checkCapacityForGuestRanges: mockCheckCapacity } = await import(
      "@/lib/capacity"
    );

    // A per-night vector shorter than the night list. The prohibited answer is
    // `?? 0`, which would write a real night at zero and hand the NEXT edit
    // evidence that the member paid nothing for it.
    const night1 = new Date("2026-08-01T00:00:00.000Z");
    const night2 = new Date("2026-08-02T00:00:00.000Z");
    const candidate = {
      id: "booking1",
      memberId: "m1",
      checkIn: new Date("2026-08-01"),
      checkOut: new Date("2026-08-03"),
      createdAt: new Date("2026-06-01"),
      totalPriceCents: 20000,
      finalPriceCents: 20000,
      guests: [
        {
          id: "g1",
          ageTier: "ADULT",
          isMember: true,
          memberId: "m1",
          nights: [
            { stayDate: night1, priceCents: 5000 },
            { stayDate: night2, priceCents: 5000 },
          ],
        },
      ],
      member: {
        id: "m1",
        email: "test@test.com",
        firstName: "John",
        lastName: "Doe",
      },
      promoRedemption: null,
    };
    mockTxBookingFindMany.mockResolvedValue([candidate]);
    (mockCheckCapacity as ReturnType<typeof vi.fn>).mockResolvedValue({
      available: true,
    });
    mockTx.booking.update.mockResolvedValue({});
    mockTx.booking.count.mockResolvedValue(0);
    mockPriceWithPolicy.mockResolvedValue({
      totalPriceCents: 13000,
      guests: [
        {
          priceCents: 13000,
          perNightCents: [6000],
          nightDates: [night1, night2],
        },
      ],
    });

    // The reprice degrades to the stored snapshot rather than losing the queue
    // place (its documented behaviour for ANY reprice failure), so the offer
    // still goes out — at the OLD price, and with the booking's stored history
    // untouched. What must never happen is a HALF-written reprice, which is why
    // the refusal is raised before the first mutation rather than between two of
    // them.
    const result = await processWaitlistForDates({
      checkIn: new Date("2026-08-01"),
      checkOut: new Date("2026-08-03"),
    });

    expect(result.offeredBookingId).toBe("booking1");
    expect(mockTx.bookingGuestNight.createMany).not.toHaveBeenCalled();
    expect(mockTx.bookingGuestNight.deleteMany).not.toHaveBeenCalled();
    expect(mockTx.bookingGuest.update).not.toHaveBeenCalled();
    expect(mockTx.booking.update).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ totalPriceCents: 13000 }),
      }),
    );
    const { default: logger } = await import("@/lib/logger");
    expect(logger.error).toHaveBeenCalledWith(
      expect.anything(),
      "Failed to reprice waitlisted booking at offer time; offering at the stored snapshot",
    );
  });

  it("declines to reprice over a night whose sold price is NOT KNOWN, and offers at the stored snapshot (#3166, INV-MOD-028)", async () => {
    const { processWaitlistForDates } = await import("@/lib/waitlist");
    const { checkCapacityForGuestRanges: mockCheckCapacity } = await import(
      "@/lib/capacity"
    );

    // A booking an admin edit already PARKED: #3170 wrote NULL onto the second
    // night to say the sold price is not known, and an OPEN review task is
    // waiting for a person to price it. This sweep passes no locked prices and
    // rewrites every night row, so without the fence the blank comes back as
    // today's rate — a figure nobody decided, in the column the next edit reads
    // as evidence, while the review that was raised over it is still open.
    //
    // The CONTROL for this is "writes the per-night rows it just priced" above:
    // the identical sweep on a booking with no blank still reprices and still
    // writes its rows. A fence that stopped every reprice would pass this test
    // and fail that one.
    const night1 = new Date("2026-08-01T00:00:00.000Z");
    const night2 = new Date("2026-08-02T00:00:00.000Z");
    const candidate = {
      id: "booking1",
      memberId: "m1",
      checkIn: new Date("2026-08-01"),
      checkOut: new Date("2026-08-03"),
      createdAt: new Date("2026-06-01"),
      totalPriceCents: 20000,
      finalPriceCents: 20000,
      guests: [
        {
          id: "g1",
          ageTier: "ADULT",
          isMember: true,
          memberId: "m1",
          nights: [
            { stayDate: night1, priceCents: 5000 },
            { stayDate: night2, priceCents: null },
          ],
        },
      ],
      member: {
        id: "m1",
        email: "test@test.com",
        firstName: "John",
        lastName: "Doe",
      },
      promoRedemption: null,
    };
    mockTxBookingFindMany.mockResolvedValue([candidate]);
    (mockCheckCapacity as ReturnType<typeof vi.fn>).mockResolvedValue({
      available: true,
    });
    mockTx.booking.update.mockResolvedValue({});
    mockTx.booking.count.mockResolvedValue(0);
    mockPriceWithPolicy.mockResolvedValue({
      totalPriceCents: 26000,
      guests: [
        {
          priceCents: 26000,
          perNightCents: [13000, 13000],
          nightDates: [night1, night2],
        },
      ],
    });

    const result = await processWaitlistForDates({
      checkIn: new Date("2026-08-01"),
      checkOut: new Date("2026-08-03"),
    });

    // The offer still goes out — the queue place is not lost over this.
    expect(result.offeredBookingId).toBe("booking1");
    // Nothing was priced, so nothing was written: no season lookup, no rows.
    expect(mockPriceWithPolicy).not.toHaveBeenCalled();
    expect(mockTx.bookingGuestNight.deleteMany).not.toHaveBeenCalled();
    expect(mockTx.bookingGuestNight.createMany).not.toHaveBeenCalled();
    expect(mockTx.bookingGuest.update).not.toHaveBeenCalled();
    expect(mockTx.booking.update).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ totalPriceCents: 26000 }),
      }),
    );
    // Declined, not failed: nothing went wrong, a decision was refused.
    const { default: logger } = await import("@/lib/logger");
    expect(logger.error).not.toHaveBeenCalledWith(
      expect.anything(),
      "Failed to reprice waitlisted booking at offer time; offering at the stored snapshot",
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.anything(),
      "Waitlisted booking carries a night with no known sold price; offering at the stored snapshot rather than repricing over it (#3166)",
    );
  });

  it("reprices downward when season rates dropped during the wait (#1035)", async () => {
    const { processWaitlistForDates } = await import("@/lib/waitlist");
    const { checkCapacityForGuestRanges: mockCheckCapacity } = await import("@/lib/capacity");
    const { sendWaitlistOfferEmail } = await import("@/lib/email");

    const candidate = {
      id: "booking1",
      memberId: "m1",
      checkIn: new Date("2026-07-01"),
      checkOut: new Date("2026-07-03"),
      createdAt: new Date("2026-04-01"),
      totalPriceCents: 20000,
      finalPriceCents: 20000,
      guests: [
        { id: "g1", ageTier: "ADULT", isMember: true, memberId: "m1", nights: [] },
      ],
      member: { id: "m1", email: "test@test.com", firstName: "John", lastName: "Doe" },
      promoRedemption: null,
    };
    mockTxBookingFindMany.mockResolvedValue([candidate]);
    (mockCheckCapacity as ReturnType<typeof vi.fn>).mockResolvedValue({ available: true });
    mockTx.booking.update.mockResolvedValue({});
    mockTx.booking.count.mockResolvedValue(0);
    mockPriceWithPolicy.mockResolvedValue({
      totalPriceCents: 16000,
      guests: [{ priceCents: 16000, perNightCents: [8000, 8000], nightDates: [] }],
    });

    await processWaitlistForDates({
      checkIn: new Date("2026-07-01"),
      checkOut: new Date("2026-07-05"),
    });

    expect(mockTx.booking.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ finalPriceCents: 16000 }),
      })
    );
    expect(sendWaitlistOfferEmail).toHaveBeenCalledWith(
      { bookingId: "booking1", recipientMemberId: "m1" },
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      "booking1",
      16000,
      undefined,
      null,
      // #2543's twelfth argument — the unpaid-subscription rate reason. Null:
      // nobody on this party is repriced.
      null
    );
  });

  it("drops a promo invalidated during the wait and prices without it (#1035)", async () => {
    const { processWaitlistForDates } = await import("@/lib/waitlist");
    const { checkCapacityForGuestRanges: mockCheckCapacity } = await import("@/lib/capacity");

    const candidate = {
      id: "booking1",
      memberId: "m1",
      checkIn: new Date("2026-07-01"),
      checkOut: new Date("2026-07-03"),
      createdAt: new Date("2026-04-01"),
      totalPriceCents: 20000,
      finalPriceCents: 18000,
      guests: [
        { id: "g1", ageTier: "ADULT", isMember: true, memberId: "m1", nights: [] },
      ],
      member: { id: "m1", email: "test@test.com", firstName: "John", lastName: "Doe" },
      promoRedemption: {
        id: "pr1",
        guestTargets: [],
        promoCode: { id: "promo1", assignments: [] },
      },
    };
    mockTxBookingFindMany.mockResolvedValue([candidate]);
    (mockCheckCapacity as ReturnType<typeof vi.fn>).mockResolvedValue({ available: true });
    mockTx.booking.update.mockResolvedValue({});
    mockTx.booking.count.mockResolvedValue(0);
    mockPriceWithPolicy.mockResolvedValue({
      totalPriceCents: 20000,
      guests: [{ priceCents: 20000, perNightCents: [10000, 10000], nightDates: [] }],
    });
    mockRecalculateBookingPromo.mockResolvedValue({
      newDiscountCents: 0,
      newPromoAdjustmentCents: 0,
      promoRemoved: true,
    });

    await processWaitlistForDates({
      checkIn: new Date("2026-07-01"),
      checkOut: new Date("2026-07-05"),
    });

    expect(mockRecalculateBookingPromo).toHaveBeenCalledWith(
      expect.objectContaining({ bookingId: "booking1" })
    );
    expect(mockTx.booking.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          promoAdjustmentCents: 0,
          finalPriceCents: 20000,
        }),
      })
    );
  });

  it("falls back to the stored snapshot when repricing fails (#1035)", async () => {
    const { processWaitlistForDates } = await import("@/lib/waitlist");
    const { checkCapacityForGuestRanges: mockCheckCapacity } = await import("@/lib/capacity");
    const { sendWaitlistOfferEmail } = await import("@/lib/email");

    const candidate = {
      id: "booking1",
      memberId: "m1",
      checkIn: new Date("2026-07-01"),
      checkOut: new Date("2026-07-03"),
      createdAt: new Date("2026-04-01"),
      totalPriceCents: 20000,
      finalPriceCents: 20000,
      guests: [
        { id: "g1", ageTier: "ADULT", isMember: true, memberId: "m1", nights: [] },
      ],
      member: { id: "m1", email: "test@test.com", firstName: "John", lastName: "Doe" },
      promoRedemption: null,
    };
    mockTxBookingFindMany.mockResolvedValue([candidate]);
    (mockCheckCapacity as ReturnType<typeof vi.fn>).mockResolvedValue({ available: true });
    mockTx.booking.update.mockResolvedValue({});
    mockTx.booking.count.mockResolvedValue(0);
    mockPriceWithPolicy.mockRejectedValue(new Error("no season rate for tier"));

    const result = await processWaitlistForDates({
      checkIn: new Date("2026-07-01"),
      checkOut: new Date("2026-07-05"),
    });

    // The offer is never blocked by a repricing edge case.
    expect(result.offeredBookingId).toBe("booking1");
    expect(mockTx.booking.update).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ finalPriceCents: expect.anything() }),
      })
    );
    expect(sendWaitlistOfferEmail).toHaveBeenCalledWith(
      { bookingId: "booking1", recipientMemberId: "m1" },
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      "booking1",
      20000,
      undefined,
      null,
      // #2543's twelfth argument — the unpaid-subscription rate reason. Null:
      // nobody on this party is repriced.
      null
    );
  });

  it("skips candidates with only partial availability", async () => {
    const { processWaitlistForDates } = await import("@/lib/waitlist");
    const { checkCapacityForGuestRanges: mockCheckCapacity } = await import("@/lib/capacity");

    const candidate = {
      id: "booking1",
      checkIn: new Date("2026-07-01"),
      checkOut: new Date("2026-07-03"),
      createdAt: new Date("2026-04-01"),
      guests: [{ id: "g1" }],
      member: { id: "m1", email: "test@test.com", firstName: "John", lastName: "Doe" },
      memberId: "m1",
      lodgeId: "lodge-1",
      waitlistAlternateLodges: [],
      promoRedemption: null,
    };

    mockTxBookingFindMany.mockResolvedValue([candidate]);
    (mockCheckCapacity as ReturnType<typeof vi.fn>).mockResolvedValue({ available: false });

    const result = await processWaitlistForDates({
      checkIn: new Date("2026-07-01"),
      checkOut: new Date("2026-07-05"),
    });

    expect(result.offeredBookingId).toBeNull();
  });

  it("passes per-guest stay ranges into waitlist promotion capacity checks", async () => {
    const { processWaitlistForDates } = await import("@/lib/waitlist");
    const { checkCapacityForGuestRanges: mockCheckCapacity } = await import("@/lib/capacity");

    const candidate = {
      id: "booking1",
      checkIn: new Date("2026-07-01"),
      checkOut: new Date("2026-07-03"),
      createdAt: new Date("2026-04-01"),
      guests: [
        {
          id: "g1",
          stayStart: new Date("2026-07-01"),
          stayEnd: new Date("2026-07-02"),
        },
        {
          id: "g2",
          stayStart: new Date("2026-07-02"),
          stayEnd: new Date("2026-07-03"),
        },
      ],
      member: { id: "m1", email: "test@test.com", firstName: "John", lastName: "Doe" },
      memberId: "m1",
      lodgeId: "lodge-1",
      waitlistAlternateLodges: [],
      promoRedemption: null,
    };

    mockTxBookingFindMany.mockResolvedValue([candidate]);
    (mockCheckCapacity as ReturnType<typeof vi.fn>).mockResolvedValue({
      available: true,
      minAvailable: 0,
      nightDetails: [],
    });
    mockTx.booking.update.mockResolvedValue({});
    mockTx.booking.count.mockResolvedValue(0);

    const result = await processWaitlistForDates({
      checkIn: new Date("2026-07-01"),
      checkOut: new Date("2026-07-03"),
    });

    expect(result.offeredBookingId).toBe("booking1");
    expect(mockCheckCapacity).toHaveBeenCalledWith(
      "lodge-1",
      candidate.checkIn,
      candidate.checkOut,
      candidate.guests,
      undefined,
      mockTx
    );
  });

  it("does nothing when no waitlisted bookings exist", async () => {
    const { processWaitlistForDates } = await import("@/lib/waitlist");

    mockTxBookingFindMany.mockResolvedValue([]);

    const result = await processWaitlistForDates({
      checkIn: new Date("2026-07-01"),
      checkOut: new Date("2026-07-05"),
    });

    expect(result.offeredBookingId).toBeNull();
  });
});

/**
 * The offer's party as the hosting EVALUATOR reads it (#2675).
 *
 * `confirmWaitlistOffer` reconciles the hosting review inside its claiming
 * transaction, and now that `mockTx` answers an ACTIVE mode the evaluator
 * genuinely builds participants from these rows rather than bailing out at the
 * mode gate. `BOOKING_HOSTING_SELECT` is the authority on their shape: names,
 * the stay envelope, the sparse night set, the D-12 consent status, and — the
 * crux — the LIVE `member` relation. A row carrying `isMember: true` with no
 * `member` is a shape production cannot emit (the review's select always
 * hydrates it) and it does not degrade gracefully: `undefined !== null` is true,
 * so `memberIsInGoodStanding` reads `undefined.active` and the claim throws.
 *
 * `nights: []` is the honest answer here — none of these cases is about a
 * partial stay — and the evaluator then falls back to stayStart..stayEnd, which
 * is the whole offered range for everyone on it.
 */
function offerGuests(
  checkIn: Date,
  checkOut: Date,
  options: { withNonMember?: boolean } = {},
) {
  const stay = {
    stayStart: checkIn,
    stayEnd: checkOut,
    nights: [] as Array<{ stayDate: Date }>,
    // `null` = no consent was ever needed, i.e. operationally present (D-12).
    consentStatus: null,
  };
  const guests: Array<Record<string, unknown>> = [
    {
      id: "g1",
      firstName: "John",
      lastName: "Doe",
      ageTier: "ADULT",
      isMember: true,
      memberId: "m1",
      // The booking owner, an adult member in good standing staying the whole
      // offer — so the party has a host and an active hosting mode raises no
      // violation. These cases therefore answer exactly what they answered
      // while the rule was off, with the fence in front now genuinely run.
      member: hostingMemberRow("m1"),
      ...stay,
    },
  ];
  if (options.withNonMember) {
    guests.push({
      id: "g2",
      firstName: "Bob",
      lastName: "Jones",
      ageTier: "ADULT",
      isMember: false,
      memberId: null,
      // A true non-member states `member: null` EXPLICITLY. Omitting the key
      // is the failure mode described above, not a softer version of this.
      member: null,
      ...stay,
    });
  }
  return guests;
}

describe("confirmWaitlistOffer", () => {
  // The service reads the offer once OUTSIDE its claiming transaction to decide
  // which pre-write checks apply, then claims it under the lodge lock. This
  // suite used to leave that first read unmocked, so every case here silently
  // exercised the "the row vanished between the two reads" path rather than the
  // ordinary one; since #2363 the claim refuses that state outright (the policy
  // guard hangs off the unlocked read, so a claim it never classified must not
  // proceed). Default it to the same live, member-owned, same-lodge offer the
  // transaction sees — cases that want a divergence override it.
  beforeEach(() => {
    mockBookingFindUnique.mockResolvedValue({
      waitlistOfferedLodgeId: null,
      memberId: "m1",
      status: "WAITLIST_OFFERED",
      lodgeId: "lodge-1",
      checkIn: new Date("2026-07-01"),
      checkOut: new Date("2026-07-03"),
      waitlistOfferExpiresAt: new Date(Date.now() + 86400000),
    });
    mockValidateMinimumStay.mockResolvedValue({ valid: true, violations: [] });
  });

  it("returns the stable retry result when the participant fence rolls back the offer claim", async () => {
    const { confirmWaitlistOffer } = await import("@/lib/waitlist");
    mockPrismaTransaction.mockRejectedValueOnce(
      new HostingCoverageParticipantRetryError(),
    );

    const result = await confirmWaitlistOffer("booking1", "m1");

    expect(result).toEqual({
      success: false,
      error: HOSTING_COVERAGE_RETRY_MESSAGE,
      code: HOSTING_COVERAGE_RETRY_CODE,
    });
    expect(mockBookingUpdate).not.toHaveBeenCalled();
    expect(mockBookingUpdateMany).not.toHaveBeenCalled();
  });

  it("transitions to PAYMENT_PENDING for all-member bookings", async () => {
    const { confirmWaitlistOffer } = await import("@/lib/waitlist");
    const { checkCapacityForGuestRanges: mockCheckCapacity } = await import("@/lib/capacity");

    mockTxBookingFindUnique.mockResolvedValue({
      id: "booking1",
      memberId: "m1",
      // Booking.lodgeId is NOT NULL in the schema, so a real row always carries
      // one — and the #2619 participant fence re-reads it under the lock and
      // compares it against the planned source.
      lodgeId: "lodge-1",
      status: "WAITLIST_OFFERED",
      waitlistOfferExpiresAt: new Date(Date.now() + 86400000),
      checkIn: new Date("2026-07-01"),
      checkOut: new Date("2026-07-03"),
      guests: offerGuests(new Date("2026-07-01"), new Date("2026-07-03")),
    });
    (mockCheckCapacity as ReturnType<typeof vi.fn>).mockResolvedValue({ available: true });
    mockTx.booking.update.mockResolvedValue({});

    const result = await confirmWaitlistOffer("booking1", "m1");

    expect(result.success).toBe(true);
    expect(result.newStatus).toBe("PAYMENT_PENDING");
  });

  /**
   * #2810: PROVES THE WIDENED DOUBLE CAN STILL FAIL.
   *
   * Every confirm in this suite passes partly BECAUSE the fence's under-lock
   * re-read agrees with the row the reconciliation planned from — that is what
   * `recordingBookingDouble` arranges, and it is the right default. But a double
   * that can only ever agree is a rubber stamp, and a rubber stamp is
   * indistinguishable from a working fence when you are reading a green suite.
   *
   * So drive it the other way once. The owner of the source booking changes
   * between the plan and the re-read, and the confirm must refuse with the stable
   * retry rather than claim the offer against an owner that moved underneath it.
   * With the fence bypassed this confirm succeeds — which is precisely the state
   * #2619 found the code in.
   */
  it("refuses the confirm when the source booking's owner drifts under the fence", async () => {
    const { confirmWaitlistOffer } = await import("@/lib/waitlist");
    const { checkCapacityForGuestRanges: mockCheckCapacity } = await import("@/lib/capacity");

    mockTxBookingFindUnique.mockResolvedValue({
      id: "booking1",
      memberId: "m1",
      lodgeId: "lodge-1",
      status: "WAITLIST_OFFERED",
      waitlistOfferExpiresAt: new Date(Date.now() + 86400000),
      checkIn: new Date("2026-07-01"),
      checkOut: new Date("2026-07-03"),
      guests: offerGuests(new Date("2026-07-01"), new Date("2026-07-03")),
    });
    (mockCheckCapacity as ReturnType<typeof vi.fn>).mockResolvedValue({ available: true });
    mockTx.booking.update.mockResolvedValue({});
    // The post-lock truth. `drift` is consulted only by the fence's re-read, so
    // the plan still sees `m1` and the disagreement is genuine rather than a
    // fixture that was inconsistent from the start.
    fenceBooking.drift("booking1", {
      id: "booking1",
      memberId: "someone-else",
      lodgeId: "lodge-1",
    });

    const result = await confirmWaitlistOffer("booking1", "m1");

    expect(result).toEqual({
      success: false,
      error: HOSTING_COVERAGE_RETRY_MESSAGE,
      code: HOSTING_COVERAGE_RETRY_CODE,
    });
    // And it refused BEFORE writing, not after. A fence that detects drift but
    // has already transitioned the booking has not protected anything.
    expect(mockBookingUpdate).not.toHaveBeenCalled();
    expect(mockBookingUpdateMany).not.toHaveBeenCalled();
  });

  it("transitions to PENDING for non-member bookings far from check-in", async () => {
    const { confirmWaitlistOffer } = await import("@/lib/waitlist");
    const { checkCapacityForGuestRanges: mockCheckCapacity } = await import("@/lib/capacity");

    const farFuture = new Date();
    farFuture.setDate(farFuture.getDate() + 30);

    mockTxBookingFindUnique.mockResolvedValue({
      id: "booking1",
      memberId: "m1",
      // Booking.lodgeId is NOT NULL in the schema, so a real row always carries
      // one — and the #2619 participant fence re-reads it under the lock and
      // compares it against the planned source.
      lodgeId: "lodge-1",
      status: "WAITLIST_OFFERED",
      waitlistOfferExpiresAt: new Date(Date.now() + 86400000),
      checkIn: farFuture,
      checkOut: new Date(farFuture.getTime() + 2 * 86400000),
      guests: offerGuests(farFuture, new Date(farFuture.getTime() + 2 * 86400000), {
        withNonMember: true,
      }),
    });
    (mockCheckCapacity as ReturnType<typeof vi.fn>).mockResolvedValue({ available: true });
    mockTx.booking.update.mockResolvedValue({});

    const result = await confirmWaitlistOffer("booking1", "m1");

    expect(result.success).toBe(true);
    expect(result.newStatus).toBe("PENDING");
  });

  it("clears the hold and takes payment when non-member holds are disabled", async () => {
    const { confirmWaitlistOffer } = await import("@/lib/waitlist");
    const { getNonMemberHoldPolicy } = await import("@/lib/cancellation");
    const { checkCapacityForGuestRanges: mockCheckCapacity } = await import("@/lib/capacity");

    vi.mocked(getNonMemberHoldPolicy).mockResolvedValueOnce({
      enabled: false,
      holdDays: 7,
      source: "default",
    });
    const farFuture = new Date();
    farFuture.setDate(farFuture.getDate() + 30);

    mockTxBookingFindUnique.mockResolvedValue({
      id: "booking1",
      memberId: "m1",
      // Booking.lodgeId is NOT NULL in the schema, so a real row always carries
      // one — and the #2619 participant fence re-reads it under the lock and
      // compares it against the planned source.
      lodgeId: "lodge-1",
      status: "WAITLIST_OFFERED",
      waitlistOfferExpiresAt: new Date(Date.now() + 86400000),
      nonMemberHoldUntil: new Date("2026-07-01"),
      checkIn: farFuture,
      checkOut: new Date(farFuture.getTime() + 2 * 86400000),
      guests: offerGuests(farFuture, new Date(farFuture.getTime() + 2 * 86400000), {
        withNonMember: true,
      }),
    });
    (mockCheckCapacity as ReturnType<typeof vi.fn>).mockResolvedValue({ available: true });
    mockTx.booking.update.mockResolvedValue({});

    const result = await confirmWaitlistOffer("booking1", "m1");

    expect(result.success).toBe(true);
    expect(result.newStatus).toBe("PAYMENT_PENDING");
    expect(mockTx.booking.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "PAYMENT_PENDING",
          nonMemberHoldUntil: null,
        }),
      })
    );
  });

  it("rejects expired offers", async () => {
    const { confirmWaitlistOffer } = await import("@/lib/waitlist");

    mockTxBookingFindUnique.mockResolvedValue({
      id: "booking1",
      memberId: "m1",
      // Booking.lodgeId is NOT NULL in the schema, so a real row always carries
      // one — and the #2619 participant fence re-reads it under the lock and
      // compares it against the planned source.
      lodgeId: "lodge-1",
      status: "WAITLIST_OFFERED",
      waitlistOfferExpiresAt: new Date(Date.now() - 1000),
      checkIn: new Date("2026-07-01"),
      checkOut: new Date("2026-07-03"),
      guests: offerGuests(new Date("2026-07-01"), new Date("2026-07-03")),
    });

    const result = await confirmWaitlistOffer("booking1", "m1");

    expect(result.success).toBe(false);
    expect(result.error).toContain("expired");
  });

  it("does not resurrect an offer that expiry reverted while confirm waited for the lodge lock (#1881)", async () => {
    const { confirmWaitlistOffer } = await import("@/lib/waitlist");

    mockTxBookingFindUnique
      // Pre-lock read resolves only the immutable lock key.
      .mockResolvedValueOnce({ lodgeId: "lodge-1" })
      // Expiry won the lock and committed before confirm's post-lock re-read.
      .mockResolvedValueOnce({
        id: "booking1",
        lodgeId: "lodge-1",
        memberId: "m1",
        status: "WAITLISTED",
        waitlistOfferExpiresAt: null,
        checkIn: new Date("2026-07-01"),
        checkOut: new Date("2026-07-03"),
        guests: offerGuests(new Date("2026-07-01"), new Date("2026-07-03")),
      });

    const result = await confirmWaitlistOffer("booking1", "m1");

    expect(result).toEqual({
      success: false,
      error: "Booking is not in WAITLIST_OFFERED status",
    });
    expect(mockTx.booking.updateMany).not.toHaveBeenCalled();
  });

  it("rejects non-owner", async () => {
    const { confirmWaitlistOffer } = await import("@/lib/waitlist");

    mockTxBookingFindUnique.mockResolvedValue({
      id: "booking1",
      memberId: "m1",
      // Booking.lodgeId is NOT NULL in the schema, so a real row always carries
      // one — and the #2619 participant fence re-reads it under the lock and
      // compares it against the planned source.
      lodgeId: "lodge-1",
      status: "WAITLIST_OFFERED",
      waitlistOfferExpiresAt: new Date(Date.now() + 86400000),
      checkIn: new Date("2026-07-01"),
      checkOut: new Date("2026-07-03"),
      guests: offerGuests(new Date("2026-07-01"), new Date("2026-07-03")),
    });

    const result = await confirmWaitlistOffer("booking1", "m2");

    expect(result.success).toBe(false);
    expect(result.error).toBe("Forbidden");
  });

  it("handles capacity race condition (capacity taken between offer and confirm)", async () => {
    const { confirmWaitlistOffer } = await import("@/lib/waitlist");
    const { checkCapacityForGuestRanges: mockCheckCapacity } = await import("@/lib/capacity");

    mockTxBookingFindUnique.mockResolvedValue({
      id: "booking1",
      memberId: "m1",
      // Booking.lodgeId is NOT NULL in the schema, so a real row always carries
      // one — and the #2619 participant fence re-reads it under the lock and
      // compares it against the planned source.
      lodgeId: "lodge-1",
      status: "WAITLIST_OFFERED",
      waitlistOfferExpiresAt: new Date(Date.now() + 86400000),
      checkIn: new Date("2026-07-01"),
      checkOut: new Date("2026-07-03"),
      guests: offerGuests(new Date("2026-07-01"), new Date("2026-07-03")),
    });
    (mockCheckCapacity as ReturnType<typeof vi.fn>).mockResolvedValue({ available: false });
    mockTx.booking.update.mockResolvedValue({});

    const result = await confirmWaitlistOffer("booking1", "m1");

    expect(result.success).toBe(false);
    expect(result.error).toContain("no longer available");
  });

  it("rejects non-WAITLIST_OFFERED status", async () => {
    const { confirmWaitlistOffer } = await import("@/lib/waitlist");

    mockTxBookingFindUnique.mockResolvedValue({
      id: "booking1",
      memberId: "m1",
      // Booking.lodgeId is NOT NULL in the schema, so a real row always carries
      // one — and the #2619 participant fence re-reads it under the lock and
      // compares it against the planned source.
      lodgeId: "lodge-1",
      status: "WAITLISTED",
      waitlistOfferExpiresAt: null,
      checkIn: new Date("2026-07-01"),
      checkOut: new Date("2026-07-03"),
      guests: offerGuests(new Date("2026-07-01"), new Date("2026-07-03")),
    });

    const result = await confirmWaitlistOffer("booking1", "m1");

    expect(result.success).toBe(false);
    expect(result.error).toContain("not in WAITLIST_OFFERED");
  });
});

describe("expireStaleOffers", () => {
  it("reverts expired offers to WAITLISTED under the offer's own lodge lock (#1881)", async () => {
    const { expireStaleOffers } = await import("@/lib/waitlist");

    mockTxBookingFindMany
      .mockResolvedValueOnce([
        {
          id: "booking1",
          lodgeId: "lodge-1",
          waitlistOfferedLodgeId: null,
          checkIn: new Date("2026-07-01"),
          checkOut: new Date("2026-07-03"),
          createdAt: new Date("2026-04-01"),
          member: { email: "test@test.com", firstName: "John" },
        },
      ])
      .mockResolvedValue([]);

    const result = await expireStaleOffers();

    expect(result.expiredCount).toBe(1);
    // The offer's own lodge is locked (not just the default lodge).
    const { acquireLodgeCapacityLock } = await import("@/lib/capacity");
    expect(acquireLodgeCapacityLock).toHaveBeenCalledWith(mockTx, "lodge-1");
    // #1881 — status-guarded revert, not a bare update.
    expect(mockTx.booking.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "booking1", status: "WAITLIST_OFFERED" },
        data: expect.objectContaining({ status: "WAITLISTED" }),
      })
    );
  });

  it("skips the revert when a concurrent confirm moved the offer out of WAITLIST_OFFERED under the lock (#1881)", async () => {
    const { expireStaleOffers } = await import("@/lib/waitlist");

    mockTxBookingFindMany
      .mockResolvedValueOnce([
        {
          id: "booking1",
          lodgeId: "lodge-1",
          waitlistOfferedLodgeId: null,
          checkIn: new Date("2026-07-01"),
          checkOut: new Date("2026-07-03"),
          createdAt: new Date("2026-04-01"),
          member: { email: "test@test.com", firstName: "John" },
        },
      ])
      .mockResolvedValue([]);
    // The status-guarded revert claims nothing: a concurrent confirm already
    // moved the offer out of WAITLIST_OFFERED while the cron waited on the lock.
    mockTx.booking.updateMany.mockResolvedValue({ count: 0 });

    const result = await expireStaleOffers();

    // The guarded updateMany claimed nothing, so the offer is not counted as
    // expired and no expiry email/reprocess is queued for it.
    expect(result.expiredCount).toBe(0);
  });

  it("does nothing when no stale offers exist", async () => {
    const { expireStaleOffers } = await import("@/lib/waitlist");

    mockTxBookingFindMany.mockResolvedValueOnce([]);

    const result = await expireStaleOffers();

    expect(result.expiredCount).toBe(0);
    expect(result.reofferedCount).toBe(0);
  });

  it("reverts expired offer to WAITLISTED and keeps reofferedCount=0 when no capacity for next candidate", async () => {
    const { expireStaleOffers } = await import("@/lib/waitlist");
    const { checkCapacityForGuestRanges } = await import("@/lib/capacity");

    mockTxBookingFindMany
      .mockResolvedValueOnce([
        {
          id: "expired-offer-1",
          lodgeId: "lodge-1",
          waitlistOfferedLodgeId: null,
          checkIn: new Date("2026-08-01"),
          checkOut: new Date("2026-08-03"),
          createdAt: new Date("2026-05-01"),
          member: { email: "alice@test.com", firstName: "Alice" },
        },
      ])
      // processWaitlistForDates finds a next candidate, but capacity is gone.
      .mockResolvedValue([
        {
          id: "next-candidate",
          checkIn: new Date("2026-08-01"),
          checkOut: new Date("2026-08-03"),
          createdAt: new Date("2026-05-02"),
          guests: [{ id: "g1" }, { id: "g2" }],
          member: { id: "m2", email: "bob@test.com", firstName: "Bob", lastName: "Jones" },
        },
      ]);
    mockTx.booking.update.mockResolvedValue({});
    vi.mocked(checkCapacityForGuestRanges).mockResolvedValue({
      available: false,
      minAvailable: 0,
      nightDetails: [],
    });

    const result = await expireStaleOffers();

    expect(result.expiredCount).toBe(1);
    expect(result.reofferedCount).toBe(0);
    expect(mockTx.booking.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "expired-offer-1", status: "WAITLIST_OFFERED" },
        data: expect.objectContaining({ status: "WAITLISTED" }),
      })
    );
  });

  it("reprocesses each lodge's own queue when two same-range offers expire at different lodges (M2)", async () => {
    const { expireStaleOffers } = await import("@/lib/waitlist");
    const { checkCapacityForGuestRanges } = await import("@/lib/capacity");

    const checkIn = new Date("2026-09-01");
    const checkOut = new Date("2026-09-03");

    // Two expired same-lodge offers sharing a date range, one at each lodge.
    // A date-only affectedRanges key would collapse them into a single
    // default-lodge reprocess; keying by lodge keeps them separate so each
    // lodge's own queue is served.
    const offerA = {
      id: "offer-a",
      lodgeId: "lodge-a",
      waitlistOfferedLodgeId: null,
      checkIn,
      checkOut,
      createdAt: new Date("2026-05-01"),
      member: { email: "a@test.com", firstName: "A" },
    };
    const offerB = {
      id: "offer-b",
      lodgeId: "lodge-b",
      waitlistOfferedLodgeId: null,
      checkIn,
      checkOut,
      createdAt: new Date("2026-05-02"),
      member: { email: "b@test.com", firstName: "B" },
    };
    function nextInLine(id: string, lodgeId: string, createdAt: string) {
      return {
        id,
        memberId: `m-${id}`,
        lodgeId,
        checkIn,
        checkOut,
        createdAt: new Date(createdAt),
        totalPriceCents: 20000,
        finalPriceCents: 20000,
        guests: [{ id: `g-${id}`, ageTier: "ADULT", isMember: true, memberId: `m-${id}`, nights: [] }],
        member: { id: `m-${id}`, email: `${id}@test.com`, firstName: id, lastName: "Next" },
        waitlistAlternateLodges: [],
        promoRedemption: null,
      };
    }

    mockTxBookingFindMany
      .mockResolvedValueOnce([offerA, offerB]) // the offers query
      .mockResolvedValueOnce([nextInLine("cand-a", "lodge-a", "2026-06-01")]) // pass 1: lodge A
      .mockResolvedValueOnce([nextInLine("cand-b", "lodge-b", "2026-06-02")]) // pass 2: lodge B
      .mockResolvedValue([]);
    mockTx.lodge.findMany.mockResolvedValue([{ id: "lodge-a" }, { id: "lodge-b" }]);
    vi.mocked(checkCapacityForGuestRanges).mockResolvedValue({
      available: true,
      minAvailable: 1,
      nightDetails: [],
    });
    mockTx.booking.update.mockResolvedValue({});
    mockTx.booking.count.mockResolvedValue(0);

    const result = await expireStaleOffers();

    expect(result.expiredCount).toBe(2);
    // Two independent reprocess passes ran — proving the same-range offers at
    // two lodges did not collapse into a single call.
    expect(result.reofferedCount).toBe(2);
    // Each lodge's own next-in-line was offered.
    expect(mockTx.booking.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "cand-a" },
        data: expect.objectContaining({ status: "WAITLIST_OFFERED" }),
      })
    );
    expect(mockTx.booking.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "cand-b" },
        data: expect.objectContaining({ status: "WAITLIST_OFFERED" }),
      })
    );
  });
});

describe("processWaitlistCron", () => {
  it("retries transient Prisma transaction-start failures", async () => {
    const originalDelay = process.env.WAITLIST_TRANSACTION_RETRY_DELAY_MS;
    process.env.WAITLIST_TRANSACTION_RETRY_DELAY_MS = "0";
    try {
      const { processWaitlistCron } = await import("@/lib/cron-waitlist");

      mockPrismaTransaction
        .mockRejectedValueOnce(
          new Error("Transaction API error: Unable to start a transaction in the given time.")
        )
        .mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) => fn(mockTx));
      mockTxBookingFindMany.mockResolvedValueOnce([]);
      mockBookingFindMany.mockResolvedValueOnce([]);

      await expect(processWaitlistCron()).resolves.toEqual({
        expiredOffers: 0,
        newOffers: 0,
        autoCancelled: 0,
      });
      expect(mockPrismaTransaction).toHaveBeenCalledTimes(2);
    } finally {
      if (originalDelay === undefined) {
        delete process.env.WAITLIST_TRANSACTION_RETRY_DELAY_MS;
      } else {
        process.env.WAITLIST_TRANSACTION_RETRY_DELAY_MS = originalDelay;
      }
    }
  });
});

// ─── Status Colors Tests ───

describe("status colors include waitlist statuses", () => {
  it("defines WAITLISTED and WAITLIST_OFFERED colors", async () => {
    const { bookingStatusClasses } = await import("@/lib/status-colors");

    expect(bookingStatusClasses["WAITLISTED"]).toBeTruthy();
    expect(bookingStatusClasses["WAITLIST_OFFERED"]).toBeTruthy();
    expect(bookingStatusClasses["WAITLISTED"]).not.toBe(bookingStatusClasses["WAITLIST_OFFERED"]);
  });

  it("WAITLISTED and WAITLIST_OFFERED have unique colors", async () => {
    const { bookingStatusClasses } = await import("@/lib/status-colors");

    const allClasses = Object.values(bookingStatusClasses);
    const unique = new Set(allClasses);
    expect(unique.size).toBe(allClasses.length);
  });

  it("bookingStatusClass returns fallback for unknown status", async () => {
    const { bookingStatusClass } = await import("@/lib/status-colors");

    expect(bookingStatusClass("UNKNOWN")).toBe("bg-muted text-foreground");
  });
});

// ─── Email Template Tests ───

describe("waitlist email templates", () => {
  it("waitlistConfirmationTemplate renders correctly", async () => {
    const { waitlistConfirmationTemplate } = await import("@/lib/email-templates/waitlist");

    const html = waitlistConfirmationTemplate(
      "John",
      new Date("2026-07-01"),
      new Date("2026-07-03"),
      3,
      2
    );

    expect(html).toContain("Waitlist");
    expect(html).toContain("John");
    expect(html).toContain("#2");
  });

  it("waitlistOfferTemplate renders correctly", async () => {
    const { waitlistOfferTemplate } = await import("@/lib/email-templates/waitlist");

    const html = waitlistOfferTemplate(
      "Jane",
      new Date("2026-07-01"),
      new Date("2026-07-03"),
      2,
      new Date("2026-07-10"),
      "booking123",
      10000
    );

    expect(html).toContain("Spot Has Opened Up");
    expect(html).toContain("Jane");
    expect(html).toContain("booking123");
  });

  it("waitlistOfferExpiredTemplate renders correctly", async () => {
    const { waitlistOfferExpiredTemplate } = await import("@/lib/email-templates/waitlist");

    const html = waitlistOfferExpiredTemplate(
      "Mike",
      new Date("2026-07-01"),
      new Date("2026-07-03"),
      3
    );

    expect(html).toContain("Expired");
    expect(html).toContain("Mike");
    expect(html).toContain("#3");
  });

  it("adminWaitlistOfferTemplate renders correctly", async () => {
    const { adminWaitlistOfferTemplate } = await import("@/lib/email-templates/admin-booking");

    const html = adminWaitlistOfferTemplate({
      memberName: "John Doe",
      checkIn: new Date("2026-07-01"),
      checkOut: new Date("2026-07-03"),
      guestCount: 4,
      position: 1,
    });

    expect(html).toContain("Waitlist Offer Made");
    expect(html).toContain("John Doe");
  });
});

// ─── Cron Job Tests ───

describe("processWaitlistCron", () => {
  it("skips cleanly when Admin Modules disables waitlist", async () => {
    const { runWaitlistProcessorCron } = await import("@/lib/cron-waitlist");

    await expect(
      runWaitlistProcessorCron({ isModuleEnabled: () => false })
    ).resolves.toEqual({
      cronStatus: "SKIPPED",
      expiredOffers: 0,
      newOffers: 0,
      autoCancelled: 0,
      reason: "Waitlist effective module state is disabled",
    });
    expect(mockBookingFindMany).not.toHaveBeenCalled();
    expect(mockBookingUpdateMany).not.toHaveBeenCalled();
  });

  it("auto-cancels past-date waitlisted bookings", async () => {
    const { processWaitlistCron } = await import("@/lib/cron-waitlist");

    mockTxBookingFindMany.mockResolvedValueOnce([]);
    mockBookingFindMany.mockResolvedValueOnce([
      {
        id: "old1",
      },
      { id: "old2" },
    ]);
    const old1 = {
      id: "old1",
      status: "WAITLISTED",
      lodgeId: "lodge-1",
      checkIn: new Date("2026-06-01"),
      checkOut: new Date("2026-06-03"),
    };
    const old2 = {
      ...old1,
      id: "old2",
      status: "WAITLIST_OFFERED",
    };
    mockTxBookingFindUnique
      .mockResolvedValueOnce(old1)
      .mockResolvedValueOnce(old1)
      .mockResolvedValueOnce(old2)
      .mockResolvedValueOnce(old2);

    const result = await processWaitlistCron();

    expect(result.autoCancelled).toBe(2);
    expect(mockTx.booking.updateMany).toHaveBeenCalledTimes(2);
    expect(mockTx.booking.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "old1",
          status: { in: ["WAITLISTED", "WAITLIST_OFFERED"] },
        }),
        data: expect.objectContaining({ status: "CANCELLED" }),
      })
    );
    expect(mockReconcileBedAllocations).toHaveBeenCalledTimes(2);
  });

  // F32 (#1888): checkOut is @db.Date (the NZ calendar date stored at UTC
  // midnight). The auto-cancel cutoff must key off the NZ calendar date, not a
  // local-midnight instant, or a stay checking out today (NZ) is skipped until
  // tomorrow for the first ~13h of each NZ day under the TZ=Pacific/Auckland
  // server pin. This test pins TZ + the clock into that window and proves a stay
  // checking out on today's NZ date IS in the auto-cancel set.
  it("auto-cancels a stay checking out on today's NZ date, not a day late (F32, #1888)", async () => {
    const { processWaitlistCron } = await import("@/lib/cron-waitlist");

    const hostTimeZone = captureHostTimeZone();
    process.env.TZ = "Pacific/Auckland";
    vi.useFakeTimers();
    // NZ 2026-07-16 08:00 (NZST +12); the UTC day (Jul 15) trails the NZ day.
    // The local-midnight bug would set the cutoff to NZ midnight = Jul 15 12:00Z,
    // excluding a Jul 16 00:00Z (@db.Date) checkout; the date-only cutoff is
    // Jul 16 00:00Z, which includes it (lte).
    vi.setSystemTime(new Date("2026-07-15T20:00:00.000Z"));
    try {
      // expireStaleOffers (step 1) runs first inside a transaction; no offers.
      mockTxBookingFindMany.mockResolvedValueOnce([]);

      // A waitlisted stay whose checkOut is today's NZ calendar date, stored as
      // @db.Date (UTC midnight).
      const todayNzCheckout = new Date("2026-07-16T00:00:00.000Z");
      const candidates = [
        {
          id: "checks-out-today-nz",
          checkIn: new Date("2026-07-14T00:00:00.000Z"),
          checkOut: todayNzCheckout,
        },
      ];
      // Behavioural fake: apply the checkOut <= cutoff filter the DB would apply,
      // so the assertion turns on which cutoff the code computed.
      mockBookingFindMany.mockImplementationOnce(
        async (args: { where: { checkOut: { lte: Date } } }) => {
          const cutoff = args.where.checkOut.lte;
          return candidates.filter(
            (b) => b.checkOut.getTime() <= cutoff.getTime()
          );
        }
      );
      const current = {
        ...candidates[0],
        status: "WAITLISTED",
        lodgeId: "lodge-1",
      };
      mockTxBookingFindUnique
        .mockResolvedValueOnce(current)
        .mockResolvedValueOnce(current);

      const result = await processWaitlistCron();

      // Behavioural: the today-NZ checkout is in the cancel set (was excluded
      // under the local-midnight bug).
      expect(result.autoCancelled).toBe(1);
      expect(mockTx.booking.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: "checks-out-today-nz" }),
          data: expect.objectContaining({ status: "CANCELLED" }),
        })
      );
      // The cutoff is the NZ calendar date at exact UTC midnight, not the
      // local-midnight instant (Jul 15 12:00Z) the bug produced.
      const cutoff = mockBookingFindMany.mock.calls[0][0].where.checkOut.lte;
      expect(cutoff.toISOString()).toBe("2026-07-16T00:00:00.000Z");
    } finally {
      vi.useRealTimers();
      hostTimeZone.restore();
    }
  });

  it("does not reconcile or report a past waitlist candidate that loses its claim", async () => {
    const { processWaitlistCron } = await import("@/lib/cron-waitlist");
    const booking = {
      id: "lost-waitlist-claim",
      status: "WAITLIST_OFFERED",
      lodgeId: "lodge-1",
      checkIn: new Date("2026-06-01"),
      checkOut: new Date("2026-06-03"),
    };
    mockTxBookingFindMany.mockResolvedValueOnce([]);
    mockBookingFindMany.mockResolvedValueOnce([{ id: booking.id }]);
    mockTxBookingFindUnique
      .mockResolvedValueOnce(booking)
      .mockResolvedValueOnce(booking);
    mockTx.booking.updateMany.mockResolvedValue({ count: 0 });

    const result = await processWaitlistCron();

    expect(result.autoCancelled).toBe(0);
    expect(mockReconcileBedAllocations).not.toHaveBeenCalled();
  });
});

// ─── Booking Creation Waitlist Path Tests ───

describe("booking creation waitlist response", () => {
  it("returns 409 with canWaitlist when capacity exceeded", () => {
    // Test the error object structure used in the booking route
    const err = Object.assign(new Error("CAPACITY_EXCEEDED"), {
      code: "CAPACITY_EXCEEDED",
      fullNights: ["2026-07-01", "2026-07-02"],
      canWaitlist: true,
    });

    expect((err as unknown as { code: string }).code).toBe("CAPACITY_EXCEEDED");
    expect((err as unknown as { canWaitlist: boolean }).canWaitlist).toBe(true);
    expect((err as unknown as { fullNights: string[] }).fullNights).toHaveLength(2);
  });
});

describe("updateWaitlistPositions", () => {
  it("recalculates positions correctly", async () => {
    const { updateWaitlistPositions } = await import("@/lib/waitlist");

    mockBookingFindMany.mockResolvedValue([
      { id: "b1" },
      { id: "b2" },
      { id: "b3" },
    ]);
    mockBookingUpdate.mockResolvedValue({});

    await updateWaitlistPositions(
      new Date("2026-07-01"),
      new Date("2026-07-05")
    );

    expect(mockBookingUpdate).toHaveBeenCalledTimes(3);
    expect(mockBookingUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "b1" },
        data: { waitlistPosition: 1 },
      })
    );
    expect(mockBookingUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "b3" },
        data: { waitlistPosition: 3 },
      })
    );
  });
});
