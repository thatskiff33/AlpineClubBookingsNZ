import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FeatureFlags } from "@/config/schema";
import {
  MANUAL_SETTLEMENT_CONFLICT_EVENT_REASON,
  MANUAL_SETTLEMENT_REVERSAL_EVENT_REASON,
} from "@/lib/manual-settlement-reversal-event";
import {
  getStuckStateDashboard,
  type StuckStateDashboardDependencies,
} from "@/lib/stuck-state-dashboard";

const modulesOn: FeatureFlags = {
  kiosk: true,
  chores: true,
  financeDashboard: true,
  waitlist: true,
  xeroIntegration: true,
  bedAllocation: true,
  internetBankingPayments: true,
  addressAutocomplete: true,
  groupBookings: true,
  lockers: true,
  induction: true,
  workParties: true,
  promoCodes: true,
  hutLeaders: true,
  communications: true,
  skifieldConditions: true,
  twoFactor: false,
  magicLink: false,
  googleLogin: false,
  analytics: false,
  lobbyDisplay: false,
  aiAssistant: false,
  memberNotices: true,
  eventsCalendar: true,
  memberGuests: false,
  aiDiagnostics: false,
  maintenanceReports: true,
  alpineCentralServer: false,
  commsPortal: false,
};

function emptyEmailResponses() {
  return {
    deliverability: {
      summary: {
        activeCount: 0,
        bounceCount: 0,
        complaintCount: 0,
        eventsLast24h: 0,
      },
      suppressions: [],
    },
    exhaustedFailures: {
      summary: {
        activeCount: 0,
        reviewedCount: 0,
        scannedCount: 0,
        maxAttempts: 3,
      },
      failures: [],
      recentlyReviewed: [],
    },
    adminAlertDelivery: {
      summary: {
        recentCount: 0,
        lookbackDays: 7,
      },
      escalations: [],
    },
    tokenRecovery: {
      summary: {
        activeCount: 0,
        reissuedCount: 0,
        scannedCount: 0,
      },
      failures: [],
      recentlyReissued: [],
    },
  };
}

/**
 * `count` uncovered lodge-nights at ONE lodge (#2917) — the shape a single-lodge
 * club produces, and what these totals assertions have always meant. Real rows,
 * not `Array.from({ length: n })`: the rows carry a lodge and an active flag the
 * tile can read, so a bare-length stand-in would no longer model the real result.
 */
function uncoveredLodgeNights(count: number, lodgeId = "lodge-1") {
  return Array.from({ length: count }, (_unused, index) => ({
    date: `2026-07-${String(index + 1).padStart(2, "0")}`,
    lodgeId,
    lodgeName: `Lodge ${lodgeId}`,
    lodgeActive: true,
    bookingCount: 1,
    guestCount: 1,
  }));
}

function buildDeps(overrides?: Partial<StuckStateDashboardDependencies>) {
  const emails = emptyEmailResponses();
  const deps: StuckStateDashboardDependencies = {
    db: {
      paymentRecoveryOperation: {
        count: vi.fn(),
      },
      // #2576: active same-owner hosting-coverage incidents (the critical officer
      // card). Zero by default so every existing expectation is unchanged.
      hostingCoverageIncident: {
        count: vi.fn().mockResolvedValue(0),
        findMany: vi.fn().mockResolvedValue([]),
      },
      booking: {
        findMany: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockResolvedValue(0),
      },
      groupBookingSettlement: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      issueReport: {
        count: vi.fn().mockResolvedValue(0),
      },
    },
    loadEffectiveModuleFlags: vi.fn().mockResolvedValue(modulesOn),
    getXeroAdminHealthSnapshot: vi.fn().mockResolvedValue({
      unlinkedMembers: { count: 0, href: "/admin/members" },
      failedOperations: { count: 0, legacyCount: 0 },
      pendingOperations: { count: 0 },
      staleRunningOperations: { count: 0, thresholdMinutes: 30 },
      staleProcessingInboundEvents: { count: 0, thresholdMinutes: 30 },
      lastMembershipRefresh: {
        at: null,
        lastCronStatus: null,
        lastCronStartedAt: null,
      },
      missingInvoices: { count: 0 },
      refundsMissingCreditNotes: { count: 0, graceHours: 24 },
      contactGroupMismatches: { count: 0, cacheReady: true },
      contactLinkMismatches: { count: 0, cacheReady: true },
      apiBudget: {
        status: "healthy",
        usagePercent: 10,
        totalCalls: 10,
        failedCalls: 0,
      },
    }),
    getEmailDeliverabilityTelemetry: vi.fn().mockResolvedValue(emails.deliverability),
    getExhaustedEmailFailureReviewQueue: vi
      .fn()
      .mockResolvedValue(emails.exhaustedFailures),
    getAdminAlertDeliveryEscalations: vi
      .fn()
      .mockResolvedValue(emails.adminAlertDelivery),
    getTokenEmailRecoveryQueue: vi.fn().mockResolvedValue(emails.tokenRecovery),
    // #2716: members the club has no way to reach — the admin-visible half of
    // direct-parent-only email inheritance. Defaulted to "none", because the
    // dashboard suppresses a zero-count item and every other test here would
    // otherwise grow an extra row it says nothing about.
    getUnreachableMemberSummary: vi.fn().mockResolvedValue({
      total: 0,
      inheritanceUnresolved: 0,
      members: [],
    }),
    getWaitlistOfferEmailDeliveries: vi.fn().mockResolvedValue(new Map()),
    countUnconfirmedSchoolAttendeeLists: vi.fn().mockResolvedValue(0),
    countBookingsWithUnnamedPlaceholderGuests: vi.fn().mockResolvedValue(0),
    getBedAllocationDashboard: vi.fn().mockResolvedValue({
      unallocatedGuestNights: [],
      suggestedUnallocatedGuestNights: [],
      warnings: [],
    }),
    getUnassignedHutLeaderDates: vi.fn().mockResolvedValue([]),
    loadHutLeaderLookaheadDays: vi.fn().mockResolvedValue(14),
    // A single-lodge club unless a test says otherwise: the hut-leader tile's
    // unit and wording are keyed on the CLUB's active-lodge count (#2917
    // review), not on how many lodges its rows happen to span.
    countActiveLodges: vi.fn().mockResolvedValue(1),
  };

  return {
    ...deps,
    ...overrides,
    db: {
      ...deps.db,
      ...overrides?.db,
      hostingCoverageIncident: {
        ...deps.db.hostingCoverageIncident,
        ...overrides?.db?.hostingCoverageIncident,
      },
    },
  };
}

describe("getStuckStateDashboard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("aggregates payment, Xero, email, waitlist, bed allocation, and lodge stuck states", async () => {
    const paymentCount = vi
      .fn()
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(3);
    const waitlistBookings = [
      {
        id: "booking-expired",
        status: "WAITLIST_OFFERED",
        waitlistOfferedAt: new Date("2026-06-21T00:00:00.000Z"),
        waitlistOfferExpiresAt: new Date("2026-06-21T23:00:00.000Z"),
        noEmails: false,
        member: { email: "one@example.org" },
      },
      {
        id: "booking-current",
        status: "WAITLIST_OFFERED",
        waitlistOfferedAt: new Date("2026-06-21T00:00:00.000Z"),
        waitlistOfferExpiresAt: new Date("2026-06-23T00:00:00.000Z"),
        noEmails: false,
        member: { email: "two@example.org" },
      },
    ];
    const deps = buildDeps({
      db: {
        paymentRecoveryOperation: { count: paymentCount },
        hostingCoverageIncident: {
          count: vi.fn().mockResolvedValue(0),
          findMany: vi.fn().mockResolvedValue([]),
        },
        booking: {
          findMany: vi.fn().mockResolvedValue(waitlistBookings),
          // #1349 crash-window detector: cancelled bookings holding a captured
          // payment with no recorded refund, recovery op, or narrative event.
          count: vi.fn().mockResolvedValue(4),
        },
        groupBookingSettlement: {
          findMany: vi.fn().mockResolvedValue([]),
        },
        issueReport: {
          count: vi.fn().mockResolvedValue(17),
        },
      },
      getXeroAdminHealthSnapshot: vi.fn().mockResolvedValue({
        unlinkedMembers: { count: 0, href: "/admin/members" },
        failedOperations: { count: 6, legacyCount: 0 },
        pendingOperations: { count: 0 },
        staleRunningOperations: { count: 7, thresholdMinutes: 30 },
        staleProcessingInboundEvents: { count: 8, thresholdMinutes: 30 },
        lastMembershipRefresh: {
          at: null,
          lastCronStatus: null,
          lastCronStartedAt: null,
        },
        missingInvoices: { count: 9 },
        refundsMissingCreditNotes: { count: 10, graceHours: 24 },
        contactGroupMismatches: { count: 12, cacheReady: true },
        contactLinkMismatches: { count: 11, cacheReady: true },
        apiBudget: {
          status: "warning",
          usagePercent: 85,
          totalCalls: 850,
          failedCalls: 1,
        },
      }),
      getEmailDeliverabilityTelemetry: vi.fn().mockResolvedValue({
        summary: {
          activeCount: 4,
          bounceCount: 3,
          complaintCount: 1,
          eventsLast24h: 5,
        },
        suppressions: [],
      }),
      getExhaustedEmailFailureReviewQueue: vi.fn().mockResolvedValue({
        summary: {
          activeCount: 5,
          reviewedCount: 0,
          scannedCount: 5,
          maxAttempts: 3,
        },
        failures: [],
        recentlyReviewed: [],
      }),
      getAdminAlertDeliveryEscalations: vi.fn().mockResolvedValue({
        summary: {
          recentCount: 1,
          lookbackDays: 7,
        },
        escalations: [],
      }),
      getTokenEmailRecoveryQueue: vi.fn().mockResolvedValue({
        summary: {
          activeCount: 2,
          reissuedCount: 0,
          scannedCount: 2,
        },
        failures: [],
        recentlyReissued: [],
      }),
      getWaitlistOfferEmailDeliveries: vi.fn().mockResolvedValue(
        new Map([
          ["booking-expired", { needsOperatorAction: true }],
          ["booking-current", { needsOperatorAction: false }],
        ]),
      ),
      getBedAllocationDashboard: vi.fn().mockResolvedValue({
        unallocatedGuestNights: Array.from({ length: 13 }),
        suggestedUnallocatedGuestNights: Array.from({ length: 14 }),
        warnings: Array.from({ length: 15 }),
      }),
      getUnassignedHutLeaderDates: vi
        .fn()
        .mockResolvedValue(uncoveredLodgeNights(16)),
    });

    const dashboard = await getStuckStateDashboard({
      deps,
      now: new Date("2026-06-22T00:00:00.000Z"),
    });

    expect(dashboard.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "payment-recovery-exhausted",
          severity: "critical",
          owner: "Finance",
          count: 2,
        }),
        // #1349 (F2): CANCELLED bookings whose captured payment shows no
        // recorded refund, no recovery operation, and no cancellation
        // narrative — the crash-window signature that previously fired nothing.
        expect.objectContaining({
          id: "payment-cancelled-refund-unrecorded",
          severity: "critical",
          owner: "Finance",
          count: 4,
        }),
        expect.objectContaining({
          id: "xero-refunds-missing-credit-notes",
          severity: "critical",
          owner: "Finance",
          count: 10,
        }),
        expect.objectContaining({
          id: "email-token-recovery",
          severity: "critical",
          owner: "Admin",
          count: 2,
        }),
        expect.objectContaining({
          id: "waitlist-offer-email-failures",
          severity: "critical",
          owner: "Admin",
          count: 1,
        }),
        expect.objectContaining({
          id: "bed-allocation-unplaceable",
          severity: "critical",
          owner: "Lodge",
          count: 14,
        }),
        expect.objectContaining({
          id: "lodge-unassigned-hut-leaders",
          severity: "warning",
          owner: "Lodge",
          count: 16,
        }),
      ]),
    );
    expect(
      dashboard.domains.find((domain) => domain.domain === "waitlist"),
    ).toMatchObject({
      count: 2,
      itemCount: 2,
      highestSeverity: "critical",
    });
    expect(dashboard.totals.itemCount).toBeGreaterThan(10);
    expect(dashboard.totals.critical).toBeGreaterThan(0);
    expect(deps.getUnassignedHutLeaderDates).toHaveBeenCalledWith({
      lookAheadDays: 14,
      scope: { kind: "all" },
    });
  });

  it("uses configured hut-leader lookahead for lodge stuck-state counts", async () => {
    const getUnassignedHutLeaderDates = vi
      .fn()
      .mockResolvedValue(uncoveredLodgeNights(3));
    const deps = buildDeps({
      loadHutLeaderLookaheadDays: vi.fn().mockResolvedValue(21),
      getUnassignedHutLeaderDates,
    });
    vi.mocked(deps.db.paymentRecoveryOperation.count)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0);

    const dashboard = await getStuckStateDashboard({
      deps,
      now: new Date("2026-06-22T00:00:00.000Z"),
    });

    expect(getUnassignedHutLeaderDates).toHaveBeenCalledWith({
      lookAheadDays: 21,
      scope: { kind: "all" },
    });
    expect(
      dashboard.items.find((item) => item.id === "lodge-unassigned-hut-leaders"),
    ).toMatchObject({
      // Title and summary must name the SAME unit: a heading saying "dates"
      // over a count of lodge-nights is the conflation #2917 removes.
      title: "Unassigned hut leader lodge dates",
      count: 3,
      summary:
        "3 upcoming lodge dates in the next 21 days with bookings have no hut leader assigned.",
    });
  });

  it("counts uncovered LODGE-nights and says so on a multi-lodge club (#2917)", async () => {
    // Two lodges uncovered on the same two nights: four lodge-nights of work,
    // which the tile must not collapse to two dates.
    const getUnassignedHutLeaderDates = vi.fn().mockResolvedValue([
      ...uncoveredLodgeNights(2, "lodge-1"),
      ...uncoveredLodgeNights(2, "lodge-2"),
    ]);
    const deps = buildDeps({
      loadHutLeaderLookaheadDays: vi.fn().mockResolvedValue(21),
      getUnassignedHutLeaderDates,
      countActiveLodges: vi.fn().mockResolvedValue(2),
    });
    vi.mocked(deps.db.paymentRecoveryOperation.count)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0);

    const dashboard = await getStuckStateDashboard({
      deps,
      now: new Date("2026-06-22T00:00:00.000Z"),
    });

    expect(
      dashboard.items.find((item) => item.id === "lodge-unassigned-hut-leaders"),
    ).toMatchObject({
      title: "Unassigned hut leader lodge-nights",
      count: 4,
      summary:
        "4 upcoming lodge-nights in the next 21 days with bookings have no hut leader assigned.",
    });
  });

  it("USES THE LODGE-NIGHT UNIT ON A MULTI-LODGE CLUB WHOSE ROWS ALL SIT AT ONE LODGE (#2917)", async () => {
    // Three active lodges, two of them covered for the whole lookahead. Keying
    // the unit on the rows would call these two rows "lodge dates" today and
    // "lodge-nights" tomorrow, for the same tile on the same club (#2917 review).
    const deps = buildDeps({
      loadHutLeaderLookaheadDays: vi.fn().mockResolvedValue(21),
      getUnassignedHutLeaderDates: vi
        .fn()
        .mockResolvedValue(uncoveredLodgeNights(2, "lodge-1")),
      countActiveLodges: vi.fn().mockResolvedValue(3),
    });
    vi.mocked(deps.db.paymentRecoveryOperation.count)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0);

    const dashboard = await getStuckStateDashboard({
      deps,
      now: new Date("2026-06-22T00:00:00.000Z"),
    });

    expect(
      dashboard.items.find((item) => item.id === "lodge-unassigned-hut-leaders"),
    ).toMatchObject({
      title: "Unassigned hut leader lodge-nights",
      count: 2,
      summary:
        "2 upcoming lodge-nights in the next 21 days with bookings have no hut leader assigned.",
    });
  });

  // #2550: the admin-dashboard half of the placeholder-naming feature. Both
  // cases below are acceptance criteria, not incidental coverage — the tile is
  // what an admin sees, and "naming all guests clears the flag" is the whole
  // point of the zero case.
  it("flags upcoming bookings that still carry placeholder guest names (#2550)", async () => {
    const deps = buildDeps({
      countBookingsWithUnnamedPlaceholderGuests: vi.fn().mockResolvedValue(3),
    });
    vi.mocked(deps.db.paymentRecoveryOperation.count)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0);
    const now = new Date("2026-06-22T00:00:00.000Z");

    const dashboard = await getStuckStateDashboard({ deps, now });

    expect(deps.countBookingsWithUnnamedPlaceholderGuests).toHaveBeenCalledWith(
      now,
    );
    const item = dashboard.items.find(
      (candidate) => candidate.id === "booking-unnamed-placeholder-guests",
    );
    expect(item).toMatchObject({
      domain: "booking",
      title: "Bookings with unnamed guests",
      // Visibility only — the owner decision on #2550 is that an unnamed party
      // is never blocked, so this may never escalate to critical.
      severity: "warning",
      owner: "Admin",
      count: 3,
      href: "/admin/bookings",
    });
    expect(item?.summary).toContain("3 upcoming bookings still list");
    // The copy must not promise a chase for every row: a school list confirmed
    // with its placeholder names, and a booking still held for approval, are
    // both counted here and emailed by nobody.
    expect(item?.summary).not.toMatch(/The booker is reminded automatically/);
    expect(item?.summary).toContain("some rows are not");
    expect(item?.summary).toContain("never held up");
  });

  it("clears the unnamed-guest flag once every guest has a real name (#2550)", async () => {
    const deps = buildDeps({
      countBookingsWithUnnamedPlaceholderGuests: vi.fn().mockResolvedValue(0),
    });
    vi.mocked(deps.db.paymentRecoveryOperation.count)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0);

    const dashboard = await getStuckStateDashboard({
      deps,
      now: new Date("2026-06-22T00:00:00.000Z"),
    });

    expect(
      dashboard.items.find(
        (candidate) => candidate.id === "booking-unnamed-placeholder-guests",
      ),
    ).toBeUndefined();
  });

  it("uses the singular voice for a single unnamed-guest booking (#2550)", async () => {
    const deps = buildDeps({
      countBookingsWithUnnamedPlaceholderGuests: vi.fn().mockResolvedValue(1),
    });
    vi.mocked(deps.db.paymentRecoveryOperation.count)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0);

    const dashboard = await getStuckStateDashboard({
      deps,
      now: new Date("2026-06-22T00:00:00.000Z"),
    });

    expect(
      dashboard.items.find(
        (candidate) => candidate.id === "booking-unnamed-placeholder-guests",
      )?.summary,
    ).toContain("1 upcoming booking still lists");
  });

  it("does not query disabled module-specific surfaces", async () => {
    const deps = buildDeps({
      loadEffectiveModuleFlags: vi.fn().mockResolvedValue({
        ...modulesOn,
        xeroIntegration: false,
        waitlist: false,
        bedAllocation: false,
      }),
    });
    vi.mocked(deps.db.paymentRecoveryOperation.count)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0);

    const dashboard = await getStuckStateDashboard({
      deps,
      now: new Date("2026-06-22T00:00:00.000Z"),
    });

    expect(deps.getXeroAdminHealthSnapshot).not.toHaveBeenCalled();
    expect(deps.db.booking.findMany).not.toHaveBeenCalled();
    expect(deps.getBedAllocationDashboard).not.toHaveBeenCalled();
    expect(dashboard.items).toEqual([]);
  });

  it("surfaces settled group cancellations whose refund plan has not executed (#1351)", async () => {
    const settlementFindMany = vi.fn(
      async (args: { where?: { status?: unknown } }) => {
        // The #1351 detector queries SUCCEEDED settlements under CANCELLED
        // groups; the stale-settlement tile queries PENDING/FAILED ones.
        if (args?.where?.status === "SUCCEEDED") {
          return [
            { refundPlan: { "child-1": 4500 } },
            { refundPlan: null }, // no plan -> refund executed or never due
          ];
        }
        return [];
      },
    );
    const deps = buildDeps({
      db: {
        paymentRecoveryOperation: { count: vi.fn().mockResolvedValue(0) },
        // #2576: active same-owner hosting-coverage incidents. Zero, so this
        // suite's expectations are unchanged.
        hostingCoverageIncident: {
          count: vi.fn().mockResolvedValue(0),
          findMany: vi.fn().mockResolvedValue([]),
        },
        booking: {
          findMany: vi.fn().mockResolvedValue([]),
          count: vi.fn().mockResolvedValue(0),
        },
        groupBookingSettlement: { findMany: settlementFindMany },
        issueReport: { count: vi.fn().mockResolvedValue(0) },
      },
    });

    const dashboard = await getStuckStateDashboard({
      deps,
      now: new Date("2026-06-22T00:00:00.000Z"),
    });

    expect(settlementFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: "SUCCEEDED",
          groupBooking: { status: "CANCELLED" },
        },
        select: { refundPlan: true },
      }),
    );
    expect(
      dashboard.items.find(
        (item) => item.id === "payment-group-settlement-refund-unexecuted",
      ),
    ).toMatchObject({
      severity: "critical",
      owner: "Finance",
      count: 1,
    });
  });

  it("scopes the cancelled-with-unrecorded-refund detector to the crash-window signature (#1349)", async () => {
    const bookingCount = vi.fn().mockResolvedValue(1);
    const deps = buildDeps({
      db: {
        paymentRecoveryOperation: { count: vi.fn().mockResolvedValue(0) },
        // #2576: active same-owner hosting-coverage incidents. Zero, so this
        // suite's expectations are unchanged.
        hostingCoverageIncident: {
          count: vi.fn().mockResolvedValue(0),
          findMany: vi.fn().mockResolvedValue([]),
        },
        booking: {
          findMany: vi.fn().mockResolvedValue([]),
          count: bookingCount,
        },
        groupBookingSettlement: { findMany: vi.fn().mockResolvedValue([]) },
        issueReport: { count: vi.fn().mockResolvedValue(0) },
      },
    });

    const dashboard = await getStuckStateDashboard({
      deps,
      now: new Date("2026-06-22T00:00:00.000Z"),
    });

    // A flagged booking is CANCELLED with a fully captured, unrefunded
    // payment and shows NO refund-recovery operation and NO cancellation
    // narrative event — deliberate zero-refund cancels (which write their
    // CANCELLED BookingEvent), refunded cancels (refundedAmountCents > 0),
    // and #1349 in-transaction enqueues (recovery op exists) are all excluded.
    //
    // #2262 L1: the two manual-settlement admin markers are CANCELLED events
    // that cancel nothing, so the "no cancellation event" leg must ignore them
    // — otherwise a marker would blind the detector to a genuinely crashed
    // cancel. The OR keeps NULL-reason genuine cancel events counted (a bare
    // notIn drops NULLs under SQL three-valued logic).
    expect(bookingCount).toHaveBeenCalledWith({
      where: {
        status: "CANCELLED",
        deletedAt: null,
        // 90-day lookback from `now`.
        updatedAt: { gte: new Date("2026-03-24T00:00:00.000Z") },
        payment: {
          is: {
            status: "SUCCEEDED",
            refundedAmountCents: 0,
            amountCents: { gt: 0 },
          },
        },
        paymentRecoveryOperations: {
          none: { type: "REFUND_BOOKING_MODIFICATION" },
        },
        events: {
          none: {
            type: "CANCELLED",
            OR: [
              { reason: null },
              {
                reason: {
                  notIn: [
                    MANUAL_SETTLEMENT_REVERSAL_EVENT_REASON,
                    MANUAL_SETTLEMENT_CONFLICT_EVENT_REASON,
                  ],
                },
              },
            ],
          },
        },
      },
    });
    expect(
      dashboard.items.find(
        (item) => item.id === "payment-cancelled-refund-unrecorded",
      ),
    ).toMatchObject({
      severity: "critical",
      owner: "Finance",
      count: 1,
    });
  });

  it("gives Booking Officers direct rows for unresolved hosting incidents (#2576)", async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        id: "incident-1",
        cause: "SYSTEM_CHANGE",
        openedAt: new Date("2026-06-20T00:00:00.000Z"),
        evidence: { affectedNights: ["2026-08-02", "2026-08-03"] },
        booking: {
          id: "booking-12345678",
          checkIn: new Date("2026-08-02T00:00:00.000Z"),
          checkOut: new Date("2026-08-04T00:00:00.000Z"),
          member: { firstName: "Aroha", lastName: "Ngata" },
          lodge: { name: "Ruapehu Lodge" },
        },
      },
    ]);
    const deps = buildDeps({
      db: {
        hostingCoverageIncident: {
          count: vi.fn().mockResolvedValue(1),
          findMany,
        },
      } as never,
    });

    const dashboard = await getStuckStateDashboard({
      deps,
      now: new Date("2026-06-22T00:00:00.000Z"),
      // #2823: the booking-owner detail rows are membership-roll surface, so a
      // caller must hold membership:view to receive them. This suite asserts the
      // full-detail shape, so it acts as such a caller.
      viewerCanViewMembership: true,
    });

    const item = dashboard.items.find(
      (candidate) => candidate.id === "booking-hosting-coverage-incidents",
    );
    expect(item).toMatchObject({
      severity: "critical",
      owner: "Booking Officer",
      count: 1,
      href: "/admin/bookings#hosting-coverage-incidents",
      details: [
        expect.objectContaining({
          id: "incident-1",
          href: "/bookings/booking-12345678",
        }),
      ],
    });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { resolvedAt: null },
        orderBy: [{ openedAt: "asc" }, { id: "asc" }],
        take: 50,
      }),
    );
  });

  /**
   * #2716. Narrowing email inheritance to the direct parent has an accepted
   * cost: where a middle generation has no address, the descendant inherits
   * nobody. The owner accepted that on the condition that it is VISIBLE — a gap
   * somebody can see beats a message going somewhere nobody chose — so this item
   * is part of the decision rather than a nicety beside it.
   */
  it("surfaces members with no reachable email address, and links to the filtered list", async () => {
    const deps = buildDeps({
      getUnreachableMemberSummary: vi.fn().mockResolvedValue({
        total: 3,
        inheritanceUnresolved: 2,
        members: [
          { id: "m-1", name: "Sam Young", reason: "inheritance-unresolved" },
          { id: "m-2", name: "Ana Reid", reason: "placeholder-address" },
        ],
      }),
    });

    const dashboard = await getStuckStateDashboard({
      deps,
      now: new Date("2026-06-22T00:00:00.000Z"),
      // #2823: the named member rows are the membership roll, gated on
      // membership:view. This assertion is about the full-detail view.
      viewerCanViewMembership: true,
    });

    const item = dashboard.items.find(
      (candidate) => candidate.id === "email-unreachable-members",
    );
    expect(item).toMatchObject({
      domain: "email",
      // WARNING, not critical: nothing is stuck or corrupt, the club simply has
      // no way to reach these members, and the remedy is to ask a person for an
      // address rather than to repair a record.
      severity: "warning",
      owner: "Admin",
      count: 3,
      href: "/admin/members?contactability=unreachable",
    });
    // The count splits by reason, because "waiting on a parent's address" and
    // "we never had an address" are different jobs and an admin who cannot tell
    // them apart works the wrong one first.
    expect(item?.summary).toMatch(/2 of them waiting on a parent's address/);
    expect(item?.details).toEqual([
      expect.objectContaining({ id: "m-1", href: "/admin/members/m-1" }),
      expect.objectContaining({ id: "m-2", href: "/admin/members/m-2" }),
    ]);
  });

  it("says nothing when every member is reachable", async () => {
    const dashboard = await getStuckStateDashboard({
      deps: buildDeps(),
      now: new Date("2026-06-22T00:00:00.000Z"),
    });

    expect(
      dashboard.items.some(
        (candidate) => candidate.id === "email-unreachable-members",
      ),
    ).toBe(false);
  });

  /**
   * #2823. The stuck-state dashboard is a `support`-area surface, so a
   * support-only admin without membership:view can reach it. The named member
   * rows and booking-owner rows are membership-roll detail and must be dropped
   * for such a caller — while the count and the card-level link stay, so support
   * still sees a problem exists and can hand it on. Fail closed: the default
   * (nobody passed the flag) is no names.
   */
  it("drops the unreachable-member names without membership:view, keeping the count and link (#2823)", async () => {
    const deps = buildDeps({
      getUnreachableMemberSummary: vi.fn().mockResolvedValue({
        total: 3,
        inheritanceUnresolved: 2,
        members: [
          { id: "m-1", name: "Sam Young", reason: "inheritance-unresolved" },
          { id: "m-2", name: "Ana Reid", reason: "placeholder-address" },
        ],
      }),
    });

    const dashboard = await getStuckStateDashboard({
      deps,
      now: new Date("2026-06-22T00:00:00.000Z"),
      viewerCanViewMembership: false,
    });

    const item = dashboard.items.find(
      (candidate) => candidate.id === "email-unreachable-members",
    );
    // The signal itself is untouched: count and card-level link both remain.
    expect(item).toMatchObject({
      count: 3,
      href: "/admin/members?contactability=unreachable",
    });
    // But no member name, id, or deep link is surfaced.
    expect(item?.details).toBeUndefined();
  });

  it("drops the hosting-coverage booking-owner rows without membership:view, keeping the count and link (#2823)", async () => {
    const deps = buildDeps({
      db: {
        hostingCoverageIncident: {
          count: vi.fn().mockResolvedValue(1),
          findMany: vi.fn().mockResolvedValue([
            {
              id: "incident-1",
              cause: "SYSTEM_CHANGE",
              openedAt: new Date("2026-06-20T00:00:00.000Z"),
              evidence: { affectedNights: ["2026-08-02", "2026-08-03"] },
              booking: {
                id: "booking-12345678",
                checkIn: new Date("2026-08-02T00:00:00.000Z"),
                checkOut: new Date("2026-08-04T00:00:00.000Z"),
                member: { firstName: "Aroha", lastName: "Ngata" },
                lodge: { name: "Ruapehu Lodge" },
              },
            },
          ]),
        },
      } as never,
    });

    const dashboard = await getStuckStateDashboard({
      deps,
      now: new Date("2026-06-22T00:00:00.000Z"),
      viewerCanViewMembership: false,
    });

    const item = dashboard.items.find(
      (candidate) => candidate.id === "booking-hosting-coverage-incidents",
    );
    expect(item).toMatchObject({
      count: 1,
      href: "/admin/bookings#hosting-coverage-incidents",
    });
    expect(item?.details).toBeUndefined();
  });

  it("fails closed to no names when membership:view is not passed at all (#2823)", async () => {
    const deps = buildDeps({
      getUnreachableMemberSummary: vi.fn().mockResolvedValue({
        total: 1,
        inheritanceUnresolved: 0,
        members: [
          { id: "m-9", name: "Kim Tui", reason: "placeholder-address" },
        ],
      }),
      db: {
        hostingCoverageIncident: {
          count: vi.fn().mockResolvedValue(1),
          findMany: vi.fn().mockResolvedValue([
            {
              id: "incident-9",
              cause: "OFFICER_OVERRIDE",
              openedAt: new Date("2026-06-20T00:00:00.000Z"),
              evidence: { affectedNights: ["2026-08-02"] },
              booking: {
                id: "booking-99999999",
                checkIn: new Date("2026-08-02T00:00:00.000Z"),
                checkOut: new Date("2026-08-03T00:00:00.000Z"),
                member: { firstName: "Jo", lastName: "Reta" },
                lodge: { name: "Ruapehu Lodge" },
              },
            },
          ]),
        },
      } as never,
    });

    // Deliberately omit viewerCanViewMembership entirely.
    const dashboard = await getStuckStateDashboard({
      deps,
      now: new Date("2026-06-22T00:00:00.000Z"),
    });

    expect(
      dashboard.items.find(
        (candidate) => candidate.id === "email-unreachable-members",
      )?.details,
    ).toBeUndefined();
    expect(
      dashboard.items.find(
        (candidate) => candidate.id === "booking-hosting-coverage-incidents",
      )?.details,
    ).toBeUndefined();
  });
});
