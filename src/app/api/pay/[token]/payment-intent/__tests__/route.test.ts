import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  applyRateLimit: vi.fn(),
  createPaymentIntentForPaymentLink: vi.fn(),
}));

vi.mock("@/lib/rate-limit", () => ({
  applyRateLimit: (...args: unknown[]) => h.applyRateLimit(...args),
  rateLimiters: { paymentLinkToken: {} },
}));

vi.mock("@/lib/payment-link", () => ({
  PaymentLinkError: class PaymentLinkError extends Error {
    status = 400;
    code?: string;
    constructor(message?: string, status = 400, code?: string) {
      super(message);
      this.status = status;
      if (code) this.code = code;
    }
  },
}));
vi.mock("@/lib/payment-link-intent", () => ({
  createPaymentIntentForPaymentLink: (...args: unknown[]) =>
    h.createPaymentIntentForPaymentLink(...args),
  PaymentLinkPaymentRecoveryError: class PaymentLinkPaymentRecoveryError extends Error {
    kind = "payment_received_status_unconfirmed";
  },
}));

vi.mock("@/lib/adult-member-hosting-queue-participants", () => ({
  HOSTING_COVERAGE_RETRY_BODY: {
    code: "HOSTING_COVERAGE_PARTICIPANT_RETRY",
    error: "Reload and try again.",
  },
}));

import { POST } from "@/app/api/pay/[token]/payment-intent/route";
import { PaymentLinkError } from "@/lib/payment-link";

describe("POST /api/pay/[token]/payment-intent repayment response", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.applyRateLimit.mockResolvedValue(null);
  });

  it("carries a refusal's code to the page, so it can say a payment is processing (#3567)", async () => {
    h.createPaymentIntentForPaymentLink.mockRejectedValue(
      new PaymentLinkError("This payment is being processed.", 409, "PAYMENT_PROCESSING"),
    );
    const response = await POST(
      new NextRequest("http://localhost/api/pay/public-token/payment-intent", { method: "POST" }),
      { params: Promise.resolve({ token: "public-token" }) },
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "This payment is being processed.", code: "PAYMENT_PROCESSING" });

    h.createPaymentIntentForPaymentLink.mockRejectedValue(new PaymentLinkError("Link used.", 410));
    const plain = await POST(
      new NextRequest("http://localhost/api/pay/public-token/payment-intent", { method: "POST" }),
      { params: Promise.resolve({ token: "public-token" }) },
    );
    expect(await plain.json()).toEqual({ error: "Link used." });
  });

  it("returns only the fresh repayment secret selected by the service", async () => {
    h.createPaymentIntentForPaymentLink.mockResolvedValue({
      type: "clientSecret",
      clientSecret: "secret_repay",
      paymentIntentId: "pi_repay",
    });

    const response = await POST(
      new NextRequest(
        "http://localhost/api/pay/public-token/payment-intent",
        { method: "POST" },
      ),
      { params: Promise.resolve({ token: "public-token" }) },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      clientSecret: "secret_repay",
      paymentIntentId: "pi_repay",
    });
    expect(h.createPaymentIntentForPaymentLink).toHaveBeenCalledWith(
      "public-token",
    );
    expect(JSON.stringify(body)).not.toContain(
      "secret_refunded_must_not_be_reused",
    );
  });
});
