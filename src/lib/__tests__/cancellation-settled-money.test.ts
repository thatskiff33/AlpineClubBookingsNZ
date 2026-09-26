import { describe, expect, it } from "vitest";
import {
  CANCELLED_BOOKING_LATE_CAPTURE_REASON,
  classifyCaptureOnCancelledBooking,
  getCancellationCreditCents,
  isCancellationRefundDecisionRecorded,
  isLateCaptureHandlerWrite,
  type CancellationRefundDecisionEvidence,
} from "@/lib/cancellation-settled-money";
import { MANUAL_SETTLEMENT_REVERSAL_EVENT_KIND } from "@/lib/manual-settlement-reversal-event";

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
        cancelledEvents: [{ type: "CANCELLED", snapshot: { refundPercentage: 0 } }],
      })
    ).toBe(true);
  });

  it("does not count an unpaid-branch CANCELLED event, which carries no snapshot", () => {
    expect(
      isCancellationRefundDecisionRecorded({
        ...noDecision(),
        cancelledEvents: [{ type: "CANCELLED", snapshot: null }],
      })
    ).toBe(false);
  });

  it("does not count an admin settlement marker, a CANCELLED event whose snapshot decides no refund", () => {
    expect(
      isCancellationRefundDecisionRecorded({
        ...noDecision(),
        cancelledEvents: [
          {
            type: "CANCELLED",
            snapshot: { kind: MANUAL_SETTLEMENT_REVERSAL_EVENT_KIND },
          },
        ],
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

describe("classifyCaptureOnCancelledBooking (#3639)", () => {
  const decided: CancellationRefundDecisionEvidence = {
    ...noDecision(),
    cancelledEvents: [{ type: "CANCELLED", snapshot: { refundPercentage: 0 } }],
  };
  const before = { capturedAfterCancellation: false };
  const after = { capturedAfterCancellation: true };

  it("settles a capture recorded before a cancel that decided it, in every captured status", () => {
    for (const status of ["SUCCEEDED", "PARTIALLY_REFUNDED", "REFUNDED"] as const) {
      expect(
        classifyCaptureOnCancelledBooking({ status, ...before }, decided)
      ).toBe("settled_by_cancellation");
    }
  });

  it("calls a row that never captured a late capture", () => {
    for (const status of ["PENDING", "PROCESSING", "FAILED"] as const) {
      expect(
        classifyCaptureOnCancelledBooking({ status, ...before }, decided)
      ).toBe("late_capture");
    }
  });

  it("refunds the handler's own earlier write on a crash-and-retry, even beside a decision", () => {
    expect(
      classifyCaptureOnCancelledBooking({ status: "SUCCEEDED", ...after }, decided)
    ).toBe("late_capture");
  });

  it("refunds a captured row when the cancellation decided nothing — a saved-card charge answered after an unpaid cancel", () => {
    expect(
      classifyCaptureOnCancelledBooking({ status: "SUCCEEDED", ...before }, noDecision())
    ).toBe("late_capture");
  });

  it("acknowledges a late capture already handed back, fully or in part, rather than refunding it again", () => {
    for (const status of ["PARTIALLY_REFUNDED", "REFUNDED"] as const) {
      expect(
        classifyCaptureOnCancelledBooking({ status, ...after }, decided)
      ).toBe("already_refunded");
      expect(
        classifyCaptureOnCancelledBooking({ status, ...before }, noDecision())
      ).toBe("already_refunded");
    }
  });

  it("recognises only the primary handler's own reason as its write", () => {
    expect(isLateCaptureHandlerWrite(CANCELLED_BOOKING_LATE_CAPTURE_REASON)).toBe(true);
    expect(isLateCaptureHandlerWrite(null)).toBe(false);
    expect(isLateCaptureHandlerWrite("confirm_pending_saved_card")).toBe(false);
  });
});
