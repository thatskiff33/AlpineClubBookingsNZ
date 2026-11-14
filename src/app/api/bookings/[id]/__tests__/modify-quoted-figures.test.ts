import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { EditPriceChangedError } from "@/lib/edit-quoted-figures";

// #4924 (`INV-MOD-062`): the save door's half of "an edit settles only the
// figures the member was shown". The comparison itself is pinned by
// `booking-modify-quoted-figures.test.ts` and, against real writers, by
// `edit-quoted-figures.realdb.test.ts`; this pins what the route carries in and
// what a refusal looks like on the wire.

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

function req(body: unknown) {
  return new NextRequest("http://localhost/api/bookings/b1/modify", {
    method: "PUT",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const params = Promise.resolve({ id: "b1" });
const previewed = {
  newFinalPriceCents: 30_000,
  priceDiffCents: -12_000,
  changeFeeCents: 0,
  netChargeCents: -12_000,
};
const fresh = { ...previewed, changeFeeCents: 3_000, netChargeCents: -9_000 };

beforeEach(() => {
  vi.clearAllMocks();
  h.auth.mockResolvedValue({ user: { id: "u1" } });
  h.requireActiveSessionUser.mockResolvedValue(null);
  h.authorizationRole.mockReturnValue("USER");
  h.modifyBookingBatch.mockResolvedValue({ ok: "batch" });
  h.adminShiftBookingDates.mockResolvedValue({ ok: "shift" });
});

describe("PUT /api/bookings/[id]/modify quoted figures (#4924)", () => {
  it("hands the previewed figures to the save and returns its result", async () => {
    const res = await PUT(req({ checkOut: "2026-08-03", quotedFigures: previewed }), { params });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: "batch" });
    expect(h.modifyBookingBatch.mock.calls[0]?.[0].input.quotedFigures).toEqual(previewed);
  });

  it("saves without figures, as an older panel sends none", async () => {
    const res = await PUT(req({ checkOut: "2026-08-03" }), { params });

    expect(res.status).toBe(200);
    expect(h.modifyBookingBatch.mock.calls[0]?.[0].input.quotedFigures).toBeUndefined();
  });

  it("answers a changed price with 409 EDIT_PRICE_CHANGED and the save's fresh figures", async () => {
    h.modifyBookingBatch.mockRejectedValue(new EditPriceChangedError(fresh));

    const res = await PUT(req({ checkOut: "2026-08-03", quotedFigures: previewed }), { params });

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({
      code: "EDIT_PRICE_CHANGED",
      error: "The price changed since you previewed it. Review and save again.",
      figures: fresh,
    });
  });

  it("binds the admin date shift too", async () => {
    h.authorizationRole.mockReturnValue("ADMIN");
    const shiftFigures = { newFinalPriceCents: 30_000, priceDiffCents: 0, changeFeeCents: 0, netChargeCents: 0 };
    h.adminShiftBookingDates.mockRejectedValue(
      new EditPriceChangedError({ ...shiftFigures, newFinalPriceCents: 31_000 }),
    );

    const res = await PUT(
      req({ adminOverride: true, pricingMode: "shift", checkIn: "2026-09-12", quotedFigures: shiftFigures }),
      { params },
    );

    expect(h.adminShiftBookingDates.mock.calls[0]?.[0].input.quotedFigures).toEqual(shiftFigures);
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ code: "EDIT_PRICE_CHANGED" });
  });

  it("refuses figures that are not integer cents before any save runs", async () => {
    const res = await PUT(
      req({ checkOut: "2026-08-03", quotedFigures: { ...previewed, changeFeeCents: 0.5 } }),
      { params },
    );

    expect(res.status).toBe(400);
    expect(h.modifyBookingBatch).not.toHaveBeenCalled();
  });
});
