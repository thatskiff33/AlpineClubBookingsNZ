/**
 * #3954 decision A (owner, 9 Oct 2026, "Raise a $30 invoice"): once a price
 * reduction's smaller re-issued ask is minted, its own supplementary invoice is
 * queued on the reducing edit, waiting on that intent and recording the
 * payment when it is captured - for the figure the reduction recorded.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  newData: null as unknown,
  enqueue: vi.fn(async (...args: unknown[]) => { void args; return { queueOperationId: "op_1", outcome: "covers-total" }; }),
  error: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: { bookingModification: { findUnique: vi.fn(async () => ({ newData: h.newData })) } },
}));
vi.mock("@/lib/xero-operation-outbox", () => ({ enqueueXeroSupplementaryInvoiceOperation: h.enqueue }));
vi.mock("@/lib/logger", () => ({ default: { error: h.error, warn: vi.fn(), info: vi.fn() } }));

const { queueReissuedAskSupplementaryInvoice } = await import("@/lib/reissued-ask-invoice");
const { unpaidAskOffsetHistory } = await import("@/lib/unpaid-ask-offset-marker");

const CALL = { bookingId: "booking_1", bookingModificationId: "mod_reduction", paymentIntentId: "pi_reissued" };

beforeEach(() => vi.clearAllMocks());

describe("queueReissuedAskSupplementaryInvoice", () => {
  it("MUTATION: queues the recorded figure on the reducing edit, waiting on the minted intent and recording its payment", async () => {
    h.newData = unpaidAskOffsetHistory({
      unpaidAskOffsetCents: 2_000,
      retiredAskModificationIds: ["mod_increase"],
      reissuedAskInvoiceCents: 3_000,
      unpaidAskBilledOffsetCents: 0,
    });
    await queueReissuedAskSupplementaryInvoice(CALL);

    expect(h.enqueue).toHaveBeenCalledWith(
      { bookingId: "booking_1", priceDiffCents: 3_000, changeFeeCents: 0, bookingModificationId: "mod_reduction" },
      { paymentIntentId: "pi_reissued", waitForConfirmedAdditionalPayment: true, recordPayment: true },
    );
  });

  it("queues nothing where the reduction recorded no invoice (the ask was cancelled, or Xero already billed it)", async () => {
    h.newData = unpaidAskOffsetHistory({
      unpaidAskOffsetCents: 5_000,
      retiredAskModificationIds: ["mod_increase"],
      reissuedAskInvoiceCents: 0,
      unpaidAskBilledOffsetCents: 0,
    });
    await queueReissuedAskSupplementaryInvoice(CALL);
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it("logs a failure for the repair pass rather than failing the mint", async () => {
    h.newData = { reissuedAskInvoiceCents: 3_000 };
    h.enqueue.mockRejectedValueOnce(new Error("database is down"));
    await expect(queueReissuedAskSupplementaryInvoice(CALL)).resolves.toBeUndefined();
    expect(h.error).toHaveBeenCalledTimes(1);
  });
});
