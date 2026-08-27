/**
 * Split-booking tests (issue #738).
 *
 * A mixed member/non-member party that is not flagged becomes two linked
 * bookings: a member booking charged up front (PAYMENT_PENDING, holds capacity)
 * and a provisional non-member child booking (PENDING, holds nothing,
 * parentBookingId = the member booking). Pure parties stay a single booking.
 * The flagged "only book if my guests can come" path is a single provisional
 * PENDING booking holding nothing.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { BookingStatus, AgeTier } from "@prisma/client";
import { LodgeBookingEligibilityError } from "@/lib/lodge-access";
import { BookingMemberNightConflictError } from "@/lib/booking-member-night-conflicts";

const h = vi.hoisted(() => ({
  transaction: vi.fn(),
  executeRaw: vi.fn(),
  seasonFindMany: vi.fn(),
  bookingCreate: vi.fn(),
  bookingUpdate: vi.fn(),
  paymentCreate: vi.fn(),
  memberFindUnique: vi.fn(),
  lodgeFindFirst: vi.fn(),
  lodgeFindUnique: vi.fn().mockResolvedValue({ id: "lodge-1", active: true }),
  memberLodgeAccessFindMany: vi.fn(),
  checkCapacityForGuestRanges: vi.fn(),
  reconcileBedAllocationsForBooking: vi.fn(),
  logAudit: vi.fn(),
  groupJoinFindUnique: vi.fn(),
  groupJoinCreate: vi.fn(),
  groupJoinUpdate: vi.fn(),
  acquireLodgeCapacityLock: vi.fn(),
  bookingFindFirst: vi.fn(),
  bookingGuestFindMany: vi.fn(),
  settleHostingCoverage: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: (fn: (tx: unknown) => Promise<unknown>) => h.transaction(fn),
    member: { findUnique: (...a: unknown[]) => h.memberFindUnique(...a) },
  },
}));

vi.mock("@/lib/capacity", () => ({
  acquireLodgeCapacityLock: (...a: unknown[]) => h.acquireLodgeCapacityLock(...a),
  checkCapacityForGuestRanges: (...a: unknown[]) => h.checkCapacityForGuestRanges(...a),
}));

vi.mock("@/lib/policies/booking-route-decisions", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/policies/booking-route-decisions")>();
  return {
    ...actual,
    // Deterministic $50/guest pricing so member/child bookings price above $0
    // (keeps them off the zero-dollar auto-PAID path).
    priceBookingGuests: (input: { guests: unknown[] }) => ({
      totalPriceCents: input.guests.length * 5000,
      guests: input.guests.map(() => ({ priceCents: 5000, perNightCents: [5000] })),
    }),
  };
});

vi.mock("@/lib/promo", () => ({
  redeemPromoCode: vi.fn(),
  shouldPersistPromoRedemption: vi.fn().mockReturnValue(false),
  validateAndCalculatePromoDiscount: vi.fn(),
}));

vi.mock("@/lib/work-party", () => ({
  resolveWorkPartyEventPromoForBooking: vi.fn(),
}));

vi.mock("@/lib/email", () => ({
  sendAdminNewBookingAlert: vi.fn().mockResolvedValue(undefined),
  sendBookingConfirmedEmail: vi.fn().mockResolvedValue(undefined),
  sendBookingPendingEmail: vi.fn().mockResolvedValue(undefined),
  sendWaitlistConfirmationEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/xero-operation-outbox", () => ({
  enqueueXeroBookingInvoiceOperation: vi.fn().mockResolvedValue({ queueOperationId: null }),
  kickQueuedXeroOutboxOperationsIfConnected: vi.fn().mockResolvedValue({}),
}));

vi.mock("@/lib/member-credit", () => ({
  applyCreditToBooking: vi.fn(),
  getMemberCreditBalance: vi.fn().mockResolvedValue(0),
}));

vi.mock("@/lib/payment-transactions", () => ({
  recordInternetBankingPaymentTransaction: vi.fn(),
}));

vi.mock("@/lib/audit", () => ({ logAudit: (...a: unknown[]) => h.logAudit(...a) }));

vi.mock("@/lib/booking-review", () => ({
  ADULT_SUPERVISION_REVIEW_REASON: "no-adult",
  requiresAdultSupervisionReview: vi.fn().mockReturnValue(false),
}));

vi.mock("@/lib/bed-allocation-lifecycle", () => ({
  reconcileBedAllocationsForBookingWithGlobalLockHeld: (...a: unknown[]) =>
    h.reconcileBedAllocationsForBooking(...a),
}));

vi.mock("@/lib/adult-member-hosting-coverage-drain", () => ({
  settleHostingCoverageAfterCommit: (...a: unknown[]) =>
    h.settleHostingCoverage(...a),
}));

vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  createConfirmedBooking,
  GroupJoinConflictError,
  DuplicateStayConflictError,
  type BookingGuestInput,
} from "@/lib/booking-create";
import { requireCalendarDate } from "@/lib/club-time";

// #3123 (`INV-LOCK-004`) — `createConfirmedBooking` is transaction-aware, so its
// caller resolves the CLUB's day and threads it in. Pinned to the frozen clock's
// club day, which is what the service used to read for itself.
const FIXTURE_CLUB_DAY = requireCalendarDate("2026-07-01");

const checkIn = new Date("2026-09-10T00:00:00.000Z");
const checkOut = new Date("2026-09-12T00:00:00.000Z");
const MEMBER_TYPE = "type-full";
const NONMEMBER_TYPE = "type-nonmember";
const mockSeasons = [
  {
    id: "season-1",
    startDate: new Date("2026-09-01T00:00:00.000Z"),
    endDate: new Date("2026-09-30T00:00:00.000Z"),
    membershipTypeRates: [
      {
        membershipTypeId: MEMBER_TYPE,
        ageTier: AgeTier.ADULT,
        pricePerNightCents: 2500,
      },
      {
        membershipTypeId: NONMEMBER_TYPE,
        ageTier: AgeTier.ADULT,
        pricePerNightCents: 5000,
      },
    ],
  },
];

let createdCount = 0;
const tx = {
  $executeRaw: (...a: unknown[]) => h.executeRaw(...a),
  season: { findMany: (...a: unknown[]) => h.seasonFindMany(...a) },
  // Rate resolver (#1930, E4): no seeded members/assignments, so every guest
  // resolves NON_MEMBER_DEFAULT and prices from the NON_MEMBER rate (>$0,
  // keeping bookings off the zero-dollar auto-PAID path).
  member: { findMany: async () => [] },
  seasonalMembershipAssignment: { findMany: async () => [] },
  membershipType: {
    findMany: async () => [
      { id: NONMEMBER_TYPE, key: "NON_MEMBER" },
      { id: MEMBER_TYPE, key: "FULL" },
    ],
  },
  // #2364: the hosting review is reconciled inside the booking write, so
  // every prisma/tx double a booking path runs against needs this client.
  adultMemberHostingPolicy: { findMany: vi.fn().mockResolvedValue([]) },
  booking: {
    create: (...a: unknown[]) => h.bookingCreate(...a),
    update: (...a: unknown[]) => h.bookingUpdate(...a),
    findFirst: (...a: unknown[]) => h.bookingFindFirst(...a),
    // #2364: the create transaction reconciles the hosting review from the rows
    // it just wrote. Answering undefined is the "booking not found" branch,
    // which writes nothing — right for a double that models the create alone.
    findUnique: vi.fn(),
    findMany: vi.fn().mockResolvedValue([]),
  },
  payment: { create: (...a: unknown[]) => h.paymentCreate(...a) },
  lodge: {
    findFirst: (...a: unknown[]) => h.lodgeFindFirst(...a),
    findUnique: (...a: unknown[]) => h.lodgeFindUnique(...a),
  },
  bookingGuest: { findMany: (...a: unknown[]) => h.bookingGuestFindMany(...a) },
  memberLodgeAccess: {
    findMany: (...a: unknown[]) => h.memberLodgeAccessFindMany(...a),
  },
  groupBookingJoin: {
    findUnique: (...a: unknown[]) => h.groupJoinFindUnique(...a),
    create: (...a: unknown[]) => h.groupJoinCreate(...a),
    update: (...a: unknown[]) => h.groupJoinUpdate(...a),
  },
};

function guest(isMember: boolean, firstName: string): BookingGuestInput {
  return {
    firstName,
    lastName: "Test",
    ageTier: AgeTier.ADULT,
    isMember,
    stayStart: checkIn,
    stayEnd: checkOut,
  };
}

function baseInput(
  guests: BookingGuestInput[],
  overrides: Partial<
    Omit<Parameters<typeof createConfirmedBooking>[0], "lodgeId">
  > = {}
) {
  const hasNonMembers = guests.some((g) => !g.isMember);
  return {
    effectiveMemberId: "member-1",
    isOnBehalf: false,
    sessionUserId: "member-1",
    checkIn,
    checkOut,
    guests,
    status: hasNonMembers ? BookingStatus.PENDING : BookingStatus.PAYMENT_PENDING,
    shouldBePending: hasNonMembers,
    holdDays: 7,
    lodgeId: "lodge-1",
    todayAtClub: FIXTURE_CLUB_DAY,
    ...overrides,
  };
}

/** The `data` payload of each tx.booking.create call, in order. */
function createPayloads() {
  return h.bookingCreate.mock.calls.map((call) => (call[0] as { data: Record<string, unknown> }).data);
}

describe("createConfirmedBooking split bookings (#738)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createdCount = 0;
    h.transaction.mockImplementation(async (fn: (store: typeof tx) => Promise<unknown>) => fn(tx));
    h.executeRaw.mockResolvedValue(undefined);
    h.seasonFindMany.mockResolvedValue(mockSeasons);
    h.checkCapacityForGuestRanges.mockResolvedValue({ available: true, nightDetails: [] });
    h.reconcileBedAllocationsForBooking.mockResolvedValue(undefined);
    h.settleHostingCoverage.mockResolvedValue({});
    h.bookingUpdate.mockResolvedValue({});
    h.memberFindUnique.mockResolvedValue({ id: "member-1", firstName: "Mem", lastName: "Ber", email: "m@example.com" });
    h.lodgeFindFirst.mockResolvedValue({ id: "lodge-1" });
    h.memberLodgeAccessFindMany.mockResolvedValue([]);
    h.bookingCreate.mockImplementation((args: { data: Record<string, unknown> }) => {
      createdCount += 1;
      const id = `booking-${createdCount}`;
      const guestRows = (args.data.guests as { create: Array<Record<string, unknown>> }).create.map(
        (g, i) => ({ ...g, id: `${id}-g${i}` })
      );
      return Promise.resolve({ ...args.data, id, guests: guestRows });
    });
  });

  it("settles hosting restoration only after standalone create commits", async () => {
    const outcome = await createConfirmedBooking(
      baseInput([guest(true, "Alice")]),
    );

    expect(outcome.type).toBe("created");
    expect(h.transaction).toHaveBeenCalledTimes(1);
    expect(h.settleHostingCoverage).toHaveBeenCalledWith({
      bookingId: "booking-1",
    });
    expect(h.transaction.mock.invocationCallOrder[0]).toBeLessThan(
      h.settleHostingCoverage.mock.invocationCallOrder[0],
    );
  });

  it("defers hosting restoration until a caller-owned transaction commits", async () => {
    const outcome = await createConfirmedBooking(
      baseInput([guest(true, "Alice")], { tx: tx as never }),
    );

    expect(outcome.type).toBe("created");
    expect(h.transaction).not.toHaveBeenCalled();
    expect(h.settleHostingCoverage).not.toHaveBeenCalled();
    if (outcome.type !== "created") throw new Error("Expected created outcome");
    await outcome.deferredPostCommit?.();
    expect(h.settleHostingCoverage).toHaveBeenCalledWith({
      bookingId: "booking-1",
    });
  });

  it("splits a mixed party into a member booking (held) and a provisional non-member child", async () => {
    const guests = [guest(true, "Alice"), guest(false, "Bob")];
    const outcome = await createConfirmedBooking(baseInput(guests));

    expect(outcome.type).toBe("created");
    const payloads = createPayloads();
    expect(payloads).toHaveLength(2);

    // Primary = member booking: charged up front, holds capacity, no children.
    const [primary, child] = payloads;
    expect(primary.status).toBe(BookingStatus.PAYMENT_PENDING);
    expect(primary.hasNonMembers).toBe(false);
    expect(primary.parentBookingId).toBeUndefined();
    expect((primary.guests as { create: unknown[] }).create).toHaveLength(1);
    expect(primary.nonMemberHoldUntil).toBeNull();

    // Child = provisional non-member booking: PENDING, holds nothing, linked.
    expect(child.status).toBe(BookingStatus.PENDING);
    expect(child.hasNonMembers).toBe(true);
    expect(child.parentBookingId).toBe("booking-1");
    expect((child.guests as { create: Array<{ isMember: boolean }> }).create).toHaveLength(1);
    expect((child.guests as { create: Array<{ isMember: boolean }> }).create[0].isMember).toBe(false);
    expect(child.nonMemberHoldUntil).toBeInstanceOf(Date);
    // #1771: an in-capacity split stamps no override on either row.
    expect(primary).not.toHaveProperty("capacityOverriddenAt");
    expect(child).not.toHaveProperty("capacityOverriddenAt");

    // The returned booking is the member (primary) booking, so the booker is
    // sent to pay for the held portion.
    if (outcome.type === "created") {
      expect(outcome.booking.id).toBe("booking-1");
    }
  });

  it("stamps the persisted capacity override on BOTH the member parent and the non-member child of an over-capacity mixed party (#1771)", async () => {
    // Adversarial-review gap (#1771): when the MEMBER guests alone overflow, an
    // on-behalf overbook admits the whole party above the ceiling behind the
    // admin's confirm. The stamped member parent now survives payment; without
    // the same stamp on the provisional non-member child, cron-confirm-pending
    // re-checks the child at the hold window, finds the lodge over-full (from
    // the parent's own overbook), and bumps it days later — a silent
    // partial-drop against an explicit admin overbook. Both rows must carry it.
    h.checkCapacityForGuestRanges.mockResolvedValue({
      available: false,
      nightDetails: [{ date: checkIn, availableBeds: -2 }],
    });

    const outcome = await createConfirmedBooking(
      baseInput([guest(true, "Alice"), guest(false, "Bob")], {
        isOnBehalf: true,
        sessionUserId: "admin-1",
        confirmOverCapacity: true,
      })
    );

    expect(outcome.type).toBe("created");
    const payloads = createPayloads();
    expect(payloads).toHaveLength(2);
    const [parent, child] = payloads;

    // Parent (member) stamped with the acting admin.
    expect(parent.hasNonMembers).toBe(false);
    expect(parent.capacityOverriddenAt).toBeInstanceOf(Date);
    expect(parent.capacityOverriddenByMemberId).toBe("admin-1");

    // Child (provisional non-member) inherits the same override.
    expect(child.parentBookingId).toBe("booking-1");
    expect(child.hasNonMembers).toBe(true);
    expect(child.capacityOverriddenAt).toBeInstanceOf(Date);
    expect(child.capacityOverriddenByMemberId).toBe("admin-1");
  });

  it("keeps a pure-member party as a single held booking", async () => {
    const guests = [guest(true, "Alice"), guest(true, "Carol")];
    await createConfirmedBooking(baseInput(guests));

    const payloads = createPayloads();
    expect(payloads).toHaveLength(1);
    expect(payloads[0].status).toBe(BookingStatus.PAYMENT_PENDING);
    expect(payloads[0].hasNonMembers).toBe(false);
    expect(payloads[0].parentBookingId).toBeUndefined();
  });

  it("keeps a pure-non-member party as a single provisional booking", async () => {
    const guests = [guest(false, "Bob"), guest(false, "Dan")];
    await createConfirmedBooking(baseInput(guests));

    const payloads = createPayloads();
    expect(payloads).toHaveLength(1);
    expect(payloads[0].status).toBe(BookingStatus.PENDING);
    expect(payloads[0].hasNonMembers).toBe(true);
    expect(payloads[0].parentBookingId).toBeUndefined();
  });

  it("keeps a flagged mixed party as one provisional booking holding nothing", async () => {
    const guests = [guest(true, "Alice"), guest(false, "Bob")];
    await createConfirmedBooking(baseInput(guests, { cancelIfGuestsBumped: true }));

    const payloads = createPayloads();
    expect(payloads).toHaveLength(1);
    // The whole party (members included) is a single provisional PENDING hold,
    // nothing charged up front.
    expect(payloads[0].status).toBe(BookingStatus.PENDING);
    expect(payloads[0].hasNonMembers).toBe(true);
    expect(payloads[0].parentBookingId).toBeUndefined();
    expect((payloads[0].guests as { create: unknown[] }).create).toHaveLength(2);
    // No up-front payment is taken for the flagged provisional booking.
    expect(h.paymentCreate).not.toHaveBeenCalled();
  });

  it("rejects the booking when the member is restricted to a different lodge", async () => {
    h.memberLodgeAccessFindMany.mockResolvedValue([{ lodgeId: "other-lodge" }]);
    const guests = [guest(true, "Alice"), guest(true, "Carol")];

    await expect(createConfirmedBooking(baseInput(guests))).rejects.toBeInstanceOf(
      LodgeBookingEligibilityError
    );
    expect(h.bookingCreate).not.toHaveBeenCalled();
  });

  it("allows an on-behalf booking despite a lodge restriction for a different lodge", async () => {
    h.memberLodgeAccessFindMany.mockResolvedValue([{ lodgeId: "other-lodge" }]);
    const guests = [guest(true, "Alice"), guest(true, "Carol")];

    const outcome = await createConfirmedBooking(
      baseInput(guests, { isOnBehalf: true })
    );

    expect(outcome.type).toBe("created");
    expect(h.bookingCreate).toHaveBeenCalledTimes(1);
  });

  it("keeps a mixed party inside the hold window as one normal booking", async () => {
    const guests = [guest(true, "Alice"), guest(false, "Bob")];
    await createConfirmedBooking(
      baseInput(guests, {
        status: BookingStatus.PAYMENT_PENDING,
        shouldBePending: false,
      })
    );

    const payloads = createPayloads();
    expect(payloads).toHaveLength(1);
    expect(payloads[0].status).toBe(BookingStatus.PAYMENT_PENDING);
    expect(payloads[0].hasNonMembers).toBe(true);
    expect(payloads[0].parentBookingId).toBeUndefined();
    expect(payloads[0].nonMemberHoldUntil).toBeNull();
    expect((payloads[0].guests as { create: unknown[] }).create).toHaveLength(2);
  });

  it("ignores the keep-together flag when no provisional hold will be created", async () => {
    const guests = [guest(true, "Alice"), guest(false, "Bob")];
    await createConfirmedBooking(
      baseInput(guests, {
        cancelIfGuestsBumped: true,
        status: BookingStatus.PAYMENT_PENDING,
        shouldBePending: false,
      })
    );

    const payloads = createPayloads();
    expect(payloads).toHaveLength(1);
    expect(payloads[0].status).toBe(BookingStatus.PAYMENT_PENDING);
    expect(payloads[0].cancelIfGuestsBumped).toBe(false);
    expect(payloads[0].nonMemberHoldUntil).toBeNull();
  });
});

describe("group join roster writes (#1039 items 2 and 3)", () => {
  const groupJoin = { groupBookingId: "group-1", joinerMemberId: "member-1" };

  beforeEach(() => {
    vi.clearAllMocks();
    createdCount = 0;
    h.transaction.mockImplementation(async (fn: (store: typeof tx) => Promise<unknown>) => fn(tx));
    h.executeRaw.mockResolvedValue(undefined);
    h.seasonFindMany.mockResolvedValue(mockSeasons);
    h.checkCapacityForGuestRanges.mockResolvedValue({ available: true, nightDetails: [] });
    h.reconcileBedAllocationsForBooking.mockResolvedValue(undefined);
    h.bookingUpdate.mockResolvedValue({});
    h.memberFindUnique.mockResolvedValue({ id: "member-1", firstName: "Mem", lastName: "Ber", email: "m@example.com" });
    h.bookingCreate.mockImplementation((args: { data: Record<string, unknown> }) => {
      createdCount += 1;
      const id = `booking-${createdCount}`;
      const guestRows = (args.data.guests as { create: Array<Record<string, unknown>> }).create.map(
        (g, i) => ({ ...g, id: `${id}-g${i}` })
      );
      return Promise.resolve({ ...args.data, id, guests: guestRows });
    });
    // Multi-lodge merge: createConfirmedBooking now resolves the booking lodge
    // and checks booking eligibility at the top of the transaction. Provide the
    // default lodge row and an unrestricted member so these group-join tests
    // reach the roster logic under test (single-lodge default behaviour).
    h.lodgeFindFirst.mockResolvedValue({ id: "lodge-1" });
    h.memberLodgeAccessFindMany.mockResolvedValue([]);
    h.groupJoinFindUnique.mockResolvedValue(null);
    h.groupJoinCreate.mockResolvedValue({ id: "join-1" });
    h.groupJoinUpdate.mockResolvedValue({ id: "join-1" });
  });

  it("writes the roster row inside the booking transaction", async () => {
    const outcome = await createConfirmedBooking(
      baseInput([guest(true, "Alice")], { groupJoin })
    );

    expect(outcome.type).toBe("created");
    expect(h.groupJoinCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        groupBookingId: "group-1",
        joinerMemberId: "member-1",
        bookingId: "booking-1",
        isMember: true,
      }),
    });
  });

  it("reuses a roster row left by a cancelled join", async () => {
    h.groupJoinFindUnique.mockResolvedValue({
      id: "join-old",
      booking: { status: BookingStatus.CANCELLED, deletedAt: null },
    });

    const outcome = await createConfirmedBooking(
      baseInput([guest(true, "Alice")], { groupJoin })
    );

    expect(outcome.type).toBe("created");
    expect(h.groupJoinUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "join-old" },
        data: expect.objectContaining({ bookingId: "booking-1" }),
      })
    );
    expect(h.groupJoinCreate).not.toHaveBeenCalled();
  });

  it("aborts the transaction when the joiner already has a live join", async () => {
    h.groupJoinFindUnique.mockResolvedValue({
      id: "join-live",
      booking: { status: BookingStatus.CONFIRMED, deletedAt: null },
    });

    await expect(
      createConfirmedBooking(baseInput([guest(true, "Alice")], { groupJoin }))
    ).rejects.toBeInstanceOf(GroupJoinConflictError);

    expect(h.groupJoinCreate).not.toHaveBeenCalled();
    expect(h.groupJoinUpdate).not.toHaveBeenCalled();
  });

  it("takes the serialising advisory lock before any duplicate checks (#1039 item 3)", async () => {
    // The person-night guard and the roster duplicate check are app-level
    // enforcement; they are race-free because every creation transaction first
    // takes the serialising advisory lock. Multi-lodge scopes that lock per
    // lodge via acquireLodgeCapacityLock (replacing the old global
    // pg_advisory_xact_lock(1)); it must still run before any duplicate check.
    await createConfirmedBooking(baseInput([guest(true, "Alice")], { groupJoin }));

    const lockOrder = h.acquireLodgeCapacityLock.mock.invocationCallOrder[0];
    const rosterCheckOrder = h.groupJoinFindUnique.mock.invocationCallOrder[0];
    const bookingCreateOrder = h.bookingCreate.mock.invocationCallOrder[0];
    expect(lockOrder).toBeLessThan(bookingCreateOrder);
    expect(lockOrder).toBeLessThan(rosterCheckOrder);
  });
});

describe("in-transaction duplicate-stay guard (#1587 item 2)", () => {
  const duplicateStayGuard = { excludeBookingId: "entry-1" };

  beforeEach(() => {
    vi.clearAllMocks();
    createdCount = 0;
    h.transaction.mockImplementation(async (fn: (store: typeof tx) => Promise<unknown>) => fn(tx));
    h.executeRaw.mockResolvedValue(undefined);
    h.seasonFindMany.mockResolvedValue(mockSeasons);
    h.checkCapacityForGuestRanges.mockResolvedValue({ available: true, nightDetails: [] });
    h.reconcileBedAllocationsForBooking.mockResolvedValue(undefined);
    h.bookingUpdate.mockResolvedValue({});
    h.memberFindUnique.mockResolvedValue({ id: "member-1", firstName: "Mem", lastName: "Ber", email: "m@example.com" });
    h.lodgeFindFirst.mockResolvedValue({ id: "lodge-1" });
    h.memberLodgeAccessFindMany.mockResolvedValue([]);
    // Default: no overlapping stay found.
    h.bookingFindFirst.mockResolvedValue(null);
    h.bookingCreate.mockImplementation((args: { data: Record<string, unknown> }) => {
      createdCount += 1;
      const id = `booking-${createdCount}`;
      const guestRows = (args.data.guests as { create: Array<Record<string, unknown>> }).create.map(
        (g, i) => ({ ...g, id: `${id}-g${i}` })
      );
      return Promise.resolve({ ...args.data, id, guests: guestRows });
    });
  });

  it("aborts with DuplicateStayConflictError and creates no booking when the guard finds an overlapping stay", async () => {
    // A concurrent confirm committed a stay for the same member/lodge/dates
    // after Phase 1 passed; the guard, running under the held capacity lock,
    // sees it and rolls the transaction back.
    h.bookingFindFirst.mockResolvedValue({ id: "concurrent-booking" });

    await expect(
      createConfirmedBooking(baseInput([guest(true, "Alice")], { duplicateStayGuard }))
    ).rejects.toBeInstanceOf(DuplicateStayConflictError);

    // The whole point: no duplicate booking row is written.
    expect(h.bookingCreate).not.toHaveBeenCalled();
    // The guard ran before the create, under the lock.
    expect(h.acquireLodgeCapacityLock.mock.invocationCallOrder[0]).toBeLessThan(
      h.bookingFindFirst.mock.invocationCallOrder[0]
    );
  });

  it("proceeds normally and scopes the guard query when no overlapping stay exists", async () => {
    const outcome = await createConfirmedBooking(
      baseInput([guest(true, "Alice")], { duplicateStayGuard })
    );

    expect(outcome.type).toBe("created");
    expect(h.bookingCreate).toHaveBeenCalledTimes(1);

    // The guard query is scoped to the member, the resolved lodge, active +
    // completed statuses, an overlapping range, and excludes the named entry.
    const where = h.bookingFindFirst.mock.calls[0][0].where;
    expect(where).toEqual(
      expect.objectContaining({
        memberId: "member-1",
        lodgeId: "lodge-1",
        id: { not: "entry-1" },
        deletedAt: null,
      })
    );
    expect(where.status.in).toEqual(
      expect.arrayContaining([
        BookingStatus.PENDING,
        BookingStatus.PAYMENT_PENDING,
        BookingStatus.CONFIRMED,
        BookingStatus.PAID,
        BookingStatus.AWAITING_REVIEW,
        BookingStatus.COMPLETED,
      ])
    );
    // Waitlist placeholders and terminal statuses never count as a real stay.
    expect(where.status.in).not.toContain(BookingStatus.WAITLISTED);
    expect(where.status.in).not.toContain(BookingStatus.WAITLIST_OFFERED);
    expect(where.status.in).not.toContain(BookingStatus.CANCELLED);
    // Date-only overlap predicate: booking.checkIn < stay.checkOut and
    // booking.checkOut > stay.checkIn.
    expect(where.checkIn.lt).toBeInstanceOf(Date);
    expect(where.checkOut.gt).toBeInstanceOf(Date);
    expect(where.checkIn.lt.getTime()).toBeGreaterThan(where.checkOut.gt.getTime());
  });

  it("does not run the guard for callers that leave duplicateStayGuard unset", async () => {
    // Every existing caller (group-booking, the bookings route) omits the
    // field; the guard query must not run for them.
    const outcome = await createConfirmedBooking(baseInput([guest(true, "Alice")]));

    expect(outcome.type).toBe("created");
    expect(h.bookingFindFirst).not.toHaveBeenCalled();
  });
});

describe("member-night guard excludes the replaced cross-lodge entry (#1628/#1609)", () => {
  const duplicateStayGuard = { excludeBookingId: "entry-1" };
  // The waitlister is a member-guest on her own entry: the guest row that
  // trips the guard when the exclusion is missing.
  const memberGuest: BookingGuestInput = { ...guest(true, "Wanda"), memberId: "member-1" };
  // The entry's own guest row, shaped exactly as the finder's include returns
  // it — a live WAITLIST_OFFERED booking overlapping the requested nights.
  const entryOwnGuestRow = {
    id: "entry-1-g0",
    memberId: "member-1",
    firstName: "Wanda",
    lastName: "Test",
    nights: [{ stayDate: checkIn }],
    member: { firstName: "Wanda", lastName: "Test" },
    booking: {
      id: "entry-1",
      memberId: "member-1",
      status: BookingStatus.WAITLIST_OFFERED,
      checkIn,
      checkOut,
      member: { firstName: "Wanda", lastName: "Test" },
      guests: [{ id: "entry-1-g0", memberId: "member-1" }],
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    createdCount = 0;
    h.transaction.mockImplementation(async (fn: (store: typeof tx) => Promise<unknown>) => fn(tx));
    h.executeRaw.mockResolvedValue(undefined);
    h.seasonFindMany.mockResolvedValue(mockSeasons);
    h.checkCapacityForGuestRanges.mockResolvedValue({ available: true, nightDetails: [] });
    h.reconcileBedAllocationsForBooking.mockResolvedValue(undefined);
    h.bookingUpdate.mockResolvedValue({});
    h.memberFindUnique.mockResolvedValue({ id: "member-1", firstName: "Mem", lastName: "Ber", email: "m@example.com" });
    h.lodgeFindFirst.mockResolvedValue({ id: "lodge-1" });
    h.memberLodgeAccessFindMany.mockResolvedValue([]);
    h.bookingFindFirst.mockResolvedValue(null);
    // Discriminating DB emulation: honour the query's own exclusion. If the
    // member-night finder excludes the replaced entry, its guest row is not
    // returned (as a real database would omit it); if the exclusion is ever
    // dropped, the entry's own row comes back and the guard throws — so this
    // suite fails loudly on regression rather than merely asserting a
    // where-clause shape.
    h.bookingGuestFindMany.mockImplementation(
      (args: { where: { booking: { id?: { not?: string } } } }) =>
        Promise.resolve(args.where.booking.id?.not === "entry-1" ? [] : [entryOwnGuestRow])
    );
    h.bookingCreate.mockImplementation((args: { data: Record<string, unknown> }) => {
      createdCount += 1;
      const id = `booking-${createdCount}`;
      const guestRows = (args.data.guests as { create: Array<Record<string, unknown>> }).create.map(
        (g, i) => ({ ...g, id: `${id}-g${i}` })
      );
      return Promise.resolve({ ...args.data, id, guests: guestRows });
    });
  });

  it("a member-guest cross-lodge confirm succeeds: the guard skips the entry being replaced", async () => {
    const outcome = await createConfirmedBooking(
      baseInput([memberGuest], { duplicateStayGuard })
    );

    expect(outcome.type).toBe("created");
    expect(h.bookingCreate).toHaveBeenCalledTimes(1);
    // Belt and braces: the finder's booking scope carried the exclusion.
    const where = h.bookingGuestFindMany.mock.calls[0][0].where;
    expect(where.booking.id).toEqual({ not: "entry-1" });
  });

  it("still rejects a genuine conflict on a DIFFERENT booking even with the exclusion set", async () => {
    // The exclusion must be surgical — only the replaced entry is ignored. A
    // real overlapping stay elsewhere still blocks the confirm.
    const otherBookingConflict = {
      ...entryOwnGuestRow,
      id: "other-g0",
      booking: { ...entryOwnGuestRow.booking, id: "other-booking", status: BookingStatus.PAID },
    };
    h.bookingGuestFindMany.mockResolvedValue([otherBookingConflict]);

    await expect(
      createConfirmedBooking(baseInput([memberGuest], { duplicateStayGuard }))
    ).rejects.toBeInstanceOf(BookingMemberNightConflictError);
    expect(h.bookingCreate).not.toHaveBeenCalled();
  });

  it("passes no exclusion for callers without duplicateStayGuard", async () => {
    // Ordinary creation paths replace nothing; their member-night scope must
    // stay exactly as before the #1628 fix. (The discriminator mock would
    // throw here by design — this test only pins the query shape.)
    h.bookingGuestFindMany.mockResolvedValue([]);
    const outcome = await createConfirmedBooking(baseInput([memberGuest]));

    expect(outcome.type).toBe("created");
    const where = h.bookingGuestFindMany.mock.calls[0][0].where;
    expect(where.booking.id).toBeUndefined();
  });
});
