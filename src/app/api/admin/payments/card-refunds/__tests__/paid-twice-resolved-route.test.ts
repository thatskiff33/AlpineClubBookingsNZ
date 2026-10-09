import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /api/admin/payments/card-refunds/[id]/paid-twice-resolved (#3372,
 * owner 9 Oct 2026: "Add a 'Resolved' button"). The route is the door:
 * finance:edit, a confirmed body with a note, and the library's refusals
 * answered with their own status. The rules are `card-refund-paid-twice.test.ts`'s.
 */

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  resolveCardRefundPaidTwice: vi.fn(),
}));

vi.mock("@/lib/session-guards", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/logger", () => ({ default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/card-refund-paid-twice", () => ({
  resolveCardRefundPaidTwice: mocks.resolveCardRefundPaidTwice,
  CardRefundPaidTwiceError: class CardRefundPaidTwiceError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
}));

import { revalidatePath } from "next/cache";
import type { NextRequest } from "next/server";
import { CardRefundPaidTwiceError } from "@/lib/card-refund-paid-twice";
import { POST } from "../[id]/paid-twice-resolved/route";

function request(body: unknown) {
  return new Request("http://localhost/api/admin/payments/card-refunds/op-1/paid-twice-resolved", {
    method: "POST",
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

const params = Promise.resolve({ id: "op-1" });
const valid = { note: "Member paid the extra back", expectedRefundedByCardCents: 9_000, confirmed: true };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAdmin.mockResolvedValue({ ok: true, session: { user: { id: "treasurer-1" } } });
  mocks.resolveCardRefundPaidTwice.mockResolvedValue({ operationId: "op-1", bookingId: "b-1", refundedByCardCents: 9_000 });
});

describe("who may mark a paid-twice row resolved", () => {
  it("MUTATION: asks for finance:edit, as the close does", async () => {
    await POST(request(valid), { params });
    expect(mocks.requireAdmin).toHaveBeenCalledWith({ permission: { area: "finance", level: "edit" } });
  });

  it("refuses a view-only finance admin before anything is read or written", async () => {
    mocks.requireAdmin.mockResolvedValue({ ok: false, response: Response.json({ error: "Forbidden" }, { status: 403 }) });
    const response = await POST(request(valid), { params });
    expect(response.status).toBe(403);
    expect(mocks.resolveCardRefundPaidTwice).not.toHaveBeenCalled();
  });
});

describe("what the mark needs", () => {
  it.each([
    ["no confirmation", { note: "Sorted" }],
    ["no note", { expectedRefundedByCardCents: 9_000, confirmed: true }],
    // #3924 round 8 (concurrency): the card figure the dialog showed.
    ["no card figure", { note: "Sorted", confirmed: true }],
    ["a card figure that is not whole cents", { ...valid, expectedRefundedByCardCents: 90.5 }],
    ["a confirmation that is not literally true", { ...valid, confirmed: "yes" }],
    ["a field it does not know", { ...valid, amountCents: 100 }],
    ["a note past the column's width", { ...valid, note: "x".repeat(501) }],
  ])("refuses %s, and marks nothing", async (_label, body) => {
    const response = await POST(request(body), { params });
    expect(response.status).toBe(400);
    expect(mocks.resolveCardRefundPaidTwice).not.toHaveBeenCalled();
  });

  it("MUTATION: hands the operation, the note, the card figure the dialog showed and the acting treasurer to the mark, and refreshes the page", async () => {
    const response = await POST(request(valid), { params });
    expect(response.status).toBe(200);
    expect(mocks.resolveCardRefundPaidTwice).toHaveBeenCalledWith({
      operationId: "op-1",
      note: "Member paid the extra back",
      expectedRefundedByCardCents: 9_000,
      actingMemberId: "treasurer-1",
    });
    expect(revalidatePath).toHaveBeenCalledWith("/admin/stuck-states");
  });

  it("answers a refusal with its own status and sentence", async () => {
    mocks.resolveCardRefundPaidTwice.mockRejectedValue(
      new CardRefundPaidTwiceError("This card refund is no longer on the paid-twice list. The list has been refreshed.", 409),
    );
    const response = await POST(request(valid), { params });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "This card refund is no longer on the paid-twice list. The list has been refreshed.",
    });
  });

  it("answers anything else with a 500 that names no internals", async () => {
    mocks.resolveCardRefundPaidTwice.mockRejectedValue(new Error("connection reset"));
    const response = await POST(request(valid), { params });
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "Could not mark it resolved." });
  });
});
