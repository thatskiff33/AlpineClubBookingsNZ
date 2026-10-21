import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #4162 (owner decision 18 Oct 2026): a person picks the bank refund an
 * unmatched voided note recorded. `finance:edit`; one line id; a refusal (the
 * note or line moved, or report-only) and a busy row are a 409.
 */
const mocks = vi.hoisted(() => ({ requireAdmin: vi.fn(), pick: vi.fn() }));

vi.mock("@/lib/session-guards", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/logger", () => ({ default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/bank-refund-void-follow-up", () => ({
  pickRefundForUnmatchedVoid: mocks.pick,
  BankRefundVoidAnswerRefusal: class BankRefundVoidAnswerRefusal extends Error {
    constructor(
      message: string,
      readonly status: number,
    ) {
      super(message);
    }
  },
}));

import { POST } from "../[id]/pick/route";
import { BankRefundVoidAnswerRefusal } from "@/lib/bank-refund-void-follow-up";

function request(body: unknown) {
  return new Request("http://localhost/api/admin/payments/bank-refund-voids/link-1/pick", { method: "POST", body: JSON.stringify(body) }) as never;
}
const params = Promise.resolve({ id: "link-1" });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAdmin.mockResolvedValue({ ok: true, session: { user: { id: "officer-1" } } });
  mocks.pick.mockResolvedValue({ followUpTaskId: "f-1", paymentId: "pay-1", bookingId: "b-1" });
});

describe("POST /api/admin/payments/bank-refund-voids/[id]/pick (#4162)", () => {
  it("is gated finance:edit", async () => {
    mocks.requireAdmin.mockResolvedValue({ ok: false, response: new Response(null, { status: 403 }) });
    expect((await POST(request({ lineId: "line-1", confirmed: true }), { params })).status).toBe(403);
    expect(mocks.requireAdmin).toHaveBeenCalledWith({ permission: { area: "finance", level: "edit" } });
    expect(mocks.pick).not.toHaveBeenCalled();
  });

  it("runs the pick with the officer and the line", async () => {
    const response = await POST(request({ lineId: "line-1", confirmed: true }), { params });
    expect(response.status).toBe(200);
    expect(mocks.pick).toHaveBeenCalledWith({ linkId: "link-1", lineId: "line-1", actingMemberId: "officer-1" });
  });

  it.each([[{ confirmed: true }], [{ lineId: "line-1" }], [{ lineId: "", confirmed: true }], [{ lineId: "l", confirmed: true, amountCents: 1 }]])("refuses %j", async (body) => {
    expect((await POST(request(body), { params })).status).toBe(400);
    expect(mocks.pick).not.toHaveBeenCalled();
  });

  it("answers a refusal and a busy row with a 409", async () => {
    mocks.pick.mockRejectedValueOnce(new BankRefundVoidAnswerRefusal("report-only", 409));
    expect((await POST(request({ lineId: "line-1", confirmed: true }), { params })).status).toBe(409);
    mocks.pick.mockRejectedValueOnce(Object.assign(new Error("lock"), { code: "55P03" }));
    expect((await POST(request({ lineId: "line-1", confirmed: true }), { params })).status).toBe(409);
  });
});
