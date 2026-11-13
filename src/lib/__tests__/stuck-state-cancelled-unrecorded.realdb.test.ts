/**
 * #4959: the "Cancelled bookings with unrecorded refunds" signal names the very
 * bookings it counts. Real PostgreSQL, real queries through the dashboard; every
 * other signal is stubbed out. No provider is called.
 */
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FeatureFlags } from "@/config/schema";
import { assertSafeRaceDbUrl } from "@/lib/__tests__/support/race-db-url";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";
const OWNER = "race-4959-owner";
const LODGE = "race-4959-lodge";
const CRASHED = "race-4959-crashed";
const MARKED = "race-4959-marked";
const NARRATED = "race-4959-narrated";
const BOOKINGS = [CRASHED, MARKED, NARRATED];
// Far past the real calendar, so the 90-day lookback sees only these rows.
const CHANGED_AT = new Date("2031-01-01T00:00:00.000Z");
const NOW = new Date("2031-01-02T00:00:00.000Z");
let prisma: PrismaClient;
let dashboard: typeof import("@/lib/stuck-state-dashboard");
let markers: typeof import("@/lib/manual-settlement-reversal-event");

async function clean() {
  await prisma.bookingEvent.deleteMany({ where: { bookingId: { in: BOOKINGS } } });
  await prisma.payment.deleteMany({ where: { bookingId: { in: BOOKINGS } } });
  await prisma.booking.deleteMany({ where: { id: { in: BOOKINGS } } });
  await prisma.lodge.deleteMany({ where: { id: LODGE } });
  await prisma.member.deleteMany({ where: { id: OWNER } });
}

async function cancelledWithCapture(id: string) {
  await prisma.booking.create({ data: {
    id, memberId: OWNER, lodgeId: LODGE, status: "CANCELLED", updatedAt: CHANGED_AT,
    checkIn: new Date("2031-02-10T00:00:00.000Z"), checkOut: new Date("2031-02-12T00:00:00.000Z"),
    totalPriceCents: 38_000, finalPriceCents: 38_000,
  } });
  await prisma.payment.create({ data: {
    id: `${id}-payment`, bookingId: id, source: "STRIPE", status: "SUCCEEDED",
    amountCents: 38_000, creditAppliedCents: 0, refundedAmountCents: 0,
  } });
}

/** Every other signal at zero, so only the cancelled-unrecorded queries touch the database. */
function quietDeps(): Partial<import("@/lib/stuck-state-dashboard").StuckStateDashboardDependencies> {
  const none = { summary: {}, failures: [], recentlyReviewed: [], recentlyReissued: [], escalations: [], suppressions: [] };
  return {
    db: {
      ...(prisma as unknown as import("@/lib/stuck-state-dashboard").StuckStateDashboardDependencies["db"]),
      paymentRecoveryOperation: { count: async () => 0, findMany: async () => [] },
      groupBookingSettlement: { findMany: async () => [] },
      hostingCoverageIncident: { count: async () => 0, findMany: async () => [] },
      issueReport: { count: async () => 0 },
    },
    loadEffectiveModuleFlags: async () => ({}) as FeatureFlags,
    getEmailDeliverabilityTelemetry: vi.fn().mockResolvedValue({ ...none, summary: { activeCount: 0 } }),
    getExhaustedEmailFailureReviewQueue: vi.fn().mockResolvedValue({ ...none, summary: { activeCount: 0 } }),
    getAdminAlertDeliveryEscalations: vi.fn().mockResolvedValue({ ...none, summary: { recentCount: 0 } }),
    getTokenEmailRecoveryQueue: vi.fn().mockResolvedValue({ ...none, summary: { activeCount: 0 } }),
    getUnreachableMemberSummary: vi.fn().mockResolvedValue({ total: 0, inheritanceUnresolved: 0, members: [] }),
    countUnconfirmedSchoolAttendeeLists: async () => 0,
    countBookingsWithUnnamedPlaceholderGuests: async () => 0,
    listBookingsWithUnnamedPlaceholderGuests: async () => [],
    getUnassignedHutLeaderDates: async () => [],
    loadHutLeaderLookaheadDays: async () => 14,
    countActiveLodges: async () => 1,
    countExhaustedCashSettlementAlerts: async () => 0,
    listExhaustedCashSettlementAlerts: async () => [],
    listDeadCardRefundOperationIds: async () => new Set(),
    loadDetailFormat: async () => ({ cents: (cents) => `${cents}c`, instantDate: (instant) => instant.toISOString() }),
  };
}

(RUN ? describe : describe.skip)("cancelled-with-unrecorded-refund rows on PostgreSQL (#4959)", () => {
  beforeAll(async () => {
    assertSafeRaceDbUrl(RACE_DB_URL, "Stuck-state cancelled-unrecorded rows");
    process.env.DATABASE_URL = RACE_DB_URL;
    ({ prisma } = await import("@/lib/prisma"));
    dashboard = await import("@/lib/stuck-state-dashboard");
    markers = await import("@/lib/manual-settlement-reversal-event");
    await clean();
  }, 120_000);

  afterAll(async () => {
    if (prisma) await clean();
  });

  it("names exactly the bookings it counts: a settlement marker hides no crashed cancel, a cancel's own event does", async () => {
    await prisma.member.create({ data: {
      id: OWNER, email: `${OWNER}@example.invalid`, passwordHash: "not-a-real-password",
      firstName: "Crash", lastName: "Proof", ageTier: "ADULT", canLogin: true,
    } });
    await prisma.lodge.create({ data: { id: LODGE, name: "Crash Window Proof", slug: "race-4959" } });
    await cancelledWithCapture(CRASHED);
    // #2262: a settlement marker is a CANCELLED event that cancels nothing, so
    // the predicate excludes it from "the cancel wrote its event" and the
    // crashed cancel underneath stays counted and named.
    await cancelledWithCapture(MARKED);
    await prisma.bookingEvent.create({ data: {
      bookingId: MARKED, type: "CANCELLED", reason: markers.SETTLEMENT_MARKER_EVENT_REASONS[0],
    } });
    // A cancel that wrote its own NULL-reason event finished: neither counted nor named.
    await cancelledWithCapture(NARRATED);
    await prisma.bookingEvent.create({ data: { bookingId: NARRATED, type: "CANCELLED", reason: null } });

    const result = await dashboard.getStuckStateDashboard({
      deps: quietDeps(), now: NOW, viewerCanViewFinance: true, viewerCanViewMembership: true,
    });
    const item = result.items.find((candidate) => candidate.id === "payment-cancelled-refund-unrecorded");

    expect(item?.count).toBe(2);
    expect(item?.details?.map((detail) => detail.id).sort()).toEqual([CRASHED, MARKED].sort());
    expect(item?.details?.[0]).toMatchObject({
      title: expect.stringMatching(/ - Crash Proof$/),
      summary: expect.stringContaining("38000c captured and not refunded"),
    });
  });
});
