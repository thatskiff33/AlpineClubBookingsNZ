import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { AdminReviewStatus, BookingStatus } from "@prisma/client";
import { ADULT_SUPERVISION_REVIEW_REASON } from "@/lib/booking-review";

// F27 / #1372 — call-site integration. Drives the REAL DELETE route through the
// REAL removeBookingGuestInTransaction so the guest composition (does an adult
// remain after the removal?) is what decides whether the admin alert fires.
//
// This deliberately does NOT stub `minorsOnlyReviewNewlyFlagged`: the flag is
// computed inside the service by the real minorsReviewAlertShouldFire({
// previous: <pre-edit booking>, updated: <written booking> }). So a regression
// that made the alert unconditional, or that swapped previous/updated (which
// would permanently disable the alert), would flip one of these assertions —
// gaps the isolated predicate/sender tests cannot catch.

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  transaction: vi.fn(),
  memberFindUnique: vi.fn(),
  // booking-modify collaborators (trivial stubs — the review decision is real)
  assertBookingNotQuotePriced: vi.fn(),
  applyLifecycleTransitions: vi.fn(),
  applyPaymentAdjustments: vi.fn(),
  calculateModificationSettlementOptions: vi.fn(),
  lockedNightPricesForGuest: vi.fn(),
  // membership-type-policy (pricing) collaborators
  priceBookingGuestsWithMembershipTypePolicy: vi.fn(),
  assertMembershipTypeBookingAllowed: vi.fn(),
  // route post-transaction side effects
  drainSupersededPrimaryIntents: vi.fn(),
  executeBookingModificationRefund: vi.fn(),
  createModificationAdditionalPaymentIntent: vi.fn(),
  reconcileBedAllocationsForBooking: vi.fn(),
  queueXeroBookingEditSettlement: vi.fn(),
  logAudit: vi.fn(),
  sendBookingModifiedEmail: vi.fn(),
  sendAdminMinorsOnlyReviewAlert: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: mocks.requireActiveSessionUser,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: mocks.transaction,
    member: { findUnique: mocks.memberFindUnique },
  },
}));
vi.mock("@/lib/booking-edit-policy", () => ({
  getBookingEditPolicy: () => ({ canModify: true, mode: "future", reason: null }),
  usesActiveBookingEditLifecycle: () => true,
}));
vi.mock("@/lib/booking-modify", async (importActual) => {
  // #2543: `rateSnapshotUpdateForRepricedGuest` is a PURE decision about whether a
  // repriced guest keeps its stored rate snapshot, so the real one is pulled through
  // rather than stubbed — a stub here would make the removal path's coding behaviour
  // untested on the very route that exercises it.
  const actual = await importActual<typeof import("@/lib/booking-modify")>();
  return {
    assertBookingNotQuotePriced: mocks.assertBookingNotQuotePriced,
    applyLifecycleTransitions: mocks.applyLifecycleTransitions,
    applyPaymentAdjustments: mocks.applyPaymentAdjustments,
    calculateModificationSettlementOptions: mocks.calculateModificationSettlementOptions,
    lockedNightPricesForGuest: mocks.lockedNightPricesForGuest,
    rateSnapshotUpdateForRepricedGuest: actual.rateSnapshotUpdateForRepricedGuest,
  };
});
vi.mock("@/lib/membership-type-policy", () => ({
  priceBookingGuestsWithMembershipTypePolicy:
    mocks.priceBookingGuestsWithMembershipTypePolicy,
  assertMembershipTypeBookingAllowed: mocks.assertMembershipTypeBookingAllowed,
  getMembershipTypeBookingPolicyErrorBody: (err: { message: string }) => ({
    error: err.message,
  }),
  MembershipTypeBookingPolicyError: class MembershipTypeBookingPolicyError extends Error {
    status = 400;
  },
}));
vi.mock("@/lib/booking-modification-settlement", () => ({
  drainSupersededPrimaryIntents: mocks.drainSupersededPrimaryIntents,
  executeBookingModificationRefund: mocks.executeBookingModificationRefund,
  createModificationAdditionalPaymentIntent:
    mocks.createModificationAdditionalPaymentIntent,
}));
vi.mock("@/lib/bed-allocation-lifecycle", () => ({
  reconcileBedAllocationsForBookingWithLodgeLockHeld:
    mocks.reconcileBedAllocationsForBooking,
}));
vi.mock("@/lib/xero-booking-edit-settlement", () => ({
  queueXeroBookingEditSettlement: mocks.queueXeroBookingEditSettlement,
}));
vi.mock("@/lib/audit", () => ({ logAudit: mocks.logAudit }));
vi.mock("@/lib/email", () => ({
  sendBookingModifiedEmail: mocks.sendBookingModifiedEmail,
  sendAdminMinorsOnlyReviewAlert: mocks.sendAdminMinorsOnlyReviewAlert,
}));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import {
  fenceHostingPolicyFindMany,
  fenceMemberFindMany,
  hostingMemberRow,
  recordingBookingDouble,
} from "@/lib/__tests__/support/hosting-participant-fence-double";
import { DELETE } from "@/app/api/bookings/[id]/guests/[guestId]/route";

const CHECK_IN = new Date("2027-07-15");
const CHECK_OUT = new Date("2027-07-17");

type Guest = {
  id: string;
  firstName: string;
  lastName: string;
  ageTier: "ADULT" | "CHILD" | "YOUTH" | "INFANT";
  isMember: boolean;
  memberId: string | null;
};

const ADULT: Guest = {
  id: "g-adult",
  firstName: "Adam",
  lastName: "Adult",
  ageTier: "ADULT",
  isMember: true,
  memberId: "m1",
};
const CHILD: Guest = {
  id: "g-child",
  firstName: "Kid",
  lastName: "Young",
  ageTier: "CHILD",
  isMember: false,
  memberId: null,
};

function preEditBooking(guests: Guest[]) {
  return {
    id: "b1",
    memberId: "m1",
    lodgeId: "lodge-1",
    status: BookingStatus.PAID,
    checkIn: CHECK_IN,
    checkOut: CHECK_OUT,
    totalPriceCents: 8000,
    discountCents: 0,
    promoAdjustmentCents: 0,
    finalPriceCents: 8000,
    // Pre-edit review state: not flagged. A previous/updated swap in the
    // service would read THIS (unflagged) as the "updated" side and never fire.
    requiresAdminReview: false,
    adminReviewStatus: null,
    adminReviewReason: null,
    memberReviewJustification: null,
    adminReviewNotes: null,
    adminReviewedById: null,
    adminReviewedAt: null,
    hasNonMembers: false,
    nonMemberHoldUntil: null,
    guests: guests.map((g) => ({
      ...g,
      stayStart: CHECK_IN,
      stayEnd: CHECK_OUT,
      // An array, not absent: `toHostingParticipants` reads `.length`. Empty is
      // the honest value here — this fixture persists no BookingGuestNight rows,
      // so the evaluator falls back to the stayStart..stayEnd envelope above.
      nights: [],
      priceCents: 4000,
      // No consent was ever asked for on this booking, which is one of the two
      // values `isOperationallyPresentConsent` counts as present (D-12).
      consentStatus: null,
      /*
        #2675: the LIVE Member relation, which is what the hosting evaluator
        reads — never the `isMember` snapshot beside it. The adult IS a member
        (an ADULT in good standing, so they qualify as a host); the child is not,
        and gets an EXPLICIT null rather than a missing key. The difference is
        load-bearing: `memberIsInGoodStanding` tests `member !== null`, and
        `undefined !== null` is TRUE, so an absent key is not read as "not a
        member" — the predicate reads `undefined.active` and throws.

        Together they describe exactly the party these tests are about: one
        non-member minor, covered on both nights by the adult member beside them,
        so removing the adult is a MINORS-ONLY question and not a hosting one.

        The guest's own `ageTier` is carried onto the member row rather than
        letting `hostingMemberRow` default to ADULT. This is the MINORS suite:
        a member-linked minor is exactly the fixture the next test here will
        add, and `participantQualifiesAsHost` reads the MEMBER's tier — so the
        default would score that child as an adult host and suppress a hosting
        violation production would raise, with nothing failing anywhere.
      */
      member: g.memberId ? hostingMemberRow(g.memberId, { ageTier: g.ageTier }) : null,
    })),
    payment: null,
    member: {
      id: "m1",
      email: "owner@example.com",
      firstName: "Pat",
      lastName: "Owner",
    },
    promoRedemption: null,
  };
}

function buildTx(
  guests: Guest[],
  // Overrides the pre-edit booking this tx serves. Pass it here rather than
  // re-stubbing tx.booking.findUnique: that would replace the recording
  // wrapper below and the fence would then see no source booking at all.
  // Deliberately loose: the fixture types several review fields as literal
  // null, so a Partial<> of it would reject the non-null values these tests
  // exist to set.
  bookingOverride?: Record<string, unknown>,
) {
  // #2619: the participant fence re-reads the locked Member rows and each
  // source booking's owner/lodge under the lock. Replay what this tx's own
  // findUnique served so the no-drift case matches by construction.
  const fenceBooking = recordingBookingDouble(async () => ({
    ...preEditBooking(guests),
    ...bookingOverride,
  }));
  return {
    $executeRawUnsafe: vi.fn().mockResolvedValue(undefined),
    member: { findMany: fenceMemberFindMany() },
    // Per-lodge advisory capacity lock (acquireLodgeCapacityLock) uses
    // $executeRaw, not $executeRawUnsafe — pg_advisory_xact_lock returns void
    // so $queryRaw can't deserialize it; every advisory lock uses $executeRaw.
    $executeRaw: vi.fn().mockResolvedValue(undefined),
    // #2364: the hosting review is reconciled inside the booking write, so
    // every prisma/tx double a booking path runs against needs this client.
    // #2623 T5 / #2675: an ACTIVE mode. `[]` resolves to DISABLED, and the mode
    // gate that now stands in front of the participant fence would take its
    // early return — switching the #2619 fence off in all five removals this
    // file runs a transaction for, while the fence doubles beside it still
    // looked like coverage.
    //
    // ADMIN_REVIEW_REQUIRED rather than the helper's ENFORCED default: this
    // fixture deliberately carries a non-member child, so it is exactly the
    // shape a hosting violation could arise on. Under ENFORCED a violation
    // THROWS and rolls the removal back — a 500 in place of the 200 these tests
    // assert, for a reason unrelated to the minors alert they exist to pin.
    // Under review-only the worst case is a review row. (Neither fires here: the
    // adult member covers the child on every night of the stay.)
    adultMemberHostingPolicy: {
      findMany: fenceHostingPolicyFindMany({ mode: "ADMIN_REVIEW_REQUIRED" }),
    },
    booking: {
      findUnique: fenceBooking.findUnique,
      findMany: fenceBooking.findMany,
      // Echo the written review fields + status so the service's real
      // minorsReviewAlertShouldFire reads the actual computed state.
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: "b1",
        memberId: "m1",
        // A real update returns the row's lodgeId. Omitting it made the
        // hosting participant fence compare a source planned with an
        // undefined lodge against a re-read that had one, and refuse (#2619).
        lodgeId: "lodge-1",
        checkIn: CHECK_IN,
        checkOut: CHECK_OUT,
        payment: null,
        ...data,
        guests: [{ id: "g-remaining" }],
      })),
    },
    bookingGuest: {
      delete: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockResolvedValue(undefined),
    },
    choreAssignment: {
      findMany: vi.fn().mockResolvedValue([]),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    season: { findMany: vi.fn().mockResolvedValue([]) },
    groupDiscountSetting: { findUnique: vi.fn().mockResolvedValue(null) },
    // #3032: the pending-review fence reads this under the booking-edit locks.
    // Empty by default - no financial review is open - so every pre-#3032 test
    // asserts exactly what it asserted before.
    manualRefundTask: { findFirst: vi.fn().mockResolvedValue(null) },
    bookingModification: {
      create: vi.fn().mockResolvedValue({ id: "mod_1" }),
    },
    lodge: {
      findFirst: vi.fn().mockResolvedValue({ id: "lodge-1" }),
    },
  };
}

function makeRequest(body?: unknown) {
  return new NextRequest("https://example.test/api/bookings/b1/guests/g1", {
    method: "DELETE",
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: { "content-type": "application/json" },
  });
}

async function runRemoval(
  removedGuestId: string,
  guests: Guest[],
  body?: unknown,
) {
  mocks.transaction.mockImplementation((cb: (tx: unknown) => unknown) =>
    cb(buildTx(guests)),
  );
  return DELETE(makeRequest(body), {
    params: Promise.resolve({ id: "b1", guestId: removedGuestId }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({
    user: { id: "m1", role: "MEMBER", accessRoles: [{ role: "USER" }] },
  });
  mocks.requireActiveSessionUser.mockResolvedValue(null);
  mocks.memberFindUnique.mockResolvedValue({
    id: "m1",
    email: "owner@example.com",
    firstName: "Pat",
    lastName: "Owner",
  });
  mocks.assertBookingNotQuotePriced.mockResolvedValue(undefined);
  mocks.lockedNightPricesForGuest.mockReturnValue(null);
  mocks.assertMembershipTypeBookingAllowed.mockResolvedValue(undefined);
  // One remaining guest priced trivially (remainingGuests always length 1 here).
  mocks.priceBookingGuestsWithMembershipTypePolicy.mockResolvedValue({
    totalPriceCents: 4000,
    guests: [{ perNightCents: [4000], nightDates: [CHECK_IN], priceCents: 4000 }],
  });
  mocks.calculateModificationSettlementOptions.mockResolvedValue(null);
  mocks.applyPaymentAdjustments.mockResolvedValue({
    refundAmountCents: 0,
    accountCreditAmountCents: 0,
    pendingRefundAmountCents: 0,
    additionalAmountCents: 0,
    settlementMethod: null,
    policyRetainedAmountCents: 0,
    xeroRefundAmountCents: 0,
    xeroAdditionalAmountCents: 0,
    hasSucceededPayment: false,
    hasIssuedXeroInvoice: false,
  });
  // The booking stays PAID (Option A / #1100) — never parked to AWAITING_REVIEW.
  mocks.applyLifecycleTransitions.mockResolvedValue({
    hasNonMembers: false,
    newNonMemberHoldUntil: null,
    newStatus: BookingStatus.PAID,
    zeroDollarAutoPaid: false,
    supersededPrimaryPaymentIntents: [],
  });
  mocks.drainSupersededPrimaryIntents.mockResolvedValue(undefined);
  mocks.executeBookingModificationRefund.mockResolvedValue(null);
  mocks.createModificationAdditionalPaymentIntent.mockResolvedValue({
    additionalPaymentClientSecret: null,
    additionalPaymentIntentId: null,
  });
  mocks.reconcileBedAllocationsForBooking.mockResolvedValue(undefined);
  mocks.queueXeroBookingEditSettlement.mockResolvedValue(undefined);
  mocks.sendBookingModifiedEmail.mockResolvedValue(undefined);
  mocks.sendAdminMinorsOnlyReviewAlert.mockResolvedValue(undefined);
});

describe("DELETE guest removal — minors-only admin alert wiring (#1372)", () => {
  it("alerts admins when removing the last adult leaves a paid booking minors-only", async () => {
    const res = await runRemoval("g-adult", [ADULT, CHILD]);

    expect(res.status).toBe(200);
    // Sanity: the route ran to completion (member email sent).
    expect(mocks.sendBookingModifiedEmail).toHaveBeenCalledTimes(1);
    // The real service flagged it and the route's call site fired the alert
    // with the freshly-written booking's details.
    expect(mocks.sendAdminMinorsOnlyReviewAlert).toHaveBeenCalledTimes(1);
    expect(mocks.sendAdminMinorsOnlyReviewAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        memberName: "Pat Owner",
        checkIn: CHECK_IN,
        checkOut: CHECK_OUT,
        guestCount: 1,
        reviewReason: ADULT_SUPERVISION_REVIEW_REASON,
      }),
    );
  });

  it("does not alert when an adult remains after the removal", async () => {
    const res = await runRemoval("g-child", [ADULT, CHILD]);

    expect(res.status).toBe(200);
    expect(mocks.sendBookingModifiedEmail).toHaveBeenCalledTimes(1);
    expect(mocks.sendAdminMinorsOnlyReviewAlert).not.toHaveBeenCalled();
  });

  it("does not double-fire the alert when the booking was already under review", async () => {
    // Pre-edit booking already carried a pending minors-only review: removing a
    // further guest that keeps it minors-only must not re-alert (#1372).
    mocks.transaction.mockImplementation((cb: (tx: unknown) => unknown) =>
      cb(
        buildTx([ADULT, CHILD], {
          requiresAdminReview: true,
          adminReviewStatus: AdminReviewStatus.PENDING,
          adminReviewReason: ADULT_SUPERVISION_REVIEW_REASON,
        }),
      ),
    );

    const res = await DELETE(makeRequest(), {
      params: Promise.resolve({ id: "b1", guestId: "g-adult" }),
    });

    expect(res.status).toBe(200);
    expect(mocks.sendAdminMinorsOnlyReviewAlert).not.toHaveBeenCalled();
  });

  /**
   * #2675 review — the fixture builder must not invent an ADULT member.
   *
   * `preEditBooking` synthesises the live `Member` relation from `memberId`, and
   * `hostingMemberRow` defaults to ADULT. A member-linked CHILD or YOUTH guest
   * would therefore arrive at `participantQualifiesAsHost` — which reads the
   * MEMBER's tier, not the guest row's — as an adult host, suppressing a hosting
   * violation production would raise. Nothing else in this suite would notice,
   * and this is the MINORS suite: a member-linked minor is exactly the fixture
   * the next test added here will need.
   */
  it("gives a member-linked minor a Member row at the guest's OWN age tier", () => {
    const memberChild: Guest = {
      ...CHILD,
      id: "g-child-member",
      isMember: true,
      memberId: "m-child",
    };

    const guests = preEditBooking([ADULT, memberChild]).guests;

    expect(guests.find((g) => g.id === "g-child-member")?.member).toEqual({
      id: "m-child",
      ageTier: "CHILD",
      active: true,
      cancelledAt: null,
      archivedAt: null,
    });
    // The adult beside them is unchanged, so the pin is about the tier being
    // CARRIED, not about the default being wrong.
    expect(guests.find((g) => g.id === "g-adult")?.member).toEqual(
      expect.objectContaining({ id: "m1", ageTier: "ADULT" }),
    );
    // And a true non-member still gets an explicit null, not a partial row.
    expect(guests.find((g) => g.id === "g-child")).toBeUndefined();
    expect(preEditBooking([CHILD]).guests[0]?.member).toBeNull();
  });
});

// Issue #1705 (#1696 semantics): the per-action member-email choice on the
// standalone guest-removal route. The REAL bookingManagementAuthorizationRole /
// authorizationRoleFromAccessRoles resolve the session, so these pin exactly
// who may suppress: a Full Admin can; the booking owner (and any other
// non-admin) is 403'd before the removal runs.
describe("DELETE guest removal — admin notify choice (#1705)", () => {
  const FULL_ADMIN_SESSION = {
    user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] },
  };

  function removalAuditEntry() {
    return mocks.logAudit.mock.calls
      .map((call) => call[0])
      .find(
        (entry) =>
          (entry as { action?: string })?.action ===
          "booking.modify.guests.remove",
      ) as { metadata: Record<string, unknown> } | undefined;
  }

  it("suppresses the member email and audits the choice when an admin sends notifyMember: false", async () => {
    mocks.auth.mockResolvedValue(FULL_ADMIN_SESSION);

    const res = await runRemoval("g-child", [ADULT, CHILD], {
      notifyMember: false,
    });

    expect(res.status).toBe(200);
    expect(mocks.sendBookingModifiedEmail).not.toHaveBeenCalled();
    const audit = removalAuditEntry();
    expect(audit).toBeDefined();
    expect(audit!.metadata.notifyMember).toBe(false);
  });

  it("emails the member by default when an admin omits the flag (absent = notify, nothing extra recorded)", async () => {
    mocks.auth.mockResolvedValue(FULL_ADMIN_SESSION);

    const res = await runRemoval("g-child", [ADULT, CHILD], {});

    expect(res.status).toBe(200);
    expect(mocks.sendBookingModifiedEmail).toHaveBeenCalledTimes(1);
    expect(removalAuditEntry()!.metadata).not.toHaveProperty("notifyMember");
  });

  it("rejects notifyMember from the booking owner with 403, no removal, no email", async () => {
    // Default session: the booking owner (m1) with only the USER access role —
    // the REAL role helpers resolve them below booking-management ADMIN.
    const res = await runRemoval("g-child", [ADULT, CHILD], {
      notifyMember: false,
    });

    expect(res.status).toBe(403);
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.sendBookingModifiedEmail).not.toHaveBeenCalled();
  });

  it("rejects a non-boolean notifyMember with 400", async () => {
    mocks.auth.mockResolvedValue(FULL_ADMIN_SESSION);

    const res = await runRemoval("g-child", [ADULT, CHILD], {
      notifyMember: "false",
    });

    expect(res.status).toBe(400);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});
