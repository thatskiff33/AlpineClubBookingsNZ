import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const {
  mockConstructWebhookEvent,
  mockGetWebhookSecret,
  mockRecordVerified,
  mockProcessEvent,
  mockReadBody,
} = vi.hoisted(() => ({
  mockConstructWebhookEvent: vi.fn(),
  mockGetWebhookSecret: vi.fn(),
  mockRecordVerified: vi.fn(),
  mockProcessEvent: vi.fn(),
  mockReadBody: vi.fn(),
}));

vi.mock("@/lib/stripe", () => ({
  constructWebhookEvent: (...a: unknown[]) => mockConstructWebhookEvent(...a),
}));
vi.mock("@/lib/stripe-config", () => ({
  getOperationalStripeWebhookSecret: (...a: unknown[]) =>
    mockGetWebhookSecret(...a),
  recordStripeWebhookVerified: (...a: unknown[]) => mockRecordVerified(...a),
}));
vi.mock("@/lib/stripe-webhook-service", () => ({
  processStripeWebhookEvent: (...a: unknown[]) => mockProcessEvent(...a),
}));
vi.mock("@/lib/webhook-body", () => ({
  readBoundedWebhookText: (...a: unknown[]) => mockReadBody(...a),
  isWebhookBodyTooLargeError: () => false,
  isWebhookBodyInvalidContentLengthError: () => false,
}));
vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { POST } from "@/app/api/webhooks/stripe/route";

function signedRequest() {
  return new NextRequest("https://club.test/api/webhooks/stripe", {
    method: "POST",
    headers: { "stripe-signature": "sig" },
    body: "{}",
  });
}

describe("Stripe webhook route — fail-closed + verified marker (#2082)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadBody.mockResolvedValue("{}");
    mockProcessEvent.mockResolvedValue({ body: { received: true }, init: {} });
  });

  it("rejects (500) with no signing secret and never verifies", async () => {
    mockGetWebhookSecret.mockResolvedValue(undefined);
    const res = await POST(signedRequest());
    expect(res.status).toBe(500);
    expect(mockConstructWebhookEvent).not.toHaveBeenCalled();
  });

  it("rejects (500) when the secret resolver throws (never accepts)", async () => {
    mockGetWebhookSecret.mockRejectedValue(new Error("db down"));
    const res = await POST(signedRequest());
    expect(res.status).toBe(500);
    expect(mockConstructWebhookEvent).not.toHaveBeenCalled();
  });

  it("records the verified marker for a signature-verified TEST-MODE event", async () => {
    mockGetWebhookSecret.mockResolvedValue("whsec_test");
    mockConstructWebhookEvent.mockResolvedValue({
      id: "evt_test",
      type: "payment_intent.succeeded",
      livemode: false,
    });
    const res = await POST(signedRequest());
    expect(res.status).toBe(200);
    expect(mockRecordVerified).toHaveBeenCalledTimes(1);
    expect(mockProcessEvent).toHaveBeenCalledTimes(1);
  });

  // #3975: Stripe's Workbench can only Resend a live delivery to a live
  // endpoint, so a live-only club verifies from a live event or never.
  it("records the verified marker for a signature-verified LIVE-MODE event (#3975)", async () => {
    mockGetWebhookSecret.mockResolvedValue("whsec_live");
    mockConstructWebhookEvent.mockResolvedValue({
      id: "evt_live",
      type: "payment_intent.succeeded",
      livemode: true,
    });
    const res = await POST(signedRequest());
    expect(res.status).toBe(200);
    expect(mockRecordVerified).toHaveBeenCalledTimes(1);
    expect(mockProcessEvent).toHaveBeenCalledTimes(1);
  });

  it("rejects (400) an invalid signature without recording a marker", async () => {
    mockGetWebhookSecret.mockResolvedValue("whsec_test");
    mockConstructWebhookEvent.mockRejectedValue(new Error("bad signature"));
    const res = await POST(signedRequest());
    expect(res.status).toBe(400);
    expect(mockRecordVerified).not.toHaveBeenCalled();
    expect(mockProcessEvent).not.toHaveBeenCalled();
  });
});
