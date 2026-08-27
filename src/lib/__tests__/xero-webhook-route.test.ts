import { createHmac } from "crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const {
  mockRecordWebhookLog,
  mockRecordXeroInboundEvent,
  mockRunXeroInboundReconciliationCycle,
  mockIsXeroConnected,
  mockGetWebhookKey,
  mockRecordXeroWebhookValidation,
} = vi.hoisted(() => ({
  mockRecordWebhookLog: vi.fn().mockResolvedValue(undefined),
  mockRecordXeroInboundEvent: vi.fn().mockResolvedValue(undefined),
  mockRunXeroInboundReconciliationCycle: vi.fn().mockResolvedValue(undefined),
  mockIsXeroConnected: vi.fn().mockResolvedValue(false),
  // DB-only resolution (#2079): the route resolves the webhook key here, not env.
  mockGetWebhookKey: vi.fn(),
  // ITR receipt sink (#2081): recorded on a valid-signature empty-events POST.
  mockRecordXeroWebhookValidation: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/xero-config", () => ({
  getOperationalXeroWebhookKey: (...args: unknown[]) => mockGetWebhookKey(...args),
}));

vi.mock("@/lib/xero-webhook-validation", () => ({
  recordXeroWebhookValidation: (...args: unknown[]) =>
    mockRecordXeroWebhookValidation(...args),
}));

vi.mock("@/lib/webhook-log", () => ({
  recordWebhookLog: (...args: unknown[]) => mockRecordWebhookLog(...args),
}));

vi.mock("@/lib/xero-sync", () => ({
  buildXeroIdempotencyKey: (...parts: unknown[]) => parts.join(":"),
  recordXeroInboundEvent: (...args: unknown[]) =>
    mockRecordXeroInboundEvent(...args),
}));

vi.mock("@/lib/xero-inbound-reconciliation", () => ({
  runXeroInboundReconciliationCycle: (...args: unknown[]) =>
    mockRunXeroInboundReconciliationCycle(...args),
}));

vi.mock("@/lib/xero", () => ({
  isXeroConnected: (...args: unknown[]) => mockIsXeroConnected(...args),
}));

vi.mock("@/lib/logger", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

function signedRequest(payload: unknown, signatureOverride?: string) {
  const body = JSON.stringify(payload);
  const signature =
    signatureOverride ??
    // Test fixture: hardcoded key signs test webhook payloads so the route can verify them; not a real secret.
    // nosemgrep: javascript.lang.security.audit.hardcoded-hmac-key.hardcoded-hmac-key
    createHmac("sha256", "xero-webhook-key").update(body).digest("base64");

  return new NextRequest("http://localhost/api/webhooks/xero", {
    method: "POST",
    headers: {
      "x-xero-signature": signature,
    },
    body,
  });
}

describe("Xero webhook route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetWebhookKey.mockResolvedValue("xero-webhook-key");
  });

  it("fails closed with 500 when no webhook key is configured (never accepts)", async () => {
    mockGetWebhookKey.mockResolvedValue(undefined);
    const { POST } = await import("@/app/api/webhooks/xero/route");

    const response = await POST(signedRequest({ events: [] }));

    expect(response.status).toBe(500);
    expect(mockRecordXeroInboundEvent).not.toHaveBeenCalled();
  });

  it("fails closed with 500 when the key resolver errors (never accepts)", async () => {
    mockGetWebhookKey.mockRejectedValue(new Error("db down"));
    const { POST } = await import("@/app/api/webhooks/xero/route");

    const response = await POST(signedRequest({ events: [] }));

    expect(response.status).toBe(500);
    expect(mockRecordXeroInboundEvent).not.toHaveBeenCalled();
  });

  it("rejects invalid signatures before parsing the payload", async () => {
    const { POST } = await import("@/app/api/webhooks/xero/route");

    const response = await POST(signedRequest({ events: [] }, "bad-signature"));

    expect(response.status).toBe(401);
    expect(mockRecordXeroInboundEvent).not.toHaveBeenCalled();
  });

  it("accepts a valid signed payload", async () => {
    const { POST } = await import("@/app/api/webhooks/xero/route");

    const response = await POST(signedRequest({ events: [] }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });

  it("records the ITR validation marker on a valid-signature empty-events POST", async () => {
    // Intent-to-receive (#2081): an empty events array with a valid signature is
    // Xero's validation ping — the route must leave an observable marker (keyed
    // to the resolved webhook key) and record NO per-event row.
    const { POST } = await import("@/app/api/webhooks/xero/route");

    const response = await POST(signedRequest({ events: [] }));

    expect(response.status).toBe(200);
    expect(mockRecordXeroWebhookValidation).toHaveBeenCalledWith("xero-webhook-key");
    expect(mockRecordXeroInboundEvent).not.toHaveBeenCalled();
  });

  it("does NOT record an ITR marker for real (non-empty) event deliveries", async () => {
    const { POST } = await import("@/app/api/webhooks/xero/route");

    const response = await POST(
      signedRequest({
        events: [
          {
            eventType: "UPDATE",
            eventCategory: "INVOICE",
            resourceId: "invoice-1",
            eventDateUtc: "2026-05-29T00:00:00.000Z",
          },
        ],
      }),
    );

    expect(response.status).toBe(200);
    expect(mockRecordXeroWebhookValidation).not.toHaveBeenCalled();
    expect(mockRecordXeroInboundEvent).toHaveBeenCalledTimes(1);
  });

  it("still returns 200 for a valid ITR even if recording the marker fails", async () => {
    // A marker-write failure must never turn a valid ITR into a non-200, or Xero
    // treats the subscription as unverified.
    mockRecordXeroWebhookValidation.mockRejectedValueOnce(new Error("db down"));
    const { POST } = await import("@/app/api/webhooks/xero/route");

    const response = await POST(signedRequest({ events: [] }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });

  it("rejects malformed events payloads after signature verification", async () => {
    const { POST } = await import("@/app/api/webhooks/xero/route");

    const response = await POST(signedRequest({ events: {} }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid events payload",
    });
    expect(mockRecordXeroInboundEvent).not.toHaveBeenCalled();
  });

  it("rejects a correctly signed non-JSON body without recording events", async () => {
    // Malformed row of the webhook Critical matrix (issue #1133): the HMAC is
    // valid for the raw bytes but the body is not JSON. Signature verification
    // runs first (over raw bytes), then parsing fails closed.
    const { POST } = await import("@/app/api/webhooks/xero/route");
    const body = "not-json{";
    // Test fixture: hardcoded key signs a test webhook payload so the route can verify it; not a real secret.
    // nosemgrep: javascript.lang.security.audit.hardcoded-hmac-key.hardcoded-hmac-key
    const signature = createHmac("sha256", "xero-webhook-key")
      .update(body)
      .digest("base64");

    const response = await POST(
      new NextRequest("http://localhost/api/webhooks/xero", {
        method: "POST",
        headers: { "x-xero-signature": signature },
        body,
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid JSON" });
    expect(mockRecordXeroInboundEvent).not.toHaveBeenCalled();
  });

  it("maps a replayed event to the same idempotency correlation key", async () => {
    // Duplicate row of the webhook Critical matrix (issue #1133): DB-level
    // dedup lives in recordXeroInboundEvent (unique correlationKey with
    // terminal-state preservation — covered in xero-sync.test.ts). The route
    // contract frozen here is that an identical redelivery produces the
    // identical correlation key, so a replay converges on the same row even
    // across process restarts.
    const { POST } = await import("@/app/api/webhooks/xero/route");
    const payload = {
      events: [
        {
          eventType: "UPDATE",
          eventCategory: "INVOICE",
          resourceId: "inv-123",
          eventDateUtc: "2026-07-01T00:00:00.000Z",
        },
      ],
    };

    const first = await POST(signedRequest(payload));
    const second = await POST(signedRequest(payload));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(mockRecordXeroInboundEvent).toHaveBeenCalledTimes(2);
    const [firstCall, secondCall] = mockRecordXeroInboundEvent.mock.calls;
    expect(firstCall[0].correlationKey).toBeTruthy();
    expect(secondCall[0].correlationKey).toBe(firstCall[0].correlationKey);
  });

  it("rejects oversized Xero webhook payloads before signature verification", async () => {
    const body = "{}";
    // Test fixture: hardcoded key signs a test webhook payload so the route can verify it; not a real secret.
    // nosemgrep: javascript.lang.security.audit.hardcoded-hmac-key.hardcoded-hmac-key
    const signature = createHmac("sha256", "xero-webhook-key")
      .update(body)
      .digest("base64");
    const { POST } = await import("@/app/api/webhooks/xero/route");

    const response = await POST(
      new NextRequest("http://localhost/api/webhooks/xero", {
        method: "POST",
        headers: {
          "x-xero-signature": signature,
          "content-length": String(256 * 1024 + 1),
        },
        body,
      })
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: "Webhook payload too large",
    });
    expect(mockRecordXeroInboundEvent).not.toHaveBeenCalled();
  });

  it("rejects malformed Xero webhook content-length before signature verification", async () => {
    const body = "{}";
    // Test fixture: hardcoded key signs a test webhook payload so the route can verify it; not a real secret.
    // nosemgrep: javascript.lang.security.audit.hardcoded-hmac-key.hardcoded-hmac-key
    const signature = createHmac("sha256", "xero-webhook-key")
      .update(body)
      .digest("base64");
    const { POST } = await import("@/app/api/webhooks/xero/route");

    const response = await POST(
      new NextRequest("http://localhost/api/webhooks/xero", {
        method: "POST",
        headers: {
          "x-xero-signature": signature,
          "content-length": "256kb",
        },
        body,
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid content-length header",
    });
    expect(mockRecordXeroInboundEvent).not.toHaveBeenCalled();
  });

  it("rejects signed Xero events with invalid event dates", async () => {
    const { POST } = await import("@/app/api/webhooks/xero/route");

    const response = await POST(
      signedRequest({
        events: [
          {
            eventType: "UPDATE",
            eventCategory: "INVOICE",
            resourceId: "invoice-1",
            eventDateUtc: "not-a-date",
          },
        ],
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid webhook event payload",
    });
    expect(mockRecordXeroInboundEvent).not.toHaveBeenCalled();
  });

  it("reads the offset-less eventDateUtc Xero really sends as UTC, on every host zone", async () => {
    /*
      THE SHAPE THAT WAS WRONG, AND THE ONE THE OLD FIXTURES COULD NOT SEE
      (#2869 review). Xero's webhook envelope documents `eventDateUtc` WITHOUT
      an offset — its own example is "2018-08-23T05:44:47.622" — and the route
      read it with `new Date(...)`, which resolves a wall-clock reading in the
      container's zone. Under the `TZ=Pacific/Auckland` pin in the Dockerfile
      that stored `XeroInboundEvent.eventCreatedAt` about thirteen hours early.

      Every existing fixture in this file is `Z`-suffixed, where the two
      readings coincide, so none of them could discriminate the defect.
    */
    // `withTimeZoneAsync`, NOT `withTimeZone`: the synchronous wrapper restores
    // the zone in a `finally` that runs when `run()` RETURNS, which for an async
    // route handler is before it has read anything. The pin would be gone by the
    // time the payload was parsed and all three iterations would silently run on
    // the host's own zone — vacuous on CI, where that zone is UTC and the defect
    // and the fix agree.
    const { withTimeZoneAsync } = await import("@/lib/__tests__/helpers/timezone");
    const { POST } = await import("@/app/api/webhooks/xero/route");

    for (const hostZone of ["UTC", "America/Denver", "Pacific/Auckland"]) {
      mockRecordXeroInboundEvent.mockClear();
      const response = await withTimeZoneAsync(hostZone, () =>
        POST(
          signedRequest({
            events: [
              {
                eventType: "UPDATE",
                eventCategory: "INVOICE",
                resourceId: "invoice-offset-less",
                eventDateUtc: "2018-08-23T05:44:47.622",
              },
            ],
          }),
        ),
      );

      expect(response.status, hostZone).toBe(200);
      expect(
        mockRecordXeroInboundEvent.mock.calls[0][0].eventCreatedAt,
        hostZone,
      ).toEqual(new Date("2018-08-23T05:44:47.622Z"));
    }
  });

  it("rejects an event date no Xero wire shape can produce", async () => {
    // The old validator was `!Number.isNaN(new Date(value).getTime())`, which is
    // as lenient as `new Date` itself — so this prose date was ACCEPTED and then
    // parsed in the host's zone. Classification at the boundary refuses it.
    const { POST } = await import("@/app/api/webhooks/xero/route");

    const response = await POST(
      signedRequest({
        events: [
          {
            eventType: "UPDATE",
            eventCategory: "INVOICE",
            resourceId: "invoice-1",
            eventDateUtc: "11 March 2019",
          },
        ],
      }),
    );

    expect(response.status).toBe(400);
    expect(mockRecordXeroInboundEvent).not.toHaveBeenCalled();
  });

  it("records valid signed Xero events with required resource identity", async () => {
    const { POST } = await import("@/app/api/webhooks/xero/route");

    const response = await POST(
      signedRequest({
        events: [
          {
            eventType: "UPDATE",
            eventCategory: "INVOICE",
            resourceId: "invoice-1",
            eventDateUtc: "2026-05-29T00:00:00.000Z",
          },
        ],
      })
    );

    expect(response.status).toBe(200);
    expect(mockRecordXeroInboundEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventCategory: "INVOICE",
        eventType: "UPDATE",
        resourceId: "invoice-1",
        eventCreatedAt: new Date("2026-05-29T00:00:00.000Z"),
        correlationKey:
          "xero:webhook:INVOICE:UPDATE:invoice-1:2026-05-29T00:00:00.000Z",
      })
    );
  });
});
