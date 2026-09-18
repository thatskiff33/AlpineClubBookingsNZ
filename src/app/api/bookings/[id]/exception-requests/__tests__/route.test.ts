import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn().mockResolvedValue(null),
  checkRateLimit: vi.fn(),
  getClientIp: vi.fn(),
  logAudit: vi.fn(),
  sendAlert: vi.fn(),
  getDefaultLodgeId: vi.fn(),
  authzRole: vi.fn(),
  editPolicy: vi.fn(),
  bookingFindUnique: vi.fn(),
  createMod: vi.fn(),
  cancelMod: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: mocks.requireActiveSessionUser,
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: (...a: unknown[]) => mocks.checkRateLimit(...a),
  getClientIp: (...a: unknown[]) => mocks.getClientIp(...a),
  rateLimiters: { bookingChangeRequest: { id: "bcr", limit: 5, windowSeconds: 86400 } },
}));
vi.mock("@/lib/audit", () => ({ logAudit: (...a: unknown[]) => mocks.logAudit(...a) }));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/email", () => ({
  sendAdminBookingChangeRequestAlert: (...a: unknown[]) => mocks.sendAlert(...a),
}));
vi.mock("@/lib/lodges", () => ({
  getDefaultLodgeId: (...a: unknown[]) => mocks.getDefaultLodgeId(...a),
}));
vi.mock("@/lib/admin-permissions", () => ({
  bookingManagementAuthorizationRole: (...a: unknown[]) => mocks.authzRole(...a),
}));
vi.mock("@/lib/booking-edit-policy", () => ({
  getBookingEditPolicy: (...a: unknown[]) => mocks.editPolicy(...a),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: { findUnique: (...a: unknown[]) => mocks.bookingFindUnique(...a) },
  },
}));
vi.mock("@/lib/booking-exception-request-service", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/booking-exception-request-service");
  return {
    ...actual,
    createModificationExceptionRequest: (...a: unknown[]) => mocks.createMod(...a),
    cancelModificationExceptionRequest: (...a: unknown[]) => mocks.cancelMod(...a),
  };
});

import { POST } from "@/app/api/bookings/[id]/exception-requests/route";
import { PATCH } from "@/app/api/bookings/[id]/exception-requests/[requestId]/route";
import { NoEligiblePolicyExceptionError } from "@/lib/booking-exception-request-service";

const CREATED = {
  id: "bcr-1",
  status: "REQUESTED",
  proposalHash: "b".repeat(64),
  reasonCodes: ["MINIMUM_STAY"],
  aggregateCapacityMode: "HOLD",
};

function makeBooking() {
  return {
    id: "booking-1",
    memberId: "m1",
    status: "CONFIRMED",
    checkIn: new Date("2026-07-04T00:00:00Z"),
    checkOut: new Date("2026-07-06T00:00:00Z"),
    lodgeId: "lodge_1",
    member: { firstName: "Ada", lastName: "Lovelace", email: "a@x.nz" },
    guests: [
      {
        id: "g1",
        firstName: "Ada",
        lastName: "Lovelace",
        ageTier: "ADULT",
        isMember: true,
        memberId: "m1",
        stayStart: new Date("2026-07-04T00:00:00Z"),
        stayEnd: new Date("2026-07-06T00:00:00Z"),
        // The stored explicit night set (#713), which the route's own `include`
        // loads (#2526) so the frozen proposal preserves a sparse stay instead of
        // flattening it to its envelope. A fixture without it would let the route
        // stop loading the relation without a test noticing.
        nights: [
          { stayDate: new Date("2026-07-04T00:00:00Z") },
          { stayDate: new Date("2026-07-05T00:00:00Z") },
        ],
      },
    ],
  };
}

function postReq(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/bookings/booking-1/exception-requests", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const params = { params: Promise.resolve({ id: "booking-1" }) };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ user: { id: "m1", email: "a@x.nz", name: "Ada", role: "member" } });
  mocks.requireActiveSessionUser.mockResolvedValue(null);
  mocks.checkRateLimit.mockResolvedValue({ success: true, resetAt: Date.now() + 1000 });
  mocks.getClientIp.mockReturnValue("0.0.0.0");
  mocks.getDefaultLodgeId.mockResolvedValue("lodge_1");
  mocks.authzRole.mockReturnValue("USER");
  mocks.editPolicy.mockReturnValue({ canModify: true, today: new Date(), editableFrom: null, mode: "future" });
  mocks.bookingFindUnique.mockResolvedValue(makeBooking());
  mocks.createMod.mockResolvedValue(CREATED);
  mocks.sendAlert.mockResolvedValue(undefined);
});

describe("POST /api/bookings/[id]/exception-requests", () => {
  it("creates a modification request (201), audits, notifies", async () => {
    const res = await POST(postReq({ checkOut: "2026-07-05", memberMessage: "please" }), params);
    expect(res.status).toBe(201);
    expect(mocks.createMod).toHaveBeenCalledTimes(1);
    expect(mocks.logAudit).toHaveBeenCalledTimes(1);
    expect(mocks.sendAlert).toHaveBeenCalledTimes(1);
    // #2525 FIX 7: the route resolves whether the live booking holds capacity and
    // threads it in. A CONFIRMED booking holds capacity, so baseHoldsCapacity=true.
    expect(mocks.createMod).toHaveBeenCalledWith(
      expect.objectContaining({ baseHoldsCapacity: true }),
    );
  });

  it("threads baseHoldsCapacity=false for a non-capacity-holding (DRAFT) base", async () => {
    // A DRAFT booking holds no capacity, so the reservation footprint must be the
    // full proposed party (#2525 FIX 7).
    mocks.bookingFindUnique.mockResolvedValue({ ...makeBooking(), status: "DRAFT" });
    const res = await POST(postReq({ checkOut: "2026-07-05", memberMessage: "please" }), params);
    expect(res.status).toBe(201);
    expect(mocks.createMod).toHaveBeenCalledWith(
      expect.objectContaining({ baseHoldsCapacity: false }),
    );
  });

  it("notify-post-commit-never-throws: a rejected alert still returns 201", async () => {
    mocks.sendAlert.mockRejectedValue(new Error("smtp down"));
    const res = await POST(postReq({ checkOut: "2026-07-05", memberMessage: "please" }), params);
    expect(res.status).toBe(201);
    await Promise.resolve();
  });

  it("refuses an un-modifiable booking (400) before creating anything", async () => {
    mocks.editPolicy.mockReturnValue({ canModify: false, reason: "Locked", today: new Date(), editableFrom: null, mode: "past" });
    const res = await POST(postReq({ checkOut: "2026-07-05", memberMessage: "please" }), params);
    expect(res.status).toBe(400);
    expect(mocks.createMod).not.toHaveBeenCalled();
  });

  it("forbids a non-owner non-admin (403)", async () => {
    mocks.auth.mockResolvedValue({ user: { id: "other", email: "o@x.nz", name: "Other", role: "member" } });
    const res = await POST(postReq({ checkOut: "2026-07-05", memberMessage: "please" }), params);
    expect(res.status).toBe(403);
    expect(mocks.createMod).not.toHaveBeenCalled();
  });

  it("maps NoEligiblePolicyExceptionError to 400", async () => {
    mocks.createMod.mockRejectedValue(new NoEligiblePolicyExceptionError());
    const res = await POST(postReq({ checkOut: "2026-07-05", memberMessage: "please" }), params);
    expect(res.status).toBe(400);
  });

  it("rejects removing a guest not on the booking (400)", async () => {
    const res = await POST(
      postReq({ removeGuestIds: ["ghost"], memberMessage: "please" }),
      params,
    );
    expect(res.status).toBe(400);
    expect(mocks.createMod).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/bookings/[id]/exception-requests/[requestId] (cancel)", () => {
  function patchReq() {
    return new NextRequest(
      "http://localhost/api/bookings/booking-1/exception-requests/bcr-1",
      {
        method: "PATCH",
        body: JSON.stringify({ action: "cancel" }),
        headers: { "content-type": "application/json" },
      },
    );
  }
  const cancelParams = { params: Promise.resolve({ id: "booking-1", requestId: "bcr-1" }) };

  it("cancels an open request (200), threads the URL bookingId into the claim, and audits", async () => {
    mocks.cancelMod.mockResolvedValue(true);
    const res = await PATCH(patchReq(), cancelParams);
    expect(res.status).toBe(200);
    // The route must thread the URL bookingId into the guarded claim so the
    // service can scope the request to its own booking.
    expect(mocks.cancelMod).toHaveBeenCalledWith(
      expect.objectContaining({ id: "bcr-1", bookingId: "booking-1", requestedByMemberId: "m1" }),
    );
    expect(mocks.logAudit).toHaveBeenCalledTimes(1);
  });

  it("lost-claim-no-side-effect: nothing to cancel is 409 and never audits", async () => {
    mocks.cancelMod.mockResolvedValue(false);
    const res = await PATCH(patchReq(), cancelParams);
    expect(res.status).toBe(409);
    expect(mocks.logAudit).not.toHaveBeenCalled();
  });

  it("mismatched bookingId: reaching a request via the wrong booking URL is 409 and writes no audit", async () => {
    // Request bcr-1 belongs to booking-1; reaching it via /bookings/booking-2/...
    // forwards booking-2 to the bookingId-scoped claim, which the service loses
    // (count 0 -> false). The route returns 409 and writes NO audit row — so the
    // success-path audit can never record booking-2 for a booking-1 request.
    mocks.cancelMod.mockResolvedValue(false);
    const req = new NextRequest(
      "http://localhost/api/bookings/booking-2/exception-requests/bcr-1",
      {
        method: "PATCH",
        body: JSON.stringify({ action: "cancel" }),
        headers: { "content-type": "application/json" },
      },
    );
    const res = await PATCH(req, {
      params: Promise.resolve({ id: "booking-2", requestId: "bcr-1" }),
    });
    expect(res.status).toBe(409);
    expect(mocks.cancelMod).toHaveBeenCalledWith(
      expect.objectContaining({ id: "bcr-1", bookingId: "booking-2", requestedByMemberId: "m1" }),
    );
    expect(mocks.logAudit).not.toHaveBeenCalled();
  });
});
