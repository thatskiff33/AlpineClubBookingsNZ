import { beforeEach, describe, expect, it, vi } from "vitest";
import Stripe from "stripe";
import { stripeSdkError as stripeError } from "./support/stripe-sdk-error";
import {
  PaymentSource,
  PaymentStatus,
  PaymentTransactionKind,
} from "@prisma/client";

// #3268 — the saved-card charge-failure classifier and the retirement of a
// card it calls terminal. The cron integration (release first, then retire,
// then the two notices) is covered at the end of cron-confirm-pending.test.ts;
// this file pins the decision table and the row-clearing contract on their own.

const mockPaymentUpdateMany = vi.fn();
const mockPaymentTransactionUpdateMany = vi.fn();
vi.mock("../prisma", () => ({
  prisma: {
    payment: {
      updateMany: (...args: unknown[]) => mockPaymentUpdateMany(...args),
    },
    paymentTransaction: {
      updateMany: (...args: unknown[]) =>
        mockPaymentTransactionUpdateMany(...args),
    },
  },
}));

const mockDetachPaymentMethod = vi.fn();
vi.mock("../stripe", () => ({
  detachPaymentMethod: (...args: unknown[]) => mockDetachPaymentMethod(...args),
}));

const mockSendSavedCardChargeFailedEmail = vi.fn();
const mockSendAdminPaymentFailureAlert = vi.fn();
vi.mock("../email", () => ({
  sendSavedCardChargeFailedEmail: (...args: unknown[]) =>
    mockSendSavedCardChargeFailedEmail(...args),
  sendAdminPaymentFailureAlert: (...args: unknown[]) =>
    mockSendAdminPaymentFailureAlert(...args),
}));

const {
  classifySavedCardChargeFailure,
  describeTerminalSavedCardChargeFailure,
  retireAndEscalateUnusableSavedCard,
  retireUnusableSavedCard,
  SOFT_DECLINE_TERMINAL_WINDOW,
} = await import("../saved-card-charge-failure");
const { reconcilePaymentAggregates } = await import("../payment-transactions");

const IN_WINDOW = { holdOverdueWindows: 1 };
const PAST_WINDOW = { holdOverdueWindows: SOFT_DECLINE_TERMINAL_WINDOW };

const INCIDENT_MESSAGE =
  "The provided PaymentMethod was previously used with a PaymentIntent without Customer attachment or was detached from a Customer. It may not be used again. To use a PaymentMethod multiple times, you must attach it to a Customer first.";

describe("classifySavedCardChargeFailure (#3268)", () => {
  describe("reads the SDK's thrown shape and the raw API shape alike", () => {
    it("the factory really produces the SDK shape: class name in `type`, API type in `rawType`", () => {
      const err = stripeError({ type: "card_error", code: "card_declined", decline_code: "lost_card" });
      expect(err).toBeInstanceOf(Stripe.errors.StripeCardError);
      expect(err.type).toBe("StripeCardError");
      expect(err.rawType).toBe("card_error");
      const irr = stripeError({ type: "invalid_request_error", message: INCIDENT_MESSAGE });
      expect(irr).toBeInstanceOf(Stripe.errors.StripeInvalidRequestError);
      expect(irr.type).toBe("StripeInvalidRequestError");
      expect(irr.rawType).toBe("invalid_request_error");
    });

    it("classifies a real SDK card decline as card_error, reporting the API type not the class name", () => {
      const result = classifySavedCardChargeFailure(
        stripeError({ type: "card_error", code: "card_declined", decline_code: "lost_card" }),
        IN_WINDOW,
      );
      expect(result.outcome).toBe("terminal");
      expect(result.stripeType).toBe("card_error");
    });

    it("classifies the raw API object — `type` holding the API type, no `rawType` — the same way (webhook / last_payment_error shape)", () => {
      const rawDecline = { type: "card_error", code: "card_declined", decline_code: "lost_card", message: "Your card was declined." };
      const decline = classifySavedCardChargeFailure(rawDecline, IN_WINDOW);
      expect(decline.outcome).toBe("terminal");
      expect(decline.outcome === "terminal" && decline.reason).toBe("card_permanently_declined");
      expect(decline.stripeType).toBe("card_error");

      const rawIncident = { type: "invalid_request_error", message: INCIDENT_MESSAGE };
      const incident = classifySavedCardChargeFailure(rawIncident, IN_WINDOW);
      expect(incident.outcome).toBe("terminal");
      expect(incident.outcome === "terminal" && incident.reason).toBe("payment_method_unusable");
      expect(incident.message).toBe(INCIDENT_MESSAGE);
    });

    it("does not mistake an SDK class name for an API type (a connection error has no rawType)", () => {
      const result = classifySavedCardChargeFailure(
        new Stripe.errors.StripeConnectionError({ message: "socket hang up" }),
        PAST_WINDOW,
      );
      expect(result.outcome).toBe("retry");
      expect(result.stripeType).toBeNull();
      expect(result.message).toBe("socket hang up");
    });
  });

  describe("payment_method_unusable — invalid_request_error about the pm itself", () => {
    it.each([
      ["param names the payment method", { type: "invalid_request_error", param: "payment_method", message: "Invalid payment_method" }],
      ["payment_method_unexpected_state", { type: "invalid_request_error", code: "payment_method_unexpected_state" }],
      ["payment_method_customer_mismatch", { type: "invalid_request_error", code: "payment_method_customer_mismatch" }],
      ["payment_method_unactivated", { type: "invalid_request_error", code: "payment_method_unactivated" }],
      ["payment_method_invalid_parameter", { type: "invalid_request_error", code: "payment_method_invalid_parameter" }],
      ["resource_missing on the payment method", { type: "invalid_request_error", code: "resource_missing", param: "payment_method", message: "No such PaymentMethod: 'pm_x'" }],
      ["resource_missing on payment_method_data", { type: "invalid_request_error", code: "resource_missing", param: "payment_method_data" }],
      ["the production incident text, no code, no param", { type: "invalid_request_error", message: INCIDENT_MESSAGE }],
      ["'does not belong to' wording", { type: "invalid_request_error", message: "The PaymentMethod does not belong to this Customer." }],
    ])("is terminal for %s", (_label, fields) => {
      const result = classifySavedCardChargeFailure(stripeError(fields), IN_WINDOW);
      expect(result.outcome).toBe("terminal");
      expect(result.outcome === "terminal" && result.reason).toBe("payment_method_unusable");
      expect(result.stripeType).toBe("invalid_request_error");
    });

    it("retries an invalid_request_error about something other than the card", () => {
      const result = classifySavedCardChargeFailure(
        stripeError({ type: "invalid_request_error", param: "amount", message: "Invalid integer: abc" }),
        PAST_WINDOW,
      );
      expect(result.outcome).toBe("retry");
    });

    it("does not let a message merely mentioning PaymentMethod trip the last-resort match", () => {
      const result = classifySavedCardChargeFailure(
        stripeError({ type: "invalid_request_error", message: "PaymentMethod requires a currency" }),
        PAST_WINDOW,
      );
      expect(result.outcome).toBe("retry");
    });

    it("carries the provider evidence for the alert and the log", () => {
      const result = classifySavedCardChargeFailure(
        stripeError({ type: "invalid_request_error", code: "resource_missing", param: "payment_method", message: "No such PaymentMethod: 'pm_x'" }),
        IN_WINDOW,
      );
      expect(result).toMatchObject({
        stripeType: "invalid_request_error",
        stripeCode: "resource_missing",
        declineCode: null,
        adviceCode: null,
        message: "No such PaymentMethod: 'pm_x'",
      });
    });
  });

  describe("card_permanently_declined — a card_error a retry cannot cure", () => {
    it.each([
      "expired_card",
      "incorrect_number",
      "invalid_number",
      "incorrect_cvc",
      "invalid_cvc",
      "invalid_expiry_month",
      "invalid_expiry_year",
      "authentication_required",
    ])("is terminal for code %s even inside the window", (code) => {
      const result = classifySavedCardChargeFailure(stripeError({ type: "card_error", code }), IN_WINDOW);
      expect(result.outcome).toBe("terminal");
      expect(result.outcome === "terminal" && result.reason).toBe("card_permanently_declined");
    });

    it.each([
      "expired_card",
      "lost_card",
      "stolen_card",
      "pickup_card",
      "restricted_card",
      "card_not_supported",
      "currency_not_supported",
      "invalid_account",
      "new_account_information_available",
      "revocation_of_all_authorizations",
      "revocation_of_authorization",
      "security_violation",
      "service_not_allowed",
      "stop_payment_order",
      "transaction_not_allowed",
      "fraudulent",
      "merchant_blacklist",
      "authentication_required",
      "do_not_try_again",
    ])("is terminal for decline_code %s even inside the window", (decline_code) => {
      const result = classifySavedCardChargeFailure(
        stripeError({ type: "card_error", code: "card_declined", decline_code }),
        IN_WINDOW,
      );
      expect(result.outcome).toBe("terminal");
      expect(result.outcome === "terminal" && result.reason).toBe("card_permanently_declined");
      expect(result.declineCode).toBe(decline_code);
    });

    it("is terminal when Stripe's advice_code says do_not_try_again, whatever the decline code", () => {
      const result = classifySavedCardChargeFailure(
        stripeError({
          type: "card_error",
          code: "card_declined",
          decline_code: "generic_decline",
          advice_code: "do_not_try_again",
        }),
        IN_WINDOW,
      );
      expect(result.outcome).toBe("terminal");
      expect(result.outcome === "terminal" && result.reason).toBe("card_permanently_declined");
      expect(result.adviceCode).toBe("do_not_try_again");
    });

    it("any other advice_code leaves a soft decline soft", () => {
      const result = classifySavedCardChargeFailure(
        stripeError({
          type: "card_error",
          code: "card_declined",
          decline_code: "generic_decline",
          advice_code: "try_again_later",
        }),
        IN_WINDOW,
      );
      expect(result.outcome).toBe("retry");
      expect(result.adviceCode).toBe("try_again_later");
    });
  });

  describe("soft declines — retried, then exhausted after the window", () => {
    const SOFT: Array<[string, { code?: string; decline_code?: string }]> = [
      ["insufficient_funds", { code: "card_declined", decline_code: "insufficient_funds" }],
      ["try_again_later", { code: "card_declined", decline_code: "try_again_later" }],
      ["processing_error", { code: "processing_error" }],
      ["issuer_not_available", { code: "card_declined", decline_code: "issuer_not_available" }],
      ["generic_decline", { code: "card_declined", decline_code: "generic_decline" }],
      ["do_not_honor", { code: "card_declined", decline_code: "do_not_honor" }],
      ["an unknown decline code", { code: "card_declined", decline_code: "some_future_code" }],
      ["a card_error with no code at all", {}],
    ];

    it.each(SOFT)("retries %s while the hold is inside the first window", (_label, fields) => {
      const result = classifySavedCardChargeFailure(
        stripeError({ type: "card_error", ...fields }),
        { holdOverdueWindows: SOFT_DECLINE_TERMINAL_WINDOW - 1 },
      );
      expect(result.outcome).toBe("retry");
    });

    it.each(SOFT)("gives up on %s once the hold is two windows overdue", (_label, fields) => {
      const result = classifySavedCardChargeFailure(
        stripeError({ type: "card_error", ...fields }),
        PAST_WINDOW,
      );
      expect(result.outcome).toBe("terminal");
      expect(result.outcome === "terminal" && result.reason).toBe("soft_decline_exhausted");
    });

    it("also gives up well past the window", () => {
      const result = classifySavedCardChargeFailure(
        stripeError({ type: "card_error", code: "card_declined", decline_code: "insufficient_funds" }),
        { holdOverdueWindows: 9 },
      );
      expect(result.outcome).toBe("terminal");
    });
  });

  describe("everything else is retried, however overdue", () => {
    it.each([
      ["api_error", stripeError({ type: "api_error" })],
      ["rate_limit_error", stripeError({ type: "rate_limit_error" })],
      ["authentication_error (our key)", stripeError({ type: "authentication_error" })],
      ["idempotency_error", stripeError({ type: "idempotency_error" })],
      ["a connection error", new Stripe.errors.StripeConnectionError({ message: "socket hang up" })],
      ["a plain Error", new Error("Card declined")],
      ["a string", "boom"],
      ["null", null],
      ["undefined", undefined],
      ["an object with a non-string type", { type: 42 }],
    ])("retries %s", (_label, err) => {
      expect(classifySavedCardChargeFailure(err, PAST_WINDOW).outcome).toBe("retry");
    });

    it("still reports the message of a non-Stripe error", () => {
      expect(classifySavedCardChargeFailure(new Error("Card declined"), IN_WINDOW).message).toBe("Card declined");
      expect(classifySavedCardChargeFailure("boom", IN_WINDOW).message).toBe("boom");
    });
  });
});

describe("describeTerminalSavedCardChargeFailure (#3268)", () => {
  it("tells the admin what happened, what was done, what the member was asked, and what Stripe said", () => {
    const text = describeTerminalSavedCardChargeFailure(
      {
        outcome: "terminal",
        reason: "payment_method_unusable",
        stripeType: "invalid_request_error",
        stripeCode: "resource_missing",
        declineCode: null,
        adviceCode: null,
        message: "No such PaymentMethod: 'pm_x'",
      },
      { claimReleased: true },
    );
    expect(text).toContain("found unusable");
    expect(text).toContain("removed from the booking");
    expect(text).toContain("save a new card");
    expect(text).toContain("The booking stays pending");
    expect(text).toContain("No such PaymentMethod: 'pm_x'");
    expect(text).toContain("code resource_missing");
  });

  it("says the booking is stuck confirmed-unpaid when the claim release itself failed, never 'stays pending'", () => {
    const text = describeTerminalSavedCardChargeFailure(
      {
        outcome: "terminal",
        reason: "payment_method_unusable",
        stripeType: "invalid_request_error",
        stripeCode: null,
        declineCode: null,
        adviceCode: null,
        message: INCIDENT_MESSAGE,
      },
      { claimReleased: false },
    );
    expect(text).not.toContain("stays pending");
    expect(text).toContain("could NOT be returned to pending");
    expect(text).toContain("still marked confirmed but unpaid");
    expect(text).toContain("needs an administrator");
  });

  it("names the two-day rule for an exhausted soft decline", () => {
    const text = describeTerminalSavedCardChargeFailure(
      {
        outcome: "terminal",
        reason: "soft_decline_exhausted",
        stripeType: "card_error",
        stripeCode: "card_declined",
        declineCode: "insufficient_funds",
        adviceCode: null,
        message: "Your card has insufficient funds.",
      },
      { claimReleased: true },
    );
    expect(text).toContain("two days");
    expect(text).toContain("decline insufficient_funds");
  });
});

describe("retireUnusableSavedCard (#3268)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDetachPaymentMethod.mockResolvedValue({ id: "pm_dead" });
    mockPaymentUpdateMany.mockResolvedValue({ count: 2 });
    mockPaymentTransactionUpdateMany.mockResolvedValue({ count: 1 });
  });

  it("detaches at Stripe, then clears every Payment row AND every ledger row carrying that exact pm", async () => {
    const result = await retireUnusableSavedCard({ paymentMethodId: "pm_dead", bookingId: "b1" });

    expect(mockDetachPaymentMethod).toHaveBeenCalledWith("pm_dead");
    expect(mockPaymentUpdateMany).toHaveBeenCalledWith({
      where: { stripePaymentMethodId: "pm_dead" },
      data: { stripePaymentMethodId: null },
    });
    expect(mockPaymentTransactionUpdateMany).toHaveBeenCalledWith({
      where: { paymentMethodId: "pm_dead" },
      data: { paymentMethodId: null },
    });
    expect(result).toEqual({ clearedPaymentRows: 2, clearedLedgerRows: 1 });

    // Provider call first, outside any transaction, then the local writes.
    const detachOrder = mockDetachPaymentMethod.mock.invocationCallOrder[0]!;
    expect(mockPaymentUpdateMany.mock.invocationCallOrder[0]!).toBeGreaterThan(detachOrder);
  });

  it("swallows an invalid_request_error from the detach and still clears the rows (an already-detached pm is unusable either way)", async () => {
    mockDetachPaymentMethod.mockRejectedValue(
      stripeError({ type: "invalid_request_error", message: "The payment method you provided is not attached to a customer" }),
    );

    const result = await retireUnusableSavedCard({ paymentMethodId: "pm_dead", bookingId: "b1" });

    expect(mockPaymentUpdateMany).toHaveBeenCalledTimes(1);
    expect(mockPaymentTransactionUpdateMany).toHaveBeenCalledTimes(1);
    expect(result.clearedPaymentRows).toBe(2);
  });

  it("also swallows resource_missing (the pm no longer exists at Stripe) and clears", async () => {
    mockDetachPaymentMethod.mockRejectedValue(
      stripeError({ type: "invalid_request_error", code: "resource_missing", param: "payment_method", message: "No such PaymentMethod: 'pm_dead'" }),
    );

    await retireUnusableSavedCard({ paymentMethodId: "pm_dead", bookingId: "b1" });

    expect(mockPaymentUpdateMany).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["api_error", stripeError({ type: "api_error", message: "Stripe is having a moment" })],
    ["rate_limit_error", stripeError({ type: "rate_limit_error" })],
    ["authentication_error", stripeError({ type: "authentication_error" })],
    ["a connection error", new Stripe.errors.StripeConnectionError({ message: "socket hang up" })],
    ["a plain Error", new Error("network down")],
  ])("RETHROWS a detach failure of %s and clears NOTHING — a cleared card must be a detached card", async (_label, detachErr) => {
    mockDetachPaymentMethod.mockRejectedValue(detachErr);

    await expect(
      retireUnusableSavedCard({ paymentMethodId: "pm_dead", bookingId: "b1" }),
    ).rejects.toBe(detachErr);

    expect(mockPaymentUpdateMany).not.toHaveBeenCalled();
    expect(mockPaymentTransactionUpdateMany).not.toHaveBeenCalled();
  });

  it("leaves the setup intent and customer alone — only the payment-method fields are written", async () => {
    await retireUnusableSavedCard({ paymentMethodId: "pm_dead", bookingId: "b1" });

    const [{ data }] = mockPaymentUpdateMany.mock.calls[0] as [{ data: Record<string, unknown> }];
    expect(Object.keys(data)).toEqual(["stripePaymentMethodId"]);
  });

  it("is durable against a later reconcile: once retired, reconcilePaymentAggregates cannot copy the pm back off the ledger", async () => {
    // The mirror on Payment is DERIVED from the latest PRIMARY ledger row on
    // every reconcile (payment-transactions.ts). Model a payment whose ledger
    // recorded the dead pm on a PROCESSING row — exactly what a prior run's
    // requires_action intent or a legacy backfill leaves behind.
    const payment = {
      id: "pay_1",
      amountCents: 10_000,
      creditAppliedCents: 0,
      refundedAmountCents: 0,
      status: PaymentStatus.PENDING,
      source: PaymentSource.STRIPE,
      reference: null,
      stripePaymentIntentId: "pi_prev",
      stripePaymentMethodId: "pm_dead",
      xeroInvoiceId: null,
      xeroInvoiceNumber: null,
      additionalPaymentIntentId: null,
      additionalAmountCents: 0,
      additionalPaymentStatus: "NONE",
      transactions: [
        {
          id: "tx_1",
          kind: PaymentTransactionKind.PRIMARY,
          source: PaymentSource.STRIPE,
          stripePaymentIntentId: "pi_prev",
          amountCents: 10_000,
          refundedAmountCents: 0,
          status: PaymentStatus.PROCESSING,
          paymentMethodId: "pm_dead" as string | null,
          reference: null,
          xeroInvoiceId: null,
          xeroInvoiceNumber: null,
          createdAt: new Date("2026-06-20T00:00:00.000Z"),
        },
      ],
    };
    // The mocked prisma writes land on this same in-memory row set.
    mockPaymentUpdateMany.mockImplementation(async ({ where, data }) => {
      let count = 0;
      if (payment.stripePaymentMethodId === where.stripePaymentMethodId) {
        payment.stripePaymentMethodId = data.stripePaymentMethodId;
        count += 1;
      }
      return { count };
    });
    mockPaymentTransactionUpdateMany.mockImplementation(async ({ where, data }) => {
      let count = 0;
      for (const tx of payment.transactions) {
        if (tx.paymentMethodId === where.paymentMethodId) {
          tx.paymentMethodId = data.paymentMethodId;
          count += 1;
        }
      }
      return { count };
    });
    const store = {
      payment: {
        findUnique: vi.fn(async () => payment),
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          Object.assign(payment, data);
          return payment;
        }),
      },
      paymentTransaction: { create: vi.fn() },
    };

    await retireUnusableSavedCard({ paymentMethodId: "pm_dead", bookingId: "b1" });
    expect(payment.stripePaymentMethodId).toBeNull();

    await reconcilePaymentAggregates({ paymentId: "pay_1", store: store as never });

    expect(
      payment.stripePaymentMethodId,
      "reconcile re-derives Payment.stripePaymentMethodId from the latest PRIMARY " +
        "ledger row; if that row still carried pm_dead the retirement would last " +
        "only until the next webhook",
    ).toBeNull();
    expect(store.paymentTransaction.create).not.toHaveBeenCalled();
  });
});

describe("retireAndEscalateUnusableSavedCard (#3268)", () => {
  const booking = {
    id: "b1",
    memberId: "member_b1",
    lodgeId: "lodge_1",
    checkIn: new Date("2026-07-15T00:00:00.000Z"),
    checkOut: new Date("2026-07-17T00:00:00.000Z"),
    finalPriceCents: 10_000,
    member: { email: "b1@example.com", firstName: "Test", lastName: "User" },
  };
  const failure = {
    outcome: "terminal" as const,
    reason: "payment_method_unusable" as const,
    stripeType: "invalid_request_error",
    stripeCode: null,
    declineCode: null,
    adviceCode: null,
    message: INCIDENT_MESSAGE,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockDetachPaymentMethod.mockResolvedValue({ id: "pm_dead" });
    mockPaymentUpdateMany.mockResolvedValue({ count: 1 });
    mockPaymentTransactionUpdateMany.mockResolvedValue({ count: 0 });
    mockSendSavedCardChargeFailedEmail.mockResolvedValue(undefined);
    mockSendAdminPaymentFailureAlert.mockResolvedValue(undefined);
  });

  it("retires the card, then emails the member once and the admins once", async () => {
    await retireAndEscalateUnusableSavedCard({
      booking,
      paymentMethodId: "pm_dead",
      paymentIntentId: "N/A",
      failure,
      claimReleased: true,
    });

    expect(mockPaymentUpdateMany).toHaveBeenCalledTimes(1);
    expect(mockSendSavedCardChargeFailedEmail).toHaveBeenCalledTimes(1);
    expect(mockSendSavedCardChargeFailedEmail).toHaveBeenCalledWith({
      bookingId: "b1",
      recipientMemberId: "member_b1",
      email: "b1@example.com",
      firstName: "Test",
      checkIn: booking.checkIn,
      checkOut: booking.checkOut,
      lodgeId: "lodge_1",
    });
    expect(mockSendAdminPaymentFailureAlert).toHaveBeenCalledTimes(1);
    const [alert] = mockSendAdminPaymentFailureAlert.mock.calls[0] as [{ errorMessage: string; memberName: string; amountCents: number }];
    expect(alert.memberName).toBe("Test User");
    expect(alert.amountCents).toBe(10_000);
    expect(alert.errorMessage).toContain("found unusable");
    expect(alert.errorMessage).toContain(INCIDENT_MESSAGE);
  });

  it("does not throw when the member email fails, and the clear is not undone", async () => {
    mockSendSavedCardChargeFailedEmail.mockRejectedValue(new Error("SES down"));

    await expect(
      retireAndEscalateUnusableSavedCard({ booking, paymentMethodId: "pm_dead", paymentIntentId: "N/A", failure, claimReleased: true }),
    ).resolves.toBeUndefined();

    expect(mockPaymentUpdateMany).toHaveBeenCalledTimes(1);
    expect(mockSendAdminPaymentFailureAlert).toHaveBeenCalledTimes(1);
  });

  it("threads a failed claim release into the admin alert's wording", async () => {
    await retireAndEscalateUnusableSavedCard({
      booking,
      paymentMethodId: "pm_dead",
      paymentIntentId: "N/A",
      failure,
      claimReleased: false,
    });

    const [alert] = mockSendAdminPaymentFailureAlert.mock.calls[0] as [{ errorMessage: string }];
    expect(alert.errorMessage).toContain("still marked confirmed but unpaid");
    expect(alert.errorMessage).not.toContain("stays pending");
  });

  it("propagates a non-invalid_request detach failure: nothing cleared, nobody emailed — the caller falls back to the retry alert", async () => {
    const outage = stripeError({ type: "api_error", message: "Stripe is having a moment" });
    mockDetachPaymentMethod.mockRejectedValue(outage);

    await expect(
      retireAndEscalateUnusableSavedCard({ booking, paymentMethodId: "pm_dead", paymentIntentId: "N/A", failure, claimReleased: true }),
    ).rejects.toBe(outage);

    expect(mockPaymentUpdateMany).not.toHaveBeenCalled();
    expect(mockSendSavedCardChargeFailedEmail).not.toHaveBeenCalled();
    expect(mockSendAdminPaymentFailureAlert).not.toHaveBeenCalled();
  });

  it("does not throw when the admin alert fails", async () => {
    mockSendAdminPaymentFailureAlert.mockRejectedValue(new Error("SES down"));

    await expect(
      retireAndEscalateUnusableSavedCard({ booking, paymentMethodId: "pm_dead", paymentIntentId: "N/A", failure, claimReleased: true }),
    ).resolves.toBeUndefined();
    expect(mockSendSavedCardChargeFailedEmail).toHaveBeenCalledTimes(1);
  });
});
