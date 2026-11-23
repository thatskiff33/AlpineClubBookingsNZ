import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  expectDefaultInvalidJsonAnswer,
  MALFORMED_JSON_BODY,
} from "@/lib/__tests__/helpers/invalid-json-body";

// #5407: the approval body is optional (the requests panel sends none for a
// general request). Only an absent body means "approve as submitted". A body
// that is not JSON, or JSON that is not an object such as `null`, is refused
// before anything is approved; `null` used to crash on the property read.
const h = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  findUnique: vi.fn(),
  approveBookingRequest: vi.fn(),
}));

vi.mock("@/lib/session-guards", () => ({ requireAdmin: h.requireAdmin }));
vi.mock("@/lib/prisma", () => ({
  prisma: { bookingRequest: { findUnique: h.findUnique } },
}));
vi.mock("@/lib/booking-request", () => ({
  approveBookingRequest: h.approveBookingRequest,
  BookingRequestError: class BookingRequestError extends Error {},
}));
vi.mock("@/lib/club-format-server", () => ({ clubFormatValues: vi.fn() }));

import { POST } from "@/app/api/admin/booking-requests/[id]/approve/route";

function approve(body?: string) {
  return POST(
    new NextRequest("http://localhost/api/admin/booking-requests/req-1/approve", {
      method: "POST",
      ...(body === undefined ? {} : { body, headers: { "content-type": "application/json" } }),
    }),
    { params: Promise.resolve({ id: "req-1" }) },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  h.requireAdmin.mockResolvedValue({ ok: true, session: { user: { id: "admin-1" } } });
  h.findUnique.mockResolvedValue({ type: "GENERAL", requestedByMemberId: null, exclusivityRequested: false });
  h.approveBookingRequest.mockResolvedValue({
    type: "approved",
    bookingId: "booking-1",
    memberId: "member-1",
    priceCents: 10000,
    paymentLinkExpiresAt: new Date("2026-07-08T00:00:00.000Z"),
  });
});

describe("POST /api/admin/booking-requests/[id]/approve: optional body (#5407)", () => {
  it.each([
    ["no body", undefined],
    ["an empty body", ""],
  ])("approves as submitted for %s", async (_label, body) => {
    const res = await approve(body);

    expect(res.status).toBe(200);
    expect(h.approveBookingRequest).toHaveBeenCalledWith({
      requestId: "req-1",
      adminMemberId: "admin-1",
      ownerContactMemberId: undefined,
    });
  });

  it.each(["null", "[]", '"yes"', "1"])(
    "refuses the non-object body %s with a 400 and approves nothing",
    async (body) => {
      const res = await approve(body);

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({ error: "Invalid request body" });
      expect(h.approveBookingRequest).not.toHaveBeenCalled();
    },
  );

  it("refuses a body that is not JSON with the shared invalid-JSON 400", async () => {
    await expectDefaultInvalidJsonAnswer(await approve(MALFORMED_JSON_BODY));
    expect(h.approveBookingRequest).not.toHaveBeenCalled();
  });
});
