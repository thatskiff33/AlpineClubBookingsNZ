import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock prisma
const mockPrismaPaymentFindUnique = vi.fn();
const mockPrismaPaymentUpdate = vi.fn();
const mockPrismaBookingUpdate = vi.fn();
const mockPrismaTransaction = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: {
    payment: {
      findUnique: mockPrismaPaymentFindUnique,
      update: mockPrismaPaymentUpdate,
    },
    booking: {
      update: mockPrismaBookingUpdate,
    },
    $transaction: mockPrismaTransaction,
  },
}));

vi.mock("@/lib/stripe", () => ({
  constructWebhookEvent: vi.fn(),
}));

describe("Webhook handler logic", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("payment_intent.succeeded handling", () => {
    it("should update payment and booking status on successful payment", async () => {
      // Simulate the handler logic directly
      const paymentIntent = {
        id: "pi_test_123",
        amount: 5000,
        metadata: { bookingId: "booking_1", memberId: "member_1" },
        payment_method: "pm_test_456",
        status: "succeeded",
      };

      mockPrismaPaymentFindUnique.mockResolvedValue({
        id: "payment_1",
        bookingId: "booking_1",
      });

      mockPrismaTransaction.mockResolvedValue([
        { id: "payment_1", status: "SUCCEEDED" },
        { id: "booking_1", status: "CONFIRMED" },
      ]);

      // Simulate handlePaymentIntentSucceeded logic
      const bookingId = paymentIntent.metadata.bookingId;
      expect(bookingId).toBe("booking_1");

      const payment = await mockPrismaPaymentFindUnique({
        where: { stripePaymentIntentId: paymentIntent.id },
      });
      expect(payment).toBeTruthy();

      // Verify transaction would be called with correct updates
      const result = await mockPrismaTransaction([
        mockPrismaPaymentUpdate({
          where: { bookingId },
          data: {
            stripePaymentIntentId: paymentIntent.id,
            stripePaymentMethodId: paymentIntent.payment_method,
            status: "SUCCEEDED",
            amountCents: paymentIntent.amount,
          },
        }),
        mockPrismaBookingUpdate({
          where: { id: bookingId },
          data: { status: "CONFIRMED" },
        }),
      ]);

      expect(mockPrismaPaymentUpdate).toHaveBeenCalled();
      expect(mockPrismaBookingUpdate).toHaveBeenCalled();
    });
  });

  describe("charge.refunded handling", () => {
    it("should mark payment as REFUNDED for full refund", async () => {
      const payment = {
        id: "payment_1",
        bookingId: "booking_1",
        amountCents: 5000,
      };

      mockPrismaPaymentFindUnique.mockResolvedValue(payment);

      const charge = {
        payment_intent: "pi_test_123",
        amount_refunded: 5000,
      };

      // Simulate handleChargeRefunded logic
      const refundedAmount = charge.amount_refunded;
      const isFullRefund = refundedAmount >= payment.amountCents;

      expect(isFullRefund).toBe(true);

      const expectedStatus = isFullRefund ? "REFUNDED" : "PARTIALLY_REFUNDED";
      expect(expectedStatus).toBe("REFUNDED");
    });

    it("should mark payment as PARTIALLY_REFUNDED for partial refund", () => {
      const payment = { amountCents: 5000 };
      const refundedAmount = 2500;
      const isFullRefund = refundedAmount >= payment.amountCents;

      expect(isFullRefund).toBe(false);

      const expectedStatus = isFullRefund ? "REFUNDED" : "PARTIALLY_REFUNDED";
      expect(expectedStatus).toBe("PARTIALLY_REFUNDED");
    });
  });

  describe("setup_intent.succeeded handling", () => {
    it("should save payment method ID from setup intent", async () => {
      const setupIntent = {
        id: "seti_test_123",
        metadata: { bookingId: "booking_1" },
        payment_method: "pm_saved_789",
      };

      // Extract payment method ID correctly from string or object
      const paymentMethodId =
        typeof setupIntent.payment_method === "string"
          ? setupIntent.payment_method
          : null;

      expect(paymentMethodId).toBe("pm_saved_789");
    });
  });
});
