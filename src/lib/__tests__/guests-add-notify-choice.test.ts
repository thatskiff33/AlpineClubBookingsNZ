/**
 * Issue #1769b (#1705 semantics): the admin's per-action member-email choice on
 * the dual-actor guest-add route (`POST /api/bookings/[id]/guests`). Absent =
 * notify (default); `false` suppresses the booking-modified email. Only an admin
 * actor may carry the flag — a member self-service caller carrying it is 403'd
 * before any work, and a suppression is recorded in the audit metadata as
 * `notifyMember: false` (the guest-add email always sends when a member exists,
 * so the field is recorded whenever the flag suppresses it).
 *
 * The harness mirrors partial-stay-edit-pricing.test.ts: it keeps the REAL
 * pricing engine and fakes only the database and side-effect leaf modules, so
 * the notify gating is exercised through the actual route end-to-end.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const mockTransaction = vi.fn();
const mockMemberCount = vi.fn();
const mockMemberFindUnique = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: {
    /*
      #3032: the modified email asks whether the club is still working out an
      amount on this booking, through `bookingHasOpenFinancialReview`. That
      reads the GLOBAL client after the transaction commits, which is a
      different read from the fence's in-transaction `findFirst`. Empty by
      default - no review is open - so every pre-#3032 assertion in this file
      means exactly what it meant before.
    */
    manualRefundTask: { findMany: vi.fn().mockResolvedValue([]) },
    $transaction: (...args: unknown[]) => {
      const fn = args[0];
      if (typeof fn === "function") return (mockTransaction as any)(fn);
      return Promise.resolve();
    },
    member: { count: mockMemberCount, findUnique: mockMemberFindUnique },
    // #2364: the hosting review is reconciled inside the booking write, so
    // every prisma/tx double a booking path runs against needs this client.
    adultMemberHostingPolicy: { findMany: vi.fn().mockResolvedValue([]) },
    booking: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
    bookingRequest: { findFirst: vi.fn().mockResolvedValue(null) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    // #1982: the default lodge's capacity is a DB override (self-healed from the
    // config bed total), not a club.json runtime fallback. Model a configured
    // lodge so the route's guest-count-vs-capacity guard resolves normally.
    lodgeSettings: { findUnique: async () => ({ capacity: 100 }) },
  },
}));

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
const mockRequireActiveSessionUser = vi.fn<(...args: unknown[]) => Promise<Response | null>>(async () => null);
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: (...args: Parameters<typeof mockRequireActiveSessionUser>) => mockRequireActiveSessionUser(...args),
}));
vi.mock("@/lib/capacity", () => ({
  checkCapacity: vi.fn(),
  checkCapacityForGuestRanges: vi.fn(),
  getOccupiedBedsForNight: vi.fn().mockReturnValue(0),
  acquireLodgeCapacityLock: vi.fn().mockResolvedValue(undefined),
  LODGE_CAPACITY: 29,
}));
vi.mock("@/lib/cancellation", () => ({
  daysUntilDate: vi.fn().mockReturnValue(30),
  loadCancellationPolicy: vi.fn().mockResolvedValue([]),
  getNonMemberHoldDays: vi.fn().mockResolvedValue(7),
  getNonMemberHoldPolicy: vi.fn().mockResolvedValue({
    enabled: true,
    holdDays: 7,
    source: "default",
  }),
}));
vi.mock("@/lib/promo", () => ({
  validatePromoCodeRules: vi.fn().mockReturnValue(null),
  validateAndCalculatePromoDiscount: vi.fn().mockResolvedValue({
    discount: { discountCents: 0, priceAdjustmentCents: 0, freeNightsUsed: 0, eligibleGuestCount: 0, allocations: [] },
    beneficiaryMemberIds: [],
  }),
  replacePromoRedemptionAllocations: vi.fn(),
  // #2299: the promo path row-locks each PromoCode it may charge or
  // refund before reading or writing any usage cap; the reprice paths also
  // re-read the usage counter under that lock.
  lockPromoCodeRowsForUpdate: vi.fn(),
  lockAndRefreshPromoCodeUsage: vi.fn(
    async (_tx: unknown, promoCode: unknown) => promoCode
  ),
  deletePromoRedemptionAndAdjustCount: vi.fn(),
}));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn(), createAuditLog: vi.fn() }));
vi.mock("@/lib/email", () => ({
  sendBookingModifiedEmail: vi.fn().mockResolvedValue(undefined),
  sendBookingConfirmedEmail: vi.fn().mockResolvedValue(undefined),
  sendAdminPaymentFailureAlert: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/xero-booking-edit-settlement", () => ({
  queueXeroBookingEditSettlement: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/bed-allocation-lifecycle", () => ({
  reconcileBedAllocationsForBookingWithGlobalLockHeld: vi.fn().mockResolvedValue(undefined),
}));

import { auth } from "@/lib/auth";
import { checkCapacity, checkCapacityForGuestRanges } from "@/lib/capacity";
import { logAudit } from "@/lib/audit";
import { sendBookingModifiedEmail } from "@/lib/email";
import {
  fenceHostingPolicyFindMany,
  fenceMemberFindMany,
  hostingMemberRow,
  recordingBookingDouble,
} from "@/lib/__tests__/support/hosting-participant-fence-double";

const mockedAuth = vi.mocked(auth);
const mockedCheckCapacity = vi.mocked(checkCapacity);
const mockedCheckCapacityForGuestRanges = vi.mocked(checkCapacityForGuestRanges);
const mockedLogAudit = vi.mocked(logAudit);
const mockedSendModifiedEmail = vi.mocked(sendBookingModifiedEmail);

function makeMemberSession() {
  return { user: { id: "m1", role: "MEMBER", accessRoles: [{ role: "USER" }], email: "alice@test.com" } };
}

function makeAdminSession() {
  return { user: { id: "admin1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }], email: "admin@test.com" } };
}

const CHECK_IN = new Date("2026-08-01T00:00:00.000Z");
const CHECK_OUT = new Date("2026-08-05T00:00:00.000Z"); // 4 nights: Aug 1-4

/**
 * These scenarios add a guest to a booking that has NOT started — the "future"
 * edit mode this route serves. Left on the real clock the suite quietly changed
 * meaning once the NZ calendar date reached CHECK_IN: getBookingEditPolicy then
 * classifies the same fixture as "in-progress" and the route correctly answers
 * 400 ("Use the full booking edit flow ..."), so the notify-choice assertions
 * never ran. Pin the clock so the scenario under test stays the intended one.
 *
 * Only `Date` is faked — real timers still run, so awaited promises resolve
 * normally.
 */
const FIXED_NOW = new Date("2026-07-15T00:00:00.000Z"); // NZ 2026-07-15 12:00

function night(day: string, priceCents: number) {
  return { stayDate: new Date(`2026-08-0${day}T00:00:00.000Z`), priceCents };
}

function makeBooking(overrides: Record<string, unknown> = {}) {
  return {
    id: "bk1",
    memberId: "m1",
    // Booking.lodgeId is NOT NULL in the schema, so a real row always carries
    // one. Omitting it here let the hosting participant fence compare
    // "bk1:m1:undefined" on both sides and pass vacuously (#2619).
    lodgeId: "lodge-1",
    checkIn: CHECK_IN,
    checkOut: CHECK_OUT,
    status: "PAID",
    totalPriceCents: 20000,
    discountCents: 0,
    finalPriceCents: 20000,
    hasNonMembers: false,
    nonMemberHoldUntil: null,
    requiresAdminReview: false,
    adminReviewStatus: null,
    guests: [
      {
        id: "g1",
        bookingId: "bk1",
        firstName: "Alice",
        lastName: "Smith",
        ageTier: "ADULT",
        isMember: true,
        memberId: "m1",
        // #2675: the hosting evaluator reads the LIVE Member row off this
        // relation, never the `isMember` snapshot beside it. A guest row that
        // claims membership without one is a shape production cannot emit — the
        // review's select always hydrates `member` — and it made
        // `memberIsInGoodStanding` read `undefined.active` the moment an active
        // hosting mode let the evaluator run.
        consentStatus: null,
        member: hostingMemberRow("m1"),
        priceCents: 20000,
        stayStart: CHECK_IN,
        stayEnd: CHECK_OUT,
        nights: [night("1", 5000), night("2", 5000), night("3", 5000), night("4", 5000)],
      },
    ],
    payment: {
      id: "p1",
      bookingId: "bk1",
      amountCents: 20000,
      source: "STRIPE",
      status: "SUCCEEDED",
      stripePaymentIntentId: "pi_original",
      stripeCustomerId: "cus_123",
      xeroInvoiceId: "inv_primary",
      refundedAmountCents: 0,
      changeFeeCents: 0,
      additionalPaymentIntentId: null,
      additionalAmountCents: 0,
      additionalPaymentStatus: null,
    },
    member: { id: "m1", email: "alice@test.com", firstName: "Alice", lastName: "Smith" },
    promoRedemption: null,
    ...overrides,
  };
}

const CURRENT_SEASON = [{
  id: "s1",
  startDate: new Date("2026-04-01T00:00:00.000Z"),
  endDate: new Date("2026-10-31T00:00:00.000Z"),
  // Membership-type-keyed rates (#1930, E4): FULL members 6000, NON_MEMBER 8000.
  membershipTypeRates: [
    { membershipTypeId: "type-full", ageTier: "ADULT", pricePerNightCents: 6000 },
    { membershipTypeId: "type-nonmember", ageTier: "ADULT", pricePerNightCents: 8000 },
  ],
}];

function makeTx(booking: ReturnType<typeof makeBooking>) {
  const fenceBooking = recordingBookingDouble(async () => booking);
  return {
    $executeRawUnsafe: vi.fn().mockResolvedValue(undefined),
    $executeRaw: vi.fn().mockResolvedValue(undefined),
    // #2364: the hosting review is reconciled inside the booking write, so
    // every prisma/tx double a booking path runs against needs this client.
    // #2623 T5 / #2675: an ACTIVE mode, so the gate in front of the participant
    // fence lets this seam reach it. `[]` here resolved to DISABLED and switched
    // the fence off in the one suite that covers the guest-add route.
    adultMemberHostingPolicy: {
      findMany: fenceHostingPolicyFindMany({ mode: "ADMIN_REVIEW_REQUIRED" }),
    },
    // #2619: the participant fence re-reads the locked Member rows and each
    // source booking's owner/lodge under the lock. An empty booking.findMany
    // made it report drift on data that never changed.
    booking: {
      findUnique: fenceBooking.findUnique,
      findMany: fenceBooking.findMany,
      update: vi.fn().mockImplementation(({ data }) =>
        Promise.resolve({ ...booking, ...data, guests: booking.guests, payment: booking.payment })),
    },
    bookingGuest: {
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockImplementation(({ data }) => Promise.resolve({ id: "new-g", ...data })),
      update: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
    },
    groupDiscountSetting: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
    bookingGuestNight: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    bookingModification: { create: vi.fn().mockResolvedValue({ id: "mod1" }) },
    // #3032: the pending-review fence reads this INSIDE the transaction, under
    // both locks and after the post-lock re-read. `null` is "no review is open",
    // so every pre-#3032 assertion in this file means what it always meant; the
    // fence cases below point it at a row instead. Note this is a different read
    // from the modified email's post-commit `manualRefundTask.findMany` on the
    // global client, mocked at the top of the file.
    manualRefundTask: { findFirst: vi.fn().mockResolvedValue(null) },
    bookingRequest: { findFirst: vi.fn().mockResolvedValue(null) },
    payment: { update: vi.fn().mockResolvedValue({}) },
    season: { findMany: vi.fn().mockResolvedValue(CURRENT_SEASON) },
    lodge: { findFirst: vi.fn().mockResolvedValue({ id: "lodge-1" }) },
    lodgeSettings: { findUnique: async () => ({ capacity: 100 }) },
    promoRedemption: { update: vi.fn().mockResolvedValue({}) },
    choreAssignment: {
      findMany: vi.fn().mockResolvedValue([]),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    // Rate resolver (#1930, E4): member guests (with a memberId) resolve to the
    // FULL type (role default) -> member rate; the built-in NON_MEMBER type
    // backs true non-members.
    member: {
      // #2619: the participant fence's id-only re-read is answered by the
      // helper (which sorts, as the fence requires); every other member read —
      // the rate resolver's — keeps the rows it always served. Merged into this
      // one delegate deliberately: a second `member:` key in this literal would
      // be silently overridden by whichever came last.
      findMany: fenceMemberFindMany([], async (args: unknown) =>
        ((args as { where?: { id?: { in?: string[] } } })?.where?.id?.in ?? []).map((id) => ({
          id,
          firstName: "Member",
          lastName: "Test",
          email: `${id}@test.com`,
          role: "MEMBER",
          ageTier: "ADULT",
        })),
      ),
      findUnique: vi.fn().mockResolvedValue(null),
      count: vi.fn().mockResolvedValue(1),
    },
    seasonalMembershipAssignment: { findMany: vi.fn().mockResolvedValue([]) },
    membershipType: {
      findMany: vi.fn().mockResolvedValue([
        { id: "type-full", key: "FULL", bookingBehavior: "MEMBER_RATE", subscriptionBehavior: "REQUIRED", name: "Full", isActive: true, isBuiltIn: true },
        { id: "type-nonmember", key: "NON_MEMBER", bookingBehavior: "NON_MEMBER_RATE", subscriptionBehavior: "NOT_REQUIRED", name: "Non-Member", isActive: true, isBuiltIn: true },
      ]),
    },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  };
}

function guestsRequest(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/bookings/bk1/guests", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

const params = { params: Promise.resolve({ id: "bk1" }) };
const NON_MEMBER_GUEST = { firstName: "Bob", lastName: "Jones", ageTier: "ADULT", isMember: false };

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(FIXED_NOW);
  mockMemberCount.mockResolvedValue(1);
  mockMemberFindUnique.mockResolvedValue({
    id: "m1",
    active: true,
    email: "alice@test.com",
    firstName: "Alice",
  } as any);
  mockedAuth.mockResolvedValue(makeMemberSession() as any);
  mockedCheckCapacity.mockResolvedValue({ available: true, availableBeds: 20 } as any);
  mockedCheckCapacityForGuestRanges.mockResolvedValue({ available: true, minAvailable: 20, nightDetails: [] } as any);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("POST /api/bookings/[id]/guests notify choice (#1769b)", () => {
  it("emails the member and records no notify field on a member self-add without the flag", async () => {
    const booking = makeBooking();
    const tx = makeTx(booking);
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    const { POST } = await import("@/app/api/bookings/[id]/guests/route");

    const res = await POST(guestsRequest({ guests: [NON_MEMBER_GUEST] }), params);

    expect(res.status).toBe(200);
    expect(mockedSendModifiedEmail).toHaveBeenCalledTimes(1);
    const metadata = mockedLogAudit.mock.calls[0][0].metadata as Record<string, unknown>;
    expect(metadata).not.toHaveProperty("notifyMember");
  });

  it("suppresses the email and records notifyMember:false for an admin add with notifyMember:false", async () => {
    mockedAuth.mockResolvedValue(makeAdminSession() as any);
    const booking = makeBooking();
    const tx = makeTx(booking);
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    const { POST } = await import("@/app/api/bookings/[id]/guests/route");

    const res = await POST(
      guestsRequest({ guests: [NON_MEMBER_GUEST], notifyMember: false }),
      params,
    );

    expect(res.status).toBe(200);
    expect(mockedSendModifiedEmail).not.toHaveBeenCalled();
    const metadata = mockedLogAudit.mock.calls[0][0].metadata as Record<string, unknown>;
    expect(metadata).toMatchObject({ notifyMember: false });
  });

  it("emails and records no notify field for an admin add with notifyMember:true", async () => {
    mockedAuth.mockResolvedValue(makeAdminSession() as any);
    const booking = makeBooking();
    const tx = makeTx(booking);
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    const { POST } = await import("@/app/api/bookings/[id]/guests/route");

    const res = await POST(
      guestsRequest({ guests: [NON_MEMBER_GUEST], notifyMember: true }),
      params,
    );

    expect(res.status).toBe(200);
    expect(mockedSendModifiedEmail).toHaveBeenCalledTimes(1);
    const metadata = mockedLogAudit.mock.calls[0][0].metadata as Record<string, unknown>;
    expect(metadata).not.toHaveProperty("notifyMember");
  });

  it("rejects a non-boolean notifyMember with 400 and runs no transaction, email, or audit", async () => {
    mockedAuth.mockResolvedValue(makeAdminSession() as any);
    const { POST } = await import("@/app/api/bookings/[id]/guests/route");

    const res = await POST(
      guestsRequest({ guests: [NON_MEMBER_GUEST], notifyMember: "false" }),
      params,
    );

    expect(res.status).toBe(400);
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockedSendModifiedEmail).not.toHaveBeenCalled();
    expect(mockedLogAudit).not.toHaveBeenCalled();
  });

  it("rejects a non-admin actor carrying notifyMember with 403 before any work", async () => {
    // Member session (default): a self-service caller may not suppress their own
    // booking-modified email.
    const { POST } = await import("@/app/api/bookings/[id]/guests/route");

    const res = await POST(
      guestsRequest({ guests: [NON_MEMBER_GUEST], notifyMember: false }),
      params,
    );

    expect(res.status).toBe(403);
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockedSendModifiedEmail).not.toHaveBeenCalled();
    expect(mockedLogAudit).not.toHaveBeenCalled();
  });
});

describe("POST /api/bookings/[id]/guests is fenced while the money is under review (#3032)", () => {
  /**
   * THE FOURTH MONEY-AFFECTING DOOR. `assertNoPendingEditFinancialReview` was
   * called from three services and not from here, and this route is the one that
   * absorbs the damage silently rather than showing it.
   *
   * It reprices every existing guest, so an unreadable strand - which carries no
   * locked night prices - is revalued at today's rate (the #3031 defect); it
   * computes `priceDiffCents` against a `finalPriceCents` that is under review,
   * charges only on a positive delta, and then WRITES the new `finalPriceCents`.
   * The overstatement the review exists to hold is absorbed into the stored
   * figure, and the admin who later completes the review credits the member
   * against a total that has already had it taken out: the same money leaves
   * twice.
   *
   * Driven through the REAL route and the REAL fence - the only thing arranged is
   * the row the fence reads.
   */
  it("refuses with the fence's own machine code, and writes nothing", async () => {
    const booking = makeBooking();
    const tx = makeTx(booking);
    tx.manualRefundTask.findFirst.mockResolvedValue({
      id: "task-open",
      occurrenceKey: "occ-1",
      amountCents: null,
      raisedAmountCents: null,
      reviewContext: null,
    });
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    const { POST } = await import("@/app/api/bookings/[id]/guests/route");

    const res = await POST(guestsRequest({ guests: [NON_MEMBER_GUEST] }), params);

    expect(res.status).toBe(409);
    // The CODE, not merely the status. `EditFinancialReviewPendingError` extends
    // the shared `ApiError`, so a handler answering it through the generic branch
    // would return the right status and sentence with no `code` at all, and the
    // surface that can explain the wait would show a bare error.
    expect((await res.json()).code).toBe("EDIT_FINANCIAL_REVIEW_PENDING");

    // Refused BEFORE any write: no guest row, no night rows, no new stored
    // total, no modification row, and no email.
    expect(tx.bookingGuest.create).not.toHaveBeenCalled();
    expect(tx.bookingGuestNight.createMany).not.toHaveBeenCalled();
    expect(tx.booking.update).not.toHaveBeenCalled();
    expect(tx.bookingModification.create).not.toHaveBeenCalled();
    expect(mockedSendModifiedEmail).not.toHaveBeenCalled();
  });

  it("still adds a guest when no review is open at all", async () => {
    // THE CONTROL, and its empty result is stated here rather than inherited:
    // `vi.clearAllMocks()` keeps implementations, so a control that said nothing
    // about this read could silently run against the previous case's OPEN row and
    // invert.
    const booking = makeBooking();
    const tx = makeTx(booking);
    tx.manualRefundTask.findFirst.mockResolvedValue(null);
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    const { POST } = await import("@/app/api/bookings/[id]/guests/route");

    const res = await POST(guestsRequest({ guests: [NON_MEMBER_GUEST] }), params);

    expect(res.status).toBe(200);
    expect(tx.manualRefundTask.findFirst).toHaveBeenCalled();
    expect(tx.bookingGuest.create).toHaveBeenCalled();
    expect(tx.booking.update).toHaveBeenCalled();
  });

  it("answers a stranger with 403 rather than telling them a review is open", async () => {
    // The fence sits BELOW the authorisation check on purpose: a 409 here would
    // tell somebody with no business on this booking that the club is reviewing
    // its money, and would be the wrong answer besides.
    mockedAuth.mockResolvedValue({
      user: {
        id: "m-nobody",
        role: "MEMBER",
        accessRoles: [{ role: "USER" }],
        email: "nobody@test.com",
      },
    } as any);
    const booking = makeBooking();
    const tx = makeTx(booking);
    tx.manualRefundTask.findFirst.mockResolvedValue({
      id: "task-open",
      occurrenceKey: "occ-1",
      amountCents: null,
      raisedAmountCents: null,
      reviewContext: null,
    });
    mockTransaction.mockImplementation((fn: any) => fn(tx));
    const { POST } = await import("@/app/api/bookings/[id]/guests/route");

    const res = await POST(guestsRequest({ guests: [NON_MEMBER_GUEST] }), params);

    expect(res.status).toBe(403);
    expect(tx.manualRefundTask.findFirst).not.toHaveBeenCalled();
  });
});

/**
 * #3166 (epic #2797): the guest-add route is the fourth edit door.
 *
 * It never rewrites an existing strand's night rows, so it is not the
 * write-back mechanism the epic is mostly about. What it does is recompute
 * `Booking.totalPriceCents` from a FULL-PARTY pass in which every existing
 * strand is priced through the LENIENT reader — so a night whose stored price is
 * blank prices at today's rate, lands in the new total, and the difference is
 * billed to the member as an additional amount for a night nobody added.
 *
 * #3170 is what makes a blank storable, so this became reachable in the same
 * release.
 */
describe("#3166 adding a guest to a booking whose history cannot be read", () => {
  /**
   * The strand from the finding: four nights, three priced and one BLANK — the
   * shape a parked edit leaves behind under #3170. Its stored total is the sum
   * of what IS known, so the only thing wrong with the booking is that one night
   * has no price.
   */
  function bookingWithABlankNight() {
    const booking = makeBooking();
    (booking.guests as Array<Record<string, unknown>>)[0].nights = [
      night("1", 5000),
      night("2", 5000),
      { stayDate: new Date("2026-08-03T00:00:00.000Z"), priceCents: null },
      night("4", 5000),
    ];
    return booking;
  }

  function txWithReviewWriter(booking: ReturnType<typeof makeBooking>) {
    const tx = makeTx(booking);
    // `raiseEditFinancialReviewTask` is a find-then-create. Without both the
    // park throws inside the transaction and surfaces as an opaque 500, which
    // reads exactly like a refusal.
    tx.manualRefundTask = {
      ...tx.manualRefundTask,
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: "task-1" }),
    } as never;
    return tx;
  }

  it("adds the guest, leaves the booking's money alone, and raises one review task", async () => {
    const tx = txWithReviewWriter(bookingWithABlankNight());
    mockTransaction.mockImplementation((fn: (t: typeof tx) => unknown) => fn(tx));

    const res = await (
      await import("@/app/api/bookings/[id]/guests/route")
    ).POST(guestsRequest({ guests: [NON_MEMBER_GUEST] }), params);
    expect(res.status).toBe(200);

    // The guest was created — parking withholds money, never the structural
    // change.
    expect(tx.bookingGuest.create).toHaveBeenCalledTimes(1);

    // And the booking's own stored figures are written back untouched: the
    // blank night is NOT valued at today's 8000 and folded into the total.
    expect(tx.booking.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          totalPriceCents: 20000,
          finalPriceCents: 20000,
        }),
      }),
    );
    const body = await res.json();
    expect(body.priceDiffCents).toBe(0);
    expect(body.additionalAmountCents).toBe(0);

    // One OPEN task, carrying no amount.
    const create = (tx.manualRefundTask as unknown as { create: ReturnType<typeof vi.fn> })
      .create;
    expect(create).toHaveBeenCalledTimes(1);
    const raised = create.mock.calls[0][0] as {
      data: { raisedAmountCents: number | null; kind: string };
    };
    expect(raised.data.kind).toBe("EDIT_FINANCIAL_REVIEW");
    expect(raised.data.raisedAmountCents).toBeNull();
  });

  it("tells the officer that guests were added and charged nothing (#3166)", async () => {
    // The occurrence on this task describes the EXISTING unreadable guest, who
    // gave back no nights and gained none. Everything the officer needs to know
    // about the money that actually moved — a guest added at the real
    // non-member rate, against a booking total written back unchanged — would
    // otherwise be nowhere on their screen.
    const tx = txWithReviewWriter(bookingWithABlankNight());
    mockTransaction.mockImplementation((fn: (t: typeof tx) => unknown) => fn(tx));

    await (
      await import("@/app/api/bookings/[id]/guests/route")
    ).POST(guestsRequest({ guests: [NON_MEMBER_GUEST] }), params);

    const create = (tx.manualRefundTask as unknown as { create: ReturnType<typeof vi.fn> })
      .create;
    const context = (
      create.mock.calls[0][0] as {
        data: { reviewContext: { guestsAddedByEdit: unknown } };
      }
    ).data.reviewContext;
    // Four nights at 8000, the figure the CONTROL above proves is what a
    // readable booking would have billed.
    expect(context.guestsAddedByEdit).toEqual({
      count: 1,
      totalPriceCents: 32000,
    });
  });

  it("CONTROL: the identical add on a fully readable booking still bills the new guest", async () => {
    // Without this the case above would pass against a gate that parked EVERY
    // guest add, which would stop the club charging for anybody.
    const tx = txWithReviewWriter(makeBooking());
    mockTransaction.mockImplementation((fn: (t: typeof tx) => unknown) => fn(tx));

    const res = await (
      await import("@/app/api/bookings/[id]/guests/route")
    ).POST(guestsRequest({ guests: [NON_MEMBER_GUEST] }), params);
    expect(res.status).toBe(200);

    const body = await res.json();
    // Four nights at the 8000 non-member rate for the guest actually added.
    expect(body.priceDiffCents).toBe(32000);
    const create = (tx.manualRefundTask as unknown as { create: ReturnType<typeof vi.fn> })
      .create;
    expect(create).not.toHaveBeenCalled();
  });
});
