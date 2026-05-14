import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockBookingFindMany } = vi.hoisted(() => ({
  mockBookingFindMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: {
      findMany: mockBookingFindMany,
    },
  },
}));

vi.mock("@/lib/finance-auth", () => ({
  hasFinanceManagerAccess: (level: string) => level === "MANAGER",
}));

import { buildFinanceBookingsSourcePageModel } from "@/lib/finance-bookings-source-page";

describe("finance bookings source page model", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("queries source bookings for the selected finance pipeline, status, and effective window", async () => {
    mockBookingFindMany.mockResolvedValue([
      {
        id: "booking-1",
        checkIn: new Date("2026-05-01T00:00:00.000Z"),
        checkOut: new Date("2026-05-04T00:00:00.000Z"),
        status: "PENDING",
        finalPriceCents: 30000,
        member: {
          firstName: "Jane",
          lastName: "Doe",
          email: "jane@example.com",
        },
        guests: [{ id: "guest-1" }, { id: "guest-2" }],
        payment: { status: "PENDING" },
      },
    ]);

    const model = await buildFinanceBookingsSourcePageModel({
      today: new Date("2026-05-01T00:00:00.000Z"),
      searchParams: {
        forwardFrom: "2026-05-01",
        forwardTo: "2026-05-10",
        forwardAsOf: "2026-05-01",
        section: "forward",
        pipeline: "at-risk",
        status: "PENDING",
        returnTo: "/finance/bookings?forwardFrom=2026-05-01",
      },
    });

    expect(mockBookingFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: "PENDING",
          checkIn: { lte: new Date("2026-05-10T00:00:00.000Z") },
          checkOut: { gt: new Date("2026-05-02T00:00:00.000Z") },
        },
      })
    );
    expect(model.returnHref).toBe("/finance/bookings?forwardFrom=2026-05-01");
    expect(model.pipelineLabel).toBe("At risk");
    expect(model.statusLabel).toBe("Pending");
    expect(model.effectiveWindow).toBe("2 May 2026 to 10 May 2026");
    expect(model.rows).toMatchObject([
      {
        memberName: "Jane Doe",
        memberEmail: "jane@example.com",
        status: "PENDING",
        guestCount: "2",
        contributingNights: "2",
        guestNights: "4",
        allocatedRevenue: "$200.00",
        bookingTotal: "$300.00",
        paymentStatus: "PENDING",
      },
    ]);
    expect(model.totals).toMatchObject({
      bookingCount: "1",
      contributingNights: "2",
      guestNights: "4",
      allocatedRevenue: "$200.00",
    });
  });

  it("rejects invalid pipeline/status combinations without querying bookings", async () => {
    const model = await buildFinanceBookingsSourcePageModel({
      today: new Date("2026-05-01T00:00:00.000Z"),
      searchParams: {
        forwardFrom: "2026-05-01",
        forwardTo: "2026-05-10",
        forwardAsOf: "2026-05-01",
        section: "forward",
        pipeline: "committed",
        status: "PENDING",
      },
    });

    expect(mockBookingFindMany).not.toHaveBeenCalled();
    expect(model.loadError).toBe(
      "This source booking drill-down is not valid for the report window."
    );
  });
});
