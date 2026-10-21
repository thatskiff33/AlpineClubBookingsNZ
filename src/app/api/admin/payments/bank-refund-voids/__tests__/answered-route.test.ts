import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #4162 (`INV-ADDPAY-042`): a person's answer to a voided bank-transfer refund
 * note the nightly follow-up could not match. `finance:edit`; a required note;
 * a refusal or a busy link row is a 409 the panel refreshes on.
 */
const mocks = vi.hoisted(() => ({ requireAdmin: vi.fn(), mark: vi.fn() }));

vi.mock("@/lib/session-guards", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/logger", () => ({ default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/bank-refund-void-follow-up", () => ({
  markUnmatchedBankRefundVoidAnswered: mocks.mark,
  BankRefundVoidAnswerRefusal: class BankRefundVoidAnswerRefusal extends Error {
    constructor(
      message: string,
      readonly status: number,
    ) {
      super(message);
    }
  },
}));

import { POST } from "../[id]/answered/route";
import { BankRefundVoidAnswerRefusal } from "@/lib/bank-refund-void-follow-up";

function request(body: unknown) {
  return new Request("http://localhost/api/admin/payments/bank-refund-voids/link-1/answered", { method: "POST", body: JSON.stringify(body) }) as never;
}
const params = Promise.resolve({ id: "link-1" });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAdmin.mockResolvedValue({ ok: true, session: { user: { id: "officer-1" } } });
  mocks.mark.mockResolvedValue({ paymentId: "pay-1", bookingId: "booking-1" });
});

describe("POST /api/admin/payments/bank-refund-voids/[id]/answered (#4162)", () => {
  it("is gated finance:edit", async () => {
    mocks.requireAdmin.mockResolvedValue({ ok: false, response: new Response(null, { status: 403 }) });
    expect((await POST(request({ note: "x", confirmed: true }), { params })).status).toBe(403);
    expect(mocks.requireAdmin).toHaveBeenCalledWith({ permission: { area: "finance", level: "edit" } });
    expect(mocks.mark).not.toHaveBeenCalled();
  });

  it("records the answer with the officer and their note", async () => {
    const response = await POST(request({ note: "  Paid; CN-0999 raised by hand  ", confirmed: true }), { params });
    expect(response.status).toBe(200);
    expect(mocks.mark).toHaveBeenCalledWith({ linkId: "link-1", note: "Paid; CN-0999 raised by hand", actingMemberId: "officer-1" });
  });

  it.each([[{ note: "   ", confirmed: true }], [{ note: "x" }], [{ note: "x", confirmed: true, amountCents: 5 }]])("refuses %j", async (body) => {
    expect((await POST(request(body), { params })).status).toBe(400);
    expect(mocks.mark).not.toHaveBeenCalled();
  });

  it("answers a refusal and a busy link row with a 409", async () => {
    mocks.mark.mockRejectedValueOnce(new BankRefundVoidAnswerRefusal("This voided refund note has already been answered.", 409));
    expect((await POST(request({ note: "x", confirmed: true }), { params })).status).toBe(409);
    mocks.mark.mockRejectedValueOnce(Object.assign(new Error("lock"), { code: "55P03" }));
    expect((await POST(request({ note: "x", confirmed: true }), { params })).status).toBe(409);
  });
});
