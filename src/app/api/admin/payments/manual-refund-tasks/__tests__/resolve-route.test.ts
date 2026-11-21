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
 * #4344 (wave C1 of #4302): an officer edit review is refused at 409 before
 * the body is read, so a stale settle screen writes nothing and reaches no
 * provider, while every other kind still resolves.
 */

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  resolveManualRefundTask: vi.fn(),
  taskFindUnique: vi.fn(),
  prepareBankRefundVoidAnswer: vi.fn(),
}));

vi.mock("@/lib/session-guards", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock("@/lib/prisma", () => ({
  prisma: { manualRefundTask: { findUnique: mocks.taskFindUnique } },
}));
// The one provider read this route can make before the resolution: Xero, for a
// re-confirmed bank refund's "already in Xero" answer.
vi.mock("@/lib/bank-refund-void-answer", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/bank-refund-void-answer")),
  prepareBankRefundVoidAnswer: mocks.prepareBankRefundVoidAnswer,
}));
vi.mock("@/lib/manual-refund-task-resolution", () => ({
  resolveManualRefundTask: mocks.resolveManualRefundTask,
  MANUAL_PAYMENT_NOTE_MAX: 500,
}));
vi.mock("@/lib/manual-booking-payment-error", () => ({
  ManualBookingPaymentError: class ManualBookingPaymentError extends Error {
    status: number;
    constructor(message: string, status = 400) {
      super(message);
      this.name = "ManualBookingPaymentError";
      this.status = status;
    }
  },
}));

import { revalidatePath } from "next/cache";
import { expectRevalidatesPageFile } from "@/lib/__tests__/support/revalidated-page";
import { POST } from "../[id]/route";
import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";

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
  mocks.taskFindUnique.mockResolvedValue({ kind: "CANCELLED_BOOKING_HAND_BACK" });
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
      CLUB_FORMAT_TEST,
    );
    // #3635: the booking detail page is refreshed - the pattern must name its
    // file, route group included, or it refreshes nothing.
    expectRevalidatesPageFile(
      vi.mocked(revalidatePath),
      "src/app/(authenticated)/bookings/[id]/page.tsx",
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

describe("a retired officer edit review is refused before anything happens (#4344)", () => {
  /** What a settle screen from before the retirement still posts. */
  const staleReviewSettle = {
    resolution: "completed",
    confirmed: true,
    note: "Priced from the evidence.",
    confirmedAmountCents: 4_500,
    direction: "REFUND_TO_MEMBER",
    recordedNightPrices: [
      { strandIndex: 0, nightPrices: [{ date: "2026-08-02", priceCents: 1_500 }] },
    ],
    bankRefundVoidAnswer: { answer: "recorded-in-xero", creditNoteNumber: "CN-1" },
  };

  beforeEach(() => {
    mocks.taskFindUnique.mockResolvedValue({ kind: "EDIT_FINANCIAL_REVIEW" });
  });

  it("answers 409 in words, and resolves nothing and reads no provider", async () => {
    const response = await POST(request(staleReviewSettle), { params });

    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toMatch(
      /Officer edit reviews were retired/,
    );
    expect(mocks.taskFindUnique).toHaveBeenCalledWith({
      where: { id: "task-1" },
      select: { kind: true },
    });
    expect(mocks.resolveManualRefundTask).not.toHaveBeenCalled();
    expect(mocks.prepareBankRefundVoidAnswer).not.toHaveBeenCalled();
    expect(vi.mocked(revalidatePath)).not.toHaveBeenCalled();
  });

  it("refuses a dismissal the same way", async () => {
    const response = await POST(
      request({ resolution: "dismissed", confirmed: true, note: "Nothing owed." }),
      { params },
    );

    expect(response.status).toBe(409);
    expect(mocks.resolveManualRefundTask).not.toHaveBeenCalled();
  });

  it("checks permission first: a caller without finance:edit meets the guard, not the refusal", async () => {
    mocks.requireAdmin.mockResolvedValueOnce({
      ok: false,
      response: new Response(null, { status: 403 }),
    });

    const response = await POST(request(staleReviewSettle), { params });

    expect(response.status).toBe(403);
    expect(mocks.taskFindUnique).not.toHaveBeenCalled();
  });

  it("CONTROL: every other kind still resolves, and a missing task still reaches the door", async () => {
    mocks.taskFindUnique.mockResolvedValueOnce({ kind: "CANCELLED_BOOKING_HAND_BACK" });
    const handBack = await POST(
      request({ resolution: "completed", confirmed: true, note: null }),
      { params },
    );
    expect(handBack.status).toBe(200);

    // The resolution answers an unknown id as it always has; this route does
    // not guess at it.
    mocks.taskFindUnique.mockResolvedValueOnce(null);
    await POST(request({ resolution: "dismissed", confirmed: true, note: "Gone." }), {
      params,
    });

    expect(mocks.resolveManualRefundTask).toHaveBeenCalledTimes(2);
    expect(mocks.resolveManualRefundTask).toHaveBeenLastCalledWith(
      expect.objectContaining({ resolution: "dismissed", recordedNightPrices: null }),
      CLUB_FORMAT_TEST,
    );
  });

  it("no longer accepts per-night prices on any other kind's body", async () => {
    mocks.taskFindUnique.mockResolvedValue({ kind: "CANCELLED_BOOKING_HAND_BACK" });
    const response = await POST(
      request({
        resolution: "dismissed",
        confirmed: true,
        note: "Nothing owed.",
        recordedNightPrices: staleReviewSettle.recordedNightPrices,
      }),
      { params },
    );

    expect(response.status).toBe(400);
    expect(mocks.resolveManualRefundTask).not.toHaveBeenCalled();
  });
});

describe("what the operator is told afterwards", () => {
  it("tells a dismissal it was a dismissal", async () => {
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

describe("the officer's cash-or-bank answer on a hand-settled refund (#3536)", () => {
  const completion = {
    resolution: "completed",
    confirmed: true,
    note: "Handed back at the lodge.",
    confirmedAmountCents: 7_300,
    direction: "REFUND_TO_MEMBER",
  };

  it("passes the answer through, and null when none was given", async () => {
    await POST(request({ ...completion, handedBackInCash: true }), { params });
    expect(mocks.resolveManualRefundTask).toHaveBeenLastCalledWith(
      expect.objectContaining({ handedBackInCash: true }),
      CLUB_FORMAT_TEST,
    );
    await POST(request(completion), { params });
    expect(mocks.resolveManualRefundTask).toHaveBeenLastCalledWith(
      expect.objectContaining({ handedBackInCash: null }),
      CLUB_FORMAT_TEST,
    );
  });

  it("refuses it on a dismissal, which hands nothing back", async () => {
    const response = await POST(
      request({ resolution: "dismissed", confirmed: true, note: "Nothing owed.", handedBackInCash: true }),
      { params },
    );
    expect(response.status).toBe(400);
    expect(mocks.resolveManualRefundTask).not.toHaveBeenCalled();
  });
});

// #4042 (`INV-PAY-124`): a group organiser's hand-back completion that does not
// say the total it was shown reaches the door as null, and the door's refusal
// is what the officer reads.
describe("a group organiser's hand-back marked paid back without the total it was shown", () => {
  it("passes no amount through as null, and answers with the door's 409 and its sentence", async () => {
    const { ManualBookingPaymentError } = await import("@/lib/manual-booking-payment-error");
    const refusal = "This repayment's total grows as each joiner's place is cancelled, so it is marked paid back at the total the screen shows. Refresh the page and try again.";
    mocks.resolveManualRefundTask.mockRejectedValueOnce(new ManualBookingPaymentError(refusal, 409));

    const response = await POST(request({ resolution: "completed", confirmed: true, note: null }), { params });

    expect(mocks.resolveManualRefundTask).toHaveBeenLastCalledWith(
      expect.objectContaining({ resolution: "completed", confirmedAmountCents: null }),
      CLUB_FORMAT_TEST,
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: refusal });
  });
});
