import { describe, expect, it } from "vitest";
import {
  CANCELLED_BOOKING_LATE_CAPTURE_REASON,
  getCancellationCreditCents,
  hasCancellationSettledCapture,
  isCancellationRefundDecisionRecorded,
  type CancellationRefundDecisionEvidence,
} from "@/lib/cancellation-settled-money";

// #3639: the one answer to "what did the cancellation already settle?", read by
// the Stripe webhook's late-capture handler and the repair tool's late-capture
// arm. The end-to-end behaviour of each caller is pinned in
// `stripe-webhook-alerts.test.ts` and `xero-booking-repair.test.ts`; this file
// pins the rule itself.

const BOOKING_ID = "booking-abcdef123";

function noDecision(): CancellationRefundDecisionEvidence {
  return {
    bookingId: BOOKING_ID,
    cancelledEvents: [],
    creditsFromCancellation: [],
    cancellationRefundRecoveryOperations: [],
  };
}

describe("isCancellationRefundDecisionRecorded (#1491, lifted by #3639)", () => {
  it("is false when the cancellation left no artefact", () => {
    expect(isCancellationRefundDecisionRecorded(noDecision())).toBe(false);
  });

  it("counts a CANCELLED event carrying the policy snapshot — the 0%-tier retention's only artefact", () => {
    expect(
      isCancellationRefundDecisionRecorded({
        ...noDecision(),
        cancelledEvents: [{ snapshot: { refundPercentage: 0 } }],
      })
    ).toBe(true);
  });

  it("does not count an unpaid-branch CANCELLED event, which carries no snapshot", () => {
    expect(
      isCancellationRefundDecisionRecorded({
        ...noDecision(),
        cancelledEvents: [{ snapshot: null }],
      })
    ).toBe(false);
  });

  it("counts the credit path's cancellation credit, matched on this booking's description", () => {
    expect(
      isCancellationRefundDecisionRecorded({
        ...noDecision(),
        creditsFromCancellation: [
          {
            type: "CANCELLATION_REFUND",
            description: "Cancellation refund for booking booking-",
            amountCents: 5000,
          },
        ],
      })
    ).toBe(true);
  });

  it("does not count applied credit handed back on an unpaid cancel, which shares the type but not the description", () => {
    expect(
      isCancellationRefundDecisionRecorded({
        ...noDecision(),
        creditsFromCancellation: [
          {
            type: "CANCELLATION_REFUND",
            description: "Credit restored from cancelled booking booking-",
            amountCents: 5000,
          },
        ],
      })
    ).toBe(false);
  });

  it("counts a live card-path recovery operation but not a terminally FAILED one", () => {
    expect(
      isCancellationRefundDecisionRecorded({
        ...noDecision(),
        cancellationRefundRecoveryOperations: [{ status: "SUCCEEDED" }],
      })
    ).toBe(true);
    expect(
      isCancellationRefundDecisionRecorded({
        ...noDecision(),
        cancellationRefundRecoveryOperations: [{ status: "FAILED" }],
      })
    ).toBe(false);
  });
});

describe("getCancellationCreditCents", () => {
  it("sums only this booking's cancellation-refund credits", () => {
    expect(
      getCancellationCreditCents(BOOKING_ID, [
        {
          type: "CANCELLATION_REFUND",
          description: "Cancellation refund for booking booking-",
          amountCents: 3000,
        },
        {
          type: "CANCELLATION_REFUND",
          description: "Cancellation refund for booking booking-",
          amountCents: 2000,
        },
        {
          type: "CANCELLATION_REFUND",
          description: "Cancellation refund for booking someone",
          amountCents: 9999,
        },
        {
          type: "ADMIN_ADJUSTMENT",
          description: "Cancellation refund for booking booking-",
          amountCents: 9999,
        },
      ])
    ).toBe(5000);
  });
});

describe("hasCancellationSettledCapture (#3639)", () => {
  const decided: CancellationRefundDecisionEvidence = {
    ...noDecision(),
    cancelledEvents: [{ snapshot: { refundPercentage: 0 } }],
  };

  it("holds for a capture the booking's own settlement recorded before a cancel that decided it", () => {
    for (const status of ["SUCCEEDED", "PARTIALLY_REFUNDED", "REFUNDED"] as const) {
      expect(
        hasCancellationSettledCapture({ status, reason: null }, decided)
      ).toBe(true);
    }
  });

  it("does not hold for a row that never captured", () => {
    for (const status of ["PENDING", "PROCESSING", "FAILED"] as const) {
      expect(
        hasCancellationSettledCapture({ status, reason: null }, decided)
      ).toBe(false);
    }
  });

  it("does not hold for the late-capture handler's own earlier write, so a crash-and-retry is still refunded", () => {
    expect(
      hasCancellationSettledCapture(
        { status: "SUCCEEDED", reason: CANCELLED_BOOKING_LATE_CAPTURE_REASON },
        decided
      )
    ).toBe(false);
  });

  it("does not hold for a captured row when the cancellation decided nothing — a saved-card charge answered after an unpaid cancel", () => {
    expect(
      hasCancellationSettledCapture(
        { status: "SUCCEEDED", reason: "confirm_pending_saved_card" },
        noDecision()
      )
    ).toBe(false);
  });
});
