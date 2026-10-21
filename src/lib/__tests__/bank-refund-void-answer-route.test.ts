import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #4162 (`INV-ADDPAY-042`): the refund list's completion route carries a bank
 * refund to re-confirm's answer. The "already in Xero" answer is checked
 * against Xero BEFORE the completion's transaction (`prepareBankRefundVoidAnswer`),
 * and its refusal reaches the treasurer as a 409 with the reason; an answer of
 * another shape is refused at the schema.
 */
const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  resolveManualRefundTask: vi.fn(),
  prepare: vi.fn(),
  order: [] as string[],
}));

vi.mock("@/lib/session-guards", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/logger", () => ({ default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/bank-refund-void-answer", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/bank-refund-void-answer")),
  prepareBankRefundVoidAnswer: mocks.prepare,
}));
vi.mock("@/lib/manual-refund-task-resolution", () => ({
  resolveManualRefundTask: mocks.resolveManualRefundTask,
  MANUAL_PAYMENT_NOTE_MAX: 500,
  ManualBookingPaymentError: class ManualBookingPaymentError extends Error {
    status: number;
    constructor(message: string, status = 400) {
      super(message);
      this.status = status;
    }
  },
}));

import { POST } from "@/app/api/admin/payments/manual-refund-tasks/[id]/route";
import { ManualBookingPaymentError } from "@/lib/manual-refund-task-resolution";

function request(body: unknown) {
  return new Request("http://localhost/api/admin/payments/manual-refund-tasks/t1", { method: "POST", body: JSON.stringify(body) }) as never;
}
const params = Promise.resolve({ id: "follow-up-1" });
const verified = { creditNoteId: "cn-hand", creditNoteNumber: "CN-0123", amountCents: 20_000, status: "AUTHORISED", total: 200 };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.order.length = 0;
  mocks.requireAdmin.mockResolvedValue({ ok: true, session: { user: { id: "admin-1" } } });
  mocks.prepare.mockImplementation(async ({ answer }: { answer: { answer: string } }) => {
    mocks.order.push("xero-check");
    return answer.answer === "fresh-note" ? { answer: "fresh-note" } : { answer: "recorded-in-xero", note: verified };
  });
  mocks.resolveManualRefundTask.mockImplementation(async () => {
    mocks.order.push("completion");
    return { amountAmended: false, settlementRoute: null, stripeRefundId: null, additionalPaymentIntentId: null, recordedNightPriceCount: 0 };
  });
});

describe("a bank refund to re-confirm's answer (#4162)", () => {
  it("checks the hand-made note in Xero before the completion, then hands the checked note to it", async () => {
    const response = await POST(
      request({ resolution: "completed", confirmed: true, note: null, bankRefundVoidAnswer: { answer: "recorded-in-xero", creditNoteNumber: "CN-0123" } }),
      { params },
    );
    expect(response.status).toBe(200);
    expect(mocks.order).toEqual(["xero-check", "completion"]);
    expect(mocks.resolveManualRefundTask.mock.calls[0]![0]).toMatchObject({
      taskId: "follow-up-1",
      resolution: "completed",
      bankRefundVoidAnswer: { answer: "recorded-in-xero", note: verified },
    });
    expect((await response.json()).message).toContain("against credit note CN-0123");
  });

  it("passes a fresh-note answer through, and says one note is queued", async () => {
    const response = await POST(request({ resolution: "completed", confirmed: true, bankRefundVoidAnswer: { answer: "fresh-note" } }), { params });
    expect(response.status).toBe(200);
    expect(mocks.resolveManualRefundTask.mock.calls[0]![0]).toMatchObject({ bankRefundVoidAnswer: { answer: "fresh-note" } });
    expect((await response.json()).message).toContain("One fresh credit note is queued");
  });

  it("a refused Xero check is a 409 with its reason, and nothing is completed", async () => {
    mocks.prepare.mockRejectedValue(new ManualBookingPaymentError("Credit note CN-0123 is voided in Xero, so it does not record this refund.", 409));
    const response = await POST(
      request({ resolution: "completed", confirmed: true, bankRefundVoidAnswer: { answer: "recorded-in-xero", creditNoteNumber: "CN-0123" } }),
      { params },
    );
    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain("voided in Xero");
    expect(mocks.resolveManualRefundTask).not.toHaveBeenCalled();
  });

  it.each([
    [{ answer: "recorded-in-xero" }],
    [{ answer: "recorded-in-xero", creditNoteNumber: "   " }],
    [{ answer: "not-yet" }],
    [{ answer: "fresh-note", creditNoteNumber: "CN-1" }],
  ])("refuses the answer %j at the schema", async (answer) => {
    const response = await POST(request({ resolution: "completed", confirmed: true, bankRefundVoidAnswer: answer }), { params });
    expect(response.status).toBe(400);
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it("a dismissal ('the club keeps it') carries no answer", async () => {
    const response = await POST(
      request({ resolution: "dismissed", confirmed: true, note: "Bounced", bankRefundVoidAnswer: { answer: "fresh-note" } }),
      { params },
    );
    expect(response.status).toBe(400);
  });
});
