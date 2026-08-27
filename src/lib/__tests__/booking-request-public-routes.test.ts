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
    // Pass-through default: a provided lodgeId is treated as active, an
    // omitted one resolves to null (default-lodge semantics).
    assertRequestedLodgeActive: vi.fn(async (lodgeId: unknown) => lodgeId ?? null),
    // Pass-through default: a provided otherLodgeId is treated as existing, an
    // omitted/blank one resolves to null ("No").
    assertRequestedOtherLodgeExists: vi.fn(
      async (otherLodgeId: unknown) => otherLodgeId ?? null,
    ),
    getPublicBookingRequestLodges: vi.fn(async () => []),
    getPublicOtherLodges: vi.fn(async () => []),
    resolvePublicRequestLodgeName: vi.fn(async () => null),
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
  PaymentLinkPaymentRecoveryError: class PaymentLinkPaymentRecoveryError extends Error {
    constructor(readonly kind: string) {
      super("payment recovery");
      this.name = "PaymentLinkPaymentRecoveryError";
    }
  },
}));

vi.mock("@/lib/lodge-capacity", () => ({
  getLodgeCapacity: vi.fn().mockResolvedValue(20),
  getDefaultLodgeCapacity: vi.fn().mockResolvedValue(20),
  // Completes the mock: the settings route below now reads the DB-resolved
  // default capacity through `public-layout-config` (#2818 decision 7), which
  // pulls in `club-identity.ts` — and that module reads this constant at import
  // time, so an incomplete factory throws "No FALLBACK_LODGE_CAPACITY export"
  // before a single test runs.
  FALLBACK_LODGE_CAPACITY: 20,
}));
vi.mock("@/lib/lodge-settings", () => ({
  loadSchoolGroupSoftCap: vi.fn().mockResolvedValue(25),
}));

/**
 * `getCachedDefaultLodgeCapacity` is an `unstable_cache` wrapper, and Next's
 * incremental cache only exists inside a real request — called from a unit test
 * it throws "Invariant: incrementalCache missing" before the route can answer.
 * Override that ONE read with the figure the mocked `getDefaultLodgeCapacity`
 * would have resolved, and keep the rest of the module real: a bare factory
 * listing only this export would break the moment anything else in the route
 * graph imports a sibling cached read.
 */
vi.mock("@/lib/public-layout-config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/public-layout-config")>()),
  getCachedDefaultLodgeCapacity: vi.fn().mockResolvedValue(20),
}));

vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

/*
  CT-4 (#2870): the routes under test now resolve the club's day through
  `clubTime()`, which reaches `getClubTimeZone` and therefore `@/lib/prisma`.
  Without this mock the module graph constructs a REAL `PrismaClient` at import —
  it throws outright when `DATABASE_URL` is unset, and quietly opens a client with
  a connection pool when it is set, which is how the failure hid from a local run
  and from CI alike.

  `clubTimeSettings` is not optional on this mock. `getClubTimeZone` degrades
  silently to the environment when the delegate is missing, so leaving it off
  would put the zone back on `APP_TIME_ZONE` with nothing failing. It is pinned to
  the environment's own default deliberately: these cases are about request
  handling, and the zone AUTHORITY is proven by the dedicated club-time suites and
  by `api-club-time-convergence`.
*/
vi.mock("@/lib/prisma", () => ({
  prisma: {
    clubTimeSettings: {
      findUnique: vi.fn().mockResolvedValue({
        timeZone: "Pacific/Auckland",
        updatedByMemberId: null,
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      }),
    },
  },
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
  getPublicBookingRequestLodges,
  getPublicOtherLodges,
  assertRequestedLodgeActive,
  assertRequestedOtherLodgeExists,
  resolvePublicRequestLodgeName,
  calculateIndicativeNonMemberPriceCents,
  BookingRequestError,
} from "@/lib/booking-request";
import {
  getPaymentLinkContext,
  createPaymentIntentForPaymentLink,
  reissuePaymentLinkForToken,
  PaymentLinkError,
  PaymentLinkPaymentRecoveryError,
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
const mockedGetPublicLodges = vi.mocked(getPublicBookingRequestLodges);
const mockedGetPublicOtherLodges = vi.mocked(getPublicOtherLodges);
const mockedAssertLodgeActive = vi.mocked(assertRequestedLodgeActive);
const mockedAssertOtherLodgeExists = vi.mocked(assertRequestedOtherLodgeExists);
const mockedResolveLodgeName = vi.mocked(resolvePublicRequestLodgeName);
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

/**
 * `POST /api/booking-requests` refuses a check-in before `getTodayDateOnly()`
 * (the NZ calendar date) before it ever reaches the mocked service layer, and
 * nearly every case below requests 2026-08-01. Left on the real clock this suite
 * would have started failing on 2 August 2026 (#2426's defect class exactly):
 * five cases expecting a 201 and a `createBookingRequest` call would instead get
 * the past-date 400, with the request never created — a green suite turning red
 * on a guard doing precisely its job.
 *
 * Pin the clock a month clear of the fixtures so the scenario under test — a
 * request for FUTURE nights — stays the intended one. The past-date guard keeps
 * its own coverage in "rejects check-in dates in the past", whose 2020-01-01 is
 * behind the pinned today as well as behind any real one.
 *
 * Only `Date` is faked, so real timers still run and awaited promises resolve
 * normally. 2026-07-01T00:00:00Z reads as 1 July in NZ (12:00 NZST) and in UTC
 * alike, so the pinned "today" does not depend on the runner's own zone.
 */
const FIXED_NOW = new Date("2026-07-01T00:00:00.000Z"); // NZ 2026-07-01 12:00

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(FIXED_NOW);
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

  it("passes the validated lodgeId through to createBookingRequest", async () => {
    mockedCreateBookingRequest.mockResolvedValue({ id: "req-2" } as never);

    const req = jsonRequest("http://localhost/api/booking-requests", {
      contactFirstName: "Tara",
      contactLastName: "Tester",
      contactEmail: "tara@example.com",
      checkIn: "2026-08-01",
      checkOut: "2026-08-03",
      lodgeId: "lodge-2",
      guests: [VALID_GUEST],
    });

    const res = await submitBookingRequest(req);

    expect(res.status).toBe(201);
    expect(mockedAssertLodgeActive).toHaveBeenCalledWith("lodge-2");
    expect(mockedCreateBookingRequest).toHaveBeenCalledWith(
      expect.objectContaining({ lodgeId: "lodge-2" })
    );
  });

  it("returns 400 for a lodgeId that is not an active lodge", async () => {
    mockedAssertLodgeActive.mockRejectedValueOnce(
      new BookingRequestError("Lodge not found or not active", 400)
    );

    const req = jsonRequest("http://localhost/api/booking-requests", {
      contactFirstName: "Tara",
      contactLastName: "Tester",
      contactEmail: "tara@example.com",
      checkIn: "2026-08-01",
      checkOut: "2026-08-03",
      lodgeId: "no-such-lodge",
      guests: [VALID_GUEST],
    });

    const res = await submitBookingRequest(req);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body).toEqual({ error: "Lodge not found or not active" });
    expect(mockedCreateBookingRequest).not.toHaveBeenCalled();
  });

  it("passes a validated otherLodgeId through to createBookingRequest (#2749)", async () => {
    mockedCreateBookingRequest.mockResolvedValue({ id: "req-ol" } as never);

    const req = jsonRequest("http://localhost/api/booking-requests", {
      contactFirstName: "Tara",
      contactLastName: "Tester",
      contactEmail: "tara@example.com",
      checkIn: "2026-08-01",
      checkOut: "2026-08-03",
      otherLodgeId: "other-1",
      guests: [VALID_GUEST],
    });

    const res = await submitBookingRequest(req);

    expect(res.status).toBe(201);
    expect(mockedAssertOtherLodgeExists).toHaveBeenCalledWith("other-1");
    expect(mockedCreateBookingRequest).toHaveBeenCalledWith(
      expect.objectContaining({ otherLodgeId: "other-1" }),
    );
  });

  it("returns 400 for an otherLodgeId that names no lodge (#2749)", async () => {
    mockedAssertOtherLodgeExists.mockRejectedValueOnce(
      new BookingRequestError("Selected lodge not found", 400),
    );

    const req = jsonRequest("http://localhost/api/booking-requests", {
      contactFirstName: "Tara",
      contactLastName: "Tester",
      contactEmail: "tara@example.com",
      checkIn: "2026-08-01",
      checkOut: "2026-08-03",
      otherLodgeId: "no-such-other-lodge",
      guests: [VALID_GUEST],
    });

    const res = await submitBookingRequest(req);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body).toEqual({ error: "Selected lodge not found" });
    expect(mockedCreateBookingRequest).not.toHaveBeenCalled();
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

  it("includes the lodge name when the request names a lodge at a multi-lodge club", async () => {
    mockedVerifyBookingRequest.mockResolvedValue({
      outcome: "verified",
      request: {
        id: "req-1",
        lodgeId: "lodge-2",
        checkIn: new Date("2026-08-01T00:00:00.000Z"),
        checkOut: new Date("2026-08-03T00:00:00.000Z"),
        guests: [VALID_GUEST],
      } as never,
    });
    mockedResolveLodgeName.mockResolvedValueOnce("Whakapapa Lodge");

    const res = await verifyRequest(VALID_TOKEN);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(mockedResolveLodgeName).toHaveBeenCalledWith("lodge-2");
    expect(body.lodgeName).toBe("Whakapapa Lodge");
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
    mockedGetSettings.mockResolvedValue({ showPricingToNonMembers: false, quoteResponseTtlDays: 14, quoteReminderLeadDays: 3, attendeeConfirmationLeadDays: 14, attendeeConfirmationReminderDays: 3 });

    const res = await quoteRequest({ checkIn: "2026-08-01", checkOut: "2026-08-03", guests: [VALID_GUEST] });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ showPricing: false, indicativePriceCents: null });
    expect(mockedCalculateIndicative).not.toHaveBeenCalled();
  });

  it("returns an indicative price when pricing visibility is on", async () => {
    mockedGetSettings.mockResolvedValue({ showPricingToNonMembers: true, quoteResponseTtlDays: 14, quoteReminderLeadDays: 3, attendeeConfirmationLeadDays: 14, attendeeConfirmationReminderDays: 3 });
    mockedCalculateIndicative.mockResolvedValue(24000);

    const res = await quoteRequest({ checkIn: "2026-08-01", checkOut: "2026-08-03", guests: [VALID_GUEST] });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ showPricing: true, indicativePriceCents: 24000 });
  });

  it("rejects check-out on or before check-in when pricing is on", async () => {
    mockedGetSettings.mockResolvedValue({ showPricingToNonMembers: true, quoteResponseTtlDays: 14, quoteReminderLeadDays: 3, attendeeConfirmationLeadDays: 14, attendeeConfirmationReminderDays: 3 });

    const res = await quoteRequest({ checkIn: "2026-08-03", checkOut: "2026-08-01", guests: [VALID_GUEST] });

    expect(res.status).toBe(400);
    expect(mockedCalculateIndicative).not.toHaveBeenCalled();
  });

  it("prices against the requested lodge when a lodgeId is supplied", async () => {
    mockedGetSettings.mockResolvedValue({
      showPricingToNonMembers: true,
      quoteResponseTtlDays: 14,
      quoteReminderLeadDays: 3,
      attendeeConfirmationLeadDays: 14,
      attendeeConfirmationReminderDays: 3,
    });
    mockedCalculateIndicative.mockResolvedValue(18000);

    const res = await quoteRequest({
      checkIn: "2026-08-01",
      checkOut: "2026-08-03",
      lodgeId: "lodge-2",
      guests: [VALID_GUEST],
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ showPricing: true, indicativePriceCents: 18000 });
    expect(mockedCalculateIndicative).toHaveBeenCalledWith(
      expect.objectContaining({ lodgeId: "lodge-2" })
    );
  });

  it("returns 400 for a lodgeId that is not an active lodge", async () => {
    mockedGetSettings.mockResolvedValue({
      showPricingToNonMembers: true,
      quoteResponseTtlDays: 14,
      quoteReminderLeadDays: 3,
      attendeeConfirmationLeadDays: 14,
      attendeeConfirmationReminderDays: 3,
    });
    mockedAssertLodgeActive.mockRejectedValueOnce(
      new BookingRequestError("Lodge not found or not active", 400)
    );

    const res = await quoteRequest({
      checkIn: "2026-08-01",
      checkOut: "2026-08-03",
      lodgeId: "no-such-lodge",
      guests: [VALID_GUEST],
    });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body).toEqual({ error: "Lodge not found or not active" });
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

  // `defaultLodgeCapacity` is the DB-resolved figure both forms prefer over the
  // static `club.lodgeCapacity` prop (#2818 decision 7); here it comes from the
  // mocked `getDefaultLodgeCapacity` via the cached read.
  it("returns the public pricing visibility flag and the default lodge capacity", async () => {
    mockedGetSettings.mockResolvedValue({ showPricingToNonMembers: true, quoteResponseTtlDays: 14, quoteReminderLeadDays: 3, attendeeConfirmationLeadDays: 14, attendeeConfirmationReminderDays: 3 });
    mockedGetPublicLodges.mockResolvedValueOnce([]);
    mockedGetPublicOtherLodges.mockResolvedValueOnce([]);

    const res = await getBookingRequestSettingsRoute(
      new NextRequest("http://localhost/api/booking-requests/settings")
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({
      showPricingToNonMembers: true,
      quoteResponseTtlDays: 14,
      quoteReminderLeadDays: 3,
      attendeeConfirmationLeadDays: 14,
      attendeeConfirmationReminderDays: 3,
      lodges: [],
      otherLodges: [],
      schoolGroupSoftCap: 25,
      defaultLodgeCapacity: 20,
    });
  });

  it("lists other/partner lodges (id and name) for the drop-down (#2749)", async () => {
    mockedGetSettings.mockResolvedValue({
      showPricingToNonMembers: false,
      quoteResponseTtlDays: 14,
      quoteReminderLeadDays: 3,
      attendeeConfirmationLeadDays: 14,
      attendeeConfirmationReminderDays: 3,
    });
    mockedGetPublicLodges.mockResolvedValueOnce([]);
    mockedGetPublicOtherLodges.mockResolvedValueOnce([
      { id: "other-1", name: "Aorangi Ski Club" },
      { id: "other-2", name: "Tongariro Ski Club" },
    ]);

    const res = await getBookingRequestSettingsRoute(
      new NextRequest("http://localhost/api/booking-requests/settings")
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.otherLodges).toEqual([
      { id: "other-1", name: "Aorangi Ski Club" },
      { id: "other-2", name: "Tongariro Ski Club" },
    ]);
  });

  it("lists active lodges (id and name only) for a multi-lodge club", async () => {
    mockedGetSettings.mockResolvedValue({
      showPricingToNonMembers: false,
      quoteResponseTtlDays: 14,
      quoteReminderLeadDays: 3,
      attendeeConfirmationLeadDays: 14,
      attendeeConfirmationReminderDays: 3,
    });
    mockedGetPublicLodges.mockResolvedValueOnce([
      { id: "lodge-1", name: "Ruapehu Lodge", capacity: 30, schoolGroupSoftCap: 25 },
      { id: "lodge-2", name: "Whakapapa Lodge", capacity: 40, schoolGroupSoftCap: 25 },
    ]);

    const res = await getBookingRequestSettingsRoute(
      new NextRequest("http://localhost/api/booking-requests/settings")
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.lodges).toEqual([
      { id: "lodge-1", name: "Ruapehu Lodge", capacity: 30, schoolGroupSoftCap: 25 },
      { id: "lodge-2", name: "Whakapapa Lodge", capacity: 40, schoolGroupSoftCap: 25 },
    ]);
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
    });

    const res = await intentRequest(VALID_TOKEN);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ alreadyPaid: true });
    expect(body).not.toHaveProperty("clientSecret");
    expect(body).not.toHaveProperty("paymentIntentId");
  });

  it.each([
    ["payment_received_finalisation_pending", true, false],
    ["payment_received_status_unconfirmed", true, false],
    ["existing_card_status_unconfirmed", false, true],
  ])(
    "returns provider-safe %s recovery without an intent id",
    async (kind, paymentReceived, existingCardTransactionFound) => {
      mockedCreatePaymentIntentForLink.mockRejectedValue(
        new PaymentLinkPaymentRecoveryError(
          kind as ConstructorParameters<
            typeof PaymentLinkPaymentRecoveryError
          >[0],
        ),
      );

      const res = await intentRequest(VALID_TOKEN);
      const body = await res.json();

      expect(res.status).toBe(409);
      expect(body).not.toHaveProperty("paymentIntentId");
      if (paymentReceived) expect(body.paymentReceived).toBe(true);
      if (existingCardTransactionFound) {
        expect(body).toMatchObject({
          existingCardTransactionFound: true,
          paymentStatusUnconfirmed: true,
        });
        expect(body).not.toHaveProperty("paymentReceived");
      }
    },
  );

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
