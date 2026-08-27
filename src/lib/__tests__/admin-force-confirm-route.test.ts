import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(undefined),
    $queryRaw: vi.fn().mockResolvedValue([]),
    lodge: {
      findFirst: vi.fn().mockResolvedValue({ id: "lodge-1" }),
    },
    booking: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    payment: {
      upsert: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
  };

  return {
    tx,
    transaction: vi.fn(),
    requireAdmin: vi.fn(),
    checkCapacityForGuestRanges: vi.fn(),
    requiresAdultSupervisionReview: vi.fn(),
    reconcileBedAllocationsForBooking: vi.fn(),
    sendBookingConfirmedEmail: vi.fn(),
    // #2576 §9: a waitlist force-confirm IS a confirmation, so it records the
    // bounded hosting re-evaluation in the claim transaction and drains it after.
    enqueueOwnHostingCoverageReevaluation: vi.fn(),
    settleHostingCoverageAfterCommit: vi.fn(),
    // Split-parent describe helper reads the provisional non-member child via
    // prisma.booking.findFirst; default null = not a split parent.
    prismaBookingFindFirst: vi.fn().mockResolvedValue(null),
    clubTimeSettingsFindUnique: vi.fn(),
    loggerError: vi.fn(),
  };
});

vi.mock("@/lib/session-guards", () => ({
  requireAdmin: mocks.requireAdmin,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    lodge: {
      findFirst: vi.fn().mockResolvedValue({ id: "lodge-1" }),
    },
    booking: {
      findFirst: mocks.prismaBookingFindFirst,
    },
    // CT-4 (#2870): the finished-stay cut-off is the club's calendar day, read
    // from `ClubTimeSettings`. Without this delegate
    // `loadPersistedClubTimeSettings()` returns null — it is fail-soft by design
    // — and the route falls back to the container's `TZ` in silence, so a suite
    // that omits it cannot tell the two authorities apart.
    clubTimeSettings: { findUnique: mocks.clubTimeSettingsFindUnique },
    $transaction: mocks.transaction,
  },
}));

vi.mock("@/lib/capacity", () => ({
  checkCapacityForGuestRanges: mocks.checkCapacityForGuestRanges,
  acquireLodgeCapacityLock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/booking-review", () => ({
  requiresAdultSupervisionReview: mocks.requiresAdultSupervisionReview,
}));

vi.mock("@/lib/bed-allocation-lifecycle", () => ({
  reconcileBedAllocationsForBookingWithGlobalLockHeld:
    mocks.reconcileBedAllocationsForBooking,
}));

vi.mock("@/lib/email", () => ({
  sendBookingConfirmedEmail: mocks.sendBookingConfirmedEmail,
}));

vi.mock("@/lib/logger", () => ({
  default: {
    error: mocks.loggerError,
  },
}));

// #2576 §9. Mocked at the module boundary like every other collaborator here. The real
// seam reads `booking.findUnique` and the lodge policy through the transaction client,
// and this suite's fake `tx` carries only the delegates the force-confirm itself needs
// — so without these the claim throws and the route answers 500, which is how this
// suite caught the change.
//
// WHAT THE ROUTE NEEDED IT FOR: WAITLISTED and WAITLIST_OFFERED are both outside
// `ACTIVE_BOOKING_STATUSES`, so a waitlisted booking is invisible to the strand check
// that guards a source cancellation. A member could cancel the booking supplying cover
// (nothing stranded, nothing queued) and an officer force-confirm this one straight to
// PAID with no hosting evaluation at all.
vi.mock("@/lib/adult-member-hosting-review", () => ({
  enqueueOwnHostingCoverageReevaluation:
    mocks.enqueueOwnHostingCoverageReevaluation,
}));

vi.mock("@/lib/adult-member-hosting-coverage-drain", () => ({
  settleHostingCoverageAfterCommit: mocks.settleHostingCoverageAfterCommit,
}));

import { POST } from "@/app/api/admin/bookings/[id]/force-confirm/route";
import { APP_TIME_ZONE } from "@/config/operational";
import { addDaysDateOnly, getTodayDateOnly } from "@/lib/date-only";

/**
 * The zone this suite PERSISTS, named once (#3123). The relative fixtures
 * below follow the club's own day, which is the authority the route reads;
 * the one case that persists `America/Denver` writes its own absolute stay
 * dates rather than deriving them.
 */
const CLUB_ZONE = "Pacific/Auckland";

function forceConfirmRequest(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/admin/bookings/booking-1/force-confirm", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-request-id": "request-1",
      "x-forwarded-for": "203.0.113.5",
      "user-agent": "vitest",
    },
    body: JSON.stringify(body),
  });
}

/** Persist a club timezone for the route's `clubTime()` read to resolve. */
function persistClubZone(timeZone: string) {
  mocks.clubTimeSettingsFindUnique.mockResolvedValue({
    timeZone,
    updatedByMemberId: null,
    updatedAt: new Date(0),
  });
}

function routeParams() {
  return {
    params: Promise.resolve({ id: "booking-1" }),
  };
}

function waitlistBooking() {
  return {
    id: "booking-1",
    memberId: "member-1",
    status: "WAITLIST_OFFERED",
    checkIn: new Date("2026-07-01T00:00:00.000Z"),
    checkOut: new Date("2026-07-03T00:00:00.000Z"),
    finalPriceCents: 12000,
    discountCents: 0,
    promoAdjustmentCents: 0,
    requiresAdminReview: false,
    adminReviewStatus: "APPROVED",
    adminReviewReason: null,
    waitlistPosition: null,
    waitlistOfferedAt: new Date("2026-06-01T00:00:00.000Z"),
    waitlistOfferExpiresAt: new Date("2026-06-03T00:00:00.000Z"),
    guests: [
      {
        id: "guest-1",
        isMember: true,
        nights: [],
      },
    ],
    member: {
      id: "member-1",
      email: "member@example.com",
      firstName: "Alex",
    },
    promoRedemption: null,
  };
}

function overbookedCapacity() {
  return {
    available: false,
    minAvailable: -1,
    nightDetails: [
      {
        date: new Date("2026-07-01T00:00:00.000Z"),
        occupiedBeds: 30,
        availableBeds: -1,
      },
      {
        date: new Date("2026-07-02T00:00:00.000Z"),
        occupiedBeds: 29,
        availableBeds: 0,
      },
    ],
  };
}

describe("POST /api/admin/bookings/[id]/force-confirm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({
      ok: true,
      session: { user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } },
    });
    mocks.transaction.mockImplementation(async (fn) => fn(mocks.tx));
    mocks.tx.booking.findUnique.mockResolvedValue(waitlistBooking());
    mocks.tx.booking.update.mockResolvedValue({});
    mocks.tx.auditLog.create.mockResolvedValue({});
    mocks.checkCapacityForGuestRanges.mockResolvedValue(overbookedCapacity());
    mocks.requiresAdultSupervisionReview.mockReturnValue(false);
    mocks.reconcileBedAllocationsForBooking.mockResolvedValue(undefined);
    persistClubZone(CLUB_ZONE);
  });

  it("reports overbook dates without committing when override is not explicit", async () => {
    const response = await POST(forceConfirmRequest({}), routeParams());
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toEqual({
      error: "CAPACITY_EXCEEDED",
      overbookDates: ["2026-07-01"],
    });
    expect(mocks.tx.booking.update).not.toHaveBeenCalled();
    expect(mocks.tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("writes critical overbook audit evidence in the force-confirm transaction", async () => {
    const response = await POST(
      forceConfirmRequest({ allowOverbook: true }),
      routeParams(),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      auditAction: "waitlist.force_confirmed_overbook",
      overbooked: true,
      overbookDates: ["2026-07-01"],
      status: "PAYMENT_PENDING",
    });
    expect(mocks.tx.booking.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "booking-1" },
        data: expect.objectContaining({
          status: "PAYMENT_PENDING",
          waitlistPosition: null,
          waitlistOfferedAt: null,
          waitlistOfferExpiresAt: null,
        }),
      }),
    );
    expect(mocks.tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "waitlist.force_confirmed_overbook",
        actorMemberId: "admin-1",
        memberId: "admin-1",
        subjectMemberId: "member-1",
        targetId: "booking-1",
        entityType: "Booking",
        entityId: "booking-1",
        category: "booking",
        severity: "critical",
        outcome: "success",
        retentionClass: "critical",
        incidentPreserved: true,
        requestId: "request-1",
        ipAddress: "203.0.113.5",
        userAgent: "vitest",
        metadata: expect.objectContaining({
          previousStatus: "WAITLIST_OFFERED",
          nextStatus: "PAYMENT_PENDING",
          allowOverbook: true,
          overbooked: true,
          overbookDates: ["2026-07-01"],
          overbookedNights: [{ date: "2026-07-01", availableBeds: -1 }],
          guestCount: 1,
          finalPriceCents: 12000,
          parkedForAdminReview: false,
        }),
      }),
    });
  });

  // #1771 — an overbook force-confirm stamps the persisted capacity override on
  // the booking (who + when), so every downstream payment-time re-check honours
  // it and never cancels the deliberately-admitted booking.
  it("stamps the persisted capacity override on an overbook force-confirm (#1771)", async () => {
    const response = await POST(
      forceConfirmRequest({ allowOverbook: true }),
      routeParams(),
    );

    expect(response.status).toBe(200);
    expect(mocks.tx.booking.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          capacityOverriddenAt: expect.any(Date),
          capacityOverriddenByMemberId: "admin-1",
        }),
      }),
    );
  });

  it("does NOT stamp the capacity override when the force-confirm fits within capacity (#1771)", async () => {
    mocks.checkCapacityForGuestRanges.mockResolvedValue({
      available: true,
      nightDetails: [],
    });

    const response = await POST(forceConfirmRequest({}), routeParams());

    expect(response.status).toBe(200);
    const updateData = mocks.tx.booking.update.mock.calls[0][0].data;
    expect(updateData).not.toHaveProperty("capacityOverriddenAt");
    expect(updateData).not.toHaveProperty("capacityOverriddenByMemberId");
  });

  // ADR-001 decision 5 (issue #118): an exclusive whole-lodge hold on the
  // target nights is NOT bypassable — even with allowOverbook the force-confirm
  // is refused and nothing advances.
  describe("whole-lodge hold non-bypass (issue #118)", () => {
    function heldCapacity() {
      return {
        available: false,
        minAvailable: 0,
        nightDetails: [
          {
            date: new Date("2026-07-01T00:00:00.000Z"),
            occupiedBeds: 8,
            // Pinned to 0 (never negative), so it never shows in overbookDates.
            availableBeds: 0,
            wholeLodgeHeld: true,
          },
          {
            date: new Date("2026-07-02T00:00:00.000Z"),
            occupiedBeds: 8,
            availableBeds: 0,
            wholeLodgeHeld: true,
          },
        ],
      };
    }

    it("refuses with 409 WHOLE_LODGE_HOLD_BLOCKED even when allowOverbook is set, committing nothing", async () => {
      mocks.checkCapacityForGuestRanges.mockResolvedValue(heldCapacity());

      const response = await POST(
        forceConfirmRequest({ allowOverbook: true }),
        routeParams(),
      );
      const body = await response.json();

      expect(response.status).toBe(409);
      expect(body.error).toBe("WHOLE_LODGE_HOLD_BLOCKED");
      expect(body.code).toBe("WHOLE_LODGE_HOLD_BLOCKED");
      expect(body.blockedNights).toEqual(["2026-07-01", "2026-07-02"]);
      // No booking advances onto a held night; no audit row is written.
      expect(mocks.tx.booking.update).not.toHaveBeenCalled();
      expect(mocks.tx.auditLog.create).not.toHaveBeenCalled();
    });
  });

  // #1723 path 1 (owner decision B): a past-dated force-confirm that lands
  // PAYMENT_PENDING is allowed but flagged at creation — in the response and
  // in the audit trail — because it creates an unpaid finished stay. Stay
  // dates are derived from the real clock (the route compares against NZ
  // today), never hardcoded calendar dates that would rot.
  describe("unpaid finished stay flagging (#1723 path 1)", () => {
    function bookingWithStay(
      days: { checkIn: number; checkOut: number },
      overrides: Record<string, unknown> = {},
    ) {
      return {
        ...waitlistBooking(),
        checkIn: addDaysDateOnly(getTodayDateOnly(CLUB_ZONE), days.checkIn),
        checkOut: addDaysDateOnly(getTodayDateOnly(CLUB_ZONE), days.checkOut),
        ...overrides,
      };
    }

    beforeEach(() => {
      // These tests pin the finished-stay flag, not capacity: leave capacity
      // clear so no overbook override is involved.
      mocks.checkCapacityForGuestRanges.mockResolvedValue({
        available: true,
        minAvailable: 3,
        nightDetails: [],
      });
      mocks.sendBookingConfirmedEmail.mockResolvedValue(undefined);
    });

    it("flags a past-dated force-confirm that lands PAYMENT_PENDING", async () => {
      mocks.tx.booking.findUnique.mockResolvedValue(
        bookingWithStay({ checkIn: -10, checkOut: -8 }),
      );

      const response = await POST(forceConfirmRequest({}), routeParams());
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        success: true,
        status: "PAYMENT_PENDING",
        unpaidFinishedStay: true,
      });
      expect(mocks.tx.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          details: expect.stringContaining("created an unpaid finished stay"),
          metadata: expect.objectContaining({
            createdUnpaidFinishedStay: true,
            nextStatus: "PAYMENT_PENDING",
          }),
        }),
      });
    });

    it("treats a stay checking out today as already finished (matches the queue cutoff)", async () => {
      mocks.tx.booking.findUnique.mockResolvedValue(
        bookingWithStay({ checkIn: -2, checkOut: 0 }),
      );

      const response = await POST(forceConfirmRequest({}), routeParams());
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toMatchObject({ unpaidFinishedStay: true });
    });

    it("does not flag a future-dated stay", async () => {
      mocks.tx.booking.findUnique.mockResolvedValue(
        bookingWithStay({ checkIn: 5, checkOut: 7 }),
      );

      const response = await POST(forceConfirmRequest({}), routeParams());
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        status: "PAYMENT_PENDING",
        unpaidFinishedStay: false,
      });
      expect(mocks.tx.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          metadata: expect.objectContaining({
            createdUnpaidFinishedStay: false,
          }),
        }),
      });
    });

    it("does not flag a past-dated $0 force-confirm (lands PAID with no card obligation)", async () => {
      mocks.tx.booking.findUnique.mockResolvedValue(
        bookingWithStay({ checkIn: -10, checkOut: -8 }, { finalPriceCents: 0 }),
      );
      mocks.tx.payment.upsert.mockResolvedValue({});

      const response = await POST(forceConfirmRequest({}), routeParams());
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        status: "PAID",
        unpaidFinishedStay: false,
      });
    });

    /*
      CT-4 (#2870), epic #2988 — WHICH "today" the flag is measured against.

      The cases above derive their fixtures from the club's own day
      (`CLUB_ZONE`, persisted in `beforeEach`) rather than from a helper
      default (#3123), so a boundary case like "checks out today" follows the
      authority the route reads. While that zone and the environment agree they
      still cannot tell the two apart, which is what this case is for. It
      pins an absolute check-out and persists a club zone the environment
      disagrees with, so the answer is attributable.

      The frozen clock is 2026-07-01T00:00:00Z: midday on 1 July in New Zealand
      and still the evening of 30 JUNE in Denver. A stay checking out on 1 July
      is therefore FINISHED for the environment and STILL RUNNING for the club —
      and the flag decides whether an officer is told they just created an
      unpaid finished stay, and whether the audit trail says so.
    */
    it("measures the finished-stay cut-off against the PERSISTED club day", async () => {
      persistClubZone("America/Denver");

      // The premise, as an answer rather than a zone identifier: two different
      // zone names can still name the same day, and then this proves nothing.
      expect(
        getTodayDateOnly(APP_TIME_ZONE).toISOString(),
        "INV-CONFIG-002: the environment authority now names the same day as " +
          "the persisted club zone, so this flag cannot tell the two apart.",
      ).not.toBe("2026-06-30T00:00:00.000Z");

      mocks.tx.booking.findUnique.mockResolvedValue({
        ...waitlistBooking(),
        checkIn: new Date("2026-06-29T00:00:00.000Z"),
        checkOut: new Date("2026-07-01T00:00:00.000Z"),
      });

      const response = await POST(forceConfirmRequest({}), routeParams());
      const body = await response.json();

      expect(response.status).toBe(200);
      // 1 July is still ahead of the club's 30 June, so nothing finished.
      // Against the environment's 1 July this would have come back `true`.
      expect(body).toMatchObject({
        status: "PAYMENT_PENDING",
        unpaidFinishedStay: false,
      });
      expect(mocks.tx.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          metadata: expect.objectContaining({
            createdUnpaidFinishedStay: false,
          }),
        }),
      });
    });

    it("does not flag a past-dated stay parked for admin review", async () => {
      mocks.tx.booking.findUnique.mockResolvedValue(
        bookingWithStay(
          { checkIn: -10, checkOut: -8 },
          { adminReviewStatus: "PENDING" },
        ),
      );
      mocks.requiresAdultSupervisionReview.mockReturnValue(true);

      const response = await POST(forceConfirmRequest({}), routeParams());
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        status: "AWAITING_REVIEW",
        unpaidFinishedStay: false,
      });
      // #2576 §9: nothing to re-evaluate, because nothing confirmed. The booking
      // parked for review instead, so recording a coverage obligation against it
      // would put a stay nobody has accepted in front of an officer as an emergency —
      // the same reason `reconcileSameOwnerCoverageIncident` opens nothing for a
      // booking outside the confirmed-and-paid set.
      expect(mocks.enqueueOwnHostingCoverageReevaluation).not.toHaveBeenCalled();
    });
  });

  // #2576 §9. A force-confirm is a confirmation — the owner's decision names "officer
  // approval" and "waitlist promotion" explicitly — and WAITLISTED / WAITLIST_OFFERED
  // are both outside `ACTIVE_BOOKING_STATUSES`, so a waitlisted booking is invisible
  // to the strand check that guards a source cancellation. A member could cancel the
  // booking supplying their cover (nothing stranded, nothing queued, cancel allowed)
  // and an officer force-confirm this one straight to PAID with no hosting evaluation
  // at all.
  describe("hosting coverage re-evaluation (#2576 §9)", () => {
    it("records the obligation in the claim transaction and drains it after commit", async () => {
      mocks.checkCapacityForGuestRanges.mockResolvedValue({
        available: true,
        minAvailable: 3,
        nightDetails: [],
      });
      mocks.tx.booking.findUnique.mockResolvedValue(waitlistBooking());

      const response = await POST(forceConfirmRequest({}), routeParams());
      expect(response.status).toBe(200);

      // ENQUEUE rather than refuse: the officer's deliberate act on a booking whose
      // beds have just been claimed, possibly over capacity, so §8 applies — allow the
      // authoritative change, record the obligation with it, escalate afterwards.
      expect(mocks.enqueueOwnHostingCoverageReevaluation).toHaveBeenCalledTimes(1);
      const [bookingId, client, context] =
        mocks.enqueueOwnHostingCoverageReevaluation.mock.calls[0];
      expect(bookingId).toBe("booking-1");
      // The CLAIM's transaction client, so the queue row and the status flip commit
      // together and the obligation cannot be lost.
      expect(client).toBe(mocks.tx);
      expect(context).toMatchObject({ cause: "SYSTEM_CHANGE" });
      // Drained after the commit, never inside it.
      expect(mocks.settleHostingCoverageAfterCommit).toHaveBeenCalledWith({
        bookingId: "booking-1",
      });
    });
  });

  // #1769b (#1705 semantics): the admin's per-action member-email choice. The
  // confirmation email only sends when the force-confirm lands PAID (a $0 stay
  // with review resolved and capacity available), so that is the only outcome a
  // suppression is real — the audit records `notifyMember: false` only there.
  describe("member-email notify choice (#1769b)", () => {
    function zeroDollarBooking(overrides: Record<string, unknown> = {}) {
      return { ...waitlistBooking(), finalPriceCents: 0, ...overrides };
    }

    beforeEach(() => {
      mocks.checkCapacityForGuestRanges.mockResolvedValue({
        available: true,
        minAvailable: 3,
        nightDetails: [],
      });
      mocks.tx.booking.findUnique.mockResolvedValue(zeroDollarBooking());
      mocks.tx.payment.upsert.mockResolvedValue({});
      mocks.sendBookingConfirmedEmail.mockResolvedValue(undefined);
    });

    it("emails the member and records no notify field by default (lands PAID)", async () => {
      const response = await POST(forceConfirmRequest({}), routeParams());
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.status).toBe("PAID");
      expect(mocks.sendBookingConfirmedEmail).toHaveBeenCalledTimes(1);
      const metadata =
        mocks.tx.auditLog.create.mock.calls[0][0].data.metadata;
      expect(metadata).not.toHaveProperty("notifyMember");
    });

    it("threads the provisional non-member child into the split-parent force-confirm confirmation email (#1942 FIX 4b)", async () => {
      const holdUntil = new Date("2026-06-25T00:00:00.000Z");
      mocks.prismaBookingFindFirst.mockResolvedValue({
        nonMemberHoldUntil: holdUntil,
        _count: { guests: 3 },
      });

      const response = await POST(forceConfirmRequest({}), routeParams());
      expect(response.status).toBe(200);

      expect(mocks.sendBookingConfirmedEmail).toHaveBeenCalledTimes(1);
      const options = mocks.sendBookingConfirmedEmail.mock.calls[0][7];
      expect(options).toMatchObject({
        provisionalGuests: { guestCount: 3, holdUntil },
      });
    });

    it("suppresses the email and records notifyMember:false when notifyMember is false", async () => {
      const response = await POST(
        forceConfirmRequest({ notifyMember: false }),
        routeParams(),
      );

      expect(response.status).toBe(200);
      expect(mocks.sendBookingConfirmedEmail).not.toHaveBeenCalled();
      const metadata =
        mocks.tx.auditLog.create.mock.calls[0][0].data.metadata;
      expect(metadata).toMatchObject({ notifyMember: false });
    });

    it("emails and records no notify field when notifyMember is true", async () => {
      const response = await POST(
        forceConfirmRequest({ notifyMember: true }),
        routeParams(),
      );

      expect(response.status).toBe(200);
      expect(mocks.sendBookingConfirmedEmail).toHaveBeenCalledTimes(1);
      const metadata =
        mocks.tx.auditLog.create.mock.calls[0][0].data.metadata;
      expect(metadata).not.toHaveProperty("notifyMember");
    });

    it("rejects a non-boolean notifyMember with 400 and runs no transaction", async () => {
      const response = await POST(
        forceConfirmRequest({ notifyMember: "false" }),
        routeParams(),
      );

      expect(response.status).toBe(400);
      expect(mocks.transaction).not.toHaveBeenCalled();
      expect(mocks.sendBookingConfirmedEmail).not.toHaveBeenCalled();
    });

    it("records NO notify field on a priced force-confirm that lands PAYMENT_PENDING even with notifyMember:false", async () => {
      // Priced booking never lands PAID, so no confirmation email is sent and a
      // suppression there is not real — the honesty rule records no field.
      mocks.tx.booking.findUnique.mockResolvedValue(waitlistBooking());

      const response = await POST(
        forceConfirmRequest({ notifyMember: false }),
        routeParams(),
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.status).toBe("PAYMENT_PENDING");
      expect(mocks.sendBookingConfirmedEmail).not.toHaveBeenCalled();
      const metadata =
        mocks.tx.auditLog.create.mock.calls[0][0].data.metadata;
      expect(metadata).not.toHaveProperty("notifyMember");
    });
  });
});
