import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #4287 (`INV-ADDPAY-043`): when a cancellation hand-back's Xero note stands on
 * its own task rather than being the payment's canonical note. The
 * real-PostgreSQL proofs (`xero-bt-per-refund-notes`) drive it through the
 * completion; this pins each clause of the rule.
 */
const canonical = vi.hoisted(() => ({ link: null as null | { xeroObjectId: string } }));
vi.mock("@/lib/xero-sync", () => ({ findCanonicalPaymentRefundCreditNote: vi.fn(async () => canonical.link) }));

import { cancellationHandBackNotedOnItsOwnRecord } from "@/lib/bank-hand-back-refund-note";

const TASK = "task-new";

function store(options: { source?: string; cardCharges?: number; cardRefunds?: number; rows?: unknown[] } = {}) {
  const findMany = vi.fn(async () => (options.rows ?? []).map((requestPayload) => ({ requestPayload })));
  return {
    db: {
      payment: { findUnique: vi.fn(async () => ({ source: options.source ?? "INTERNET_BANKING" })) },
      paymentTransaction: { count: vi.fn(async () => options.cardCharges ?? 0) },
      paymentRefund: { count: vi.fn(async () => options.cardRefunds ?? 0) },
      xeroSyncOperation: { findMany },
    } as never,
    findMany,
  };
}

const queued = (extra: Record<string, unknown>) => ({ queueType: "REFUND_CREDIT_NOTE", refundAmountCents: 1_000, watermarkCents: 1_000, ...extra });

describe("whether a cancellation hand-back's note stands on its own record (#4287, INV-ADDPAY-043)", () => {
  beforeEach(() => {
    canonical.link = null;
  });

  it("CONTROL: the payment's first refund, with nothing else on it, takes the canonical note", async () => {
    await expect(cancellationHandBackNotedOnItsOwnRecord(store().db, "payment-1", TASK)).resolves.toBe(false);
  });

  it("MUTATION: the payment already has its canonical note linked", async () => {
    canonical.link = { xeroObjectId: "cn-1" };
    await expect(cancellationHandBackNotedOnItsOwnRecord(store().db, "payment-1", TASK)).resolves.toBe(true);
  });

  it("MUTATION (review F7): only a bank-transfer payment - a card payment's note is left exactly as before", async () => {
    canonical.link = { xeroObjectId: "cn-1" };
    await expect(cancellationHandBackNotedOnItsOwnRecord(store({ source: "STRIPE", cardCharges: 1, cardRefunds: 1 }).db, "payment-1", TASK)).resolves.toBe(false);
  });

  it("MUTATION (review F2): the payment holds a card charge, even before any card refund lands", async () => {
    await expect(cancellationHandBackNotedOnItsOwnRecord(store({ cardCharges: 1 }).db, "payment-1", TASK)).resolves.toBe(true);
  });

  it("MUTATION: the payment has card refund rows (an organiser child's refund names no charge row)", async () => {
    await expect(cancellationHandBackNotedOnItsOwnRecord(store({ cardRefunds: 1 }).db, "payment-1", TASK)).resolves.toBe(true);
  });

  it("MUTATION: another refund's canonical note is on its way - queued, running or failed, in either payload shape", async () => {
    const { db, findMany } = store({ rows: [queued({ handBackTaskId: "task-first" })] });
    await expect(cancellationHandBackNotedOnItsOwnRecord(db, "payment-1", TASK)).resolves.toBe(true);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ status: { in: ["PENDING", "RUNNING", "FAILED"] } }) }));
    const executed = { allocation: { invoiceId: "inv-1", amount: 10 }, watermarkCents: 1_000 };
    await expect(cancellationHandBackNotedOnItsOwnRecord(store({ rows: [executed] }).db, "payment-1", TASK)).resolves.toBe(true);
  });

  it("MUTATION (review F3): a row whose payload cannot be read counts as on its way", async () => {
    await expect(cancellationHandBackNotedOnItsOwnRecord(store({ rows: [{ queueType: "REFUND_CREDIT_NOTE" }] }).db, "payment-1", TASK)).resolves.toBe(true);
    await expect(cancellationHandBackNotedOnItsOwnRecord(store({ rows: [null] }).db, "payment-1", TASK)).resolves.toBe(true);
  });

  it("rows that are no canonical note leave it canonical: its own, a per-record note, a review's, a request's, a per-refund one, a readable account-credit note", async () => {
    const rows = [
      queued({ handBackTaskId: TASK }),
      queued({ paidAnotherWayTaskId: "close-1" }),
      queued({ reviewTaskId: "review-1" }),
      queued({ refundRequestId: "request-1" }),
      queued({ perDelta: true }),
      { queueType: "ACCOUNT_CREDIT_NOTE", refundAmountCents: 1_000 },
    ];
    await expect(cancellationHandBackNotedOnItsOwnRecord(store({ rows }).db, "payment-1", TASK)).resolves.toBe(false);
  });
});
