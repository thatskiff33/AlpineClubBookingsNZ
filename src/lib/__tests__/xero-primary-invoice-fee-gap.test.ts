import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  payment: { findUnique: vi.fn() },
  bookingModification: { findMany: vi.fn() },
  xeroSyncOperation: { findUnique: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
  xeroObjectLink: { findFirst: vi.fn() },
  enqueue: vi.fn(),
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    payment: mocks.payment,
    bookingModification: mocks.bookingModification,
    xeroSyncOperation: mocks.xeroSyncOperation,
    xeroObjectLink: mocks.xeroObjectLink,
  },
}));
vi.mock("@/lib/xero-operation-outbox", () => ({ enqueueXeroSupplementaryInvoiceOperation: mocks.enqueue }));
vi.mock("@/lib/logger", () => ({ default: mocks.logger }));

import { CHANGE_FEE_LINE_DESCRIPTION } from "@/lib/xero-modification-line-items";
import {
  billedChangeFeeCents,
  primaryInvoiceBilledFee,
  queuePrimaryInvoiceChangeFeeGap,
  recheckPrimaryInvoiceChangeFeeGap,
  recordPrimaryInvoiceBilledFee,
} from "@/lib/xero-primary-invoice-fee-gap";

const guestLine = { description: "Jordan - (ADULT, Member) - 2 nights", quantity: 1, unitAmount: 200 };
const feeLine = (dollars: number) => ({ description: CHANGE_FEE_LINE_DESCRIPTION, quantity: 1, unitAmount: dollars });

const unpaid = { changeFeeCents: 6_500, source: "STRIPE", status: "PENDING", amountCents: 0, refundedAmountCents: 0 };

/**
 * #3955 review X4: a primary invoice built before a fee was recorded (an edit
 * committed mid-create, or a lost response replayed under the same key) bills
 * less fee than the payment records; the remainder goes on a supplementary
 * invoice anchored on a finished-stay correction that routed its fee to the
 * primary invoice, never dropped, never billed twice, never on another edit's
 * queued invoice — and a retry re-runs the check.
 */
describe("the primary invoice's change-fee gap (#3955 X4)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.payment.findUnique.mockResolvedValue(unpaid);
    mocks.bookingModification.findMany.mockResolvedValue([{ id: "mod_late" }, { id: "mod_early" }]);
    mocks.xeroSyncOperation.findFirst.mockResolvedValue(null);
    mocks.xeroObjectLink.findFirst.mockResolvedValue(null);
    mocks.enqueue.mockResolvedValue({ queueOperationId: "op_gap", outcome: "covers-total" });
  });

  it("reads only the change-fee lines, as Xero adds them", () => {
    expect(billedChangeFeeCents([guestLine, feeLine(12.5), feeLine(7.5)])).toBe(2_000);
    expect(billedChangeFeeCents([guestLine])).toBe(0);
    expect(primaryInvoiceBilledFee("inv_1", [guestLine, feeLine(25)])).toEqual({
      xeroInvoiceId: "inv_1",
      billedChangeFeeCents: 2_500,
      billedTotalCents: 22_500,
    });
  });

  it("does nothing when the invoice bills the recorded fee", async () => {
    mocks.payment.findUnique.mockResolvedValue({ ...unpaid, changeFeeCents: 2_500 });
    await expect(
      queuePrimaryInvoiceChangeFeeGap({
        bookingId: "booking_1",
        billed: primaryInvoiceBilledFee("inv_1", [guestLine, feeLine(25)]),
      }),
    ).resolves.toMatchObject({ gapCents: 0, queueOperationId: null });
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("bills the gap UNPAID on the latest correction that routed its fee to the primary invoice", async () => {
    await expect(
      queuePrimaryInvoiceChangeFeeGap({
        bookingId: "booking_1",
        // The invoice Xero returned was built before the 40.00 fee was recorded.
        billed: primaryInvoiceBilledFee("inv_1", [guestLine, feeLine(25)]),
        createdByMemberId: "officer_1",
      }),
    ).resolves.toEqual({ gapCents: 4_000, queueOperationId: "op_gap", alreadyQueued: false });
    expect(mocks.bookingModification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          bookingId: "booking_1",
          changeFeeCents: { gt: 0 },
          newData: { path: ["finishedStayCorrection", "feeOnPrimaryInvoice"], equals: true },
        },
        orderBy: { createdAt: "desc" },
      }),
    );
    // Round 3, finding 1: never the enqueue's paid-by-Stripe default.
    expect(mocks.enqueue).toHaveBeenCalledWith(
      { bookingId: "booking_1", priceDiffCents: 0, changeFeeCents: 4_000, bookingModificationId: "mod_late" },
      { createdByMemberId: "officer_1", recordPayment: false },
    );
    expect(mocks.logger.error).not.toHaveBeenCalled();
  });

  it("records a payment only when a captured Stripe payment nets the fee beyond the primary invoice", async () => {
    const billed = primaryInvoiceBilledFee("inv_1", [guestLine, feeLine(25)]); // total 22,500
    // Captured exactly the primary's total: nothing left over for the gap.
    mocks.payment.findUnique.mockResolvedValue({ ...unpaid, status: "SUCCEEDED", amountCents: 22_500 });
    await queuePrimaryInvoiceChangeFeeGap({ bookingId: "booking_1", billed });
    expect(mocks.enqueue).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ recordPayment: false }));

    // Captured the primary's total plus the 40.00 gap.
    mocks.payment.findUnique.mockResolvedValue({ ...unpaid, status: "SUCCEEDED", amountCents: 26_500 });
    await queuePrimaryInvoiceChangeFeeGap({ bookingId: "booking_1", billed });
    expect(mocks.enqueue).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ recordPayment: true }));

    // The same cash by internet banking is never recorded as a Stripe payment.
    mocks.payment.findUnique.mockResolvedValue({
      ...unpaid,
      source: "INTERNET_BANKING",
      status: "SUCCEEDED",
      amountCents: 26_500,
    });
    await queuePrimaryInvoiceChangeFeeGap({ bookingId: "booking_1", billed });
    expect(mocks.enqueue).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ recordPayment: false }));
  });

  it("never queues the gap twice, and never raises an anchor's queued invoice", async () => {
    mocks.xeroSyncOperation.findFirst.mockResolvedValue({ id: "op_earlier" });
    await expect(
      queuePrimaryInvoiceChangeFeeGap({
        bookingId: "booking_1",
        billed: primaryInvoiceBilledFee("inv_1", [guestLine, feeLine(25)]),
      }),
    ).resolves.toEqual({ gapCents: 4_000, queueOperationId: "op_earlier", alreadyQueued: true });
    expect(mocks.xeroSyncOperation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          localModel: "BookingModification",
          localId: { in: ["mod_late", "mod_early"] },
        }),
      }),
    );

    mocks.xeroSyncOperation.findFirst.mockResolvedValue(null);
    mocks.xeroObjectLink.findFirst.mockResolvedValue({ id: "link_sent" });
    await queuePrimaryInvoiceChangeFeeGap({
      bookingId: "booking_1",
      billed: primaryInvoiceBilledFee("inv_1", [guestLine, feeLine(25)]),
    });
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("is loud when no correction explains the gap, or the enqueue did not queue a fresh invoice", async () => {
    mocks.bookingModification.findMany.mockResolvedValueOnce([]);
    await queuePrimaryInvoiceChangeFeeGap({
      bookingId: "booking_1",
      billed: primaryInvoiceBilledFee("inv_1", [guestLine]),
    });
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.logger.error).toHaveBeenCalledTimes(1);

    for (const outcome of ["none", "short-sent", "short-in-flight"]) {
      mocks.logger.error.mockClear();
      mocks.enqueue.mockResolvedValueOnce({ queueOperationId: null, outcome });
      await queuePrimaryInvoiceChangeFeeGap({
        bookingId: "booking_1",
        billed: primaryInvoiceBilledFee("inv_1", [guestLine]),
      });
      expect(mocks.logger.error, outcome).toHaveBeenCalledTimes(1);
    }
  });

  it("is loud, and raises nothing, when the invoice bills more fee than is recorded", async () => {
    mocks.payment.findUnique.mockResolvedValue({ ...unpaid, changeFeeCents: 2_500 });
    await queuePrimaryInvoiceChangeFeeGap({
      bookingId: "booking_1",
      billed: primaryInvoiceBilledFee("inv_1", [feeLine(30)]),
    });
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.logger.error).toHaveBeenCalled();
  });

  it("round 3, finding 2: a check that throws after the link is persisted is billed by the retry", async () => {
    // The operation's payload, as the database would hold it.
    let storedPayload: unknown = { invoices: [] };
    mocks.xeroSyncOperation.findUnique.mockImplementation(async () => ({ requestPayload: storedPayload }));
    mocks.xeroSyncOperation.update.mockImplementation(async ({ data }: { data: { requestPayload: unknown } }) => {
      storedPayload = data.requestPayload;
      return {};
    });

    // The create: records what the invoice billed, persists its link, then the
    // gap check dies.
    const billed = primaryInvoiceBilledFee("inv_1", [guestLine, feeLine(25)]);
    await recordPrimaryInvoiceBilledFee("op_create", billed);
    mocks.enqueue.mockRejectedValueOnce(new Error("connection reset"));
    await expect(queuePrimaryInvoiceChangeFeeGap({ bookingId: "booking_1", billed })).rejects.toThrow(
      "connection reset",
    );

    // The retry takes the create's "invoice already exists" exit, which
    // re-runs the check from the record.
    mocks.xeroSyncOperation.findFirst.mockImplementation(async (args: { where: { queueType?: string } }) =>
      args.where.queueType ? null : { requestPayload: storedPayload },
    );
    await expect(
      recheckPrimaryInvoiceChangeFeeGap({ bookingId: "booking_1", xeroInvoiceId: "inv_1" }),
    ).resolves.toEqual({ gapCents: 4_000, queueOperationId: "op_gap", alreadyQueued: false });
    expect(mocks.enqueue).toHaveBeenLastCalledWith(
      { bookingId: "booking_1", priceDiffCents: 0, changeFeeCents: 4_000, bookingModificationId: "mod_late" },
      { createdByMemberId: undefined, recordPayment: false },
    );
    expect(storedPayload).toMatchObject({ invoices: [], primaryInvoiceBilledFee: billed });
  });

  it("a retry of an invoice with no record bills nothing", async () => {
    await expect(
      recheckPrimaryInvoiceChangeFeeGap({ bookingId: "booking_1", xeroInvoiceId: "inv_legacy" }),
    ).resolves.toEqual({ gapCents: 0, queueOperationId: null, alreadyQueued: false });
    expect(mocks.xeroSyncOperation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          requestPayload: { path: ["primaryInvoiceBilledFee", "xeroInvoiceId"], equals: "inv_legacy" },
        }),
      }),
    );
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
});
