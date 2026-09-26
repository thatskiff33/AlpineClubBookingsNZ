import { describe, expect, it, vi } from "vitest";
import {
  paidCancellationBranch,
  writePaidCancellationEvent,
} from "@/lib/paid-cancellation-event";

// #3639: the paid-path cancellation's branch, decided once inside the claim, and
// the CANCELLED event it writes there. `booking-cancel.test.ts` pins the card,
// credit and 0% branches end to end through the claim; the cash hand-back has no
// end-to-end fixture there, so its branch and sentence are pinned here.

describe("paidCancellationBranch", () => {
  it("is none whenever nothing is refunded, whatever the method", () => {
    for (const refundMethod of ["card", "credit"] as const) {
      expect(
        paidCancellationBranch({ manualDisposition: true, refundMethod, refundAmountCents: 0 })
      ).toBe("none");
    }
  });

  it("puts a cash settlement's refund on the manual branch, ahead of the method", () => {
    expect(
      paidCancellationBranch({ manualDisposition: true, refundMethod: "credit", refundAmountCents: 500 })
    ).toBe("manual");
  });

  it("otherwise follows the method", () => {
    expect(
      paidCancellationBranch({ manualDisposition: false, refundMethod: "credit", refundAmountCents: 500 })
    ).toBe("credit");
    expect(
      paidCancellationBranch({ manualDisposition: false, refundMethod: "card", refundAmountCents: 500 })
    ).toBe("card");
  });
});

describe("writePaidCancellationEvent", () => {
  it("writes the cash hand-back's sentence and method on the claim's own client", async () => {
    const create = vi.fn().mockResolvedValue({});
    const tx = { bookingEvent: { create } } as never;

    await writePaidCancellationEvent(tx, {
      bookingId: "booking_1",
      actorMemberId: "admin_1",
      branch: "manual",
      days: 10,
      refundPercentage: 50,
      refundAmountCents: 4000,
      paidAmountCents: 8000,
      changeFeeCents: 0,
    });

    expect(create).toHaveBeenCalledWith({
      data: {
        bookingId: "booking_1",
        type: "CANCELLED",
        actorMemberId: "admin_1",
        amountCents: 8000,
        reason: null,
        snapshot: {
          policySummary:
            "Cancelled 10 day(s) before check-in: 50% refund under the policy in effect at the time, to be paid back by the club by hand (cash / off-Xero settlement).",
          refundMethod: "manual",
          refundPercentage: 50,
          paidAmountCents: 8000,
          settledAmountCents: 4000,
          retainedAmountCents: 4000,
          changeFeeCents: 0,
        },
      },
    });
  });

  it("lets a failed write throw, so the claim rolls back", async () => {
    const tx = {
      bookingEvent: { create: vi.fn().mockRejectedValue(new Error("insert failed")) },
    } as never;

    await expect(
      writePaidCancellationEvent(tx, {
        bookingId: "booking_1",
        actorMemberId: "member_1",
        branch: "none",
        days: 3,
        refundPercentage: 0,
        refundAmountCents: 0,
        paidAmountCents: 8000,
        changeFeeCents: 0,
      })
    ).rejects.toThrow("insert failed");
  });
});
