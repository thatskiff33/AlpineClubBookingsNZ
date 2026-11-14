/**
 * #4911 (`INV-PAY-154`, `INV-PAY-128`): a late capture's automatic refund that
 * the refund chokepoint refuses because the cardholder disputes the capture is
 * answered as `disputeRefused`, never re-thrown, so the webhook holds it for a
 * treasurer instead of answering 500 to every redelivery.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  refundPaymentTransactions: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: { paymentTransaction: { findUnique: mocks.findUnique } } }));
vi.mock("@/lib/payment-transactions", () => ({ refundPaymentTransactions: mocks.refundPaymentTransactions }));

import { refundLateCaptureFromOwnCharge } from "@/lib/late-capture-own-charge-refund";
import { DisputedCaptureRefundRefusedError } from "@/lib/stripe-dispute-hold";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

const params = { format: CLUB_FORMAT_TEST, bookingId: "booking-1", paymentId: "payment-1", paymentIntentId: "pi_late", amountCents: 5000 };
const disputes = [{ stripeDisputeId: "dp_1", stripePaymentIntentId: "pi_late", status: "OPEN" as const, amountCents: 5000 }];

describe("refundLateCaptureFromOwnCharge on a disputed capture (#4911)", () => {
  beforeEach(() => {
    mocks.findUnique.mockResolvedValue({ id: "txn-late", paymentId: "payment-1", status: "SUCCEEDED", amountCents: 5000, refundedAmountCents: 0 });
  });

  it("answers disputeRefused with nothing sent, rather than throwing for Stripe's redelivery", async () => {
    // As `refundPaymentTransactions` refuses it: the refusal as its PartialRefundError's cause.
    const partial = Object.assign(new Error("partial"), { name: "PartialRefundError", cause: new DisputedCaptureRefundRefusedError("pi_late", disputes) });
    mocks.refundPaymentTransactions.mockRejectedValueOnce(partial);

    const result = await refundLateCaptureFromOwnCharge(params);

    expect(result).toEqual(expect.objectContaining({ refunds: [], disputeRefused: true, reservationRefused: false }));
  });

  it("still re-throws any other failure", async () => {
    mocks.refundPaymentTransactions.mockRejectedValueOnce(new Error("Stripe is down"));

    await expect(refundLateCaptureFromOwnCharge(params)).rejects.toThrow("Stripe is down");
  });
});
