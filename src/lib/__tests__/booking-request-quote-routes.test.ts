import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { expectDefaultInvalidJsonAnswer, MALFORMED_JSON_BODY } from "./helpers/invalid-json-body";
import {
  BookingRequestPricingMode,
  BookingRequestQuoteStatus,
} from "@prisma/client";

const routeMocks = vi.hoisted(() => ({
  mockRequireAdmin: vi.fn(),
  mockApplyRateLimit: vi.fn(),
  mockCreateQuote: vi.fn(),
  mockSendQuote: vi.fn(),
  mockGetContext: vi.fn(),
  mockRespond: vi.fn(),
}));

const mockRequireAdmin = routeMocks.mockRequireAdmin;
const mockApplyRateLimit = routeMocks.mockApplyRateLimit;
const mockCreateQuote = routeMocks.mockCreateQuote;
const mockSendQuote = routeMocks.mockSendQuote;
const mockGetContext = routeMocks.mockGetContext;
const mockRespond = routeMocks.mockRespond;

vi.mock("@/lib/session-guards", () => ({
  requireAdmin: routeMocks.mockRequireAdmin,
}));

vi.mock("@/lib/rate-limit", () => ({
  applyRateLimit: (...args: unknown[]) => routeMocks.mockApplyRateLimit(...args),
  rateLimiters: {
    bookingRequestToken: { id: "booking-request-token" },
  },
}));

vi.mock("@/lib/booking-request-quotes", () => {
  class BookingRequestQuoteError extends Error {
    status: number;
    constructor(message: string, status = 400) {
      super(message);
      this.name = "BookingRequestQuoteError";
      this.status = status;
    }
  }

  return {
    BookingRequestQuoteError,
    parseBookingRequestQuoteOptions: (raw: unknown) => raw,
    createBookingRequestQuote: (...args: unknown[]) =>
      routeMocks.mockCreateQuote(...args),
    sendBookingRequestQuote: (...args: unknown[]) =>
      routeMocks.mockSendQuote(...args),
    getBookingRequestQuoteContext: (...args: unknown[]) =>
      routeMocks.mockGetContext(...args),
    respondToBookingRequestQuote: (...args: unknown[]) =>
      routeMocks.mockRespond(...args),
  };
});

import { POST as createQuoteRoute } from "@/app/api/admin/booking-requests/[id]/quote/route";
import { POST as sendQuoteRoute } from "@/app/api/admin/booking-requests/[id]/send-quote/route";
import {
  GET as getPublicQuoteRoute,
  POST as respondPublicQuoteRoute,
} from "@/app/api/booking-requests/respond/[token]/route";

function jsonRequest(url: string, body: unknown) {
  return new NextRequest(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAdmin.mockResolvedValue({
    ok: true,
    session: { user: { id: "admin-1" } },
  });
  mockApplyRateLimit.mockReturnValue(null);
});

describe("admin booking request quote routes", () => {
  it("requires admin before creating a quote", async () => {
    mockRequireAdmin.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    });

    const res = await createQuoteRoute(
      jsonRequest("http://localhost/api/admin/booking-requests/req-1/quote", {
        pricingMode: BookingRequestPricingMode.OVERALL_TOTAL,
        options: [{ totalCents: 1000 }],
      }),
      { params: Promise.resolve({ id: "req-1" }) }
    );

    expect(res.status).toBe(401);
    expect(mockCreateQuote).not.toHaveBeenCalled();
  });

  it("creates a quote with the authenticated admin id", async () => {
    mockCreateQuote.mockResolvedValue({
      id: "quote-1",
      version: 1,
      status: BookingRequestQuoteStatus.DRAFT,
      pricingMode: BookingRequestPricingMode.OVERALL_TOTAL,
      options: [{ id: "STANDARD", totalCents: 1000 }],
    });

    const res = await createQuoteRoute(
      jsonRequest("http://localhost/api/admin/booking-requests/req-1/quote", {
        pricingMode: BookingRequestPricingMode.OVERALL_TOTAL,
        options: [{ totalCents: 1000 }],
      }),
      { params: Promise.resolve({ id: "req-1" }) }
    );

    expect(res.status).toBe(200);
    expect(mockCreateQuote).toHaveBeenCalledWith({
      requestId: "req-1",
      adminMemberId: "admin-1",
      quote: {
        pricingMode: BookingRequestPricingMode.OVERALL_TOTAL,
        options: [{ totalCents: 1000 }],
      },
    });
  });

  it("sends the latest quote", async () => {
    mockSendQuote.mockResolvedValue({
      id: "quote-1",
      version: 1,
      status: BookingRequestQuoteStatus.SENT,
      responseTokenExpiresAt: new Date("2026-08-01T00:00:00.000Z"),
      options: [{ id: "STANDARD", totalCents: 1000 }],
    });

    const res = await sendQuoteRoute(
      new NextRequest("http://localhost/api/admin/booking-requests/req-1/send-quote", {
        method: "POST",
      }),
      { params: Promise.resolve({ id: "req-1" }) }
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(mockSendQuote).toHaveBeenCalledWith({
      requestId: "req-1",
      adminMemberId: "admin-1",
    });
  });

  // #5407 item 27: the send body is optional (the panel sends none unless an
  // officer mapped a contact or changed child counts). An empty body still
  // sends, as the case above shows; a body that is present but not JSON used to
  // be swallowed as "no body" and now answers the shared invalid-JSON 400.
  it("refuses a send body that is not JSON and sends nothing", async () => {
    const res = await sendQuoteRoute(
      jsonRequest("http://localhost/api/admin/booking-requests/req-1/send-quote", MALFORMED_JSON_BODY),
      { params: Promise.resolve({ id: "req-1" }) }
    );

    await expectDefaultInvalidJsonAnswer(res);
    expect(mockSendQuote).not.toHaveBeenCalled();
  });

  it.each(["null", "[]"])("refuses the non-object send body %s with a 400 and sends nothing", async (raw) => {
    const res = await sendQuoteRoute(
      jsonRequest("http://localhost/api/admin/booking-requests/req-1/send-quote", raw),
      { params: Promise.resolve({ id: "req-1" }) }
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "Invalid request body" });
    expect(mockSendQuote).not.toHaveBeenCalled();
  });

  it("keeps its own answer for a send body of the wrong shape", async () => {
    const res = await sendQuoteRoute(
      jsonRequest("http://localhost/api/admin/booking-requests/req-1/send-quote", {
        ownerContactMemberId: 7,
      }),
      { params: Promise.resolve({ id: "req-1" }) }
    );

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "Invalid contact selection" });
    expect(mockSendQuote).not.toHaveBeenCalled();
  });
});

describe("public booking request quote response route", () => {
  const token = "a".repeat(64);

  it("does not call the service for invalid token shapes", async () => {
    const res = await getPublicQuoteRoute(
      new NextRequest("http://localhost/api/booking-requests/respond/not-a-token"),
      { params: Promise.resolve({ token: "not-a-token" }) }
    );

    expect(res.status).toBe(404);
    expect(mockGetContext).not.toHaveBeenCalled();
  });

  it("returns the rate-limit response without resolving the quote", async () => {
    mockApplyRateLimit.mockReturnValue(
      NextResponse.json({ error: "Too many requests" }, { status: 429 })
    );

    const res = await getPublicQuoteRoute(
      new NextRequest(`http://localhost/api/booking-requests/respond/${token}`),
      { params: Promise.resolve({ token }) }
    );

    expect(res.status).toBe(429);
    expect(mockGetContext).not.toHaveBeenCalled();
  });

  it("returns quote context for valid tokens", async () => {
    mockGetContext.mockResolvedValue({
      quoteId: "quote-1",
      options: [{ id: "STANDARD", totalCents: 1000 }],
    });

    const res = await getPublicQuoteRoute(
      new NextRequest(`http://localhost/api/booking-requests/respond/${token}`),
      { params: Promise.resolve({ token }) }
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.quoteId).toBe("quote-1");
    expect(mockGetContext).toHaveBeenCalledWith(token);
  });

  it("submits an accept response", async () => {
    mockRespond.mockResolvedValue({ outcome: "accepted", bookingId: "booking-1" });

    const res = await respondPublicQuoteRoute(
      jsonRequest(`http://localhost/api/booking-requests/respond/${token}`, {
        action: "ACCEPT",
        optionId: "STANDARD",
      }),
      { params: Promise.resolve({ token }) }
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.outcome).toBe("accepted");
    expect(mockRespond).toHaveBeenCalledWith({
      token,
      action: "ACCEPT",
      optionId: "STANDARD",
      message: undefined,
    });
  });
});
