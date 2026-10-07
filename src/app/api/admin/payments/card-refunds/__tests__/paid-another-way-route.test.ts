import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /api/admin/payments/card-refunds/[id]/paid-another-way (#3372, owner
 * 7 Oct 2026: "Count + add close action").
 *
 * The route is the door: finance:edit, a confirmed body with a note, and the
 * library's refusals answered with their own status. What the close itself
 * does - the lock, the claim, the money - is `card-refund-paid-another-way.test.ts`
 * and the real-PostgreSQL double-click proof.
 */

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  closeCardRefundPaidAnotherWay: vi.fn(),
}));

vi.mock("@/lib/session-guards", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock("@/lib/card-refund-paid-another-way", () => ({
  closeCardRefundPaidAnotherWay: mocks.closeCardRefundPaidAnotherWay,
  CardRefundPaidAnotherWayError: class CardRefundPaidAnotherWayError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
}));

import { revalidatePath } from "next/cache";
import type { NextRequest } from "next/server";
import { CardRefundPaidAnotherWayError } from "@/lib/card-refund-paid-another-way";
import { POST } from "../[id]/paid-another-way/route";

function request(body: unknown) {
  return new Request("http://localhost/api/admin/payments/card-refunds/op-1/paid-another-way", {
    method: "POST",
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

const params = Promise.resolve({ id: "op-1" });
const valid = { amountCents: 5_000, note: "Bank transfer, ref 123", confirmed: true };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAdmin.mockResolvedValue({ ok: true, session: { user: { id: "treasurer-1" } } });
  mocks.closeCardRefundPaidAnotherWay.mockResolvedValue({
    operationId: "op-1",
    bookingId: "b-1",
    paymentId: "p-1",
    amountCents: 5_000,
    owedCents: 5_000,
    xeroRefundNoteQueued: false,
  });
});

describe("who may close a card refund as paid another way", () => {
  it("asks for finance:edit, the permission that completes a refund paid back by hand", async () => {
    await POST(request(valid), { params });
    expect(mocks.requireAdmin).toHaveBeenCalledWith({ permission: { area: "finance", level: "edit" } });
  });

  it("refuses a view-only finance admin before anything is read or written", async () => {
    // requireAdmin answers a finance:view admin with its own 403.
    mocks.requireAdmin.mockResolvedValue({
      ok: false,
      response: Response.json({ error: "Forbidden" }, { status: 403 }),
    });

    const response = await POST(request(valid), { params });

    expect(response.status).toBe(403);
    expect(mocks.closeCardRefundPaidAnotherWay).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("what the close needs", () => {
  it.each([
    ["no confirmation", { amountCents: 5_000, note: "Bank transfer" }],
    ["a confirmation that is not literally true", { ...valid, confirmed: "yes" }],
    ["no note", { amountCents: 5_000, confirmed: true }],
    ["a negative amount", { ...valid, amountCents: -1 }],
    ["fractional cents", { ...valid, amountCents: 10.5 }],
    ["a field it does not know", { ...valid, refundToCard: true }],
    ["a note past the column's width", { ...valid, note: "x".repeat(501) }],
  ])("refuses %s, and closes nothing", async (_label, body) => {
    const response = await POST(request(body), { params });
    expect(response.status).toBe(400);
    expect(mocks.closeCardRefundPaidAnotherWay).not.toHaveBeenCalled();
  });

  it("hands the operation, amount, note and acting treasurer to the close", async () => {
    const response = await POST(request(valid), { params });

    expect(response.status).toBe(200);
    expect(mocks.closeCardRefundPaidAnotherWay).toHaveBeenCalledWith({
      operationId: "op-1",
      amountCents: 5_000,
      note: "Bank transfer, ref 123",
      actingMemberId: "treasurer-1",
    });
    await expect(response.json()).resolves.toMatchObject({ success: true, xeroRefundNoteQueued: false });
    expect(revalidatePath).toHaveBeenCalledWith("/admin/stuck-states");
  });

  it("answers a refusal with its own status and sentence - a second click's 409", async () => {
    mocks.closeCardRefundPaidAnotherWay.mockRejectedValue(
      new CardRefundPaidAnotherWayError("This card refund has already been closed.", 409),
    );

    const response = await POST(request(valid), { params });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "This card refund has already been closed." });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("answers anything else with a 500 that names no internals", async () => {
    mocks.closeCardRefundPaidAnotherWay.mockRejectedValue(new Error("connection reset"));

    const response = await POST(request(valid), { params });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "Could not close the card refund." });
  });
});
