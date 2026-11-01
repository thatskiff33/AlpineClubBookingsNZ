/**
 * #3954 decision A (owner, 9 Oct 2026, "Raise a $30 invoice"): once a price
 * reduction's smaller re-issued ask is minted, its own supplementary invoice is
 * queued on the reducing edit, waiting on that intent and recording the
 * payment when it is captured - for the figure the reduction recorded.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Txn = { status: string; withdrawnAt: Date | null; reason?: string | null; recoveryOperations?: { id: string }[] };
const h = vi.hoisted(() => ({
  newData: null as unknown,
  byId: null as null | Record<string, unknown>,
  // Round 7: the minted intent's own row, re-read before anything is queued.
  txn: { status: "PENDING", withdrawnAt: null } as null | Txn,
  enqueue: vi.fn(async (...args: unknown[]) => { void args; return { queueOperationId: "op_1", outcome: "covers-total" }; }),
  error: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    // #4052: a row as the liveness re-read selects it - its retirement evidence included.
    paymentTransaction: { findUnique: vi.fn(async () => (h.txn ? { reason: null, recoveryOperations: [], ...h.txn } : null)) },
    bookingModification: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => ({
        newData: h.byId ? h.byId[where.id] : h.newData,
      })),
    },
  },
}));
vi.mock("@/lib/xero-operation-outbox", () => ({ enqueueXeroSupplementaryInvoiceOperation: h.enqueue }));
vi.mock("@/lib/logger", () => ({ default: { error: h.error, warn: vi.fn(), info: vi.fn() } }));

const { queueFoldedReissuedAskInvoices, queueReissuedAskSupplementaryInvoice } = await import("@/lib/reissued-ask-invoice");
const { NO_FOLDED_REISSUED_ASKS, NO_UNPAID_ASK_SETTLEMENT, unpaidAskOffsetHistory } = await import("@/lib/unpaid-ask-offset-marker");

const CALL = { bookingId: "booking_1", bookingModificationId: "mod_reduction", paymentIntentId: "pi_reissued" };

beforeEach(() => {
  vi.clearAllMocks();
  h.byId = null;
  h.txn = { status: "PENDING", withdrawnAt: null };
});

describe("queueReissuedAskSupplementaryInvoice", () => {
  it("MUTATION: queues the recorded figure on the reducing edit, waiting on the minted intent and recording its payment", async () => {
    h.newData = unpaidAskOffsetHistory({
      ...NO_UNPAID_ASK_SETTLEMENT,
      unpaidAskOffsetCents: 2_000,
      retiredAskModificationIds: ["mod_increase"],
      reissuedAskInvoiceCents: 3_000,
      reissuedAskInvoiceUnsureCents: 0,
      unpaidAskBilledOffsetCents: 0,
      unpaidAskBilledOffsetUnsureCents: 0,
      foldedReissuedAsks: NO_FOLDED_REISSUED_ASKS,
    });
    expect(await queueReissuedAskSupplementaryInvoice(CALL)).toBe(true);

    expect(h.enqueue).toHaveBeenCalledWith(
      { bookingId: "booking_1", priceDiffCents: 3_000, changeFeeCents: 0, bookingModificationId: "mod_reduction" },
      { paymentIntentId: "pi_reissued", waitForConfirmedAdditionalPayment: true, recordPayment: true },
    );
  });

  it("queues nothing where the reduction recorded no invoice (the ask was cancelled, or Xero already billed it)", async () => {
    h.newData = unpaidAskOffsetHistory({
      ...NO_UNPAID_ASK_SETTLEMENT,
      unpaidAskOffsetCents: 5_000,
      retiredAskModificationIds: ["mod_increase"],
      reissuedAskInvoiceCents: 0,
      reissuedAskInvoiceUnsureCents: 0,
      unpaidAskBilledOffsetCents: 0,
      unpaidAskBilledOffsetUnsureCents: 0,
      foldedReissuedAsks: NO_FOLDED_REISSUED_ASKS,
    });
    await queueReissuedAskSupplementaryInvoice(CALL);
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it("logs a failure for the repair pass rather than failing the mint", async () => {
    h.newData = { reissuedAskInvoiceCents: 3_000 };
    h.enqueue.mockRejectedValueOnce(new Error("database is down"));
    await expect(queueReissuedAskSupplementaryInvoice(CALL)).resolves.toBe(true);
    expect(h.error).toHaveBeenCalledTimes(1);
  });

  it.each<[string, Txn]>([
    ["withdrawn by a later reduction", { status: "FAILED", withdrawnAt: new Date("2026-07-01T00:00:00.000Z") }],
    // #4052: a supersede or a booking's end fails the row and queues its Stripe cancellation.
    ["superseded, its cancellation queued", { status: "FAILED", withdrawnAt: null, recoveryOperations: [{ id: "op_cancel" }] }],
    ["superseded by the cancel processor's older stamp", { status: "FAILED", withdrawnAt: null, reason: "zero_dollar_batch_modification_superseded" }],
  ])("MUTATION (round 7): a minted intent %s queues nothing and offers no secret", async (_label, txn) => {
    h.newData = { reissuedAskInvoiceCents: 3_000 };
    h.txn = txn;
    expect(await queueReissuedAskSupplementaryInvoice(CALL)).toBe(false);
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  // Round 8 (F4): only a RETIRED row is not live. The recovery path reaches
  // here after the member may already have paid; that invoice is owed.
  it.each<[string, Txn | null]>([
    ["already paid", { status: "SUCCEEDED", withdrawnAt: null }],
    ["being paid", { status: "PROCESSING", withdrawnAt: null }],
    ["not found", null],
    // #4052: a declined card marks the row FAILED and nothing more; the member can pay it with another card.
    ["declined (FAILED, nothing retired it)", { status: "FAILED", withdrawnAt: null, reason: "guest_removal_price_increase" }],
  ])("MUTATION (round 8): a minted intent %s is live, and its invoice is queued", async (_label, txn) => {
    h.newData = { reissuedAskInvoiceCents: 3_000 };
    h.txn = txn;
    expect(await queueReissuedAskSupplementaryInvoice(CALL)).toBe(true);
    expect(h.enqueue).toHaveBeenCalledTimes(1);
  });

  it("#4052: the retirement evidence it reads is a queued Stripe cancellation of THAT row, not any recovery", async () => {
    h.newData = { reissuedAskInvoiceCents: 3_000 };
    await queueReissuedAskSupplementaryInvoice(CALL);
    const { prisma } = await import("@/lib/prisma");
    expect(vi.mocked(prisma.paymentTransaction.findUnique)).toHaveBeenCalledWith({
      where: { stripePaymentIntentId: "pi_reissued" },
      select: expect.objectContaining({
        withdrawnAt: true,
        reason: true,
        recoveryOperations: { where: { type: "CANCEL_PAYMENT_INTENT" }, select: { id: true }, take: 1 },
      }),
    });
  });

  it("round 8: a re-read that fails is read as live, so the invoice is still queued", async () => {
    h.newData = { reissuedAskInvoiceCents: 3_000 };
    const { prisma } = await import("@/lib/prisma");
    vi.mocked(prisma.paymentTransaction.findUnique).mockRejectedValueOnce(new Error("database is down"));
    expect(await queueReissuedAskSupplementaryInvoice(CALL)).toBe(true);
    expect(h.enqueue).toHaveBeenCalledTimes(1);
  });
});

describe("queueFoldedReissuedAskInvoices (#3954 round 6)", () => {
  it("MUTATION: queues each folded reduction's own invoice, anchored on that reduction and waiting on the INCREASE's intent", async () => {
    h.byId = {
      mod_increase: unpaidAskOffsetHistory({
        ...NO_UNPAID_ASK_SETTLEMENT,
        foldedReissuedAsks: { cents: 3_000, modificationIds: ["mod_reduction"], invoiceCents: 1_000 },
      }),
      mod_reduction: { reissuedAskInvoiceCents: 1_000 },
    };
    await queueFoldedReissuedAskInvoices({ bookingId: "booking_1", increaseModificationId: "mod_increase", paymentIntentId: "pi_increase" });

    expect(h.enqueue).toHaveBeenCalledTimes(1);
    expect(h.enqueue).toHaveBeenCalledWith(
      { bookingId: "booking_1", priceDiffCents: 1_000, changeFeeCents: 0, bookingModificationId: "mod_reduction" },
      { paymentIntentId: "pi_increase", waitForConfirmedAdditionalPayment: true, recordPayment: true },
    );
  });

  it("MUTATION (round 7): an increase's intent a reduction retired meanwhile queues no folded invoice and offers no secret", async () => {
    h.byId = { mod_increase: { foldedReissuedAskModificationIds: ["mod_reduction"], foldedReissuedAskCents: 3_000 }, mod_reduction: { reissuedAskInvoiceCents: 1_000 } };
    h.txn = { status: "FAILED", withdrawnAt: new Date("2026-07-01T00:00:00.000Z") };
    expect(await queueFoldedReissuedAskInvoices({ bookingId: "booking_1", increaseModificationId: "mod_increase", paymentIntentId: "pi_increase" })).toBe(false);
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it("queues nothing for an increase that folded nothing in", async () => {
    h.byId = { mod_increase: {} };
    await queueFoldedReissuedAskInvoices({ bookingId: "booking_1", increaseModificationId: "mod_increase", paymentIntentId: "pi_increase" });
    expect(h.enqueue).not.toHaveBeenCalled();
  });
});
