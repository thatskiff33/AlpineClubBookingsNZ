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

vi.mock("@/lib/payment-link", async (importOriginal) => ({
  // The real class: the route reads its status and its optional code.
  PaymentLinkError: ((await importOriginal()) as typeof import("@/lib/payment-link"))
    .PaymentLinkError,
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
import { SWITCHED_TO_INTERNET_BANKING_BODY } from "@/lib/payment-recovery-contract";

describe("POST /api/pay/[token]/payment-intent repayment response", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.applyRateLimit.mockResolvedValue(null);
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

  // #3638 delta D4: the link door sends the SAME switched-to-Internet-Banking
  // body as the session pay route, code included.
  it("sends the shared switched-to-Internet-Banking body with its code", async () => {
    h.createPaymentIntentForPaymentLink.mockRejectedValue(
      new PaymentLinkError(
        SWITCHED_TO_INTERNET_BANKING_BODY.error,
        409,
        SWITCHED_TO_INTERNET_BANKING_BODY.code,
      ),
    );

    const response = await POST(
      new NextRequest(
        "http://localhost/api/pay/public-token/payment-intent",
        { method: "POST" },
      ),
      { params: Promise.resolve({ token: "public-token" }) },
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ ...SWITCHED_TO_INTERNET_BANKING_BODY });
  });

  it("keeps a code-less refusal to its message alone", async () => {
    h.createPaymentIntentForPaymentLink.mockRejectedValue(
      new PaymentLinkError("This payment link is not valid.", 404),
    );

    const response = await POST(
      new NextRequest(
        "http://localhost/api/pay/public-token/payment-intent",
        { method: "POST" },
      ),
      { params: Promise.resolve({ token: "public-token" }) },
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "This payment link is not valid.",
    });
  });
});
