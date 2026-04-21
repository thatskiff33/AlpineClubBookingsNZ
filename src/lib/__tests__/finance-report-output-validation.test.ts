import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BookingStatus,
  FinanceSnapshotType,
  PaymentStatus,
} from "@prisma/client";
import { parseDateOnly } from "@/lib/date-only";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    booking: {
      findMany: vi.fn(),
    },
    financeSnapshot: {
      findMany: vi.fn(),
    },
  },
}));

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));

vi.mock("@/lib/finance-auth", () => ({
  hasFinanceManagerAccess: (level: string) => level === "MANAGER",
}));

import { buildFinanceBookingsReportPageModel } from "@/lib/finance-bookings-report-page";
import {
  buildFinanceRevenueReportPageModel,
  resolveFinanceRevenueReportFilters,
} from "@/lib/finance-revenue-report-page";

function financeViewer() {
  return {
    id: "finance-viewer-1",
    email: "viewer@example.com",
    firstName: "View",
    lastName: "Only",
    role: "MEMBER" as const,
    financeAccessLevel: "VIEWER" as const,
    active: true,
    forcePasswordChange: false,
  };
}

function representativeBookings() {
  return [
    {
      id: "booking-confirmed-split",
      checkIn: new Date("2026-04-20T00:00:00.000Z"),
      checkOut: new Date("2026-04-23T00:00:00.000Z"),
      status: BookingStatus.CONFIRMED,
      finalPriceCents: 30000,
      guests: [{ id: "guest-1" }, { id: "guest-2" }],
      payment: {
        status: PaymentStatus.SUCCEEDED,
        amountCents: 30000,
        refundedAmountCents: 0,
        changeFeeCents: 0,
        creditAppliedCents: 0,
        additionalAmountCents: 0,
        additionalPaymentStatus: null,
      },
    },
    {
      id: "booking-paid-realized",
      checkIn: new Date("2026-04-18T00:00:00.000Z"),
      checkOut: new Date("2026-04-20T00:00:00.000Z"),
      status: BookingStatus.PAID,
      finalPriceCents: 12000,
      guests: [{ id: "guest-3" }],
      payment: {
        status: PaymentStatus.PARTIALLY_REFUNDED,
        amountCents: 12000,
        refundedAmountCents: 2000,
        changeFeeCents: 500,
        creditAppliedCents: 1000,
        additionalAmountCents: 0,
        additionalPaymentStatus: null,
      },
    },
    {
      id: "booking-completed-free",
      checkIn: new Date("2026-04-19T00:00:00.000Z"),
      checkOut: new Date("2026-04-20T00:00:00.000Z"),
      status: BookingStatus.COMPLETED,
      finalPriceCents: 0,
      guests: [{ id: "guest-4" }, { id: "guest-5" }, { id: "guest-6" }],
      payment: null,
    },
    {
      id: "booking-pending-forward",
      checkIn: new Date("2026-04-22T00:00:00.000Z"),
      checkOut: new Date("2026-04-24T00:00:00.000Z"),
      status: BookingStatus.PENDING,
      finalPriceCents: 8000,
      guests: [{ id: "guest-7" }],
      payment: {
        status: PaymentStatus.PENDING,
        amountCents: 8000,
        refundedAmountCents: 0,
        changeFeeCents: 0,
        creditAppliedCents: 0,
        additionalAmountCents: 0,
        additionalPaymentStatus: null,
      },
    },
  ];
}

function representativeRevenueSnapshots() {
  return [
    {
      id: "snapshot-april",
      snapshotType: FinanceSnapshotType.PROFIT_AND_LOSS_MONTHLY,
      scope: "default",
      asOfDate: new Date("2026-04-30T00:00:00.000Z"),
      periodStart: new Date("2026-04-01T00:00:00.000Z"),
      periodEnd: new Date("2026-04-30T00:00:00.000Z"),
      rowCount: 3,
      currency: null,
      sourceUpdatedAt: new Date("2026-05-01T00:15:00.000Z"),
      payload: {
        reportDate: "2026-04-30",
        reportTitles: [
          "Profit and Loss",
          "Tokoroa Alpine Club",
          "April 2026",
        ],
        fields: [
          {
            fieldId: "period",
            description: "Period",
            value: "April 2026",
          },
        ],
        rows: [
          {
            rowType: "Section",
            title: "Income",
            cells: [],
            rows: [
              {
                rowType: "Row",
                title: null,
                cells: [
                  { value: "Accommodation income" },
                  { value: "1450.00" },
                ],
                rows: [],
              },
              {
                rowType: "Row",
                title: null,
                cells: [{ value: "Retail sales" }, { value: "50.00" }],
                rows: [],
              },
              {
                rowType: "SummaryRow",
                title: null,
                cells: [{ value: "Total Income" }, { value: "1500.00" }],
                rows: [],
              },
            ],
          },
        ],
      },
      syncRunId: "run-1",
      createdAt: new Date("2026-05-01T00:20:00.000Z"),
      updatedAt: new Date("2026-05-01T00:20:00.000Z"),
    },
    {
      id: "snapshot-march",
      snapshotType: FinanceSnapshotType.PROFIT_AND_LOSS_MONTHLY,
      scope: "default",
      asOfDate: new Date("2026-03-31T00:00:00.000Z"),
      periodStart: new Date("2026-03-01T00:00:00.000Z"),
      periodEnd: new Date("2026-03-31T00:00:00.000Z"),
      rowCount: 3,
      currency: null,
      sourceUpdatedAt: new Date("2026-04-01T00:15:00.000Z"),
      payload: {
        reportDate: "2026-03-31",
        reportTitles: [
          "Profit and Loss",
          "Tokoroa Alpine Club",
          "March 2026",
        ],
        fields: [
          {
            fieldId: "period",
            description: "Period",
            value: "March 2026",
          },
        ],
        rows: [
          {
            rowType: "Section",
            title: "Income",
            cells: [],
            rows: [
              {
                rowType: "Row",
                title: null,
                cells: [
                  { value: "Accommodation income" },
                  { value: "1200.00" },
                ],
                rows: [],
              },
              {
                rowType: "Row",
                title: null,
                cells: [{ value: "Retail sales" }, { value: "100.00" }],
                rows: [],
              },
              {
                rowType: "SummaryRow",
                title: null,
                cells: [{ value: "Total Income" }, { value: "1300.00" }],
                rows: [],
              },
            ],
          },
        ],
      },
      syncRunId: "run-1",
      createdAt: new Date("2026-04-01T00:20:00.000Z"),
      updatedAt: new Date("2026-04-01T00:20:00.000Z"),
    },
  ];
}

describe("finance report output validation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T00:30:00.000Z"));
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the representative bookings report output aligned with TACBookings booking metrics", async () => {
    mockPrisma.booking.findMany.mockResolvedValue(representativeBookings());

    const model = await buildFinanceBookingsReportPageModel({
      member: financeViewer(),
      today: parseDateOnly("2026-04-21"),
      searchParams: {
        realizedFrom: "2026-04-18",
        realizedTo: "2026-04-22",
        realizedCutoff: "2026-04-21",
        forwardFrom: "2026-04-20",
        forwardTo: "2026-04-24",
        forwardAsOf: "2026-04-21",
      },
    });

    expect(model.realized.cards).toMatchObject([
      {
        title: "Guest nights",
        value: "9",
        footnote: "5 booking nights were realized.",
      },
      {
        title: "Occupancy",
        value: "7.8%",
      },
      {
        title: "Booked revenue",
        value: "$320.00",
        footnote: "$64.00 average nightly revenue.",
      },
      {
        title: "Net collected cash",
        value: "$400.00",
        footnote: "1 booking has no payment row yet.",
      },
    ]);
    expect(model.realized.dailyRows).toEqual([
      {
        date: "Sat, 18 Apr",
        bookingCount: "1",
        guestNights: "1",
        occupiedBeds: "1 / 29",
        occupancyRate: "3.5%",
        bookedRevenue: "$60.00",
      },
      {
        date: "Sun, 19 Apr",
        bookingCount: "2",
        guestNights: "4",
        occupiedBeds: "4 / 29",
        occupancyRate: "13.8%",
        bookedRevenue: "$60.00",
      },
      {
        date: "Mon, 20 Apr",
        bookingCount: "1",
        guestNights: "2",
        occupiedBeds: "2 / 29",
        occupancyRate: "6.9%",
        bookedRevenue: "$100.00",
      },
      {
        date: "Tue, 21 Apr",
        bookingCount: "1",
        guestNights: "2",
        occupiedBeds: "2 / 29",
        occupancyRate: "6.9%",
        bookedRevenue: "$100.00",
      },
    ]);
    expect(model.realized.statusRows).toEqual([
      {
        pipeline: "Realized",
        status: "Confirmed",
        bookingCount: "1",
        bookingNights: "2",
        guestNights: "4",
        bookedRevenue: "$200.00",
      },
      {
        pipeline: "Realized",
        status: "Paid",
        bookingCount: "1",
        bookingNights: "2",
        guestNights: "2",
        bookedRevenue: "$120.00",
      },
      {
        pipeline: "Realized",
        status: "Completed",
        bookingCount: "1",
        bookingNights: "1",
        guestNights: "3",
        bookedRevenue: "$0.00",
      },
    ]);
    expect(model.forward.cards).toMatchObject([
      {
        title: "Committed guest nights",
        value: "2",
        footnote: "$100.00",
      },
      {
        title: "At-risk guest nights",
        value: "2",
        footnote: "$80.00",
      },
      {
        title: "Total pipeline revenue",
        value: "$180.00",
      },
      {
        title: "Pipeline occupancy",
        value: "4.6%",
      },
    ]);
    expect(model.forward.dailyRows).toEqual([
      {
        date: "Wed, 22 Apr",
        bookingCount: "2",
        guestNights: "3",
        occupiedBeds: "3 / 29",
        occupancyRate: "10.3%",
        bookedRevenue: "$140.00",
        committedBookingCount: "1",
        committedGuestNights: "2",
        atRiskBookingCount: "1",
        atRiskGuestNights: "1",
        totalPipelineBookingCount: "2",
        totalPipelineGuestNights: "3",
      },
      {
        date: "Thu, 23 Apr",
        bookingCount: "1",
        guestNights: "1",
        occupiedBeds: "1 / 29",
        occupancyRate: "3.5%",
        bookedRevenue: "$40.00",
        committedBookingCount: "0",
        committedGuestNights: "0",
        atRiskBookingCount: "1",
        atRiskGuestNights: "1",
        totalPipelineBookingCount: "1",
        totalPipelineGuestNights: "1",
      },
      {
        date: "Fri, 24 Apr",
        bookingCount: "0",
        guestNights: "0",
        occupiedBeds: "0 / 29",
        occupancyRate: "0.0%",
        bookedRevenue: "$0.00",
        committedBookingCount: "0",
        committedGuestNights: "0",
        atRiskBookingCount: "0",
        atRiskGuestNights: "0",
        totalPipelineBookingCount: "0",
        totalPipelineGuestNights: "0",
      },
    ]);
    expect(model.forward.statusRows).toEqual([
      {
        pipeline: "Committed",
        status: "Confirmed",
        bookingCount: "1",
        bookingNights: "1",
        guestNights: "2",
        bookedRevenue: "$100.00",
      },
      {
        pipeline: "Committed",
        status: "Paid",
        bookingCount: "0",
        bookingNights: "0",
        guestNights: "0",
        bookedRevenue: "$0.00",
      },
      {
        pipeline: "At risk",
        status: "Pending",
        bookingCount: "1",
        bookingNights: "2",
        guestNights: "2",
        bookedRevenue: "$80.00",
      },
    ]);
  });

  it("keeps the representative revenue report output aligned with stored finance snapshots", async () => {
    mockPrisma.financeSnapshot.findMany.mockResolvedValue(
      representativeRevenueSnapshots()
    );

    const model = await buildFinanceRevenueReportPageModel({
      member: financeViewer(),
      searchParams: { periods: "2" },
    });

    expect(model.summaryCards).toMatchObject([
      {
        title: "Latest synced month",
        value: "$1500.00",
      },
      {
        title: "Selected periods total",
        value: "$2800.00",
      },
      {
        title: "Average monthly revenue",
        value: "$1400.00",
      },
      {
        title: "Revenue lines tracked",
        value: "2",
        footnote: "2 periods loaded from durable FinanceSnapshot storage.",
      },
    ]);
    expect(model.monthlyRows).toEqual([
      {
        snapshotId: "snapshot-april",
        periodLabel: "April 2026",
        sourceWindow: "1 Apr 2026 to 30 Apr 2026",
        totalRevenue: "$1500.00",
        lineItemCount: "2",
        asOfDateLabel: "30 Apr 2026",
        sourceUpdatedAtLabel: "1 May 2026, 12:15 pm",
      },
      {
        snapshotId: "snapshot-march",
        periodLabel: "March 2026",
        sourceWindow: "1 Mar 2026 to 31 Mar 2026",
        totalRevenue: "$1300.00",
        lineItemCount: "2",
        asOfDateLabel: "31 Mar 2026",
        sourceUpdatedAtLabel: "1 Apr 2026, 1:15 pm",
      },
    ]);
    expect(model.lineItemRows).toEqual([
      {
        lineItem: "Accommodation income",
        latestPeriodAmount: "$1450.00",
        selectedPeriodsAmount: "$2650.00",
        periodsPresent: "2",
      },
      {
        lineItem: "Retail sales",
        latestPeriodAmount: "$50.00",
        selectedPeriodsAmount: "$150.00",
        periodsPresent: "2",
      },
    ]);
  });

  it.each(["6abc", "3.5", "1e2"])(
    "rejects malformed revenue period filters for %s",
    (periods) => {
      const resolved = resolveFinanceRevenueReportFilters({
        searchParams: { periods },
      });

      expect(resolved.filters).toEqual({
        periods: 6,
      });
      expect(resolved.warnings).toEqual([
        "Revenue periods must be a whole number between 1 and 24. Showing the default 6-period window.",
      ]);
    }
  );
});
