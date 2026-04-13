import { describe, expect, it } from "vitest";
import { summarizeMemberPaymentOwed } from "../member-dashboard";

describe("summarizeMemberPaymentOwed", () => {
  it("adds outstanding initial and additional booking payments", () => {
    const summary = summarizeMemberPaymentOwed([
      {
        status: "CONFIRMED",
        finalPriceCents: 12000,
        payment: null,
      },
      {
        status: "PAID",
        finalPriceCents: 9000,
        payment: {
          status: "SUCCEEDED",
          additionalAmountCents: 3000,
          additionalPaymentStatus: "PENDING",
        },
      },
      {
        status: "CONFIRMED",
        finalPriceCents: 8000,
        payment: {
          status: "PENDING",
          additionalAmountCents: 1000,
          additionalPaymentStatus: "PENDING",
        },
      },
    ]);

    expect(summary).toEqual({
      bookingCount: 3,
      totalCents: 24000,
    });
  });

  it("ignores bookings without any actionable amount due", () => {
    const summary = summarizeMemberPaymentOwed([
      {
        status: "PENDING",
        finalPriceCents: 7000,
        payment: {
          status: "PENDING",
          additionalAmountCents: 0,
          additionalPaymentStatus: null,
        },
      },
      {
        status: "CONFIRMED",
        finalPriceCents: 7000,
        payment: {
          status: "SUCCEEDED",
          additionalAmountCents: 0,
          additionalPaymentStatus: null,
        },
      },
      {
        status: "PAID",
        finalPriceCents: 7000,
        payment: {
          status: "SUCCEEDED",
          additionalAmountCents: 2000,
          additionalPaymentStatus: "SUCCEEDED",
        },
      },
    ]);

    expect(summary).toEqual({
      bookingCount: 0,
      totalCents: 0,
    });
  });
});
