import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("@/lib/booking-request", async () => {
  const { z } = await import("zod");
  const { nameField } = await import("@/lib/zod-helpers");
  const { ageTierEnum } = await import("@/lib/age-tier-schema");

  class BookingRequestError extends Error {
    status: number;
    constructor(message: string, status = 400) {
      super(message);
      this.name = "BookingRequestError";
      this.status = status;
    }
  }

  return {
    bookingRequestGuestSchema: z.object({
      firstName: nameField(),
      lastName: nameField(),
      ageTier: ageTierEnum,
    }),
    BookingRequestError,
    createBookingRequest: vi.fn(),
    verifyBookingRequest: vi.fn(),
    parseBookingRequestGuests: vi.fn((raw: unknown) => raw),
    getBookingRequestSettings: vi.fn(),
    calculateIndicativeNonMemberPriceCents: vi.fn(),
  };
});

vi.mock("@/lib/payment-link", () => ({
  getPaymentLinkContext: vi.fn(),
  createPaymentIntentForPaymentLink: vi.fn(),
  reissuePaymentLinkForToken: vi.fn(),
  PaymentLinkError: class PaymentLinkError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.name = "PaymentLinkError";
      this.status = status;
    }
  },
}));

vi.mock("@/lib/lodge-capacity", () => ({
  getLodgeCapacity: vi.fn().mockResolvedValue(20),
}));

vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const mockApplyRateLimit = vi.fn();
vi.mock("@/lib/rate-limit", () => ({
  applyRateLimit: (...args: unknown[]) => mockApplyRateLimit(...args),
  rateLimiters: {
    bookingRequest: { id: "booking-request", limit: 5, windowSeconds: 3600 },
    bookingRequestToken: { id: "booking-request-token", limit: 10, windowSeconds: 900 },
    bookingQuery: { id: "booking-query", limit: 60, windowSeconds: 60 },
    paymentLinkToken: { id: "payment-link-token", limit: 20, windowSeconds: 900 },
  },
}));

import {
  createBookingRequest,
  verifyBookingRequest,
  getBookingRequestSettings,
  calculateIndicativeNonMemberPriceCents,
  BookingRequestError,
} from "@/lib/booking-request";
import {
  getPaymentLinkContext,
  createPaymentIntentForPaymentLink,
  reissuePaymentLinkForToken,
  PaymentLinkError,
} from "@/lib/payment-link";
import { POST as submitBookingRequest } from "@/app/api/booking-requests/route";
import { GET as verifyBookingRequestRoute } from "@/app/api/booking-requests/verify/[token]/route";
import { POST as quoteBookingRequest } from "@/app/api/booking-requests/quote/route";
import { GET as getBookingRequestSettingsRoute } from "@/app/api/booking-requests/settings/route";
import { GET as getPayLink } from "@/app/api/pay/[token]/route";
import { POST as createPayPaymentIntent } from "@/app/api/pay/[token]/payment-intent/route";
import { POST as refreshPayLink } from "@/app/api/pay/[token]/refresh/route";

const mockedCreateBookingRequest = vi.mocked(createBookingRequest);
const mockedVerifyBookingRequest = vi.mocked(verifyBookingRequest);
const mockedGetSettings = vi.mocked(getBookingRequestSettings);
const mockedCalculateIndicative = vi.mocked(calculateIndicativeNonMemberPriceCents);
const mockedGetPaymentLinkContext = vi.mocked(getPaymentLinkContext);
const mockedCreatePaymentIntentForLink = vi.mocked(createPaymentIntentForPaymentLink);
const mockedReissuePaymentLinkForToken = vi.mocked(reissuePaymentLinkForToken);

const VALID_GUEST = { firstName: "Tara", lastName: "Tester", ageTier: "ADULT" };
const VALID_TOKEN = "a".repeat(64);

function jsonRequest(url: string, body: unknown) {
  return new NextRequest(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockApplyRateLimit.mockReturnValue(null);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("POST /api/booking-requests", () => {
  it("returns the rate-limit response without calling createBookingRequest", async () => {
    const limited = NextResponse.json({ error: "Too many requests" }, { status: 429 });
    mockApplyRateLimit.mockReturnValue(limited);

    const req = jsonRequest("http://localhost/api/booking-requests", {
      contactFirstName: "Tara",
      contactLastName: "Tester",
      contactEmail: "tara@example.com",
      checkIn: "2026-08-01",
      checkOut: "2026-08-03",
      guests: [VALID_GUEST],
    });

    const res = await submitBookingRequest(req);

    expect(res.status).toBe(429);
    expect(mockedCreateBookingRequest).not.toHaveBeenCalled();
  });

  it("returns 400 for malformed JSON", async () => {
    const req = new NextRequest("http://localhost/api/booking-requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });

    const res = await submitBookingRequest(req);

    expect(res.status).toBe(400);
    expect(mockedCreateBookingRequest).not.toHaveBeenCalled();
  });

  it("returns 422 and never calls createBookingRequest for invalid input", async () => {
    const req = jsonRequest("http://localhost/api/booking-requests", {
      contactFirstName: "",
      contactLastName: "Tester",
      contactEmail: "not-an-email",
      checkIn: "2026-08-01",
      checkOut: "2026-08-03",
      guests: [VALID_GUEST],
    });

    const res = await submitBookingRequest(req);

    expect(res.status).toBe(422);
    expect(mockedCreateBookingRequest).not.toHaveBeenCalled();
  });

  it("rejects a CRLF injection attempt in the optional message field", async () => {
    const req = jsonRequest("http://localhost/api/booking-requests", {
      contactFirstName: "Tara",
      contactLastName: "Tester",
      contactEmail: "tara@example.com",
      checkIn: "2026-08-01",
      checkOut: "2026-08-03",
      guests: [VALID_GUEST],
      message: "Hello\r\nBcc: attacker@evil.com",
    });

    const res = await submitBookingRequest(req);

    expect(res.status).toBe(422);
    expect(mockedCreateBookingRequest).not.toHaveBeenCalled();
  });

  it("rejects check-out on or before check-in", async () => {
    const req = jsonRequest("http://localhost/api/booking-requests", {
      contactFirstName: "Tara",
      contactLastName: "Tester",
      contactEmail: "tara@example.com",
      checkIn: "2026-08-03",
      checkOut: "2026-08-01",
      guests: [VALID_GUEST],
    });

    const res = await submitBookingRequest(req);

    expect(res.status).toBe(400);
    expect(mockedCreateBookingRequest).not.toHaveBeenCalled();
  });

  it("rejects check-in dates in the past", async () => {
    const req = jsonRequest("http://localhost/api/booking-requests", {
      contactFirstName: "Tara",
      contactLastName: "Tester",
      contactEmail: "tara@example.com",
      checkIn: "2020-01-01",
      checkOut: "2020-01-03",
      guests: [VALID_GUEST],
    });

    const res = await submitBookingRequest(req);

    expect(res.status).toBe(400);
    expect(mockedCreateBookingRequest).not.toHaveBeenCalled();
  });

  it("rejects a guest count over lodge capacity", async () => {
    const manyGuests = Array.from({ length: 21 }, () => VALID_GUEST);
    const req = jsonRequest("http://localhost/api/booking-requests", {
      contactFirstName: "Tara",
      contactLastName: "Tester",
      contactEmail: "tara@example.com",
      checkIn: "2026-08-01",
      checkOut: "2026-08-03",
      guests: manyGuests,
    });

    const res = await submitBookingRequest(req);

    expect(res.status).toBe(400);
    expect(mockedCreateBookingRequest).not.toHaveBeenCalled();
  });

  it("creates only a BookingRequest, never a confirmed Booking, on success", async () => {
    mockedCreateBookingRequest.mockResolvedValue({ id: "req-1" } as never);

    const req = jsonRequest("http://localhost/api/booking-requests", {
      contactFirstName: "Tara",
      contactLastName: "Tester",
      contactEmail: "tara@example.com",
      checkIn: "2026-08-01",
      checkOut: "2026-08-03",
      guests: [VALID_GUEST],
    });

    const res = await submitBookingRequest(req);
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body).toEqual({ success: true });
    expect(mockedCreateBookingRequest).toHaveBeenCalledTimes(1);
    // The route response carries no booking ID, member ID, or status —
    // a public submission cannot produce or reveal a confirmed booking.
    expect(body).not.toHaveProperty("bookingId");
    expect(body).not.toHaveProperty("status");
  });

  it("maps BookingRequestError to its declared status", async () => {
    mockedCreateBookingRequest.mockRejectedValue(new BookingRequestError("nope", 422));

    const req = jsonRequest("http://localhost/api/booking-requests", {
      contactFirstName: "Tara",
      contactLastName: "Tester",
      contactEmail: "tara@example.com",
      checkIn: "2026-08-01",
      checkOut: "2026-08-03",
      guests: [VALID_GUEST],
    });

    const res = await submitBookingRequest(req);
    expect(res.status).toBe(422);
  });
});

describe("GET /api/booking-requests/verify/[token]", () => {
  function verifyRequest(token: string) {
    return verifyBookingRequestRoute(
      new NextRequest(`http://localhost/api/booking-requests/verify/${token}`),
      { params: Promise.resolve({ token }) }
    );
  }

  it("returns the rate-limit response without calling verifyBookingRequest", async () => {
    const limited = NextResponse.json({ error: "Too many requests" }, { status: 429 });
    mockApplyRateLimit.mockReturnValue(limited);

    const res = await verifyRequest(VALID_TOKEN);

    expect(res.status).toBe(429);
    expect(mockedVerifyBookingRequest).not.toHaveBeenCalled();
  });

  it("rejects a malformed token without a lookup", async () => {
    const res = await verifyRequest("not-a-valid-token");

    expect(res.status).toBe(404);
    expect(mockedVerifyBookingRequest).not.toHaveBeenCalled();
  });

  it("returns 404 for a token that doesn't match any request", async () => {
    mockedVerifyBookingRequest.mockResolvedValue({ outcome: "invalid" });

    const res = await verifyRequest(VALID_TOKEN);
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toEqual({ outcome: "invalid" });
  });

  it("returns 410 for an expired verification token", async () => {
    mockedVerifyBookingRequest.mockResolvedValue({ outcome: "expired" });

    const res = await verifyRequest(VALID_TOKEN);
    expect(res.status).toBe(410);
  });

  it("returns only check-in/check-out/guest count on success, never PII", async () => {
    mockedVerifyBookingRequest.mockResolvedValue({
      outcome: "verified",
      request: {
        id: "req-1",
        checkIn: new Date("2026-08-01T00:00:00.000Z"),
        checkOut: new Date("2026-08-03T00:00:00.000Z"),
        guests: [VALID_GUEST],
        contactEmail: "tara@example.com",
        contactPhone: "+64123456789",
      } as never,
    });

    const res = await verifyRequest(VALID_TOKEN);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({
      outcome: "verified",
      checkIn: "2026-08-01T00:00:00.000Z",
      checkOut: "2026-08-03T00:00:00.000Z",
      guestCount: 1,
    });
    expect(body).not.toHaveProperty("contactEmail");
    expect(body).not.toHaveProperty("contactPhone");
  });
});

describe("POST /api/booking-requests/quote", () => {
  function quoteRequest(body: unknown) {
    return quoteBookingRequest(jsonRequest("http://localhost/api/booking-requests/quote", body));
  }

  it("returns the rate-limit response without checking settings", async () => {
    const limited = NextResponse.json({ error: "Too many requests" }, { status: 429 });
    mockApplyRateLimit.mockReturnValue(limited);

    const res = await quoteRequest({ checkIn: "2026-08-01", checkOut: "2026-08-03", guests: [VALID_GUEST] });

    expect(res.status).toBe(429);
    expect(mockedGetSettings).not.toHaveBeenCalled();
  });

  it("returns no price when pricing visibility is off, without parsing the body", async () => {
    mockedGetSettings.mockResolvedValue({ showPricingToNonMembers: false });

    const res = await quoteRequest({ checkIn: "2026-08-01", checkOut: "2026-08-03", guests: [VALID_GUEST] });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ showPricing: false, indicativePriceCents: null });
    expect(mockedCalculateIndicative).not.toHaveBeenCalled();
  });

  it("returns an indicative price when pricing visibility is on", async () => {
    mockedGetSettings.mockResolvedValue({ showPricingToNonMembers: true });
    mockedCalculateIndicative.mockResolvedValue(24000);

    const res = await quoteRequest({ checkIn: "2026-08-01", checkOut: "2026-08-03", guests: [VALID_GUEST] });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ showPricing: true, indicativePriceCents: 24000 });
  });

  it("rejects check-out on or before check-in when pricing is on", async () => {
    mockedGetSettings.mockResolvedValue({ showPricingToNonMembers: true });

    const res = await quoteRequest({ checkIn: "2026-08-03", checkOut: "2026-08-01", guests: [VALID_GUEST] });

    expect(res.status).toBe(400);
    expect(mockedCalculateIndicative).not.toHaveBeenCalled();
  });
});

describe("GET /api/booking-requests/settings", () => {
  it("returns the rate-limit response without reading settings", async () => {
    const limited = NextResponse.json({ error: "Too many requests" }, { status: 429 });
    mockApplyRateLimit.mockReturnValue(limited);

    const res = await getBookingRequestSettingsRoute(
      new NextRequest("http://localhost/api/booking-requests/settings")
    );

    expect(res.status).toBe(429);
    expect(mockedGetSettings).not.toHaveBeenCalled();
  });

  it("returns the public pricing visibility flag", async () => {
    mockedGetSettings.mockResolvedValue({ showPricingToNonMembers: true });

    const res = await getBookingRequestSettingsRoute(
      new NextRequest("http://localhost/api/booking-requests/settings")
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ showPricingToNonMembers: true });
  });
});

describe("GET /api/pay/[token]", () => {
  function payRequest(token: string) {
    return getPayLink(new NextRequest(`http://localhost/api/pay/${token}`), {
      params: Promise.resolve({ token }),
    });
  }

  it("returns the rate-limit response without resolving the link", async () => {
    const limited = NextResponse.json({ error: "Too many requests" }, { status: 429 });
    mockApplyRateLimit.mockReturnValue(limited);

    const res = await payRequest(VALID_TOKEN);

    expect(res.status).toBe(429);
    expect(mockedGetPaymentLinkContext).not.toHaveBeenCalled();
  });

  it("returns a polite 404 for a token that does not resolve to any booking", async () => {
    mockedGetPaymentLinkContext.mockRejectedValue(
      new PaymentLinkError("This payment link is not valid.", 404)
    );

    const res = await payRequest("b".repeat(64));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body).toEqual({ error: "This payment link is not valid." });
  });

  it("returns booking context only for the matching token", async () => {
    mockedGetPaymentLinkContext.mockImplementation(async (token: string) => {
      if (token !== VALID_TOKEN) {
        throw new PaymentLinkError("This payment link is not valid.", 404);
      }
      return {
        state: "payable",
        booking: {
          checkIn: "2026-08-01T00:00:00.000Z",
          checkOut: "2026-08-03T00:00:00.000Z",
          guestCount: 1,
          status: "PENDING",
        },
        firstName: "Tara",
        amountCents: 12000,
        internetBankingReference: "BOOKING-ABC123",
        expiresAt: "2026-08-01T00:00:00.000Z",
      } as never;
    });

    const ok = await payRequest(VALID_TOKEN);
    expect(ok.status).toBe(200);
    const okBody = await ok.json();
    expect(okBody.firstName).toBe("Tara");

    const wrongToken = await payRequest("c".repeat(64));
    expect(wrongToken.status).toBe(404);
  });
});

describe("POST /api/pay/[token]/payment-intent", () => {
  function intentRequest(token: string) {
    return createPayPaymentIntent(
      new NextRequest(`http://localhost/api/pay/${token}/payment-intent`, { method: "POST" }),
      { params: Promise.resolve({ token }) }
    );
  }

  it("returns the rate-limit response without creating a payment intent", async () => {
    const limited = NextResponse.json({ error: "Too many requests" }, { status: 429 });
    mockApplyRateLimit.mockReturnValue(limited);

    const res = await intentRequest(VALID_TOKEN);

    expect(res.status).toBe(429);
    expect(mockedCreatePaymentIntentForLink).not.toHaveBeenCalled();
  });

  it("returns a polite error for a revoked link", async () => {
    mockedCreatePaymentIntentForLink.mockRejectedValue(
      new PaymentLinkError("This payment link is no longer active. Please contact the club for help.", 410)
    );

    const res = await intentRequest(VALID_TOKEN);
    expect(res.status).toBe(410);
  });

  it("reports alreadyPaid without leaking a fresh client secret", async () => {
    mockedCreatePaymentIntentForLink.mockResolvedValue({
      type: "alreadyPaid",
      paymentIntentId: "pi_123",
    });

    const res = await intentRequest(VALID_TOKEN);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ alreadyPaid: true, paymentIntentId: "pi_123" });
    expect(body).not.toHaveProperty("clientSecret");
  });

  it("returns a client secret for a payable booking", async () => {
    mockedCreatePaymentIntentForLink.mockResolvedValue({
      type: "clientSecret",
      clientSecret: "secret_abc",
      paymentIntentId: "pi_456",
    });

    const res = await intentRequest(VALID_TOKEN);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ clientSecret: "secret_abc", paymentIntentId: "pi_456" });
  });
});

describe("POST /api/pay/[token]/refresh", () => {
  function refreshRequest(token: string) {
    return refreshPayLink(
      new NextRequest(`http://localhost/api/pay/${token}/refresh`, { method: "POST" }),
      { params: Promise.resolve({ token }) }
    );
  }

  it("returns the rate-limit response without reissuing a payment link", async () => {
    const limited = NextResponse.json({ error: "Too many requests" }, { status: 429 });
    mockApplyRateLimit.mockReturnValue(limited);

    const res = await refreshRequest(VALID_TOKEN);

    expect(res.status).toBe(429);
    expect(mockedReissuePaymentLinkForToken).not.toHaveBeenCalled();
  });

  it("reissues a fresh link for the matching token and returns the email status only", async () => {
    mockedReissuePaymentLinkForToken.mockResolvedValue({ emailed: true });

    const res = await refreshRequest(VALID_TOKEN);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ emailed: true });
    expect(mockedReissuePaymentLinkForToken).toHaveBeenCalledWith(VALID_TOKEN);
  });

  it("maps payment-link refresh failures to polite public errors", async () => {
    mockedReissuePaymentLinkForToken.mockRejectedValue(
      new PaymentLinkError("These dates have already passed, so a new payment link can't be issued.", 410)
    );

    const res = await refreshRequest(VALID_TOKEN);
    const body = await res.json();

    expect(res.status).toBe(410);
    expect(body).toEqual({
      error: "These dates have already passed, so a new payment link can't be issued.",
    });
  });
});
