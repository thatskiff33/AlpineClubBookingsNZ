// "+ Add Member Guest" (epic #2305) MG2 (#2307) — THE CONSENT REMOVAL AUTHORITY.
//
// `removeBookingGuestInTransaction` admits the booking owner, an `ADMIN`, or the
// guest themselves. Two of the three consent removals are none of those: a
// DELEGATE answering for a target who cannot log in (owner decisions D-5/D-10) is
// a fourth party, and the EXPIRY SWEEP has no actor at all. `consentAuthority` is
// the narrow grant that lets exactly those two reach this function — which makes
// it the most security-sensitive thing MG2 adds, because a grant that widened by
// one field would let one member take another off a stranger's booking.
//
// SO EVERY BOUNDARY OF IT IS ASSERTED SEPARATELY, against the REAL removal
// service rather than a stand-in:
//
//   * it authorizes exactly the one guest id it names, and no other;
//   * it applies only once the row ALREADY carries the terminal consent status the
//     caller claims, which is what binds it to the status-guarded claim earlier in
//     the same transaction — so it cannot remove a live PENDING or CONFIRMED row;
//   * it applies only when the row's `memberId` is the target it names;
//   * it grants nothing on any pre-existing path;
//   * and it routes to the SELF-REMOVAL gate set rather than the owner gate set,
//     which is what makes owner decision D-14 hold to the letter.
//
// The last one is asserted DIFFERENTIALLY, on one fixture, because that is the
// only way to show a routing decision rather than a coincidence: a DRAFT booking
// is self-removable but is NOT in the owner path's narrower status list, so the
// same guest on the same booking is refused for an owner and released for the
// sweep.
//
// The harness keeps the REAL pricing, settlement and lifecycle machinery and fakes
// only the database and the leaf side-effect modules — the same arrangement
// `partial-stay-edit-pricing.test.ts` uses, which is also where the pre-existing
// owner/admin removal behaviour is pinned end-to-end (its "#1093" cases). This
// file deliberately does not repeat that money math; it tests the gate.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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
  calculateDualRefundAmounts: vi.fn((basisAmountCents: number) => ({
    cardRefundAmountCents: basisAmountCents,
    cardRefundPercentage: 100,
    creditRefundAmountCents: basisAmountCents,
    creditRefundPercentage: 100,
  })),
}));
vi.mock("@/lib/promo", () => ({
  validatePromoCodeRules: vi.fn().mockReturnValue(null),
  validateAndCalculatePromoDiscount: vi.fn().mockResolvedValue({
    discount: {
      discountCents: 0,
      priceAdjustmentCents: 0,
      freeNightsUsed: 0,
      eligibleGuestCount: 0,
      allocations: [],
    },
    beneficiaryMemberIds: [],
  }),
  calculatePromoDiscountForGuestRates: vi.fn().mockReturnValue({
    discountCents: 0,
    priceAdjustmentCents: 0,
    freeNightsUsed: 0,
    eligibleGuestCount: 0,
    allocations: [],
  }),
  shouldPersistPromoRedemption: vi.fn().mockReturnValue(true),
  redeemPromoCode: vi.fn(),
  replacePromoRedemptionAllocations: vi.fn(),
  deletePromoRedemptionAndAdjustCount: vi.fn(),
  getMemberFreeNightsUsed: vi.fn().mockResolvedValue(0),
}));
vi.mock("@/lib/stripe", () => ({
  processRefund: vi.fn().mockResolvedValue({ id: "re_1" }),
  createPaymentIntent: vi.fn().mockResolvedValue({ id: "pi_1", client_secret: "secret" }),
  findOrCreateCustomer: vi.fn().mockResolvedValue({ id: "cus_1" }),
  getPaymentIntent: vi.fn(),
  constructWebhookEvent: vi.fn(),
  listRefundsForCharge: vi.fn().mockResolvedValue([]),
  cancelPaymentIntentIfCancellable: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/payment-transactions", () => ({
  upsertPaymentIntentTransaction: vi.fn().mockResolvedValue({}),
  refundPaymentTransactions: vi.fn().mockResolvedValue({ refunds: [] }),
  findPaymentTransactionByIntentId: vi.fn().mockResolvedValue(null),
  markPaymentIntentTransactionSucceeded: vi.fn().mockResolvedValue({}),
  markPaymentIntentTransactionFailed: vi.fn().mockResolvedValue({}),
  syncRefundsFromStripeCharge: vi.fn(),
}));
vi.mock("@/lib/payment-recovery", () => ({
  enqueueAdditionalPaymentIntentRecovery: vi.fn().mockResolvedValue({ id: "rec_1" }),
  completeCanceledSupersededPaymentIntentRecovery: vi.fn().mockResolvedValue(undefined),
  queueSupersededPaymentIntentRefundRecovery: vi.fn().mockResolvedValue(undefined),
  queueRefundRecoveryOperation: vi.fn().mockResolvedValue(undefined),
  getStripePaymentMethodId: vi.fn().mockReturnValue(null),
}));
vi.mock("@/lib/booking-payment-cleanup", () => ({
  queueSupersededAdditionalIntentCancellations: vi.fn().mockResolvedValue([]),
  queueSupersededPrimaryIntentCancellations: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/bed-allocation-lifecycle", () => ({
  reconcileBedAllocationsForBookingWithLodgeLockHeld: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/member-credit", () => ({
  createBookingModificationCredit: vi.fn().mockResolvedValue({ id: "credit-1" }),
}));
vi.mock("@/lib/xero", () => ({
  createXeroSupplementaryInvoice: vi.fn().mockResolvedValue(undefined),
  createXeroCreditNoteForModification: vi.fn().mockResolvedValue(undefined),
  isXeroConnected: vi.fn().mockResolvedValue(false),
  createXeroInvoiceForBooking: vi.fn().mockResolvedValue(undefined),
  createXeroCreditNote: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: { findUnique: vi.fn().mockResolvedValue(null) },
    member: { count: vi.fn().mockResolvedValue(1), findUnique: vi.fn().mockResolvedValue(null) },
    lodgeSettings: { findUnique: async () => ({ capacity: 100 }) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  },
}));

import { BookingStatus } from "@prisma/client";

import {
  BookingGuestRemovalError,
  removeBookingGuestInTransaction,
} from "@/lib/booking-guest-removal-service";
import { SELF_REMOVABLE_GUEST_BOOKING_STATUSES } from "@/lib/booking-guest-self-removal";

/**
 * #3123 — the club's day now arrives at these lock-bound entry points as a
 * REQUIRED argument, resolved by the caller outside its transaction
 * (`INV-LOCK-004`). This is the same day the frozen clock's default instant
 * produced before the migration, so every assertion below is unchanged.
 */
const CLUB_TODAY_DATE_ONLY = new Date("2026-07-01T00:00:00.000Z");
import {
  fenceHostingPolicyFindMany,
  fenceMemberFindMany,
  hostingMemberRow,
  recordingBookingDouble,
} from "@/lib/__tests__/support/hosting-participant-fence-double";

const BOOKING = "bk-1";
const OWNER = "m-owner";
const TARGET = "m-target";
const COMPANION = "m-companion";
const DELEGATE = "m-delegate";
const ADMIN = "m-admin";
const TARGET_GUEST = "g-target";
const COMPANION_GUEST = "g-companion";

/**
 * THE CLOCK IS PINNED, and it has to be.
 *
 * The self-removal gate this file exists to test asks whether check-in is still
 * in the future, and it asks the REAL wall clock — `removeBookingGuestInTransaction`
 * takes no injectable date, so there is nothing to thread one through. A fixture
 * check-in that is merely "well in the future" is therefore a dated assertion: on
 * 2 November 2026 the stay stops being future, `STAY_NOT_FUTURE` starts firing,
 * and eight tests in this file go red on that one morning for reasons that have
 * nothing to do with the code they cover. Finding H4 caught exactly this shape
 * eight days out; this is the same remedy applied to the one suite that reaches
 * the gate through the real clock rather than through a threaded date.
 *
 * Mid-October: after the request went out (1 Oct) and before the deadline
 * (1 Nov) and the stay (2 Nov), which is the situation the fixture describes.
 */
const PINNED_NOW = new Date("2026-10-15T00:00:00.000Z");
beforeAll(() => {
  vi.setSystemTime(PINNED_NOW);
});
afterAll(() => {
  vi.useRealTimers();
});

// Well in the future OF THE PINNED CLOCK, so the self-removal future check
// passes and the stay is nowhere near a rate boundary.
const CHECK_IN = new Date("2026-11-02T00:00:00.000Z");
const CHECK_OUT = new Date("2026-11-04T00:00:00.000Z"); // 2 nights

const SEASONS = [
  {
    id: "s1",
    startDate: new Date("2026-04-01T00:00:00.000Z"),
    endDate: new Date("2027-03-31T00:00:00.000Z"),
    membershipTypeRates: [
      { membershipTypeId: "type-full", ageTier: "ADULT", pricePerNightCents: 6000 },
      { membershipTypeId: "type-nonmember", ageTier: "ADULT", pricePerNightCents: 8000 },
    ],
  },
];

function night(day: string, priceCents: number) {
  return { stayDate: new Date(`2026-11-0${day}T00:00:00.000Z`), priceCents };
}

type ConsentStatus = "PENDING" | "CONFIRMED" | "DECLINED" | "EXPIRED" | null;

function guestRow(
  id: string,
  memberId: string,
  consentStatus: ConsentStatus,
  firstName: string,
) {
  return {
    id,
    bookingId: BOOKING,
    firstName,
    lastName: "Person",
    ageTier: "ADULT",
    isMember: true,
    memberId,
    priceCents: 12000,
    stayStart: CHECK_IN,
    stayEnd: CHECK_OUT,
    nights: [night("2", 6000), night("3", 6000)],
    /*
      #2675: the LIVE Member relation, which is what the hosting evaluator reads
      — never the `isMember` snapshot above. Every row this builder makes is a
      member guest, so every one carries a member row.

      It matters that this is not merely tidiness. `memberIsInGoodStanding` tests
      `member !== null`, and `undefined !== null` is TRUE, so a MISSING key does
      not read as "not a member": the predicate goes on to read
      `undefined.active` and throws a TypeError. That never showed while the tx
      double below answered `[]` for the hosting policy, because the evaluator
      builds no participants at all unless the mode is active.

      ADULT and in good standing, which is the shape that leaves this suite's
      assertions exactly as they were: the party is then all members, nobody is a
      non-member guest, and no hosting hazard exists to record on the bookings
      these removals reprice. Note the CONSENT status beside it is independent —
      `participantQualifiesAsHost` refuses a member whose invite is not
      operationally present (D-12), so the EXPIRED/PENDING/DECLINED target
      deliberately does NOT count as a host, while the consent-free companion
      does.
    */
    member: hostingMemberRow(memberId),
    consentStatus,
    consentRequestedAt: consentStatus === null ? null : new Date("2026-10-01T00:00:00.000Z"),
    consentRespondedAt: null,
    consentRespondedByMemberId: null,
    consentExpiresAt: consentStatus === null ? null : new Date("2026-11-01T11:00:00.000Z"),
  };
}

/**
 * A booking with the consent target and one companion, so a removal is never the
 * last guest. `targetConsent` is what the status-guarded claim would already have
 * written by the time the authority is used.
 */
function makeBooking(options: {
  status?: string;
  targetConsent?: ConsentStatus;
  targetMemberId?: string;
  extraGuests?: ReturnType<typeof guestRow>[];
} = {}) {
  const guests = [
    guestRow(TARGET_GUEST, options.targetMemberId ?? TARGET, options.targetConsent ?? "EXPIRED", "Tania"),
    guestRow(COMPANION_GUEST, COMPANION, null, "Cass"),
    ...(options.extraGuests ?? []),
  ];
  return {
    id: BOOKING,
    memberId: OWNER,
    lodgeId: "lodge-1",
    checkIn: CHECK_IN,
    checkOut: CHECK_OUT,
    status: options.status ?? BookingStatus.CONFIRMED,
    totalPriceCents: 24000,
    discountCents: 0,
    promoAdjustmentCents: 0,
    finalPriceCents: 24000,
    hasNonMembers: false,
    nonMemberHoldUntil: null,
    requiresAdminReview: false,
    adminReviewStatus: null,
    adminReviewReason: null,
    memberReviewJustification: null,
    adminReviewNotes: null,
    adminReviewedById: null,
    adminReviewedAt: null,
    guests,
    // No captured payment: a settled booking would need a refund-vs-credit
    // election, which is its own D-14 trap and is covered in
    // member-guest-consent-service.test.ts.
    payment: null,
    member: { id: OWNER, email: "owner@example.com", firstName: "Ophelia", lastName: "Owner" },
    promoRedemption: null,
  };
}

function makeTx(
  booking: ReturnType<typeof makeBooking>,
  // Overrides the booking this tx serves. Pass it here rather than re-stubbing
  // tx.booking.findUnique: that would replace the recording wrapper below and
  // the participant fence would then see no source booking at all.
  bookingOverride?: Partial<ReturnType<typeof makeBooking>>,
) {
  // #2619: the hosting participant fence locks this booking's owner/actor Member
  // rows FOR KEY SHARE NOWAIT and then re-reads, under that lock, both those
  // members and the source booking's own owner and lodge. Replay what this tx's
  // own findUnique served, so the no-drift case matches by construction — an
  // empty booking.findMany made the fence report drift on data nothing touched.
  const fenceBooking = recordingBookingDouble(async () => ({
    ...booking,
    ...bookingOverride,
  }));
  /** Per-tx, so ids do not carry across the suite's fixtures. */
  let raiseCount = 0;
  return {
    $executeRaw: vi.fn().mockResolvedValue(undefined),
    $executeRawUnsafe: vi.fn().mockResolvedValue(undefined),
    // #2364: the hosting review is reconciled inside the booking write, so
    // every prisma/tx double a booking path runs against needs this client.
    // #2623 T5 / #2675: an ACTIVE mode. `[]` resolves to DISABLED, and the mode
    // gate that now stands in front of the participant fence would take its
    // early return — switching the #2619 fence off in the seven removals this
    // file actually completes, while the fence doubles beside it still looked
    // like coverage.
    //
    // ADMIN_REVIEW_REQUIRED rather than the helper's ENFORCED default: under
    // ENFORCED a hosting violation THROWS out of the reconciler and would roll
    // the removal back, turning a success case in this file into a refusal for a
    // reason that has nothing to do with the consent authority under test. Under
    // review-only the worst a violation could do is record a review. (These
    // fixtures raise none either way — every guest is a member in good standing,
    // so nobody on them needs hosting.)
    adultMemberHostingPolicy: {
      findMany: fenceHostingPolicyFindMany({ mode: "ADMIN_REVIEW_REQUIRED" }),
    },
    booking: {
      findUnique: fenceBooking.findUnique,
      findMany: fenceBooking.findMany,
      update: vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ ...booking, ...data, guests: booking.guests, payment: booking.payment }),
      ),
    },
    bookingGuest: {
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
    },
    bookingGuestNight: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    // #3032: the pending-review fence reads this under the booking-edit locks.
    // Empty by default - no financial review is open - so every pre-#3032 test
    // asserts exactly what it asserted before.
    // #3032: `findUnique` and `create` are the raise's find-then-create pair.
    // `findUnique` resolving null means "this occurrence is not on file", so a
    // parked removal takes the create branch; a test that wants a REPLAY points
    // it at an existing row instead.
    manualRefundTask: {
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn().mockResolvedValue(null),
      // A DISTINCT id per raise, so a suite asserting `financialReviewTaskIds`
      // is asserting which tasks came back rather than one id repeated. A
      // parked removal raises one task per parked strand, and the departing
      // strand is always one of them (#3032), so more than one raise is the
      // ordinary shape here rather than the exception.
      create: vi.fn().mockImplementation(() => {
        raiseCount += 1;
        return Promise.resolve({
          id: raiseCount === 1 ? "task-raised" : `task-raised-${raiseCount}`,
          status: "OPEN",
        });
      }),
    },
    bookingModification: { create: vi.fn().mockResolvedValue({ id: "mod-1" }) },
    // Not a quote-priced booking: no booking request holds or converted to it.
    bookingRequest: { findFirst: vi.fn().mockResolvedValue(null) },
    payment: { update: vi.fn().mockResolvedValue({}) },
    season: { findMany: vi.fn().mockResolvedValue(SEASONS) },
    lodge: { findFirst: vi.fn().mockResolvedValue({ id: "lodge-1" }) },
    lodgeSettings: { findUnique: async () => ({ capacity: 100 }) },
    groupDiscountSetting: { findUnique: vi.fn().mockResolvedValue(null) },
    promoRedemption: { update: vi.fn().mockResolvedValue({}) },
    choreAssignment: {
      findMany: vi.fn().mockResolvedValue([]),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    member: {
      // #2619: the fence's own re-read asks for ids alone and requires every
      // locked participant back in sorted order; every other member.findMany on
      // this path keeps the notification rows it has always served.
      findMany: fenceMemberFindMany([], async (args: unknown) => {
        const { where } = (args ?? {}) as { where?: { id?: { in?: string[] } } };
        return (where?.id?.in ?? []).map((id) => ({
          id,
          firstName: "Member",
          lastName: "Test",
          email: `${id}@example.com`,
          role: "MEMBER",
          ageTier: "ADULT",
        }));
      }),
      findUnique: vi.fn().mockResolvedValue(null),
      count: vi.fn().mockResolvedValue(1),
    },
    seasonalMembershipAssignment: { findMany: vi.fn().mockResolvedValue([]) },
    membershipType: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: "type-full",
          key: "FULL",
          bookingBehavior: "MEMBER_RATE",
          subscriptionBehavior: "REQUIRED",
          name: "Full",
          isActive: true,
          isBuiltIn: true,
        },
        {
          id: "type-nonmember",
          key: "NON_MEMBER",
          bookingBehavior: "NON_MEMBER_RATE",
          subscriptionBehavior: "NOT_REQUIRED",
          name: "Non-Member",
          isActive: true,
          isBuiltIn: true,
        },
      ]),
    },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  };
}

/** The authority the consent service builds for a decline or a lapse. */
function authority(
  kind: "CONSENT_DECLINE" | "CONSENT_EXPIRY",
  overrides: { guestId?: string; targetMemberId?: string } = {},
) {
  return {
    kind,
    guestId: overrides.guestId ?? TARGET_GUEST,
    targetMemberId: overrides.targetMemberId ?? TARGET,
  };
}

async function remove(
  tx: ReturnType<typeof makeTx>,
  params: {
    guestId: string;
    actorMemberId: string;
    actorRole?: string;
    consentAuthority?: ReturnType<typeof authority>;
    settlementMethod?: "card" | "credit";
  },
) {
  return removeBookingGuestInTransaction({
    today: CLUB_TODAY_DATE_ONLY,
    tx: tx as never,
    bookingId: BOOKING,
    guestId: params.guestId,
    actorMemberId: params.actorMemberId,
    actorRole: params.actorRole ?? "MEMBER",
    ...(params.settlementMethod ? { settlementMethod: params.settlementMethod } : {}),
    ...(params.consentAuthority ? { consentAuthority: params.consentAuthority } : {}),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("consentAuthority authorizes exactly one guest row", () => {
  it("lets the sweep remove the guest whose consent lapsed", async () => {
    // The baseline the refusals below are refusals FROM. The sweep has no actor, so
    // it passes the booking owner (the party whose booking is repriced and who
    // receives the credit) and the authority is what admits it at all.
    const booking = makeBooking({ targetConsent: "EXPIRED" });
    const tx = makeTx(booking);

    const result = await remove(tx, {
      guestId: TARGET_GUEST,
      actorMemberId: OWNER,
      consentAuthority: authority("CONSENT_EXPIRY"),
    });

    expect(tx.bookingGuest.delete).toHaveBeenCalledWith({ where: { id: TARGET_GUEST } });
    expect(result.removedGuest.id).toBe(TARGET_GUEST);
    // The booking is repriced down to the one remaining guest, so the bed is
    // genuinely released rather than merely unlinked.
    expect(result.oldGuestCount).toBe(2);
    expect(result.priceDiffCents).toBeLessThan(0);
  });

  it("refuses to remove a DIFFERENT guest than the one it names", async () => {
    // The IDOR shape that matters most: hold a valid authority for your own lapsed
    // row and aim it at somebody else's place on the same booking. The authority is
    // checked against the POST-LOCK re-read, so nothing the caller says about the
    // guest id can widen it.
    const booking = makeBooking({ targetConsent: "EXPIRED" });
    const tx = makeTx(booking);

    await expect(
      remove(tx, {
        guestId: COMPANION_GUEST,
        actorMemberId: DELEGATE,
        consentAuthority: authority("CONSENT_EXPIRY", { guestId: TARGET_GUEST }),
      }),
    ).rejects.toMatchObject({ message: "Forbidden", status: 403 });
    expect(tx.bookingGuest.delete).not.toHaveBeenCalled();
  });

  it("refuses when the authority names the guest but the caller asks for another", async () => {
    // The mirror of the case above — authority for the companion, request for the
    // target — so neither field can be the one that matters by itself.
    const booking = makeBooking({ targetConsent: "EXPIRED" });
    const tx = makeTx(booking);

    await expect(
      remove(tx, {
        guestId: TARGET_GUEST,
        actorMemberId: DELEGATE,
        consentAuthority: authority("CONSENT_EXPIRY", { guestId: COMPANION_GUEST }),
      }),
    ).rejects.toMatchObject({ message: "Forbidden", status: 403 });
    expect(tx.bookingGuest.delete).not.toHaveBeenCalled();
  });
});

describe("consentAuthority applies only to a row already in its terminal status", () => {
  // This conjunct is what BINDS the authority to the status-guarded claim in
  // `member-guest-consent-service.ts`. The claim runs first, in the same
  // transaction; if it lost its race the row is not in the claimed status and the
  // authority simply does not apply. Without this, an authority object would be a
  // standing permission to remove a live guest.
  it("cannot remove a live PENDING row", async () => {
    const booking = makeBooking({ targetConsent: "PENDING" });
    const tx = makeTx(booking);
    await expect(
      remove(tx, {
        guestId: TARGET_GUEST,
        actorMemberId: DELEGATE,
        consentAuthority: authority("CONSENT_EXPIRY"),
      }),
    ).rejects.toMatchObject({ message: "Forbidden", status: 403 });
    expect(tx.bookingGuest.delete).not.toHaveBeenCalled();
  });

  it("cannot remove a CONFIRMED row", async () => {
    // D-13: an approved consent is terminal. A stale authority must not be able to
    // undo a member's yes.
    const booking = makeBooking({ targetConsent: "CONFIRMED" });
    const tx = makeTx(booking);
    await expect(
      remove(tx, {
        guestId: TARGET_GUEST,
        actorMemberId: DELEGATE,
        consentAuthority: authority("CONSENT_DECLINE"),
      }),
    ).rejects.toMatchObject({ message: "Forbidden", status: 403 });
  });

  it("cannot remove a consent-free (NULL) row", async () => {
    // Every ordinary guest in the database has a NULL consentStatus. If the
    // authority applied to them, it would be a general removal permission.
    const booking = makeBooking({ targetConsent: null });
    const tx = makeTx(booking);
    await expect(
      remove(tx, {
        guestId: TARGET_GUEST,
        actorMemberId: DELEGATE,
        consentAuthority: authority("CONSENT_DECLINE"),
      }),
    ).rejects.toMatchObject({ message: "Forbidden", status: 403 });
  });

  it("will not accept a decline authority for an expired row, or the reverse", async () => {
    // The two kinds are not interchangeable: each one asserts what already happened
    // to the row, and a mismatch means the caller is describing a transition that
    // did not occur.
    const expired = makeTx(makeBooking({ targetConsent: "EXPIRED" }));
    await expect(
      remove(expired, {
        guestId: TARGET_GUEST,
        actorMemberId: DELEGATE,
        consentAuthority: authority("CONSENT_DECLINE"),
      }),
    ).rejects.toMatchObject({ message: "Forbidden", status: 403 });

    const declined = makeTx(makeBooking({ targetConsent: "DECLINED" }));
    await expect(
      remove(declined, {
        guestId: TARGET_GUEST,
        actorMemberId: DELEGATE,
        consentAuthority: authority("CONSENT_EXPIRY"),
      }),
    ).rejects.toMatchObject({ message: "Forbidden", status: 403 });
  });

  it("lets a delegate's DECLINE through on a DECLINED row", async () => {
    // The matching case, so the four refusals above are about the mismatch rather
    // than about declines never working. The delegate is neither the owner, nor an
    // admin, nor the guest — the three parties this function otherwise admits.
    const booking = makeBooking({ targetConsent: "DECLINED" });
    const tx = makeTx(booking);
    const result = await remove(tx, {
      guestId: TARGET_GUEST,
      actorMemberId: DELEGATE,
      consentAuthority: authority("CONSENT_DECLINE"),
    });
    expect(result.removedGuest.id).toBe(TARGET_GUEST);
    // The truthful actor is recorded on the modification: the delegate who
    // refused, not the target they answered for.
    expect(tx.bookingModification.create.mock.calls[0][0].data.memberId).toBe(DELEGATE);
  });
});

describe("consentAuthority applies only to the target it names", () => {
  it("refuses when the row belongs to a different member", async () => {
    // A guest row's `memberId` is the person whose consent was asked for. An
    // authority naming somebody else is not authority over this row, whatever else
    // matches.
    const booking = makeBooking({ targetConsent: "EXPIRED", targetMemberId: COMPANION });
    const tx = makeTx(booking);
    await expect(
      remove(tx, {
        guestId: TARGET_GUEST,
        actorMemberId: DELEGATE,
        consentAuthority: authority("CONSENT_EXPIRY", { targetMemberId: TARGET }),
      }),
    ).rejects.toMatchObject({ message: "Forbidden", status: 403 });
    expect(tx.bookingGuest.delete).not.toHaveBeenCalled();
  });

  it("refuses a non-member guest row even with a matching status", async () => {
    // A row with no `memberId` is a plain named guest: nobody's consent to give, so
    // no authority can be about it.
    const booking = makeBooking({ targetConsent: "EXPIRED" });
    booking.guests[0].memberId = null as unknown as string;
    // #2675: the live Member relation goes with the column. `memberId` is the
    // guest's own foreign key and `member` is the row it resolves to, so a
    // production read can never serve one without the other — and leaving an
    // adult member row on the guest this test declares a PLAIN NAMED GUEST would
    // hand the hosting evaluator a party the fixture does not describe (a host
    // who is not there, and one fewer person needing cover).
    booking.guests[0].member =
      null as unknown as ReturnType<typeof hostingMemberRow>;
    const tx = makeTx(booking);
    await expect(
      remove(tx, {
        guestId: TARGET_GUEST,
        actorMemberId: DELEGATE,
        consentAuthority: authority("CONSENT_EXPIRY"),
      }),
    ).rejects.toMatchObject({ message: "Forbidden", status: 403 });
  });
});

describe("consentAuthority grants nothing on the paths that already existed", () => {
  // The pre-existing owner/admin/self behaviour is pinned end-to-end (including
  // the money math) by partial-stay-edit-pricing.test.ts's #1093 cases; what is
  // asserted here is only that adding the authority parameter left the GATE alone.
  it("still lets the booking owner remove a guest with no authority at all", async () => {
    const tx = makeTx(makeBooking({ targetConsent: null }));
    const result = await remove(tx, { guestId: TARGET_GUEST, actorMemberId: OWNER });
    expect(result.removedGuest.id).toBe(TARGET_GUEST);
  });

  it("still lets an admin remove a guest with no authority at all", async () => {
    const tx = makeTx(makeBooking({ targetConsent: null }));
    const result = await remove(tx, {
      guestId: TARGET_GUEST,
      actorMemberId: ADMIN,
      actorRole: "ADMIN",
    });
    expect(result.removedGuest.id).toBe(TARGET_GUEST);
  });

  it("still lets a linked guest take themselves off", async () => {
    const tx = makeTx(makeBooking({ targetConsent: null }));
    const result = await remove(tx, { guestId: TARGET_GUEST, actorMemberId: TARGET });
    expect(result.removedGuest.id).toBe(TARGET_GUEST);
  });

  it("still refuses a stranger", async () => {
    const tx = makeTx(makeBooking({ targetConsent: null }));
    await expect(
      remove(tx, { guestId: TARGET_GUEST, actorMemberId: "m-nobody" }),
    ).rejects.toMatchObject({ message: "Forbidden", status: 403 });
  });

  it("still refuses a linked guest aiming at somebody else's place", async () => {
    // The pre-existing rule that a guest may remove only THEMSELVES. A caller who
    // holds a guest row on the booking is a "linked guest viewer", which gets them
    // past the first gate and no further.
    const tx = makeTx(makeBooking({ targetConsent: null }));
    await expect(
      remove(tx, { guestId: COMPANION_GUEST, actorMemberId: TARGET }),
    ).rejects.toMatchObject({ message: "Forbidden", status: 403 });
  });
});

describe("an unpriceable removal parks its money instead of inventing it (#3032, D-14)", () => {
  // WHAT CHANGED HERE, AND WHY THE OLD ASSERTIONS ARE NOT SIMPLY DELETED.
  //
  // #3031 added an evidence gate to this function: unless every strand on the
  // booking reconciles, the removal was REFUSED as `FINANCIAL_REVIEW_REQUIRED`
  // rather than credited from a number nobody can support (INV-MOD-028). That
  // refusal was an interim, and #3031 said so — it exempted a consent removal
  // from the gate because owner decision D-14 says a decline or an expiry must
  // ALWAYS be able to take its target off the booking, and left a hand-off block
  // naming this issue as the one that parks the money.
  //
  // #3032 discharges it. There is no refusal on either path any more: EVERY
  // unpriceable removal now commits structurally and raises an OPEN review task
  // for a person to price. So the case that used to pin the 409 for an owner now
  // pins the parking, which is the same fixture asserting the behaviour that
  // replaced the one it was written for — and the consent cases below assert
  // what D-14 was always about, which is that the member comes OFF.
  //
  // The differential is preserved and is now about the EVIDENCE rather than
  // about the refusal: the same removal on a booking whose rows DO reconcile
  // settles normally and raises nothing.
  //
  // WHAT THIS FIXTURE PINNED WRONG, AND NOW PINS RIGHT. It gives the DEPARTING
  // guest readable rows and empties only the COMPANION's, which is the exact
  // shape in which the first cut of #3032 lost money: the unreadable-strand
  // filter skipped the departing guest for being "exact", so the single task
  // raised named the guest who was STAYING, carried `surrenderedNightDates: []`,
  // and read as "reviewed, nothing to adjust" — while the delete destroyed the
  // departing guest's night rows and `priceDiffCents` stayed 0. These cases
  // asserted `create` was called exactly ONCE, so the fixture was the defect's
  // proof rather than its refutation. They now require the departing strand's
  // task as well, with its nights and its real stored prices on it.
  function unpriceableCompanionBooking(targetConsent: ConsentStatus) {
    const booking = makeBooking({ targetConsent });
    // The companion carries money with no per-night record at all: a booking
    // predating `BookingGuestNight`, or one created by approving a request
    // (#2739 backfills those but cannot empty the population). Their strand
    // cannot reconcile, and it is not the strand being removed.
    booking.guests[1].nights = [];
    return booking;
  }

  /** The one `manualRefundTask.create` call whose task is about `guestId`. */
  function raisedFor(tx: ReturnType<typeof makeTx>, guestId: string) {
    const calls = tx.manualRefundTask.create.mock.calls as Array<
      [{ data: Record<string, never> }]
    >;
    const match = calls
      .map((call) => call[0].data as Record<string, never>)
      .filter(
        (data) =>
          (
            data.reviewContext as unknown as {
              occurrence: { bookingGuestId: string };
            }
          ).occurrence.bookingGuestId === guestId,
      );
    expect(match, `expected exactly one task about ${guestId}`).toHaveLength(1);
    return match[0] as unknown as {
      amountCents: number | null;
      raisedAmountCents: number | null;
      kind: string;
      status: string;
      occurrenceKey: string;
      reason: string;
      reviewContext: {
        bookingModificationId: string | null;
        occurrence: {
          bookingGuestId: string;
          cause: string;
          surrenderedNightDates: string[];
          storedEvidence: {
            guestTotalCents: number | null;
            nightPrices: Array<{ date: string; priceCents: number | null }>;
          };
        };
      };
    };
  }

  it("takes a declining member off, and parks the money rather than settling it", async () => {
    const tx = makeTx(unpriceableCompanionBooking("DECLINED"));

    const result = await remove(tx, {
      guestId: TARGET_GUEST,
      actorMemberId: TARGET,
      consentAuthority: authority("CONSENT_DECLINE"),
    });

    // The structural half: the guest is off the booking. This is D-14, and it is
    // the half that must never be held behind a pricing question.
    expect(tx.bookingGuest.delete).toHaveBeenCalledWith({
      where: { id: TARGET_GUEST },
    });
    expect(result.removedGuest.id).toBe(TARGET_GUEST);

    // The money half: parked, not settled and not invented.
    expect(result.financialReviewPending).toBe(true);
    expect(tx.manualRefundTask.create).toHaveBeenCalledTimes(2);
    expect(result.financialReviewTaskIds).toEqual([
      "task-raised",
      "task-raised-2",
    ]);
    expect(result.priceDiffCents).toBe(0);
    expect(result.refundAmountCents).toBe(0);
    expect(result.accountCreditAmountCents).toBe(0);
    expect(result.additionalAmountCents).toBe(0);
    expect(result.xeroRefundAmountCents).toBe(0);
    expect(result.xeroAdditionalAmountCents).toBe(0);

    // The task is RAISED WITH NO AMOUNT. Null is "not yet known"; a zero here
    // would be a financial statement the club has not made (epic #2797).
    const raised = raisedFor(tx, COMPANION_GUEST);
    expect(raised.amountCents).toBeNull();
    expect(raised.raisedAmountCents).toBeNull();
    expect(raised.kind).toBe("EDIT_FINANCIAL_REVIEW");
    expect(raised.status).toBe("OPEN");

    // Owner decision D-3032-1: the anchor a confirmed amount settles against is
    // THIS removal's own `BookingModification` row, carried on the context and
    // deliberately not on the occurrence.
    expect(raised.reviewContext.bookingModificationId).toBe("mod-1");
    expect(raised.reviewContext.occurrence).not.toHaveProperty(
      "bookingModificationId",
    );

    // And the booking's stored money did not move. Reducing the total would mean
    // knowing by how much, which is the question under review.
    const written = tx.booking.update.mock.calls[0][0].data;
    expect(written.totalPriceCents).toBe(24000);
    expect(written.finalPriceCents).toBe(24000);
    // Nothing was repriced, so no remaining strand had its price overwritten.
    expect(tx.bookingGuest.update).not.toHaveBeenCalled();
    expect(tx.payment.update).not.toHaveBeenCalled();
  });

  it("records the DEPARTING guest's money even though their own rows read cleanly", async () => {
    // THE CASE THAT FAILS IF THE DEPARTING STRAND IS DROPPED AGAIN.
    //
    // On this booking the guest who is LEAVING reconciles — two stored nights at
    // 6000 summing to their stored 12000 — and a guest who is STAYING does not.
    // Nothing settles, `priceDiffCents` is 0, the booking's total does not move,
    // and the delete below destroys the departing guest's `BookingGuestNight`
    // rows; `BookingModification.previousData` keeps only their name, age tier
    // and membership. So if this removal raises nothing about them, their refund
    // is a number that exists nowhere in the database afterwards — and the only
    // task an admin sees is about the guest who is staying, says "gave back no
    // nights", and invites the DISMISSED that clears the banner with it.
    const tx = makeTx(unpriceableCompanionBooking("DECLINED"));

    await remove(tx, {
      guestId: TARGET_GUEST,
      actorMemberId: TARGET,
      consentAuthority: authority("CONSENT_DECLINE"),
    });

    const departing = raisedFor(tx, TARGET_GUEST);

    // The nights that left the booking, and therefore the money.
    expect(
      departing.reviewContext.occurrence.surrenderedNightDates,
    ).toEqual(["2026-11-02", "2026-11-03"]);

    // And the amount is recoverable from the row: the real per-night prices as
    // they stood, plus the stored guest total they add up to. This is the number
    // the delete was about to destroy.
    expect(departing.reviewContext.occurrence.storedEvidence).toEqual({
      guestTotalCents: 12000,
      nightPrices: [
        { date: "2026-11-02", priceCents: 6000 },
        { date: "2026-11-03", priceCents: 6000 },
      ],
    });

    // Its cause says WHY a strand whose own rows are perfect is under review, so
    // the admin is confirming a figure the rows already show rather than
    // reconstructing one. The three "we cannot read this strand" causes would be
    // false of it.
    expect(departing.reviewContext.occurrence.cause).toBe(
      "COUNTERPART_STRAND_UNREADABLE",
    );

    // The operator sentence matches the cause. "The exact sold price could not be
    // read" is FALSE here and would contradict the priced rows printed beside it.
    expect(departing.reason).toContain("2026-11-02");
    expect(departing.reason).not.toContain(
      "The exact sold price could not be read",
    );

    // Still no amount: what goes back also depends on the cancellation tier and
    // the promo recalculation this parked path skipped, so the gross stored
    // figure is evidence for the admin, not a settlement the club may assert.
    expect(departing.amountCents).toBeNull();
    expect(departing.raisedAmountCents).toBeNull();

    // Two occurrences, two identities. A shared key would mean one of the two
    // strands silently reusing the other's task.
    expect(departing.occurrenceKey).not.toBe(
      raisedFor(tx, COMPANION_GUEST).occurrenceKey,
    );
  });

  it("lets the expiry sweep through on the same booking, parking it the same way", async () => {
    // The sweep has no actor at all, so a refusal here would leave the row
    // PENDING-claimed-then-rolled-back for ever and hold its bed with it.
    const tx = makeTx(unpriceableCompanionBooking("EXPIRED"));

    const result = await remove(tx, {
      guestId: TARGET_GUEST,
      actorMemberId: OWNER,
      consentAuthority: authority("CONSENT_EXPIRY"),
    });

    expect(result.removedGuest.id).toBe(TARGET_GUEST);
    expect(result.financialReviewPending).toBe(true);
    // Both strands: the unreadable companion, and the departing member whose own
    // rows read cleanly and whose money the delete is about to destroy.
    expect(tx.manualRefundTask.create).toHaveBeenCalledTimes(2);
    expect(raisedFor(tx, TARGET_GUEST).reviewContext.occurrence
      .surrenderedNightDates).toHaveLength(2);
  });

  it("parks the SAME removal on the SAME booking when the OWNER asks for it", async () => {
    // This case used to pin the interim 409. It now pins what replaced it: an
    // ordinary owner removal of an unpriceable booking is no longer refused, and
    // the guest comes off exactly as they do on the consent paths above.
    const tx = makeTx(unpriceableCompanionBooking("DECLINED"));

    const result = await remove(tx, {
      guestId: TARGET_GUEST,
      actorMemberId: OWNER,
    });

    expect(tx.bookingGuest.delete).toHaveBeenCalledWith({
      where: { id: TARGET_GUEST },
    });
    expect(result.financialReviewPending).toBe(true);
    expect(result.priceDiffCents).toBe(0);
  });

  it("raises no second task when the same occurrence is already on file", async () => {
    // A replay — the retried request, or a second lane that got there first. The
    // find-then-create pair under the global lock returns the existing task, and
    // the removal still completes rather than failing on a unique violation that
    // would roll the structural change back with it.
    const tx = makeTx(unpriceableCompanionBooking("DECLINED"));
    // Keyed by the occurrence key the raise looks up, so this also proves the two
    // strands are looked up under two DISTINCT identities: a single shared key
    // would return one row twice and the second strand would silently inherit the
    // first strand's task.
    const onFile = new Map<string, string>();
    tx.manualRefundTask.findUnique.mockImplementation(
      async ({ where }: { where: { occurrenceKey: string } }) => {
        if (!onFile.has(where.occurrenceKey)) {
          onFile.set(
            where.occurrenceKey,
            `task-already-open-${onFile.size + 1}`,
          );
        }
        return { id: onFile.get(where.occurrenceKey), status: "OPEN" };
      },
    );

    const result = await remove(tx, {
      guestId: TARGET_GUEST,
      actorMemberId: TARGET,
      consentAuthority: authority("CONSENT_DECLINE"),
    });

    expect(result.removedGuest.id).toBe(TARGET_GUEST);
    expect(tx.manualRefundTask.create).not.toHaveBeenCalled();
    expect(result.financialReviewTaskIds).toEqual([
      "task-already-open-1",
      "task-already-open-2",
    ]);
    expect(onFile.size).toBe(2);
    expect(result.financialReviewPending).toBe(true);
  });

  it("settles normally, and raises nothing, when the booking CAN be priced", async () => {
    // The control, and the whole differential. Every strand on the untouched
    // fixture reconciles, so the same removal takes the ordinary path: the
    // booking's total moves, and no review task is raised at all. Without this
    // the cases above would pass just as well if the park had been made
    // unconditional.
    const tx = makeTx(makeBooking({ targetConsent: "DECLINED" }));

    const result = await remove(tx, {
      guestId: TARGET_GUEST,
      actorMemberId: OWNER,
    });

    expect(result.removedGuest.id).toBe(TARGET_GUEST);
    expect(result.financialReviewPending).toBe(false);
    expect(result.financialReviewTaskIds).toEqual([]);
    expect(tx.manualRefundTask.create).not.toHaveBeenCalled();
    expect(result.priceDiffCents).toBeLessThan(0);
    expect(tx.booking.update.mock.calls[0][0].data.totalPriceCents).toBeLessThan(
      24000,
    );
  });
});

describe("a consent removal runs the SELF-REMOVAL gate set (D-14)", () => {
  // THE DIFFERENTIAL TEST, and the reason D-14 holds to the letter: the cases in
  // which a never-consented member is trapped on a booking are exactly the cases in
  // which they could not have taken themselves off, and those refusals are what
  // D-15 routes to the admin exception list. A DRAFT booking is the cleanest
  // demonstration available — it IS in the self-removal status set and is NOT in
  // the owner path's narrower ["PENDING", "PAYMENT_PENDING", "CONFIRMED", "PAID"]
  // list — so the same guest on the same booking goes two different ways.
  it("expires a guest off a DRAFT booking that the owner path would refuse on status", async () => {
    expect(SELF_REMOVABLE_GUEST_BOOKING_STATUSES.has(BookingStatus.DRAFT)).toBe(true);

    const tx = makeTx(makeBooking({ status: BookingStatus.DRAFT, targetConsent: "EXPIRED" }));
    const result = await remove(tx, {
      guestId: TARGET_GUEST,
      actorMemberId: OWNER,
      consentAuthority: authority("CONSENT_EXPIRY"),
    });
    expect(result.removedGuest.id).toBe(TARGET_GUEST);
  });

  it("refuses the SAME removal on the SAME booking when it comes from the owner path", async () => {
    // Same fixture, same guest, no authority — and now the owner's own status gate
    // applies and refuses. This is what proves the authority ROUTES rather than
    // merely permits.
    const tx = makeTx(makeBooking({ status: BookingStatus.DRAFT, targetConsent: "EXPIRED" }));
    await expect(
      remove(tx, { guestId: TARGET_GUEST, actorMemberId: OWNER }),
    ).rejects.toMatchObject({
      message: "Only PENDING, PAYMENT_PENDING, CONFIRMED, or PAID bookings can be modified",
      status: 400,
    });
  });

  it("is refused by the self-removal status gate on a status a member could not leave", async () => {
    // The other side of the routing: a status that is not self-removable refuses the
    // consent removal too, with the self-removal sentence — which is the sentence
    // `classifyConsentRemovalRefusal` reads to file the row as BOOKING_STATUS.
    expect(SELF_REMOVABLE_GUEST_BOOKING_STATUSES.has(BookingStatus.CANCELLED)).toBe(false);

    const tx = makeTx(makeBooking({ status: BookingStatus.CANCELLED, targetConsent: "EXPIRED" }));
    await expect(
      remove(tx, {
        guestId: TARGET_GUEST,
        actorMemberId: OWNER,
        consentAuthority: authority("CONSENT_EXPIRY"),
      }),
    ).rejects.toMatchObject({
      message: "You cannot remove yourself from this booking in its current status",
      status: 400,
    });
  });

  it("is refused once check-in is no longer in the future", async () => {
    // The `STAY_NOT_FUTURE` gate, and the reason the expiry clamp is set a day
    // BEFORE check-in: a deadline landing on check-in morning would fire here.
    const tx = makeTx(makeBooking({ targetConsent: "EXPIRED" }), {
      checkIn: new Date("2020-01-01T00:00:00.000Z"),
      checkOut: new Date("2020-01-03T00:00:00.000Z"),
    });
    await expect(
      remove(tx, {
        guestId: TARGET_GUEST,
        actorMemberId: OWNER,
        consentAuthority: authority("CONSENT_EXPIRY"),
      }),
    ).rejects.toMatchObject({
      message: "Only future booking guests can remove themselves from another member's booking",
      status: 400,
    });
  });

  it("is refused when the guest is the booking's last one", async () => {
    // No exemption, exactly as D-14 was ticked: a booking cannot be emptied by a
    // lapse. The row is left for a human to decide whether the booking should exist
    // at all.
    const booking = makeBooking({ targetConsent: "EXPIRED" });
    booking.guests = [booking.guests[0]];
    const tx = makeTx(booking);
    await expect(
      remove(tx, {
        guestId: TARGET_GUEST,
        actorMemberId: OWNER,
        consentAuthority: authority("CONSENT_EXPIRY"),
      }),
    ).rejects.toBeInstanceOf(BookingGuestRemovalError);
    await expect(
      remove(tx, {
        guestId: TARGET_GUEST,
        actorMemberId: OWNER,
        consentAuthority: authority("CONSENT_EXPIRY"),
      }),
    ).rejects.toMatchObject({
      message: "Cannot remove the last guest. Cancel the booking instead.",
      status: 400,
    });
  });

  it("settles the reduction as account credit when the sweep elects it (D-15)", async () => {
    // The election is passed straight through to the shared settlement machinery
    // rather than being re-implemented for consent, so a lapse and an ordinary edit
    // settle a paid booking the same way.
    const tx = makeTx(makeBooking({ targetConsent: "EXPIRED" }));
    const result = await remove(tx, {
      guestId: TARGET_GUEST,
      actorMemberId: OWNER,
      consentAuthority: authority("CONSENT_EXPIRY"),
      settlementMethod: "credit",
    });
    // Nothing was captured on this fixture, so nothing is refunded to a card —
    // which is the point: the sweep never issues a card refund.
    expect(result.refundAmountCents).toBe(0);
    expect(result.priceDiffCents).toBeLessThan(0);
  });
});

/**
 * #3123 — the self-removal window, and why BOTH sides of it moved at once.
 *
 * `removeBookingGuestInTransaction` decides whether a member may take
 * themselves off somebody else's booking with one comparison:
 *
 *     storedDateOnly(booking.checkIn) > today
 *
 * Before this migration it was
 * `normalizeDateOnlyForTimeZone(booking.checkIn) > getTodayDateOnly()` — two
 * different legacy helpers, both defaulting their zone to `APP_TIME_ZONE`, on
 * one line. A1 and A2 both flagged it as the #3107 shape: for a club behind
 * Greenwich the two projections CANCEL, so moving one side alone turns a
 * working path into a broken one. They moved together.
 *
 * The two sides are now different KINDS, which is the whole point.
 * `booking.checkIn` is a `@db.Date`, a stored calendar day, so it is decoded
 * zone-free (`storedDateOnly`, `INV-DATE-026`) — sweeping it onto the club zone
 * would have been the mistake #3113 exists to correct. `today` is a real
 * question about the club's clock and is answered OUTSIDE this transaction by
 * the caller (`INV-LOCK-004`), because this one holds the per-lodge capacity
 * key.
 *
 * WHAT THIS BLOCK CAN AND CANNOT SEE. It discriminates the RIGHT operand
 * exactly: the old code ignored any supplied day and read `APP_TIME_ZONE`,
 * which under this file's unmocked environment is `Pacific/Auckland` and
 * therefore 2026-07-01 at the frozen instant. The LEFT operand's old projection
 * is invisible here, because Auckland is AHEAD of Greenwich and a UTC-midnight
 * `@db.Date` projects onto itself there — that is precisely the "two errors
 * cancel" property that made this pair dangerous. What covers the left side is
 * structural and mechanical: `lock-bound-club-zone-outside-transaction.test.ts`
 * fails if `normalizeDateOnlyForTimeZone(` or any club-zone reader reappears in
 * this module at all, so the operand has no zone available to be wrong about.
 */
describe("the self-removal window is judged on the day the caller supplies (#3123)", () => {
  const CLUB_DAY = new Date("2026-06-30T00:00:00.000Z");
  const ENVIRONMENT_DAY = new Date("2026-07-01T00:00:00.000Z");
  /** A stored lodge night: `@db.Date`, so UTC midnight and no zone at all. */
  const CHECK_IN_1_JULY = new Date("2026-07-01T00:00:00.000Z");
  const CHECK_OUT_3_JULY = new Date("2026-07-03T00:00:00.000Z");

  function futureStayBooking() {
    const base = makeBooking({ targetConsent: "CONFIRMED" });
    return {
      ...base,
      checkIn: CHECK_IN_1_JULY,
      checkOut: CHECK_OUT_3_JULY,
    };
  }

  async function selfRemove(today: Date) {
    const booking = futureStayBooking();
    const tx = makeTx(booking as ReturnType<typeof makeBooking>);
    return removeBookingGuestInTransaction({
      today,
      tx: tx as never,
      bookingId: BOOKING,
      guestId: TARGET_GUEST,
      actorMemberId: TARGET,
      actorRole: "MEMBER",
    });
  }

  it("lets a member off a stay that is still future ON THE CLUB'S DAY", async () => {
    // The club is on 30 June; the stay starts on 1 July, so it is future and the
    // member may leave. The container says it is already 1 July, which makes the
    // same stay "today" and refuses them — a member locked out of a booking they
    // are entitled to leave, one whole day early, on every deployment behind
    // Greenwich.
    await expect(selfRemove(CLUB_DAY)).resolves.toMatchObject({
      priceDiffCents: expect.any(Number),
    });
  });

  it("refuses once the club's day has caught the stay up", async () => {
    // The boundary itself, from the other side: same booking, same guest, only
    // the supplied day moves. A `today` the function ignored could not do this.
    await expect(selfRemove(ENVIRONMENT_DAY)).rejects.toMatchObject({
      message:
        "Only future booking guests can remove themselves from another member's booking",
      status: 400,
    });
  });
});

/**
 * #3032 (epic #2797): the pending-review fence on the removal path, and the one
 * exemption that keeps owner decision D-14 true.
 *
 * D-14 says a member who never consented must ALWAYS be able to come off a
 * booking. The fence is what stops a second money-affecting edit compounding an
 * amount nobody has priced yet — so without the exemption it would trap exactly
 * the people D-14 exists to free, for as long as an admin left the review open.
 * With it, the removal proceeds and #3032 parks its money as a second review
 * task rather than inventing a figure or silently skipping one.
 */
describe("#3032 pending financial review fences a removal, except a consent one", () => {
  const openReview = {
    id: "task-open",
    occurrenceKey: "edit-financial-review:v1:abc",
    amountCents: null,
    raisedAmountCents: null,
    reviewContext: null,
  };

  it("refuses an ordinary owner removal while the booking's money is under review", async () => {
    const tx = makeTx(makeBooking({ targetConsent: null }));
    tx.manualRefundTask.findFirst.mockResolvedValue(openReview);

    await expect(
      remove(tx, { guestId: TARGET_GUEST, actorMemberId: OWNER }),
    ).rejects.toMatchObject({ status: 409 });

    // Refused BEFORE any write: the booking is exactly as it was.
    expect(tx.bookingGuest.delete).not.toHaveBeenCalled();
    expect(tx.bookingModification.create).not.toHaveBeenCalled();
  });

  it("refuses an admin removal on the same terms — the fence is about the money, not the actor", async () => {
    const tx = makeTx(makeBooking({ targetConsent: null }));
    tx.manualRefundTask.findFirst.mockResolvedValue(openReview);

    await expect(
      remove(tx, {
        guestId: TARGET_GUEST,
        actorMemberId: ADMIN,
        actorRole: "ADMIN",
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("D-14: a CONSENT_EXPIRY removal still comes off, with the review open", async () => {
    const tx = makeTx(makeBooking({ targetConsent: "EXPIRED" }));
    tx.manualRefundTask.findFirst.mockResolvedValue(openReview);

    const result = await remove(tx, {
      guestId: TARGET_GUEST,
      actorMemberId: OWNER,
      consentAuthority: authority("CONSENT_EXPIRY"),
    });
    expect(result.removedGuest.id).toBe(TARGET_GUEST);
  });

  it("D-14: a CONSENT_DECLINE removal still comes off, with the review open", async () => {
    const tx = makeTx(makeBooking({ targetConsent: "DECLINED" }));
    tx.manualRefundTask.findFirst.mockResolvedValue(openReview);

    const result = await remove(tx, {
      guestId: TARGET_GUEST,
      actorMemberId: OWNER,
      consentAuthority: authority("CONSENT_DECLINE"),
    });
    expect(result.removedGuest.id).toBe(TARGET_GUEST);
  });

  it("CONTROL: the same ordinary removal succeeds when no review is open", async () => {
    // Without this the four assertions above would still pass against a fence
    // that refused every removal, or one that refused none.
    const tx = makeTx(makeBooking({ targetConsent: null }));
    tx.manualRefundTask.findFirst.mockResolvedValue(null);

    const result = await remove(tx, {
      guestId: TARGET_GUEST,
      actorMemberId: OWNER,
    });
    expect(result.removedGuest.id).toBe(TARGET_GUEST);
    expect(tx.manualRefundTask.findFirst).toHaveBeenCalledTimes(1);
  });

  it("a stranger still gets 403, not a 409 telling them the club is reviewing this booking's money", async () => {
    const tx = makeTx(makeBooking({ targetConsent: null }));
    tx.manualRefundTask.findFirst.mockResolvedValue(openReview);

    await expect(
      remove(tx, { guestId: TARGET_GUEST, actorMemberId: "m-stranger" }),
    ).rejects.toMatchObject({ status: 403 });
    // And the fence never even ran: it sits below the authorisation checks, so a
    // caller with no business here learns nothing about the booking's finances.
    expect(tx.manualRefundTask.findFirst).not.toHaveBeenCalled();
  });
});
