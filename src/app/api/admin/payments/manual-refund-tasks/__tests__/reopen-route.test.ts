import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /api/admin/payments/manual-refund-tasks/[id]/reopen — #3498, owner
 * decision D2.
 *
 * The route is a door: guard, parse, hand over, answer. What it pins here is the
 * boundary — that undoing a money decision needs the same permission as taking
 * one, that it cannot happen by a single unconfirmed click, and that the
 * library's refusals reach the officer as their own sentences rather than as a
 * 500. Every rule about WHICH closures may be reopened is
 * `manual-refund-task-reopen.test.ts`, because it is a rule about the row and
 * not about the request.
 */

const mocks = vi.hoisted(() => {
  class ManualBookingPaymentError extends Error {
    status: number;
    constructor(message: string, status = 400) {
      super(message);
      this.name = "ManualBookingPaymentError";
      this.status = status;
    }
  }
  return {
    requireAdmin: vi.fn(),
    reopenManualRefundTask: vi.fn(),
    ManualBookingPaymentError,
  };
});

vi.mock("@/lib/session-guards", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock("@/lib/payment-reconciliation", () => ({
  ManualBookingPaymentError: mocks.ManualBookingPaymentError,
}));
vi.mock("@/lib/manual-refund-task-reopen", () => ({
  reopenManualRefundTask: mocks.reopenManualRefundTask,
  MANUAL_PAYMENT_NOTE_MAX: 500,
}));

import { POST } from "../[id]/reopen/route";

function request(body: unknown) {
  return new Request(
    "http://localhost/api/admin/payments/manual-refund-tasks/task-1/reopen",
    {
      method: "POST",
      body: JSON.stringify(body),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    },
  ) as any;
}

const params = Promise.resolve({ id: "task-1" });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAdmin.mockResolvedValue({
    ok: true,
    session: { user: { id: "admin-1" } },
  });
  mocks.reopenManualRefundTask.mockResolvedValue({
    taskId: "task-1",
    bookingId: "booking-1",
    kind: "EDIT_FINANCIAL_REVIEW",
    status: "OPEN",
  });
});

describe("POST manual-refund-tasks/[id]/reopen (#3498 D2)", () => {
  it("needs finance:edit — the same permission as closing one", async () => {
    // Undoing a decision is not a lesser act than taking it, so it is not a
    // `finance:view` affordance with a write behind it.
    await POST(request({ confirmed: true, note: "Closed by mistake." }), {
      params,
    });
    expect(mocks.requireAdmin).toHaveBeenCalledWith({
      permission: { area: "finance", level: "edit" },
    });
  });

  it("hands the library the task, the actor and the note", async () => {
    const response = await POST(
      request({ confirmed: true, note: "  Closed by mistake.  " }),
      { params },
    );
    expect(response.status).toBe(200);
    expect(mocks.reopenManualRefundTask).toHaveBeenCalledWith({
      taskId: "task-1",
      actingMemberId: "admin-1",
      note: "  Closed by mistake.  ",
    });
  });

  it("refuses an unconfirmed body, so this is never a single-click accident", async () => {
    const response = await POST(request({ note: "Closed by mistake." }), {
      params,
    });
    expect(response.status).toBe(400);
    expect(mocks.reopenManualRefundTask).not.toHaveBeenCalled();
  });

  it("refuses an unrecognised field rather than ignoring it", async () => {
    // `.strict()`, for the reason every money body here is: a field this door
    // never agreed to must not reach the library as if it had.
    const response = await POST(
      request({ confirmed: true, note: "x", settleInstead: true }),
      { params },
    );
    expect(response.status).toBe(400);
    expect(mocks.reopenManualRefundTask).not.toHaveBeenCalled();
  });

  it("passes the library's own refusal through, with its status", async () => {
    // The note requirement and the COMPLETED refusal are the library's, so the
    // officer must read ITS sentence - a schema failure here would answer
    // "Invalid reopen request." and a field dump, which is the bare refusal the
    // owner's 31 Aug 2026 decision rejected on the sibling route.
    mocks.reopenManualRefundTask.mockRejectedValue(
      new mocks.ManualBookingPaymentError("Only a closure that was dismissed…", 409),
    );
    const response = await POST(request({ confirmed: true, note: "x" }), {
      params,
    });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toBe(
      "Only a closure that was dismissed…",
    );
  });

  it("answers 500 for anything else, without leaking it", async () => {
    mocks.reopenManualRefundTask.mockRejectedValue(new Error("boom"));
    const response = await POST(request({ confirmed: true, note: "x" }), {
      params,
    });
    expect(response.status).toBe(500);
    expect(((await response.json()) as { error: string }).error).not.toContain(
      "boom",
    );
  });
});
