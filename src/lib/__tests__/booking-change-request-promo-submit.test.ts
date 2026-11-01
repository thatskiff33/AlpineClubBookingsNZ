import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * #4533, Edit Booking's entry point: an officer on a FINISHED stay raises a
 * change request carrying only a promo change, through the member route's
 * `POST`. It is written for the officer to approve; nothing is applied here.
 */

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  bookingFindUnique: vi.fn(),
  bookingChangeRequestFindFirst: vi.fn(),
  bookingChangeRequestCreate: vi.fn(),
  promoRedemptionFindMany: vi.fn(),
  logAudit: vi.fn(),
  sendAdminBookingChangeRequestAlert: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: vi.fn().mockResolvedValue(null),
  requireAdmin: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: { findUnique: (...args: unknown[]) => mocks.bookingFindUnique(...args) },
    promoRedemption: { findMany: (...args: unknown[]) => mocks.promoRedemptionFindMany(...args) },
    bookingChangeRequest: {
      findFirst: (...args: unknown[]) => mocks.bookingChangeRequestFindFirst(...args),
      create: (...args: unknown[]) => mocks.bookingChangeRequestCreate(...args),
    },
  },
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ success: true, resetAt: 0 }),
  getClientIp: vi.fn().mockReturnValue("127.0.0.1"),
  rateLimiters: { bookingChangeRequest: { id: "booking-change-request" } },
}));
vi.mock("@/lib/audit", () => ({ logAudit: (...args: unknown[]) => mocks.logAudit(...args) }));
vi.mock("@/lib/email", () => ({
  sendAdminBookingChangeRequestAlert: (...args: unknown[]) => mocks.sendAdminBookingChangeRequestAlert(...args),
}));
vi.mock("@/lib/logger", () => ({ default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/club-time/server", () => ({
  clubTodayDateOnlyInstant: async () => new Date("2026-07-01T00:00:00.000Z"),
}));

import { POST } from "@/app/api/bookings/[id]/change-requests/route";
import {
  PROMO_CHANGE_ALONE_MESSAGE,
  PROMO_CHANGE_ALREADY_APPLIED_MESSAGE,
  PROMO_CHANGE_OFFICER_FINISHED_STAY_ONLY_MESSAGE,
  PROMO_CHANGE_SUMMARY_SUFFIX,
} from "@/lib/booking-change-request-promo";

const OFFICER = { user: { id: "officer-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } };
const MEMBER = { user: { id: "member-1", role: "MEMBER", accessRoles: [{ role: "USER" }] } };

function finishedBooking(overrides: Record<string, unknown> = {}) {
  return {
    id: "booking-1",
    memberId: "member-1",
    status: "COMPLETED",
    checkIn: new Date("2026-06-10T00:00:00.000Z"),
    checkOut: new Date("2026-06-16T00:00:00.000Z"),
    lodgeId: "lodge-1",
    guests: [
      {
        id: "guest-1",
        firstName: "Alex",
        lastName: "Example",
        ageTier: "ADULT",
        isMember: true,
        memberId: "member-1",
        stayStart: new Date("2026-06-10T00:00:00.000Z"),
        stayEnd: new Date("2026-06-16T00:00:00.000Z"),
        nights: [],
      },
    ],
    member: { id: "member-1", firstName: "Alex", lastName: "Example", email: "alex@example.com" },
    organisation: null,
    payment: null,
    ...overrides,
  };
}

function post(body: unknown) {
  return POST(
    new NextRequest("http://localhost/api/bookings/booking-1/change-requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: "booking-1" }) },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue(OFFICER);
  mocks.bookingFindUnique.mockResolvedValue(finishedBooking());
  mocks.bookingChangeRequestFindFirst.mockResolvedValue(null);
  mocks.promoRedemptionFindMany.mockResolvedValue([]);
  mocks.bookingChangeRequestCreate.mockImplementation(async (args: { data: Record<string, unknown> }) => ({
    id: "request-1",
    status: "REQUESTED",
    ...args.data,
  }));
  mocks.sendAdminBookingChangeRequestAlert.mockResolvedValue(undefined);
});

describe("POST change-requests with a promo change (#4533)", () => {
  it("writes an officer's promo correction for a finished stay, stamped and snapshotted", async () => {
    const response = await post({ promoChange: { promoCode: "freenight" } });
    expect(response.status).toBe(201);
    const created = mocks.bookingChangeRequestCreate.mock.calls[0]![0] as {
      data: { requestedByMemberId: string; requestedChanges: Record<string, Record<string, unknown>> };
    };
    expect(created.data.requestedByMemberId).toBe("officer-1");
    const { original, requested } = created.data.requestedChanges;
    expect(original!.promoCodes).toEqual([]);
    expect(requested!.addGuests).toEqual([]);
    expect(requested!.promoChange).toMatchObject({
      promoCode: "freenight",
      enteredBy: { onMemberBehalf: true, officerMemberId: "officer-1", enteredOn: "request" },
    });
    expect(requested!.summary).toBe(`apply promo code FREENIGHT ${PROMO_CHANGE_SUMMARY_SUFFIX}`);
    expect(mocks.logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking-change-request.create",
        subjectMemberId: "member-1",
        metadata: expect.objectContaining({
          promoChange: { codes: ["FREENIGHT"], onMemberBehalf: true, enteredOn: "request" },
        }),
      }),
    );
  });

  it("refuses a member, for their own finished stay or a running one", async () => {
    mocks.auth.mockResolvedValue(MEMBER);
    const response = await post({ promoChange: { promoCode: "FREENIGHT" } });
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe(PROMO_CHANGE_OFFICER_FINISHED_STAY_ONLY_MESSAGE);
    expect(mocks.bookingChangeRequestCreate).not.toHaveBeenCalled();
  });

  it("refuses an officer on a stay that has not finished — Edit Booking changes that code", async () => {
    mocks.bookingFindUnique.mockResolvedValue(
      finishedBooking({ status: "PAID", checkOut: new Date("2026-07-03T00:00:00.000Z") }),
    );
    const response = await post({ promoChange: { promoCode: "FREENIGHT" } });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe(PROMO_CHANGE_OFFICER_FINISHED_STAY_ONLY_MESSAGE);
  });

  it("refuses a cancelled finished stay with the lifecycle sentence", async () => {
    mocks.bookingFindUnique.mockResolvedValue(finishedBooking({ status: "CANCELLED" }));
    const response = await post({ promoChange: { promoCode: "FREENIGHT" } });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/^Only .* bookings can be modified$/);
  });

  it("carries the promo change alone", async () => {
    const response = await post({ promoChange: { promoCode: "FREENIGHT" }, checkOut: "2026-06-15" });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe(PROMO_CHANGE_ALONE_MESSAGE);
  });

  it("refuses a code the booking already carries, and a guest not on it", async () => {
    mocks.promoRedemptionFindMany.mockResolvedValue([{ promoCode: { code: "FREENIGHT" } }]);
    let response = await post({ promoChange: { promoCode: "FREENIGHT" } });
    expect((await response.json()).error).toBe(PROMO_CHANGE_ALREADY_APPLIED_MESSAGE);
    response = await post({ promoChange: { promoCode: "OTHER", promoGuestIds: ["someone-else"] } });
    expect(response.status).toBe(400);
    expect(mocks.bookingChangeRequestCreate).not.toHaveBeenCalled();
  });

  it("points at the officer's pending request rather than raising a second", async () => {
    mocks.bookingChangeRequestFindFirst.mockResolvedValue({ id: "request-0" });
    const response = await post({ promoChange: { promoCode: "FREENIGHT" } });
    expect(response.status).toBe(409);
    expect((await response.json()).requestId).toBe("request-0");
  });

  it("refuses a removal: the shape cannot say it", async () => {
    const response = await post({ promoChange: { promoCodes: [] } });
    expect(response.status).toBe(400);
    expect(mocks.bookingChangeRequestCreate).not.toHaveBeenCalled();
  });
});
