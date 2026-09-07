import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /api/admin/payments/manual-refund-tasks/[id] — closing a task.
 *
 * This suite exists because #3195 MOVED a refusal. The route's own schema used
 * to reject a `confirmedAmountCents` of zero, which answered "Invalid refund
 * task request." with a field dump — a bare refusal, and the owner's 31 Aug 2026
 * decision named that as the worst version of the behaviour it was keeping. The
 * rule now lives in the one layer that knows which control the officer can
 * actually see, so what this file pins is that the route lets a zero THROUGH to
 * it rather than answering for it, while still refusing everything a money
 * boundary must.
 *
 * It also pins #3191's new field in both directions: it reaches the library on a
 * completion AND on a dismissal, and an unrecognised field is still refused.
 */

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  resolveManualRefundTask: vi.fn(),
}));

vi.mock("@/lib/session-guards", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock("@/lib/manual-refund-task-resolution", () => ({
  resolveManualRefundTask: mocks.resolveManualRefundTask,
  MANUAL_PAYMENT_NOTE_MAX: 500,
  ManualBookingPaymentError: class ManualBookingPaymentError extends Error {
    status: number;
    constructor(message: string, status = 400) {
      super(message);
      this.name = "ManualBookingPaymentError";
      this.status = status;
    }
  },
}));

import { POST } from "../[id]/route";

function request(body: unknown) {
  return new Request("http://localhost/api/admin/payments/manual-refund-tasks/t1", {
    method: "POST",
    body: JSON.stringify(body),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
}

const params = Promise.resolve({ id: "task-1" });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAdmin.mockResolvedValue({
    ok: true,
    session: { user: { id: "admin-1" } },
  });
  mocks.resolveManualRefundTask.mockResolvedValue({
    amountAmended: false,
    settlementRoute: null,
    stripeRefundId: null,
    additionalPaymentIntentId: null,
    recordedNightPriceCount: 0,
  });
});

describe("a $0 completion reaches the layer that can explain it (#3195)", () => {
  it("does not refuse zero at the schema, so the library's sentence is what the operator reads", async () => {
    const response = await POST(
      request({
        resolution: "completed",
        confirmed: true,
        note: "Nothing owed.",
        confirmedAmountCents: 0,
        direction: "REFUND_TO_MEMBER",
      }),
      { params },
    );

    expect(response.status).toBe(200);
    expect(mocks.resolveManualRefundTask).toHaveBeenCalledWith(
      expect.objectContaining({ confirmedAmountCents: 0 }),
    );
  });

  it("still refuses a negative amount, which is not a decision anybody could mean", async () => {
    // THE CONTROL. Dropping `.positive()` must not have dropped the sign rule
    // with it: a money box that accepts a minus sign is the overloading this
    // epic exists to remove, and nothing downstream re-checks it before the
    // database's own CHECK.
    const response = await POST(
      request({
        resolution: "completed",
        confirmed: true,
        note: "Nothing owed.",
        confirmedAmountCents: -100,
        direction: "REFUND_TO_MEMBER",
      }),
      { params },
    );

    expect(response.status).toBe(400);
    expect(mocks.resolveManualRefundTask).not.toHaveBeenCalled();
  });
});

describe("per-night amounts on the way in (#3191)", () => {
  const recordedNightPrices = [{ date: "2026-08-02", priceCents: 1_500 }];

  it("passes them to the library on a completion", async () => {
    await POST(
      request({
        resolution: "completed",
        confirmed: true,
        note: "Priced from the rate card.",
        confirmedAmountCents: 4_500,
        direction: "REFUND_TO_MEMBER",
        recordedNightPrices,
      }),
      { params },
    );

    expect(mocks.resolveManualRefundTask).toHaveBeenCalledWith(
      expect.objectContaining({ recordedNightPrices }),
    );
  });

  it("passes them on a DISMISSAL too, which is where most parked strands end", async () => {
    await POST(
      request({
        resolution: "dismissed",
        confirmed: true,
        note: "Nothing owed either way.",
        recordedNightPrices,
      }),
      { params },
    );

    expect(mocks.resolveManualRefundTask).toHaveBeenCalledWith(
      expect.objectContaining({
        resolution: "dismissed",
        recordedNightPrices,
      }),
    );
  });

  it("sends null when none were given, so an untouched settle posts what it always did", async () => {
    await POST(
      request({
        resolution: "completed",
        confirmed: true,
        note: "Priced from the rate card.",
        confirmedAmountCents: 4_500,
        direction: "REFUND_TO_MEMBER",
      }),
      { params },
    );

    expect(mocks.resolveManualRefundTask).toHaveBeenCalledWith(
      expect.objectContaining({ recordedNightPrices: null }),
    );
  });

  it("refuses a night amount that is not whole non-negative cents", async () => {
    for (const priceCents of [-1, 10.5]) {
      const response = await POST(
        request({
          resolution: "dismissed",
          confirmed: true,
          note: "Nothing owed either way.",
          recordedNightPrices: [{ date: "2026-08-02", priceCents }],
        }),
        { params },
      );
      expect(response.status).toBe(400);
    }
    expect(mocks.resolveManualRefundTask).not.toHaveBeenCalled();
  });

  it("refuses a date that is not a lodge night", async () => {
    const response = await POST(
      request({
        resolution: "dismissed",
        confirmed: true,
        note: "Nothing owed either way.",
        recordedNightPrices: [{ date: "the second", priceCents: 100 }],
      }),
      { params },
    );
    expect(response.status).toBe(400);
    expect(mocks.resolveManualRefundTask).not.toHaveBeenCalled();
  });

  it("refuses an extra field on a night, so no 'work the rest out' flag can be smuggled in", async () => {
    const response = await POST(
      request({
        resolution: "dismissed",
        confirmed: true,
        note: "Nothing owed either way.",
        recordedNightPrices: [
          { date: "2026-08-02", priceCents: 100, splitRemainder: true },
        ],
      }),
      { params },
    );
    expect(response.status).toBe(400);
    expect(mocks.resolveManualRefundTask).not.toHaveBeenCalled();
  });
});

describe("what the operator is told afterwards", () => {
  it("says the nights were recorded, and what that bought them", async () => {
    mocks.resolveManualRefundTask.mockResolvedValue({
      amountAmended: false,
      settlementRoute: null,
      stripeRefundId: null,
      additionalPaymentIntentId: null,
      recordedNightPriceCount: 2,
    });

    const response = await POST(
      request({
        resolution: "dismissed",
        confirmed: true,
        note: "Nothing owed either way.",
        recordedNightPrices: [
          { date: "2026-08-02", priceCents: 100 },
          { date: "2026-08-03", priceCents: 100 },
        ],
      }),
      { params },
    );
    const body = (await response.json()) as { message: string };
    expect(body.message).toContain("2 nights' prices were recorded");
    /*
      #3191 fix round: the receipt claims THIS GUEST'S nights, not the booking.
      One edit raises one review per unreadable guest strand, so settling the
      first of two leaves the second blank - and "this booking will not be sent
      for review again" would be a promise the next edit disproves, on the one
      promise this whole epic is about.
    */
    expect(body.message).toContain(
      "this guest's nights will not send this booking back for review again",
    );
    expect(body.message).toContain(
      "If another guest on the same booking has unpriced nights",
    );
  });

  it("says nothing extra when no nights were recorded", async () => {
    // THE CONTROL: the sentence is appended, so it must be absent rather than
    // empty-but-present on the ordinary settle.
    const response = await POST(
      request({
        resolution: "dismissed",
        confirmed: true,
        note: "Member declined it.",
      }),
      { params },
    );
    const body = (await response.json()) as { message: string };
    expect(body.message).toBe("Refund task dismissed.");
  });

  /*
    #3213: the same route, the same resolution, a different item type - and the
    officer must not be told they dismissed a refund when what they did was
    check Xero and bill a shortfall by hand. The route reads the kind off the
    resolved task rather than off the request, so a client that lied about the
    kind cannot change the sentence. Wording itself is pinned in
    `manual-refund-task-closure-wording.test.ts`; what this pins is that the
    route asks at all.
  */
  it("says what a withheld share close actually did, not that a refund was dismissed", async () => {
    mocks.resolveManualRefundTask.mockResolvedValue({
      amountAmended: false,
      settlementRoute: null,
      stripeRefundId: null,
      additionalPaymentIntentId: null,
      recordedNightPriceCount: 0,
      kind: "UNCOLLECTED_EDIT_REVIEW_SHARE",
    });
    const response = await POST(
      request({
        resolution: "dismissed",
        confirmed: true,
        note: "Xero already showed the full amount.",
      }),
      { params },
    );
    const body = (await response.json()) as { message: string };
    expect(body.message).not.toBe("Refund task dismissed.");
    expect(body.message.toLowerCase()).not.toContain("refund");
    expect(body.message).toContain("It moved no money and raised no invoice");
  });
});
