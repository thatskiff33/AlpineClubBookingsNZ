import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withSaveFigures } from "@/lib/__tests__/support/edit-save-figures";
import { NextRequest } from "next/server";
import { OverCapacityConfirmationRequiredError } from "@/lib/over-capacity-confirmation";

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  authorizationRole: vi.fn(),
  modifyBookingBatch: vi.fn(),
  adminShiftBookingDates: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: h.requireActiveSessionUser,
}));
vi.mock("@/lib/admin-permissions", () => ({
  bookingManagementAuthorizationRole: h.authorizationRole,
}));
vi.mock("@/lib/booking-batch-modification-service", () => ({
  modifyBookingBatch: h.modifyBookingBatch,
}));
vi.mock("@/lib/booking-date-modification-service", () => ({
  adminShiftBookingDates: h.adminShiftBookingDates,
}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { PUT } from "@/app/api/bookings/[id]/modify/route";
import {
  XeroLockDateCheckFailedError,
  XeroPeriodLockedError,
} from "@/lib/xero-period-lock-guard";

function req(body: unknown) {
  return new NextRequest("http://localhost/api/bookings/b1/modify", {
    method: "PUT",
    body: JSON.stringify(withSaveFigures(body)),
    headers: { "content-type": "application/json" },
  });
}

const params = Promise.resolve({ id: "b1" });

beforeEach(() => {
  vi.clearAllMocks();
  h.auth.mockResolvedValue({ user: { id: "u1" } });
  h.requireActiveSessionUser.mockResolvedValue(null);
  h.authorizationRole.mockReturnValue("ADMIN");
  h.modifyBookingBatch.mockResolvedValue({ ok: "batch" });
  h.adminShiftBookingDates.mockResolvedValue({ ok: "shift" });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("PUT /api/bookings/[id]/modify admin override gating (issue #1668)", () => {
  it("rejects override flags from a non-admin with 403 and calls no service", async () => {
    h.authorizationRole.mockReturnValue("USER");

    const res = await PUT(req({ adminOverride: true, pricingMode: "shift" }), {
      params,
    });

    expect(res.status).toBe(403);
    expect(h.modifyBookingBatch).not.toHaveBeenCalled();
    expect(h.adminShiftBookingDates).not.toHaveBeenCalled();
  });

  it("requires a pricingMode when adminOverride is set (400)", async () => {
    const res = await PUT(req({ adminOverride: true, checkIn: "2026-09-12" }), {
      params,
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: "Choose a pricing mode for the admin override",
    });
    expect(h.adminShiftBookingDates).not.toHaveBeenCalled();
  });

  it("rejects pricingMode without adminOverride (400)", async () => {
    const res = await PUT(req({ pricingMode: "shift", checkIn: "2026-09-12" }), {
      params,
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: "adminOverride is required for pricingMode/confirmOverCapacity",
    });
    expect(h.adminShiftBookingDates).not.toHaveBeenCalled();
  });

  it("rejects confirmOverCapacity without adminOverride (400)", async () => {
    const res = await PUT(
      req({ confirmOverCapacity: true, checkIn: "2026-09-12" }),
      { params },
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: "adminOverride is required for pricingMode/confirmOverCapacity",
    });
    expect(h.modifyBookingBatch).not.toHaveBeenCalled();
  });

  it("enforces the date-only contract (rejects guest inputs with 400)", async () => {
    const res = await PUT(
      req({
        adminOverride: true,
        pricingMode: "shift",
        checkIn: "2026-09-12",
        removeGuestIds: ["g1"],
      }),
      { params },
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: "Admin override edits change dates only",
    });
    expect(h.adminShiftBookingDates).not.toHaveBeenCalled();
  });

  it("dispatches a shift override to adminShiftBookingDates, not the batch service", async () => {
    const res = await PUT(
      req({
        adminOverride: true,
        pricingMode: "shift",
        checkIn: "2026-09-12",
        notifyMember: false,
        hostingCoverageOverride: {
          acknowledged: true,
          reason: "Confirmed alternate supervision plan.",
          strandedStateKey: `v1:${"a".repeat(64)}`,
        },
      }),
      { params },
    );

    expect(res.status).toBe(200);
    expect(h.adminShiftBookingDates).toHaveBeenCalledTimes(1);
    expect(h.modifyBookingBatch).not.toHaveBeenCalled();
    const arg = h.adminShiftBookingDates.mock.calls[0][0];
    expect(arg.actor).toEqual({ id: "u1", role: "ADMIN" });
    expect(arg.hostingCoverageOverride).toEqual({
      acknowledged: true,
      reason: "Confirmed alternate supervision plan.",
      strandedStateKey: `v1:${"a".repeat(64)}`,
    });
    // The admin's email choice is threaded to the service (owner decision).
    expect(arg.input).toMatchObject({
      checkIn: "2026-09-12",
      notifyMember: false,
    });
  });

  it("dispatches a recalculate override to the batch service", async () => {
    const res = await PUT(
      req({
        adminOverride: true,
        pricingMode: "recalculate",
        checkIn: "2026-09-12",
      }),
      { params },
    );

    expect(res.status).toBe(200);
    expect(h.modifyBookingBatch).toHaveBeenCalledTimes(1);
    expect(h.adminShiftBookingDates).not.toHaveBeenCalled();
  });

  it("maps an unconfirmed over-capacity throw to a 409 with code + nightDetails", async () => {
    const nightDetails = [{ date: "2026-09-12", availableBeds: -1 }];
    h.adminShiftBookingDates.mockRejectedValue(
      new OverCapacityConfirmationRequiredError(nightDetails),
    );

    const res = await PUT(
      req({ adminOverride: true, pricingMode: "shift", checkIn: "2026-09-12" }),
      { params },
    );

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      code: "OVER_CAPACITY_CONFIRM_REQUIRED",
      nightDetails,
    });
  });
});

describe("PUT /api/bookings/[id]/modify notify choice on plain edits (issue #1696)", () => {
  it("accepts notifyMember alone (no adminOverride) from an ADMIN and threads it to the batch service", async () => {
    const res = await PUT(
      req({
        addGuests: [
          { firstName: "New", lastName: "Guest", ageTier: "ADULT", isMember: true },
        ],
        notifyMember: false,
      }),
      { params },
    );

    expect(res.status).toBe(200);
    expect(h.modifyBookingBatch).toHaveBeenCalledTimes(1);
    expect(h.adminShiftBookingDates).not.toHaveBeenCalled();
    const arg = h.modifyBookingBatch.mock.calls[0][0];
    expect(arg.actor).toEqual({ id: "u1", role: "ADMIN" });
    expect(arg.input).toMatchObject({ notifyMember: false });
    expect(arg.input).not.toHaveProperty("adminOverride", true);
  });

  it("rejects notifyMember alone from a non-ADMIN with 403, no service call", async () => {
    h.authorizationRole.mockReturnValue("USER");

    const res = await PUT(
      req({ notifyMember: false, checkIn: "2026-09-12" }),
      { params },
    );

    expect(res.status).toBe(403);
    expect(h.modifyBookingBatch).not.toHaveBeenCalled();
    expect(h.adminShiftBookingDates).not.toHaveBeenCalled();
  });
});

describe("PUT /api/bookings/[id]/modify Xero lock-date guard mapping (issue #1697)", () => {
  it("maps XeroPeriodLockedError to 409 with the machine-readable code and lockDate", async () => {
    h.modifyBookingBatch.mockRejectedValue(
      new XeroPeriodLockedError("2026-06-30"),
    );

    const res = await PUT(
      req({ adminOverride: true, pricingMode: "recalculate", checkIn: "2026-06-15" }),
      { params },
    );

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      code: "XERO_PERIOD_LOCKED",
      lockDate: "2026-06-30",
      error: expect.stringContaining("2026-06-30"),
    });
  });

  it("maps XeroLockDateCheckFailedError to a retryable 503 with its code", async () => {
    h.modifyBookingBatch.mockRejectedValue(new XeroLockDateCheckFailedError());

    const res = await PUT(
      req({ adminOverride: true, pricingMode: "recalculate", checkIn: "2026-06-15" }),
      { params },
    );

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({
      code: "XERO_LOCK_DATE_CHECK_FAILED",
    });
  });
});
