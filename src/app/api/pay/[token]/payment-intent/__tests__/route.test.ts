import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  expectDefaultInvalidJsonAnswer,
  MALFORMED_JSON_BODY,
} from "@/lib/__tests__/helpers/invalid-json-body";

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
    constructor(readonly kind: string = "payment_received_status_unconfirmed") {
      super("Payment-link card status requires recovery");
    }
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
      { paidPaymentIntentId: null },
    );
    expect(JSON.stringify(body)).not.toContain(
      "secret_refunded_must_not_be_reused",
    );
  });

  it("#4300: tells the payer their earlier, superseded payment is going back, beside the fresh secret", async () => {
    h.createPaymentIntentForPaymentLink.mockResolvedValue({
      type: "clientSecret",
      clientSecret: "secret_repay",
      paymentIntentId: "pi_repay",
      previousPaymentRefunding: true,
    });
    const response = await POST(
      new NextRequest("http://localhost/api/pay/public-token/payment-intent", { method: "POST" }),
      { params: Promise.resolve({ token: "public-token" }) },
    );
    expect(await response.json()).toEqual({ clientSecret: "secret_repay", paymentIntentId: "pi_repay", previousPaymentRefunding: true });
  });

  it("#4300: passes on the intent the payer says they have just paid, and nothing else from the body", async () => {
    h.createPaymentIntentForPaymentLink.mockResolvedValue({ type: "clientSecret", clientSecret: "secret_fresh", paymentIntentId: "pi_fresh" });
    await POST(
      new NextRequest("http://localhost/api/pay/public-token/payment-intent", {
        method: "POST",
        body: JSON.stringify({ paidPaymentIntentId: "pi_paid", bookingId: "someone-else" }),
      }),
      { params: Promise.resolve({ token: "public-token" }) },
    );
    expect(h.createPaymentIntentForPaymentLink).toHaveBeenCalledWith("public-token", { paidPaymentIntentId: "pi_paid" });
  });

  it("#4300: a superseded capture the settle refused answers the shared refunding body", async () => {
    const { PaymentLinkPaymentRecoveryError } = await import("@/lib/payment-link-intent");
    const { SUPERSEDED_CARD_PAYMENT_REFUNDING_BODY } = await import("@/lib/payment-recovery-contract");
    h.createPaymentIntentForPaymentLink.mockRejectedValue(new PaymentLinkPaymentRecoveryError("superseded_capture_refunding"));
    const response = await POST(
      new NextRequest("http://localhost/api/pay/public-token/payment-intent", { method: "POST" }),
      { params: Promise.resolve({ token: "public-token" }) },
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual(SUPERSEDED_CARD_PAYMENT_REFUNDING_BODY);
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

// #5407 item 27: the body is optional. The pay page sends none, and the
// card-success check sends the intent it has just paid. An empty body is still
// "no intent named"; a body that is present but not JSON used to be swallowed
// as one and now answers the shared invalid-JSON 400, before any intent is
// created or reused. The rate limit still comes first.
describe("POST /api/pay/[token]/payment-intent: malformed body (#5407)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.applyRateLimit.mockResolvedValue(null);
    h.createPaymentIntentForPaymentLink.mockResolvedValue({
      type: "clientSecret",
      clientSecret: "secret_fresh",
      paymentIntentId: "pi_fresh",
    });
  });

  function post(body?: string) {
    return POST(
      new NextRequest("http://localhost/api/pay/public-token/payment-intent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body }),
      }),
      { params: Promise.resolve({ token: "public-token" }) },
    );
  }

  it("treats an empty body as naming no paid intent", async () => {
    const response = await post("");

    expect(response.status).toBe(200);
    expect(h.createPaymentIntentForPaymentLink).toHaveBeenCalledWith("public-token", {
      paidPaymentIntentId: null,
    });
  });

  it("refuses a JSON null body with a 400 and creates no intent", async () => {
    const response = await post("null");

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "Invalid request body" });
    expect(h.createPaymentIntentForPaymentLink).not.toHaveBeenCalled();
  });

  it("refuses a body that is not JSON and creates no intent", async () => {
    await expectDefaultInvalidJsonAnswer(await post(MALFORMED_JSON_BODY));
    expect(h.createPaymentIntentForPaymentLink).not.toHaveBeenCalled();
  });

  it("answers the rate limit before reading the body", async () => {
    const { NextResponse } = await import("next/server");
    h.applyRateLimit.mockResolvedValue(
      NextResponse.json({ error: "Too many requests" }, { status: 429 }),
    );

    const response = await post(MALFORMED_JSON_BODY);

    expect(response.status).toBe(429);
    expect(h.createPaymentIntentForPaymentLink).not.toHaveBeenCalled();
  });
});
