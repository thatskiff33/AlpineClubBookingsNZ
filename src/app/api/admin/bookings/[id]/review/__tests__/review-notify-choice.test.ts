import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { AdminReviewStatus, BookingStatus } from "@prisma/client";

// Route-level gating for the per-decision member-email choice (issue #1790,
// mirroring #1769a / #1705). requireAdmin already restricts the route to
// admins, so there is no extra actor gate: an omitted flag notifies (default),
// `notifyMember: false` suppresses only the review approval/rejection email and
// records the choice in the audit metadata, and the review state change
// (approve claim / reject cancel) still happens either way. A non-boolean is a
// 400 through the same schema parse.
const h = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  transaction: vi.fn(),
  executeRaw: vi.fn(),
  acquireLodgeCapacityLock: vi.fn(),
  findUnique: vi.fn(),
  updateMany: vi.fn(),
  reconcile: vi.fn(),
  cancelBooking: vi.fn(),
  sendApproved: vi.fn(),
  sendRejected: vi.fn(),
  logAudit: vi.fn(),
}));

vi.mock("@/lib/session-guards", () => ({ requireAdmin: h.requireAdmin }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: h.transaction,
    booking: { findUnique: h.findUnique, updateMany: h.updateMany },
  },
}));
vi.mock("@/lib/capacity", () => ({
  acquireLodgeCapacityLock: h.acquireLodgeCapacityLock,
}));
vi.mock("@/lib/bed-allocation-lifecycle", () => ({
  reconcileBedAllocationsForBookingWithLodgeLockHeld: h.reconcile,
}));
vi.mock("@/lib/booking-cancel", () => ({ cancelBooking: h.cancelBooking }));
vi.mock("@/lib/email", () => ({
  sendBookingReviewApprovedEmail: h.sendApproved,
  sendBookingReviewRejectedEmail: h.sendRejected,
}));
vi.mock("@/lib/audit", () => ({ logAudit: h.logAudit }));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { PATCH } from "@/app/api/admin/bookings/[id]/review/route";

function req(body: unknown) {
  return new NextRequest("http://localhost/api/admin/bookings/b1/review", {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const params = Promise.resolve({ id: "b1" });

function baseBooking() {
  return {
    id: "b1",
    memberId: "member-1",
    status: BookingStatus.AWAITING_REVIEW,
    adminReviewStatus: AdminReviewStatus.PENDING,
    checkIn: new Date("2026-08-01T00:00:00Z"),
    checkOut: new Date("2026-08-03T00:00:00Z"),
    lodgeId: "lodge-1",
    member: { email: "m@example.com", firstName: "Mem" },
  };
}

function auditFor(action: string) {
  return h.logAudit.mock.calls.find((c) => c[0].action === action)?.[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  h.transaction.mockImplementation(async (callback) =>
    callback({
      $executeRaw: h.executeRaw,
      booking: { findUnique: h.findUnique, updateMany: h.updateMany },
    }),
  );
  h.requireAdmin.mockResolvedValue({
    ok: true,
    session: { user: { id: "admin-1" } },
  });
  h.findUnique.mockResolvedValue(baseBooking());
  h.updateMany.mockResolvedValue({ count: 1 });
  h.reconcile.mockResolvedValue(undefined);
  h.cancelBooking.mockResolvedValue({ status: 200, data: { success: true } });
  h.sendApproved.mockResolvedValue(undefined);
  h.sendRejected.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("PATCH /api/admin/bookings/[id]/review notify choice (#1790) — approve", () => {
  it("emails the member and records no notify field when the flag is omitted (default = notify)", async () => {
    const res = await PATCH(req({ status: "APPROVED" }), { params });

    expect(res.status).toBe(200);
    expect(h.sendApproved).toHaveBeenCalledTimes(1);
    const call = auditFor("booking.review.approve");
    expect(call?.metadata).toMatchObject({ decision: "APPROVED" });
    expect(call?.metadata).not.toHaveProperty("notifyMember");
  });

  it("suppresses the email, audits the choice, and still applies the approval when notifyMember is false", async () => {
    const res = await PATCH(req({ status: "APPROVED", notifyMember: false }), {
      params,
    });

    expect(res.status).toBe(200);
    expect(h.sendApproved).not.toHaveBeenCalled();
    // The review state change (atomic claim) still happens.
    expect(h.updateMany).toHaveBeenCalledTimes(1);
    const call = auditFor("booking.review.approve");
    expect(call?.metadata).toMatchObject({
      decision: "APPROVED",
      notifyMember: false,
    });
  });

  it("emails the member and records no notify field when notifyMember is true", async () => {
    const res = await PATCH(req({ status: "APPROVED", notifyMember: true }), {
      params,
    });

    expect(res.status).toBe(200);
    expect(h.sendApproved).toHaveBeenCalledTimes(1);
    const call = auditFor("booking.review.approve");
    expect(call?.metadata).not.toHaveProperty("notifyMember");
  });
});

describe("PATCH /api/admin/bookings/[id]/review notify choice (#1790) — reject", () => {
  it("emails the member and records no notify field when the flag is omitted (default = notify)", async () => {
    const res = await PATCH(
      req({ status: "REJECTED", adminNotes: "No adult on this booking" }),
      { params },
    );

    expect(res.status).toBe(200);
    expect(h.cancelBooking).toHaveBeenCalledTimes(1);
    expect(h.sendRejected).toHaveBeenCalledTimes(1);
    const call = auditFor("booking.review.reject");
    expect(call?.metadata).toMatchObject({ decision: "REJECTED" });
    expect(call?.metadata).not.toHaveProperty("notifyMember");
  });

  it("suppresses the rejection email, audits the choice, and still cancels when notifyMember is false", async () => {
    const res = await PATCH(
      req({
        status: "REJECTED",
        adminNotes: "No adult on this booking",
        notifyMember: false,
      }),
      { params },
    );

    expect(res.status).toBe(200);
    // The review state change (shared cancel flow) still happens.
    expect(h.cancelBooking).toHaveBeenCalledTimes(1);
    // #1730 carve-out (guards the DOMAIN_INVARIANTS/registry claim): the
    // review-declined explainer is suppressed, but notifyMember must NOT be
    // threaded into cancelBooking, so its cancellation email still always
    // sends. Pin that no suppress/options arg is passed (7th positional arg,
    // after `format` and `refundMethod`, stays undefined) — a future refactor
    // that suppresses it would fail here.
    expect(h.cancelBooking.mock.calls[0][6]).toBeUndefined();
    expect(h.sendRejected).not.toHaveBeenCalled();
    const call = auditFor("booking.review.reject");
    expect(call?.metadata).toMatchObject({
      decision: "REJECTED",
      notifyMember: false,
    });
  });

  it("emails the member and records no notify field when notifyMember is true", async () => {
    const res = await PATCH(
      req({
        status: "REJECTED",
        adminNotes: "No adult on this booking",
        notifyMember: true,
      }),
      { params },
    );

    expect(res.status).toBe(200);
    expect(h.sendRejected).toHaveBeenCalledTimes(1);
    const call = auditFor("booking.review.reject");
    expect(call?.metadata).not.toHaveProperty("notifyMember");
  });
});

describe("PATCH /api/admin/bookings/[id]/review notify choice (#1790) — validation", () => {
  it("rejects a non-boolean notifyMember with 400 and applies nothing", async () => {
    const res = await PATCH(
      req({ status: "APPROVED", notifyMember: "false" }),
      { params },
    );

    expect(res.status).toBe(400);
    expect(h.updateMany).not.toHaveBeenCalled();
    expect(h.sendApproved).not.toHaveBeenCalled();
  });
});
