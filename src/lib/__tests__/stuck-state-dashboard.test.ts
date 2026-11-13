import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FeatureFlags } from "@/config/schema";
import {
  MANUAL_SETTLEMENT_CONFLICT_EVENT_REASON,
  MANUAL_SETTLEMENT_REVERSAL_EVENT_REASON,
  SECOND_INSTRUMENT_SETTLEMENT_CONFLICT_EVENT_REASON,
  IB_SETTLEMENT_FIGURE_CHECK_EVENT_REASON,
  GROUP_JOINER_PAYS_OWN_EVENT_REASON,
} from "@/lib/manual-settlement-reversal-event";
import {
  getStuckStateDashboard,
  STUCK_STATE_DETAIL_ROW_CAP,
  type StuckStateDashboardDependencies,
} from "@/lib/stuck-state-dashboard";
import { adminAnchorHref, adminHref } from "@/lib/admin-hubs";

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
  memberLodgeRoster: false,
  multiPromoCodes: false,
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
        // #4959: the named rows, read only for a finance and membership viewer.
        findMany: vi.fn().mockResolvedValue([]),
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
    listBookingsWithUnnamedPlaceholderGuests: vi.fn().mockResolvedValue([]),
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
    // #4162: the voided bank refund notes a person answers.
    countBankRefundVoidsToAnswer: vi.fn().mockResolvedValue(0),
    countExhaustedCashSettlementAlerts: vi.fn().mockResolvedValue(0),
    listExhaustedCashSettlementAlerts: vi.fn().mockResolvedValue([]),
    listDeadCardRefundOperationIds: vi.fn().mockResolvedValue(new Set()),
    loadDetailFormat: vi.fn().mockResolvedValue(detailFormat),
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
      paymentRecoveryOperation: {
        ...deps.db.paymentRecoveryOperation,
        ...overrides?.db?.paymentRecoveryOperation,
      },
    },
  };
}

/** A stand-in for the club's money format and zone (#4959). */
const detailFormat = {
  cents: (cents: number) => `$${(cents / 100).toFixed(2)}`,
  instantDate: (instant: Date) => instant.toISOString().slice(0, 10),
};

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
        paymentRecoveryOperation: { count: paymentCount, findMany: vi.fn().mockResolvedValue([]) },
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
        "3 upcoming lodge dates in the next 21 days with guests have no hut leader who counts.",
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
        "4 upcoming lodge-nights in the next 21 days with guests have no hut leader who counts.",
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
        "2 upcoming lodge-nights in the next 21 days with guests have no hut leader who counts.",
    });
  });

  // #4104 (ops 7, concurrency C): a card refund raised dead is PENDING with its
  // attempts spent. It is exhausted - a person's - never an overdue queue.
  it("MUTATION: counts a dead PENDING row as exhausted, never as overdue (#4104)", async () => {
    const deps = buildDeps({});
    vi.mocked(deps.db.paymentRecoveryOperation.count).mockResolvedValue(0);
    await getStuckStateDashboard({ deps, now: new Date("2026-06-22T00:00:00.000Z") });
    const wheres = vi.mocked(deps.db.paymentRecoveryOperation.count).mock.calls.map((call) => (call[0] as { where: Record<string, unknown> }).where);
    expect(wheres).toContainEqual({ status: { in: ["PENDING", "FAILED"] }, attempts: { gte: 5 } });
    expect(wheres).toContainEqual(expect.objectContaining({ status: "PENDING", attempts: { lt: 5 } }));
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
      // #4959: the card names its bookings on this page.
      href: adminAnchorHref("stuck-states", "booking-unnamed-placeholder-guests"),
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
        paymentRecoveryOperation: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
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
        paymentRecoveryOperation: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
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
                    // #3638: the second-instrument conflict marker.
                    SECOND_INSTRUMENT_SETTLEMENT_CONFLICT_EVENT_REASON,
                    // #3979: the bank-transfer settlement-figure marker.
                    IB_SETTLEMENT_FIGURE_CHECK_EVENT_REASON,
                    // #3672: the group payer-switch marker.
                    GROUP_JOINER_PAYS_OWN_EVENT_REASON,
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

describe("voided bank refund notes to answer (#4162)", () => {
  it("counts them under Xero, linking a finance viewer to the panel and anyone else to the Xero screen", async () => {
    const deps = buildDeps({ countBankRefundVoidsToAnswer: vi.fn().mockResolvedValue(2) });
    const finance = await getStuckStateDashboard({ deps, now: new Date("2026-06-22T00:00:00.000Z"), viewerCanViewFinance: true });
    expect(finance.items.find((item) => item.id === "xero-bank-refund-voids-to-answer")).toMatchObject({
      domain: "xero",
      owner: "Finance",
      count: 2,
      href: adminAnchorHref("stuck-states", "bank-refund-voids"),
      summary: expect.stringContaining("2 bank refunds had their Xero credit note voided"),
    });
    const support = await getStuckStateDashboard({ deps, now: new Date("2026-06-22T00:00:00.000Z") });
    expect(support.items.find((item) => item.id === "xero-bank-refund-voids-to-answer")?.href).toBe("/admin/xero");
  });
});

it("keeps exhausted settlement figure alerts visible for finance", async () => {
  const deps = buildDeps({ countExhaustedCashSettlementAlerts: vi.fn().mockResolvedValue(1) });
  const result = await getStuckStateDashboard({ deps });
  expect(result.items).toContainEqual(expect.objectContaining({
    id: "payment-settlement-alert-undelivered", count: 1, severity: "critical", href: "/admin/payments",
  }));
});

/**
 * #4959: the eight signals that name their bookings. A finance and membership
 * viewer gets up to STUCK_STATE_DETAIL_ROW_CAP rows each, read with the very
 * where the count reads; anyone else gets the count and the card link only.
 */
describe("named rows behind the stuck-state signals (#4959)", () => {
  const NOW = new Date("2026-06-22T00:00:00.000Z");
  const PAYMENT_ROW_SIGNALS = [
    "payment-group-settlement-refund-unexecuted",
    "payment-cancelled-refund-unrecorded",
    "payment-recovery-exhausted",
    "payment-recovery-stale-processing",
    "payment-group-settlement-stale",
    "payment-recovery-overdue-pending",
    "payment-settlement-alert-undelivered",
  ];

  function owned(id: string) {
    return { id, member: { firstName: "Aroha", lastName: "Ngata" }, organisation: null };
  }

  type Where = Record<string, unknown>;
  /** Which recovery signal a where reads, by the shape each builder gives it. */
  function recoverySignal(where: Where) {
    if (where.status === "PROCESSING") return "stale";
    if (where.status === "PENDING") return "overdue";
    return "exhausted";
  }

  /** Every payment signal live: `counts` per signal, rows minted up to `take`. */
  function paymentDeps(counts: { exhausted: number; stale: number; overdue: number; cancelled: number }) {
    const recoveryCount = vi.fn(async ({ where }: { where: Where }) => counts[recoverySignal(where)]);
    const recoveryFindMany = vi.fn(async ({ where, take }: { where: Where; take: number }) =>
      Array.from({ length: Math.min(take, counts[recoverySignal(where)]) }, (_unused, index) => ({
        id: `${recoverySignal(where)}-op-${index}`,
        type: "REFUND_BOOKING_MODIFICATION",
        amountCents: 12_345,
        createdAt: new Date("2026-06-01T00:00:00.000Z"),
        booking: owned(`${recoverySignal(where)}-booking-${index}`),
      })),
    );
    const bookingCount = vi.fn().mockResolvedValue(counts.cancelled);
    const bookingFindMany = vi.fn(async (args: { where: Where; take?: number }) =>
      args.where.status === "CANCELLED"
        ? Array.from({ length: Math.min(args.take ?? 0, counts.cancelled) }, (_unused, index) => ({
            ...owned(`cancelled-booking-${index}`),
            updatedAt: new Date("2026-06-10T00:00:00.000Z"),
            lodge: { name: "Ruapehu Lodge" },
            payment: { amountCents: 40_000 },
          }))
        : [],
    );
    const settlementFindMany = vi.fn(async (args: { where: { status?: unknown } }) =>
      args.where.status === "SUCCEEDED"
        ? [
            { id: "settlement-planned", amountCents: 90_000, refundPlan: { child: 4_500 }, groupBooking: { organiserBooking: owned("organiser-planned") } },
            { id: "settlement-done", amountCents: 10_000, refundPlan: null, groupBooking: { organiserBooking: owned("organiser-done") } },
          ]
        : [
            {
              id: "settlement-stale",
              amountCents: 75_000,
              updatedAt: new Date("2026-05-01T00:00:00.000Z"),
              groupBooking: { organiserBooking: { ...owned("organiser-stale"), checkIn: new Date("2026-05-10T00:00:00.000Z") } },
            },
          ],
    );
    const deps = buildDeps({
      db: {
        paymentRecoveryOperation: { count: recoveryCount, findMany: recoveryFindMany },
        hostingCoverageIncident: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
        booking: { count: bookingCount, findMany: bookingFindMany },
        groupBookingSettlement: { findMany: settlementFindMany },
        issueReport: { count: vi.fn().mockResolvedValue(0) },
      },
      countExhaustedCashSettlementAlerts: vi.fn().mockResolvedValue(1),
      listExhaustedCashSettlementAlerts: vi.fn().mockResolvedValue([
        {
          id: "alert-1",
          createdAt: new Date("2026-06-15T00:00:00.000Z"),
          booking: { ...owned("alert-booking"), checkIn: new Date("2026-08-01T00:00:00.000Z"), checkOut: new Date("2026-08-03T00:00:00.000Z") },
        },
      ]),
      listDeadCardRefundOperationIds: vi.fn().mockResolvedValue(new Set(["exhausted-op-0"])),
    });
    return { deps, recoveryCount, recoveryFindMany, bookingCount, bookingFindMany };
  }

  const ALL_SIGNALS = { exhausted: 60, stale: 2, overdue: 1, cancelled: 3 };

  it("names each payment signal's bookings for a finance and membership viewer, capped with the full count kept", async () => {
    const { deps } = paymentDeps(ALL_SIGNALS);
    const dashboard = await getStuckStateDashboard({ deps, now: NOW, viewerCanViewFinance: true, viewerCanViewMembership: true });
    const item = (id: string) => dashboard.items.find((candidate) => candidate.id === id);

    for (const id of PAYMENT_ROW_SIGNALS) {
      expect(item(id)?.details?.length, id).toBeGreaterThan(0);
      for (const detail of item(id)?.details ?? []) {
        expect(detail.title, id).toMatch(/ - Aroha Ngata$/);
        expect(detail.href, id).toMatch(/^\/bookings\//);
      }
    }
    // The cap: the count stays the whole total, so the page says "and 10 more".
    expect(item("payment-recovery-exhausted")).toMatchObject({ count: 60 });
    expect(item("payment-recovery-exhausted")?.details).toHaveLength(STUCK_STATE_DETAIL_ROW_CAP);
    expect(item("payment-cancelled-refund-unrecorded")?.details).toEqual([
      expect.objectContaining({
        id: "cancelled-booking-0",
        href: "/bookings/cancelled-booking-0",
        summary: "Ruapehu Lodge; $400.00 captured and not refunded; cancelled, last changed 2026-06-10.",
      }),
      expect.anything(),
      expect.anything(),
    ]);
    expect(item("payment-recovery-stale-processing")?.details?.[0]?.summary).toBe(
      "Card refund of $123.45, raised 2026-06-01.",
    );
    // Only the planned settlement counts and is named; its organiser is the owner.
    expect(item("payment-group-settlement-refund-unexecuted")).toMatchObject({
      count: 1,
      details: [expect.objectContaining({ id: "settlement-planned", href: "/bookings/organiser-planned" })],
    });
    expect(item("payment-group-settlement-stale")).toMatchObject({
      count: 1,
      details: [expect.objectContaining({ id: "settlement-stale", href: "/bookings/organiser-stale" })],
    });
    expect(item("payment-settlement-alert-undelivered")?.details).toEqual([
      expect.objectContaining({ id: "alert-1", href: "/bookings/alert-booking" }),
    ]);
    expect(deps.listExhaustedCashSettlementAlerts).toHaveBeenCalledWith(STUCK_STATE_DETAIL_ROW_CAP);
  });

  it("sends an exhausted card refund Stripe gave up on to its settle list, and no other row", async () => {
    const { deps } = paymentDeps(ALL_SIGNALS);
    const dashboard = await getStuckStateDashboard({ deps, now: NOW, viewerCanViewFinance: true, viewerCanViewMembership: true });
    const details = dashboard.items.find((item) => item.id === "payment-recovery-exhausted")?.details ?? [];
    expect(details[0]?.summary).toContain('Settle it under "Card refunds Stripe gave up on"');
    expect(details.slice(1).some((detail) => detail.summary.includes("Card refunds Stripe gave up on"))).toBe(false);
  });

  it("MUTATION: reads each signal's rows with the very where its count reads", async () => {
    const { deps, recoveryCount, recoveryFindMany, bookingCount, bookingFindMany } = paymentDeps(ALL_SIGNALS);
    await getStuckStateDashboard({ deps, now: NOW, viewerCanViewFinance: true, viewerCanViewMembership: true });
    const countWheres = recoveryCount.mock.calls.map(([args]) => args.where);
    const rowWheres = recoveryFindMany.mock.calls.map(([args]) => args.where);
    expect(rowWheres).toHaveLength(3);
    expect(rowWheres).toEqual(expect.arrayContaining(countWheres));
    expect(countWheres).toEqual(expect.arrayContaining(rowWheres));
    const cancelledRows = bookingFindMany.mock.calls.find(([args]) => args.where.status === "CANCELLED");
    expect(cancelledRows?.[0].where).toEqual(bookingCount.mock.calls[0]?.[0].where);
    // Never the provider's detail: no error text, Stripe id or idempotency key.
    for (const [args] of recoveryFindMany.mock.calls) {
      expect(Object.keys((args as unknown as { select: object }).select).sort()).toEqual(
        ["amountCents", "booking", "createdAt", "id", "type"],
      );
    }
  });

  it.each([
    ["membership only", { viewerCanViewMembership: true }],
    ["finance only", { viewerCanViewFinance: true }],
    ["neither", {}],
  ])("keeps the payment counts and links but names nobody and reads no rows with %s", async (_label, flags) => {
    const { deps, recoveryFindMany, bookingFindMany } = paymentDeps(ALL_SIGNALS);
    const dashboard = await getStuckStateDashboard({ deps, now: NOW, ...flags });
    for (const id of PAYMENT_ROW_SIGNALS) {
      const item = dashboard.items.find((candidate) => candidate.id === id);
      expect(item?.count, id).toBeGreaterThan(0);
      expect(item?.href, id).toBeTruthy();
      expect(item?.details, id).toBeUndefined();
    }
    expect(recoveryFindMany).not.toHaveBeenCalled();
    expect(bookingFindMany.mock.calls.some(([args]) => args.where.status === "CANCELLED")).toBe(false);
    expect(deps.listExhaustedCashSettlementAlerts).not.toHaveBeenCalled();
    expect(deps.listDeadCardRefundOperationIds).not.toHaveBeenCalled();
    expect(deps.loadDetailFormat).not.toHaveBeenCalled();
  });

  it("links each payment signal where its work is done, and none to System Health", async () => {
    const { deps } = paymentDeps(ALL_SIGNALS);
    const dashboard = await getStuckStateDashboard({ deps, now: NOW });
    const href = (id: string) => dashboard.items.find((item) => item.id === id)?.href;
    for (const id of [
      "payment-group-settlement-refund-unexecuted",
      "payment-cancelled-refund-unrecorded",
      "payment-recovery-exhausted",
      "payment-group-settlement-stale",
    ] as const) {
      expect(href(id)).toBe(adminAnchorHref("stuck-states", id));
    }
    expect(href("payment-recovery-stale-processing")).toBe(adminHref("background-jobs"));
    expect(href("payment-recovery-overdue-pending")).toBe(adminHref("background-jobs"));
    expect(href("payment-settlement-alert-undelivered")).toBe(adminHref("payments"));
    expect(dashboard.items.filter((item) => item.href === adminHref("health"))).toEqual([]);
  });

  function unnamedBooking(index: number) {
    return {
      ...owned(`unnamed-booking-${index}`),
      checkIn: new Date("2026-07-10T00:00:00.000Z"),
      lodge: { name: "Ruapehu Lodge" },
      unnamedGuestCount: 2,
    };
  }

  it("names the unnamed-guest bookings for a membership viewer from the list the count is the length of", async () => {
    const deps = buildDeps({
      listBookingsWithUnnamedPlaceholderGuests: vi.fn().mockResolvedValue(
        Array.from({ length: 55 }, (_unused, index) => unnamedBooking(index)),
      ),
    });
    const dashboard = await getStuckStateDashboard({ deps, now: NOW, viewerCanViewMembership: true });
    const item = dashboard.items.find((candidate) => candidate.id === "booking-unnamed-placeholder-guests");
    expect(item?.count).toBe(55);
    expect(item?.details).toHaveLength(STUCK_STATE_DETAIL_ROW_CAP);
    expect(item?.details?.[0]).toMatchObject({
      id: "unnamed-booking-0",
      title: expect.stringMatching(/ - Aroha Ngata$/),
      summary: expect.stringContaining("2 unnamed guests"),
      href: "/bookings/unnamed-booking-0",
    });
    expect(deps.countBookingsWithUnnamedPlaceholderGuests).not.toHaveBeenCalled();
  });

  it("counts the unnamed-guest bookings without naming them for a viewer without membership:view", async () => {
    const deps = buildDeps({ countBookingsWithUnnamedPlaceholderGuests: vi.fn().mockResolvedValue(4) });
    const dashboard = await getStuckStateDashboard({ deps, now: NOW, viewerCanViewFinance: true });
    const item = dashboard.items.find((candidate) => candidate.id === "booking-unnamed-placeholder-guests");
    expect(item).toMatchObject({ count: 4, href: adminAnchorHref("stuck-states", "booking-unnamed-placeholder-guests") });
    expect(item?.details).toBeUndefined();
    expect(deps.listBookingsWithUnnamedPlaceholderGuests).not.toHaveBeenCalled();
  });
});
