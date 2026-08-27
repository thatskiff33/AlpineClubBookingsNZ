import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The sessionless .ics download (fork issue #35).
 *
 * An unauthenticated endpoint whose whole security story is the signed-expiry
 * HMAC token check, so that check is what gets tested: a live token serves
 * exactly one booking's stay as text/calendar; a wrong-booking token, a
 * missing token, an expired or tampered expiry, and a gone booking are all
 * the same 404. The rate limiter is mocked to pass by default (the real
 * in-memory store is per-process and this file's ~17 requests would eat half
 * a real 30/15-min bucket) and asserted separately.
 */

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  applyRateLimit: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { booking: { findUnique: mocks.findUnique } },
}));

vi.mock("@/lib/rate-limit", () => ({
  applyRateLimit: mocks.applyRateLimit,
  rateLimiters: { bookingCalendarDownload: { id: "booking-calendar-download" } },
}));

import { GET } from "@/app/api/booking-calendar/[id]/route";
import { bookingCalendarToken } from "@/lib/calendar-links";
import { parseDateOnly } from "@/lib/date-only";

const BOOKING_ID = "bkg_route_test";
// Future and past relative to the frozen test clock (2026-07-01).
const FUTURE_EXP = Math.floor(parseDateOnly("2026-10-01").getTime() / 1000);
const PAST_EXP = Math.floor(parseDateOnly("2026-06-01").getTime() / 1000);

function requestFor(
  token: string | null,
  exp: number | null = FUTURE_EXP,
): NextRequest {
  const url = new URL(
    `https://bookings.example.org/api/booking-calendar/${BOOKING_ID}`,
  );
  if (token !== null) url.searchParams.set("token", token);
  if (exp !== null) url.searchParams.set("exp", String(exp));
  return new NextRequest(url);
}

function call(
  token: string | null,
  exp: number | null = FUTURE_EXP,
  id = BOOKING_ID,
) {
  return GET(requestFor(token, exp), { params: Promise.resolve({ id }) });
}

const SERVABLE_BOOKING = {
  checkIn: parseDateOnly("2026-08-01"),
  checkOut: parseDateOnly("2026-08-04"),
  status: "CONFIRMED",
  deletedAt: null,
  updatedAt: new Date(),
  lodge: { name: "Example Lodge" },
};

beforeEach(() => {
  vi.stubEnv("AUTH_SECRET", "calendar-route-test-secret");
  vi.stubEnv("NEXTAUTH_URL", "https://bookings.example.org");
  mocks.findUnique.mockReset();
  mocks.findUnique.mockResolvedValue(SERVABLE_BOOKING);
  mocks.applyRateLimit.mockReset();
  mocks.applyRateLimit.mockResolvedValue(null);
});

describe("GET /api/booking-calendar/[id]", () => {
  it("serves the stay as a per-stay-named attachment with a live token, SEQUENCE included", async () => {
    const response = await call(bookingCalendarToken(BOOKING_ID, FUTURE_EXP));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(
      "text/calendar; charset=utf-8",
    );
    expect(response.headers.get("Content-Disposition")).toBe(
      'attachment; filename="lodge-stay-20260801.ics"',
    );
    const body = await response.text();
    expect(body).toContain("DTSTART;VALUE=DATE:20260801");
    expect(body).toContain("DTEND;VALUE=DATE:20260805");
    expect(body).toContain("SUMMARY:Example Lodge stay");
    expect(body).toContain(
      `SEQUENCE:${Math.floor(SERVABLE_BOOKING.updatedAt.getTime() / 1000)}`,
    );
  });

  it("consults the rate limiter first and returns its refusal untouched", async () => {
    const refusal = new Response(null, { status: 429 });
    mocks.applyRateLimit.mockResolvedValue(refusal);
    const response = await call(bookingCalendarToken(BOOKING_ID, FUTURE_EXP));
    expect(response).toBe(refusal);
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });

  it("404s with no token, without touching the database", async () => {
    const response = await call(null);
    expect(response.status).toBe(404);
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });

  it("404s with another booking's token, without touching the database", async () => {
    const response = await call(bookingCalendarToken("bkg_other", FUTURE_EXP));
    expect(response.status).toBe(404);
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });

  it("404s an expired link, without touching the database", async () => {
    const response = await call(
      bookingCalendarToken(BOOKING_ID, PAST_EXP),
      PAST_EXP,
    );
    expect(response.status).toBe(404);
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });

  it("404s a tampered expiry — a past-exp token replayed with a future exp", async () => {
    const response = await call(
      bookingCalendarToken(BOOKING_ID, PAST_EXP),
      FUTURE_EXP,
    );
    expect(response.status).toBe(404);
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });

  it("404s a missing or non-numeric exp, without touching the database", async () => {
    const token = bookingCalendarToken(BOOKING_ID, FUTURE_EXP);
    expect((await call(token, null)).status).toBe(404);
    const url = new URL(
      `https://bookings.example.org/api/booking-calendar/${BOOKING_ID}?token=${token}&exp=soon`,
    );
    const response = await GET(new NextRequest(url), {
      params: Promise.resolve({ id: BOOKING_ID }),
    });
    expect(response.status).toBe(404);
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });

  it("404s for a booking that no longer exists", async () => {
    mocks.findUnique.mockResolvedValue(null);
    const response = await call(bookingCalendarToken(BOOKING_ID, FUTURE_EXP));
    expect(response.status).toBe(404);
  });

  it.each(["CANCELLED", "BUMPED", "DRAFT", "WAITLISTED", "WAITLIST_OFFERED"])(
    "404s for a %s booking — a stay that no longer stands must not reach a calendar",
    async (status) => {
      mocks.findUnique.mockResolvedValue({ ...SERVABLE_BOOKING, status });
      const response = await call(bookingCalendarToken(BOOKING_ID, FUTURE_EXP));
      expect(response.status).toBe(404);
    },
  );

  it("404s for a soft-deleted booking", async () => {
    mocks.findUnique.mockResolvedValue({
      ...SERVABLE_BOOKING,
      deletedAt: new Date(),
    });
    const response = await call(bookingCalendarToken(BOOKING_ID, FUTURE_EXP));
    expect(response.status).toBe(404);
  });

  it.each(["PAID", "COMPLETED", "PENDING", "PAYMENT_PENDING", "AWAITING_REVIEW"])(
    "still serves a %s booking — the stay stands even as status advances",
    async (status) => {
      mocks.findUnique.mockResolvedValue({ ...SERVABLE_BOOKING, status });
      const response = await call(bookingCalendarToken(BOOKING_ID, FUTURE_EXP));
      expect(response.status).toBe(200);
    },
  );
});
