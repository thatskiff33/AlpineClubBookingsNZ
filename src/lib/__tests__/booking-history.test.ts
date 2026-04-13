import { describe, expect, it } from "vitest";
import { buildBookingHistoryItems } from "@/lib/booking-history";

describe("buildBookingHistoryItems", () => {
  it("builds a unified history sorted newest-first", () => {
    const items = buildBookingHistoryItems({
      createdAt: new Date("2026-04-01T09:00:00Z"),
      payment: {
        status: "PARTIALLY_REFUNDED",
        amountCents: 12000,
        refundedAmountCents: 3000,
        additionalAmountCents: 2500,
        additionalPaymentStatus: "SUCCEEDED",
        createdAt: new Date("2026-04-01T09:00:00Z"),
        updatedAt: new Date("2026-04-04T13:00:00Z"),
      },
      modifications: [
        {
          id: "mod-1",
          modificationType: "DATE_CHANGE",
          previousData: {
            checkIn: "2026-07-01",
            checkOut: "2026-07-03",
          },
          newData: {
            checkIn: "2026-07-02",
            checkOut: "2026-07-04",
          },
          priceDiffCents: 2500,
          changeFeeCents: 1000,
          createdAt: new Date("2026-04-03T12:00:00Z"),
        },
      ],
      refundRequests: [
        {
          id: "refund-1",
          status: "APPROVED",
          reason: "Travel disruption.",
          requestedAmountCents: 3000,
          approvedAmountCents: 3000,
          adminNotes: "Approved after committee review.",
          createdAt: new Date("2026-04-05T10:00:00Z"),
          reviewedAt: new Date("2026-04-06T11:00:00Z"),
        },
      ],
      auditLogs: [
        {
          id: "audit-payment",
          action: "booking.payment.confirmed",
          details: JSON.stringify({
            paymentIntentId: "pi_123",
            amountCents: 12000,
          }),
          createdAt: new Date("2026-04-02T10:00:00Z"),
        },
        {
          id: "audit-cancel",
          action: "booking.cancel",
          details: "Refund 50% = 3000 cents",
          createdAt: new Date("2026-04-07T12:00:00Z"),
        },
      ],
    });

    expect(items.map((item) => item.title)).toEqual([
      "Booking cancelled",
      "Refund appeal approved",
      "Refund appeal submitted",
      "Additional payment recorded",
      "Dates Changed",
      "Payment successful",
      "Booking created",
    ]);

    expect(items[0].category).toBe("Booking");
    expect(items[1].amountDisplay).toBe("$30.00");
    expect(items[4].amountDisplay).toBe("+$25.00");
    expect(items[4].detail).toContain("Change fee applied: $10.00.");
  });

  it("falls back to the payment updated timestamp when no success audit exists", () => {
    const items = buildBookingHistoryItems({
      createdAt: new Date("2026-04-01T09:00:00Z"),
      payment: {
        status: "SUCCEEDED",
        amountCents: 9000,
        refundedAmountCents: 0,
        additionalAmountCents: 0,
        additionalPaymentStatus: null,
        createdAt: new Date("2026-04-01T09:00:00Z"),
        updatedAt: new Date("2026-04-08T14:00:00Z"),
      },
      modifications: [],
      refundRequests: [],
      auditLogs: [],
    });

    expect(items[0].title).toBe("Payment recorded");
    expect(items[0].occurredAt.toISOString()).toBe("2026-04-08T14:00:00.000Z");
  });
});
