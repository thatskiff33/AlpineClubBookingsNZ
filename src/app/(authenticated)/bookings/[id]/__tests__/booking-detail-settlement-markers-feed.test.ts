import { beforeEach, describe, expect, it, vi } from "vitest";
import { BookingEventType } from "@prisma/client";

/**
 * #3638 — the settlement markers (#2262's reversal and reciprocal fence, #3638's
 * second instrument) are admin-only. They are withheld at the booking page's DATA
 * FEED, not only in the timeline builder: the builder's own audience gate is the
 * second layer, so this asserts what the loader hands the builder. Removing the
 * `canSeeAdminTools` gate in the loader must fail here even though the builder
 * would still hide the rows from a member.
 */

const mocks = vi.hoisted(() => ({
  auditLogFindMany: vi.fn(),
  bookingEventFindMany: vi.fn(),
  buildBookingHistoryItems: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    auditLog: { findMany: mocks.auditLogFindMany },
    bookingEvent: { findMany: mocks.bookingEventFindMany },
  },
}));
vi.mock("@/lib/booking-history", () => ({
  buildBookingHistoryItems: mocks.buildBookingHistoryItems,
}));
vi.mock("@/lib/booking-narrative", () => ({
  resolveBookingNarrative: vi.fn().mockReturnValue({ state: "paid" }),
}));
vi.mock("@/lib/booking-financial-review-visibility", () => ({
  bookingHasOpenFinancialReview: vi.fn().mockResolvedValue(false),
}));
vi.mock("@/lib/rate-membership-label", () => ({
  loadRateMembershipLabelResolver: vi.fn(),
}));

import { loadBookingDetailHistory } from "../_lib/booking-detail-history";
import {
  SECOND_INSTRUMENT_SETTLEMENT_CONFLICT_EVENT_KIND,
  SECOND_INSTRUMENT_SETTLEMENT_CONFLICT_EVENT_REASON,
} from "@/lib/manual-settlement-reversal-event";
import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";

const booking = {
  id: "booking-1",
  status: "PAID",
  finalPriceCents: 27000,
  checkIn: new Date("2026-08-01"),
  checkOut: new Date("2026-08-03"),
  createdAt: new Date("2026-07-01"),
  memberId: "member-1",
  member: { id: "member-1", firstName: "Ada", lastName: "Lovelace", email: "ada@x.org" },
  organisationId: null,
  organisation: null,
  adminReviewStatus: null,
  adminReviewNotes: null,
  adminReviewReason: null,
  payment: null,
  modifications: [],
  refundRequests: [],
  moneyReconciliation: null,
} as never;

async function feedFor(canSeeAdminTools: boolean) {
  await loadBookingDetailHistory({
    booking,
    club: {} as never,
    viewer: { canSeeAdminTools } as never,
    format: CLUB_FORMAT_TEST,
  });
  expect(mocks.buildBookingHistoryItems).toHaveBeenCalledTimes(1);
  const [options] = mocks.buildBookingHistoryItems.mock.calls[0] as [
    { settlementMarkers: unknown[]; audience: string },
  ];
  return options;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auditLogFindMany.mockResolvedValue([]);
  mocks.buildBookingHistoryItems.mockReturnValue([]);
  mocks.bookingEventFindMany.mockResolvedValue([
    {
      id: "ev-marker",
      type: BookingEventType.CANCELLED,
      occurredAt: new Date("2026-08-04"),
      amountCents: 27000,
      reason: SECOND_INSTRUMENT_SETTLEMENT_CONFLICT_EVENT_REASON,
      snapshot: {
        kind: SECOND_INSTRUMENT_SETTLEMENT_CONFLICT_EVENT_KIND,
        invoiceNumber: "INV-3638",
      },
    },
  ]);
});

describe("booking detail feed: settlement markers are staff-only at the data feed (#3638)", () => {
  it("hands a member viewer's timeline no settlement markers at all", async () => {
    const options = await feedFor(false);
    expect(options.audience).toBe("member");
    expect(options.settlementMarkers).toEqual([]);
  });

  it("hands a staff viewer's timeline the marker", async () => {
    const options = await feedFor(true);
    expect(options.audience).toBe("staff");
    expect(options.settlementMarkers).toEqual([
      expect.objectContaining({
        id: "ev-marker",
        title: "May have been paid twice (card and Xero)",
      }),
    ]);
  });
});
