import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * #3956 round 3: the review queue tells the screen whether a zero ceiling on a
 * group joiner's appeal is only a wait for the group cancellation's own refund.
 */
const mocks = vi.hoisted(() => ({
  readSupersededCaptureHeldBack: vi.fn().mockResolvedValue({ byTransaction: new Map(), totalCents: 0 }),
  requireAdmin: vi.fn(),
  findMany: vi.fn(),
  count: vi.fn(),
  paymentFindMany: vi.fn(),
  auditFindMany: vi.fn(async () => []),
  taskFindMany: vi.fn(async () => []),
  organiserCardAppealCeilingFor: vi.fn(),
}));

vi.mock("@/lib/session-guards", () => ({ requireAdmin: mocks.requireAdmin }));

// #4872: the superseded-capture hold-back read; none unless a test says.
vi.mock("@/lib/superseded-capture-hold-back", () => ({
  readSupersededCaptureHeldBack: (...args: unknown[]) => mocks.readSupersededCaptureHeldBack(...args),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    refundRequest: {
      findMany: (...args: unknown[]) => mocks.findMany(...args),
      count: (...args: unknown[]) => mocks.count(...args),
    },
    payment: { findMany: (...args: unknown[]) => mocks.paymentFindMany(...args) },
    auditLog: { findMany: () => mocks.auditFindMany() },
    manualRefundTask: { findMany: () => mocks.taskFindMany() },
  },
}));
vi.mock("@/lib/organiser-child-refund", () => ({
  organiserCardAppealCeilingFor: (...args: unknown[]) => mocks.organiserCardAppealCeilingFor(...args),
}));

import { GET } from "@/app/api/admin/refund-requests/route";

function request(id: string, status = "PENDING") {
  return {
    id,
    status,
    booking: { id: `b-${id}`, payment: { id: `p-${id}`, source: "STRIPE", recoveryOperations: [], refunds: [] } },
  };
}

describe("GET /api/admin/refund-requests, organiser-card appeals (#3956)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({ ok: true });
    mocks.count.mockResolvedValue(3);
    mocks.paymentFindMany.mockResolvedValue([]);
  });

  it("flags an appeal waiting on the group cancellation's refund, rather than showing a bare zero ceiling", async () => {
    mocks.findMany.mockResolvedValue([request("waiting"), request("open"), request("plain"), request("done", "APPROVED")]);
    mocks.organiserCardAppealCeilingFor.mockImplementation(async (_db: unknown, booking: { id: string }) => {
      if (booking.id === "b-waiting") return { ceilingCents: 0, combinedRefundPending: true };
      if (booking.id === "b-open") return { ceilingCents: 4_000, combinedRefundPending: false };
      return null;
    });

    const response = await GET(new NextRequest("http://localhost/api/admin/refund-requests?status=ALL"));
    const { data } = (await response.json()) as { data: Array<{ id: string; booking: Record<string, unknown> }> };
    const byId = Object.fromEntries(data.map((row) => [row.id, row.booking]));

    expect(byId.waiting).toMatchObject({ organiserCardMaxRefundableCents: 0, organiserCardCombinedRefundPending: true });
    expect(byId.open).toMatchObject({ organiserCardMaxRefundableCents: 4_000, organiserCardCombinedRefundPending: false });
    expect(byId.plain).not.toHaveProperty("organiserCardMaxRefundableCents");
    // A decided request is not re-read: no ceiling is offered on it.
    expect(byId.done).not.toHaveProperty("organiserCardCombinedRefundPending");
    expect(mocks.organiserCardAppealCeilingFor).toHaveBeenCalledTimes(3);
  });
});

/**
 * #4117 (`INV-PAY-128`): an approved appeal's card refund still owed - its
 * recovery row's unmade part - so the screen shows what was actually refunded.
 */
describe("GET /api/admin/refund-requests, an approved appeal's card refund still owed (#4117)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({ ok: true });
    mocks.count.mockResolvedValue(1);
    mocks.organiserCardAppealCeilingFor.mockResolvedValue(null);
  });

  it("reads the request's own recovery row: its made slice filled by its refund, the refused one owed", async () => {
    // The approved appeal's payment, as the route's second read selects it.
    mocks.paymentFindMany.mockResolvedValue([
      {
        id: "p-rq-1",
        status: "PARTIALLY_REFUNDED",
        amountCents: 10_000,
        refundedAmountCents: 1_500,
        recoveryOperations: [
          {
            id: "op-1",
            type: "REFUND_BOOKING_MODIFICATION",
            status: "PENDING",
            attempts: 0,
            nextRetryAt: new Date("2026-06-20T00:10:00.000Z"),
            idempotencyKey: "refund_request_refund_rq-1",
            amountCents: 2_500,
            allocationPlan: [
              { paymentTransactionId: "txn-new", amountCents: 1_500, madeRefundId: "re_made" },
              { paymentTransactionId: "txn-old", amountCents: 1_000, stripeKeySuffix: "refused1" },
            ],
            paymentTransactionId: null,
            createdAt: new Date("2026-06-20T00:00:05.000Z"),
            succeededAt: null,
          },
        ],
        refunds: [
          { stripeRefundId: "re_made", paymentTransactionId: "txn-new", amountCents: 1_500, status: "succeeded", createdAt: new Date("2026-06-20T00:00:01.000Z"), stripeCreatedAt: new Date("2026-06-20T00:00:01.000Z") },
        ],
      },
    ]);
    const approved = request("rq-1", "APPROVED");
    mocks.findMany.mockResolvedValue([approved, request("rq-other", "APPROVED")]);

    const response = await GET(new NextRequest("http://localhost/api/admin/refund-requests?status=APPROVED"));
    const { data } = (await response.json()) as { data: Array<{ id: string; cardRefundOwedCents: number; cardRefundState: string }> };
    const byId = Object.fromEntries(data.map((row) => [row.id, row]));

    expect(byId["rq-1"]).toMatchObject({ cardRefundOwedCents: 1_000, cardRefundState: "retrying" });
    expect(byId["rq-other"]).toMatchObject({ cardRefundOwedCents: 0, cardRefundState: "made" });
    // One read of the approved appeals' payments, none for a pending one.
    expect(mocks.paymentFindMany).toHaveBeenCalledTimes(1);
    expect(mocks.paymentFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: ["p-rq-1", "p-rq-other"] } } }));
  });
});

describe("GET /api/admin/refund-requests, a pending appeal's ceiling (#4124)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({ ok: true });
    mocks.count.mockResolvedValue(1);
    mocks.organiserCardAppealCeilingFor.mockResolvedValue(null);
  });

  it("nets a card refund still owed on the payment, and sends the figure, never the rows", async () => {
    const pending = {
      id: "rq-1",
      status: "PENDING",
      booking: {
        id: "b-rq-1",
        creditsFromCancellation: [],
        payment: {
          id: "p-rq-1",
          source: "STRIPE",
          status: "PARTIALLY_REFUNDED",
          amountCents: 10_000,
          refundedAmountCents: 0,
          manualRefundTasks: [{ amountCents: 500 }],
          recoveryOperations: [
            {
              id: "op-refused",
              type: "REFUND_BOOKING_MODIFICATION",
              status: "FAILED",
              idempotencyKey: "refund_request_refund_rq-0",
              amountCents: 2_500,
              allocationPlan: [{ paymentTransactionId: "txn-1", amountCents: 2_500, stripeKeySuffix: "refused1" }],
              paymentTransactionId: null,
              createdAt: new Date("2026-06-20T00:00:00.000Z"),
              succeededAt: null,
            },
          ],
          refunds: [],
        },
      },
    };
    mocks.findMany.mockResolvedValue([pending]);

    const response = await GET(new NextRequest("http://localhost/api/admin/refund-requests?status=PENDING"));
    const { data } = (await response.json()) as {
      data: Array<{ booking: { appealCeilingCents: number; appealCardRefundOwedCents: number; payment: Record<string, unknown> } }>;
    };

    // $100 less a $5 open hand-back and the $25 card refund still owed.
    expect(data[0].booking.appealCeilingCents).toBe(7_000);
    // #4124 review: the card refund it netted, for the screen's "Less ..." line.
    expect(data[0].booking.appealCardRefundOwedCents).toBe(2_500);
    expect(data[0].booking.payment).not.toHaveProperty("recoveryOperations");
    expect(data[0].booking.payment).not.toHaveProperty("refunds");
    expect(data[0].booking.payment).not.toHaveProperty("manualRefundTasks");
    expect(data[0].booking.payment).toMatchObject({ id: "p-rq-1", amountCents: 10_000, refundedAmountCents: 0 });
  });

  it("nets a live superseded capture's hold-back, as the approval does (#4872)", async () => {
    mocks.findMany.mockResolvedValue([{
      id: "rq-held",
      status: "PENDING",
      booking: {
        id: "b-rq-held",
        creditsFromCancellation: [],
        payment: { id: "p-rq-held", source: "STRIPE", status: "SUCCEEDED", amountCents: 20_000, refundedAmountCents: 0, manualRefundTasks: [], recoveryOperations: [], refunds: [] },
      },
    }]);
    mocks.readSupersededCaptureHeldBack.mockResolvedValueOnce({ byTransaction: new Map([["txn-superseded", 6_500]]), totalCents: 6_500 });

    const response = await GET(new NextRequest("http://localhost/api/admin/refund-requests?status=PENDING"));
    const { data } = (await response.json()) as { data: Array<{ booking: { appealCeilingCents: number; appealCardRefundOwedCents: number } }> };

    expect(mocks.readSupersededCaptureHeldBack).toHaveBeenCalledWith(expect.anything(), "p-rq-held");
    // $200 captured, $65 of it a superseded capture its own refund still owns.
    expect(data[0].booking.appealCeilingCents).toBe(13_500);
    expect(data[0].booking.appealCardRefundOwedCents).toBe(0);
  });
});
