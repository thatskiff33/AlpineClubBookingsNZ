import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /api/admin/payments/card-refunds/[id]/checked-not-owed (#4210 round 3,
 * `INV-PAY-136`). The route is the door: finance:edit, a confirmed body with a
 * note, and the library's refusals answered with their own status. The rules
 * are `card-refund-check-not-owed.test.ts`'s.
 */

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  closeCardRefundCheckNotOwed: vi.fn(),
}));

vi.mock("@/lib/session-guards", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/logger", () => ({ default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/card-refund-check-not-owed", () => ({
  closeCardRefundCheckNotOwed: mocks.closeCardRefundCheckNotOwed,
  CardRefundCheckNotOwedError: class CardRefundCheckNotOwedError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
}));

import { revalidatePath } from "next/cache";
import type { NextRequest } from "next/server";
import { CardRefundCheckNotOwedError } from "@/lib/card-refund-check-not-owed";
import { POST } from "../[id]/checked-not-owed/route";

function request(body: unknown) {
  return new Request("http://localhost/api/admin/payments/card-refunds/op-1/checked-not-owed", {
    method: "POST",
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

const params = Promise.resolve({ id: "op-1" });
const valid = { note: "The member returned nothing; the close paid it", confirmed: true };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAdmin.mockResolvedValue({ ok: true, session: { user: { id: "treasurer-1" } } });
  mocks.closeCardRefundCheckNotOwed.mockResolvedValue({ operationId: "op-1", bookingId: "b-1", amountCents: 4_000 });
});

describe("who may close a check as not owed", () => {
  it("MUTATION: asks for finance:edit, as the paid-another-way close does", async () => {
    await POST(request(valid), { params });
    expect(mocks.requireAdmin).toHaveBeenCalledWith({ permission: { area: "finance", level: "edit" } });
  });

  it("refuses a view-only finance admin before anything is read or written", async () => {
    mocks.requireAdmin.mockResolvedValue({ ok: false, response: Response.json({ error: "Forbidden" }, { status: 403 }) });
    const response = await POST(request(valid), { params });
    expect(response.status).toBe(403);
    expect(mocks.closeCardRefundCheckNotOwed).not.toHaveBeenCalled();
  });
});

describe("what the close needs", () => {
  it.each([
    ["no confirmation", { note: "Not owed" }],
    ["no note", { confirmed: true }],
    ["a confirmation that is not literally true", { ...valid, confirmed: "yes" }],
    ["a field it does not know", { ...valid, amountCents: 100 }],
    ["a note past the column's width", { ...valid, note: "x".repeat(501) }],
  ])("refuses %s, and closes nothing", async (_label, body) => {
    const response = await POST(request(body), { params });
    expect(response.status).toBe(400);
    expect(mocks.closeCardRefundCheckNotOwed).not.toHaveBeenCalled();
  });

  it("MUTATION: hands the operation, the note and the acting officer to the close, and refreshes the page", async () => {
    const response = await POST(request(valid), { params });
    expect(response.status).toBe(200);
    expect(mocks.closeCardRefundCheckNotOwed).toHaveBeenCalledWith({ operationId: "op-1", note: valid.note, actingMemberId: "treasurer-1" });
    expect(revalidatePath).toHaveBeenCalledWith("/admin/stuck-states");
  });

  it("answers a refusal with its own status and sentence", async () => {
    mocks.closeCardRefundCheckNotOwed.mockRejectedValue(new CardRefundCheckNotOwedError("This card refund has already been closed.", 409));
    const response = await POST(request(valid), { params });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "This card refund has already been closed." });
  });

  it("answers anything else with a 500 that names no internals", async () => {
    mocks.closeCardRefundCheckNotOwed.mockRejectedValue(new Error("connection reset"));
    const response = await POST(request(valid), { params });
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "Could not close the card refund." });
  });
});
