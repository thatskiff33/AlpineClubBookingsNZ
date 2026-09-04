import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * #3214 (epic #2797) - the stored-night-prices route's contract.
 *
 * The DOMAIN behaviour - the eligibility fence, the no-op total, the created
 * night set, the race refusals - is proved against real data in
 * `stored-night-price-strand-reconcile.test.ts`. What is proved here is what
 * only the route decides: who may reach it, what body it accepts, that the plan
 * and the write share ONE transaction, and that a domain refusal keeps its own
 * status instead of collapsing into a 500.
 */

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  plan: vi.fn(),
  record: vi.fn(),
  transaction: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/session-guards", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({
  prisma: { $transaction: mocks.transaction },
}));
vi.mock("@/lib/stored-night-price-strand-reconcile", () => ({
  planStrandNightPriceReconcile: mocks.plan,
  recordStrandNightPriceReconcile: mocks.record,
}));

import { POST } from "@/app/api/admin/bookings/[id]/stored-night-prices/route";
import { ManualBookingPaymentError } from "@/lib/payment-reconciliation";
import { STRAND_RECONCILE_NOT_OFFERED_MESSAGE } from "@/lib/stored-night-price-repair";

const params = Promise.resolve({ id: "booking-1" });

function makeRequest(body: unknown) {
  return new NextRequest(
    "https://example.test/api/admin/bookings/booking-1/stored-night-prices",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

const validBody = {
  bookingGuestId: "guest-1",
  confirmed: true,
  note: null,
  nightPrices: [
    { date: "2026-08-01", priceCents: 4_000 },
    { date: "2026-08-02", priceCents: 6_000 },
  ],
};

const TX = { marker: "the-transaction" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAdmin.mockResolvedValue({
    ok: true,
    session: { user: { id: "admin-9" } },
  });
  mocks.transaction.mockImplementation(
    async (callback: (tx: unknown) => Promise<unknown>) => callback(TX),
  );
  mocks.plan.mockResolvedValue({ bookingGuestId: "guest-1" });
  mocks.record.mockResolvedValue(undefined);
});

describe("POST /api/admin/bookings/[id]/stored-night-prices", () => {
  it("is gated on finance:edit, not bookings:edit", async () => {
    // The path prefix says bookings and the act is money, exactly as mark-paid
    // is. `admin-route-area-matrix.test.ts` pins that the path INFERENCE agrees.
    await POST(makeRequest(validBody), { params });

    expect(mocks.requireAdmin).toHaveBeenCalledWith({
      permission: { area: "finance", level: "edit" },
    });
  });

  it("answers the guard's own response and writes nothing when refused", async () => {
    mocks.requireAdmin.mockResolvedValue({
      ok: false,
      response: new Response("nope", { status: 403 }),
    });

    const response = await POST(makeRequest(validBody), { params });

    expect(response.status).toBe(403);
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.plan).not.toHaveBeenCalled();
  });

  it("refuses a body with no explicit confirmation", async () => {
    // Recording what a stay sold for is never a single-click accident, matching
    // the settle route's own rule.
    const { confirmed: _confirmed, ...unconfirmed } = validBody;

    const response = await POST(makeRequest(unconfirmed), { params });

    expect(response.status).toBe(400);
    expect(mocks.plan).not.toHaveBeenCalled();
  });

  it("refuses an unknown field rather than ignoring it", async () => {
    // `.strict()`: a "split the rest evenly" flag cannot be smuggled into a body
    // this feature never agreed to.
    const response = await POST(
      makeRequest({ ...validBody, splitRemainder: true }),
      { params },
    );

    expect(response.status).toBe(400);
    expect(mocks.plan).not.toHaveBeenCalled();
  });

  it("refuses a night amount that is not whole non-negative cents", async () => {
    const response = await POST(
      makeRequest({
        ...validBody,
        nightPrices: [{ date: "2026-08-01", priceCents: -1 }],
      }),
      { params },
    );

    expect(response.status).toBe(400);
    expect(mocks.plan).not.toHaveBeenCalled();
  });

  it("plans and writes on ONE transaction, scoped to the path's booking", async () => {
    await POST(makeRequest(validBody), { params });

    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.plan).toHaveBeenCalledWith({
      bookingId: "booking-1",
      bookingGuestId: "guest-1",
      entries: validBody.nightPrices,
      store: TX,
    });
    expect(mocks.record).toHaveBeenCalledWith({
      plan: { bookingGuestId: "guest-1" },
      actingMemberId: "admin-9",
      note: null,
      store: TX,
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/bookings/[id]", "page");
  });

  it("keeps a domain refusal's own status instead of collapsing it into a 500", async () => {
    mocks.plan.mockRejectedValue(
      new ManualBookingPaymentError(STRAND_RECONCILE_NOT_OFFERED_MESSAGE, 409),
    );

    const response = await POST(makeRequest(validBody), { params });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: STRAND_RECONCILE_NOT_OFFERED_MESSAGE,
    });
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("answers 404 for a strand the plan says is not this booking's", async () => {
    mocks.plan.mockRejectedValue(
      new ManualBookingPaymentError("not this booking", 404),
    );

    const response = await POST(makeRequest(validBody), { params });

    expect(response.status).toBe(404);
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("answers 500 without leaking an unexpected failure's text", async () => {
    mocks.record.mockRejectedValue(new Error("column bookingGuestNight.x"));

    const response = await POST(makeRequest(validBody), { params });

    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: string };
    expect(body.error).not.toContain("bookingGuestNight");
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });
});
