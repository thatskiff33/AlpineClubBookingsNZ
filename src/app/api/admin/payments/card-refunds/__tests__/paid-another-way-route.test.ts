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
  closeGroupCardRefundPaidAnotherWay: vi.fn(),
  findUnique: vi.fn(),
}));

vi.mock("@/lib/session-guards", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
// #4851: the route reads the row's key to send a group organiser's refund to the group close.
vi.mock("@/lib/prisma", () => ({
  prisma: { paymentRecoveryOperation: { findUnique: mocks.findUnique } },
}));
vi.mock("@/lib/card-refund-group-paid-another-way", () => ({
  closeGroupCardRefundPaidAnotherWay: mocks.closeGroupCardRefundPaidAnotherWay,
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
import {
  BOOKING_CANCELLATION_REFUND_RECOVERY_PREFIX,
  GROUP_SETTLEMENT_REFUND_RECOVERY_PREFIX,
  ORGANISER_CHILD_REFUND_KEY_PREFIX,
} from "@/lib/payment-recovery-keys";
import { POST } from "../[id]/paid-another-way/route";

// Built from the real prefixes, so the routing reads the keys the writers mint.
const CHARGE_ROW = `${BOOKING_CANCELLATION_REFUND_RECOVERY_PREFIX}b-1`;
const ORGANISER_CHILD_ROW = `${ORGANISER_CHILD_REFUND_KEY_PREFIX}c-1`;
const LEGACY_GROUP_ROW = `${GROUP_SETTLEMENT_REFUND_RECOVERY_PREFIX}s-1`;

function request(body: unknown) {
  return new Request("http://localhost/api/admin/payments/card-refunds/op-1/paid-another-way", {
    method: "POST",
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

const params = Promise.resolve({ id: "op-1" });
const valid = {
  amountCents: 5_000,
  paidBack: "full",
  expectedOwedCents: 5_000,
  note: "Bank transfer, ref 123",
  confirmed: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAdmin.mockResolvedValue({ ok: true, session: { user: { id: "treasurer-1" } } });
  mocks.findUnique.mockResolvedValue({ idempotencyKey: CHARGE_ROW });
  mocks.closeCardRefundPaidAnotherWay.mockResolvedValue({
    operationId: "op-1",
    bookingId: "b-1",
    paymentId: "p-1",
    amountCents: 5_000,
    owedCents: 5_000,
    paidBack: "full",
    xeroQueued: "nothing",
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
    expect(mocks.findUnique).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("what the close needs", () => {
  it.each([
    ["no confirmation", { amountCents: 5_000, paidBack: "full", expectedOwedCents: 5_000, note: "Bank transfer" }],
    // Owner, 8 Oct 2026: the treasurer says full or part; it is never inferred.
    ["no full-or-part answer", { amountCents: 5_000, expectedOwedCents: 5_000, note: "Bank transfer", confirmed: true }],
    // #3924 round 7 (C7): the owed figure the treasurer saw is required.
    ["no owed figure the treasurer saw", { amountCents: 5_000, paidBack: "full", note: "Bank transfer", confirmed: true }],
    ["a negative owed figure", { ...valid, expectedOwedCents: -1 }],
    ["an answer that is neither full nor part", { ...valid, paidBack: "most" }],
    ["a confirmation that is not literally true", { ...valid, confirmed: "yes" }],
    ["no note", { amountCents: 5_000, paidBack: "full", expectedOwedCents: 5_000, confirmed: true }],
    ["a negative amount", { ...valid, amountCents: -1 }],
    ["fractional cents", { ...valid, amountCents: 10.5 }],
    ["a field it does not know", { ...valid, refundToCard: true }],
    ["a note past the column's width", { ...valid, note: "x".repeat(501) }],
    ["a rest that is neither answer (#4516)", { ...valid, paidBack: "partial", amountCents: 4_000, rest: "split" }],
  ])("refuses %s, and closes nothing", async (_label, body) => {
    const response = await POST(request(body), { params });
    expect(response.status).toBe(400);
    expect(mocks.closeCardRefundPaidAnotherWay).not.toHaveBeenCalled();
  });

  it("hands the operation, amount, full-or-part answer, the owed figure seen, note and acting treasurer to the close", async () => {
    const response = await POST(request({ ...valid, paidBack: "partial", rest: "still-owed", amountCents: 4_000 }), { params });

    expect(response.status).toBe(200);
    expect(mocks.closeCardRefundPaidAnotherWay).toHaveBeenCalledWith({
      operationId: "op-1",
      amountCents: 4_000,
      paidBack: "partial",
      rest: "still-owed", // #4516: the treasurer's answer for the rest, passed exactly
      expectedOwedCents: 5_000,
      note: "Bank transfer, ref 123",
      actingMemberId: "treasurer-1",
    });
    await expect(response.json()).resolves.toMatchObject({ success: true, xeroQueued: "nothing" });
    expect(revalidatePath).toHaveBeenCalledWith("/admin/system/stuck-states");
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

  it("answers the close's full-or-part refusal with a 400 and its sentence", async () => {
    mocks.closeCardRefundPaidAnotherWay.mockRejectedValue(
      new CardRefundPaidAnotherWayError("Paid back in full must be exactly what is still owed. Refresh and check the amount.", 400),
    );

    const response = await POST(request(valid), { params });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Paid back in full must be exactly what is still owed. Refresh and check the amount.",
    });
  });

  it("answers anything else with a 500 that names no internals", async () => {
    mocks.closeCardRefundPaidAnotherWay.mockRejectedValue(new Error("connection reset"));

    const response = await POST(request(valid), { params });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "Could not close the card refund." });
  });
});

describe("which close a row goes to (#4851)", () => {
  it.each([
    ["a joiner's refund out of the organiser's card", ORGANISER_CHILD_ROW],
    ["a pre-#3653 whole-group refund", LEGACY_GROUP_ROW],
  ])("sends %s to the group close, without the charge close's rest", async (_label, idempotencyKey) => {
    mocks.findUnique.mockResolvedValue({ idempotencyKey });
    mocks.closeGroupCardRefundPaidAnotherWay.mockResolvedValue({ operationId: "op-1" });

    const response = await POST(request(valid), { params });

    expect(response.status).toBe(200);
    expect(mocks.findUnique).toHaveBeenCalledWith({ where: { id: "op-1" }, select: { idempotencyKey: true } });
    expect(mocks.closeGroupCardRefundPaidAnotherWay).toHaveBeenCalledWith({
      operationId: "op-1",
      amountCents: 5_000,
      paidBack: "full",
      expectedOwedCents: 5_000,
      note: "Bank transfer, ref 123",
      actingMemberId: "treasurer-1",
    });
    expect(mocks.closeCardRefundPaidAnotherWay).not.toHaveBeenCalled();
  });

  it("sends a charge-backed row, and a row it cannot find, to the charge close", async () => {
    await POST(request(valid), { params });
    mocks.findUnique.mockResolvedValue(null);
    await POST(request(valid), { params });

    expect(mocks.closeCardRefundPaidAnotherWay).toHaveBeenCalledTimes(2);
    expect(mocks.closeGroupCardRefundPaidAnotherWay).not.toHaveBeenCalled();
  });

  it("answers the group close's refusal with its own status and sentence", async () => {
    mocks.findUnique.mockResolvedValue({ idempotencyKey: ORGANISER_CHILD_ROW });
    mocks.closeGroupCardRefundPaidAnotherWay.mockRejectedValue(
      new CardRefundPaidAnotherWayError("This refund is the organiser's and closes for the whole amount.", 400),
    );

    const response = await POST(request(valid), { params });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "This refund is the organiser's and closes for the whole amount.",
    });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
