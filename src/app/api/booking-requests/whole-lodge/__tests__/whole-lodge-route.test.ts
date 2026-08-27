import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/*
  #2263 — the member whole-lodge submit route.

  The acceptance criterion the byte-compare Playwright spec proves against three
  SEEDED worlds is proved here at the layer where the reasoning lives: the route
  hands back one FROZEN body, serialised per request, and the decision to do so
  cannot be undone by a later "helpful" addition (a reference number, an echo of
  the dates) without failing these tests.

  It also pins the order of operations. That order is load-bearing: session
  before rate limit before schema before the service means every observable
  rejection is derived from the caller's own session, their own request history,
  or their own payload — never from the state of the calendar.
*/

const h = vi.hoisted(() => ({
  requireActiveSession: vi.fn(),
  createMemberWholeLodgeRequest: vi.fn(),
  assertRequestedLodgeActive: vi.fn(),
  applyRateLimit: vi.fn(),
  checkRateLimit: vi.fn(),
  // Defined inside vi.hoisted so the class exists before the hoisted vi.mock
  // factories below run.
  TestBookingRequestError: class TestBookingRequestError extends Error {
    status: number;
    constructor(message: string, status = 400) {
      super(message);
      this.status = status;
    }
  },
}));

const TestBookingRequestError = h.TestBookingRequestError;

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
vi.mock("@/lib/session-guards", () => ({
  requireActiveSession: h.requireActiveSession,
}));
vi.mock("@/lib/booking-request", () => ({
  BookingRequestError: h.TestBookingRequestError,
  createMemberWholeLodgeRequest: h.createMemberWholeLodgeRequest,
  assertRequestedLodgeActive: h.assertRequestedLodgeActive,
}));
vi.mock("@/lib/rate-limit", () => ({
  applyRateLimit: h.applyRateLimit,
  checkRateLimit: h.checkRateLimit,
  rateLimitedResponse: () => new Response("{}", { status: 429 }),
  rateLimiters: {
    memberWholeLodgeRequest: { id: "member-whole-lodge-request", limit: 5, windowSeconds: 3600 },
  },
}));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { POST } from "@/app/api/booking-requests/whole-lodge/route";

const VALID_BODY = {
  lodgeId: "lodge-a",
  checkIn: "2099-08-01",
  checkOut: "2099-08-05",
  headcount: 12,
  groupDescription: "Club alpine skills course",
};

function request(body: unknown) {
  return new NextRequest("http://localhost/api/booking-requests/whole-lodge", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.requireActiveSession.mockResolvedValue({
    ok: true,
    session: { user: { id: "member-1" } },
  });
  h.applyRateLimit.mockResolvedValue(null);
  h.checkRateLimit.mockResolvedValue({ success: true, limit: 5, resetAt: 0 });
  h.assertRequestedLodgeActive.mockResolvedValue(null);
  h.createMemberWholeLodgeRequest.mockResolvedValue({ id: "req-1" });
});

describe("POST /api/booking-requests/whole-lodge (#2263)", () => {
  it("returns 201 with a body that echoes nothing the member submitted", async () => {
    const response = await POST(request(VALID_BODY));
    expect(response.status).toBe(201);

    const text = await response.text();
    // No dates, no headcount, no group description, no request id. Every one of
    // those would be an echo, and an echo is a channel.
    expect(text).not.toContain("2099-08-01");
    expect(text).not.toContain("2099-08-05");
    expect(text).not.toContain("12");
    expect(text).not.toContain("alpine");
    expect(text).not.toContain("req-1");
  });

  it("returns BYTE-IDENTICAL bodies for different submissions from different members", async () => {
    const first = await POST(request(VALID_BODY));
    const firstBytes = Buffer.from(await first.arrayBuffer());

    h.requireActiveSession.mockResolvedValue({
      ok: true,
      session: { user: { id: "member-2" } },
    });
    const second = await POST(
      request({
        ...VALID_BODY,
        checkIn: "2099-12-24",
        checkOut: "2099-12-28",
        headcount: 3,
        groupDescription: "Something else entirely",
        notes: "and a note",
      }),
    );
    const secondBytes = Buffer.from(await second.arrayBuffer());

    expect(first.status).toBe(second.status);
    // Buffer equality, not deep-equal: two objects can be deep-equal and
    // serialise to different bytes (key order, whitespace), and it is the BYTES
    // a caller measures.
    expect(secondBytes.equals(firstBytes)).toBe(true);
  });

  it("serialises a fresh body per request, so the second caller is not handed a consumed stream", async () => {
    // The frozen constant is the BODY, never a Response instance: a Response's
    // body is a one-shot stream and reusing the instance breaks on the second
    // request. Two sequential reads both succeeding is what proves it.
    const first = await POST(request(VALID_BODY));
    expect(await first.json()).toMatchObject({ success: true });
    const second = await POST(request(VALID_BODY));
    expect(await second.json()).toMatchObject({ success: true });
  });

  it("takes the member id from the SESSION and ignores any id in the body", async () => {
    await POST(
      request({ ...VALID_BODY, memberId: "someone-else", requestedByMemberId: "someone-else" }),
    );

    expect(h.createMemberWholeLodgeRequest).toHaveBeenCalledWith(
      expect.objectContaining({ memberId: "member-1" }),
    );
  });

  it("checks the session BEFORE anything else, so an anonymous caller cannot even spend a rate-limit token", async () => {
    h.requireActiveSession.mockResolvedValue({
      ok: false,
      response: new Response("{}", { status: 401 }),
    });

    const response = await POST(request(VALID_BODY));

    expect(response.status).toBe(401);
    expect(h.applyRateLimit).not.toHaveBeenCalled();
    expect(h.createMemberWholeLodgeRequest).not.toHaveBeenCalled();
  });

  it("rate limits per-IP and again per-member", async () => {
    await POST(request(VALID_BODY));
    expect(h.applyRateLimit).toHaveBeenCalledTimes(1);
    expect(h.checkRateLimit).toHaveBeenCalledWith(
      expect.anything(),
      "member:member-1",
    );
  });

  it("rejects an invalid payload with 422 and never reaches the service", async () => {
    const response = await POST(request({ ...VALID_BODY, headcount: 0 }));
    expect(response.status).toBe(422);
    expect(h.createMemberWholeLodgeRequest).not.toHaveBeenCalled();
  });

  it("rejects a check-out that is not after check-in, and a past stay", async () => {
    expect(
      (await POST(request({ ...VALID_BODY, checkOut: "2099-08-01" }))).status,
    ).toBe(400);
    expect(
      (
        await POST(
          request({ ...VALID_BODY, checkIn: "2000-01-01", checkOut: "2000-01-03" }),
        )
      ).status,
    ).toBe(400);
  });

  it("passes the service error status through — including the open-request cap 409", async () => {
    h.createMemberWholeLodgeRequest.mockRejectedValue(
      new TestBookingRequestError("maximum open requests", 409),
    );

    const response = await POST(request(VALID_BODY));
    expect(response.status).toBe(409);
  });

  it("lets the SERVICE own the headcount-vs-capacity bound, so the status is 422 not 400", async () => {
    // The route used to duplicate this check and answer 400 while the service
    // answered 422 for the identical refusal, so the same rejection looked like
    // two different failures depending on which layer caught it. The route no
    // longer reads lodge capacity at all — hence no @/lib/lodge-capacity mock in
    // this file, which is itself the pin: adding the check back reintroduces the
    // import and this suite fails on the missing mock.
    h.createMemberWholeLodgeRequest.mockRejectedValue(
      new TestBookingRequestError(
        "A whole-lodge request cannot exceed the lodge capacity of 30 guests",
        422,
      ),
    );

    const response = await POST(request({ ...VALID_BODY, headcount: 31 }));
    expect(response.status).toBe(422);
    // It really did reach the service — the route did not short-circuit.
    expect(h.createMemberWholeLodgeRequest).toHaveBeenCalled();
  });

  it("strips CRLF-bearing text at the schema, so nothing can be injected into the officer's copy", async () => {
    const response = await POST(
      request({ ...VALID_BODY, groupDescription: "line\r\nBcc: attacker@example.com" }),
    );
    expect(response.status).toBe(422);
  });
});
