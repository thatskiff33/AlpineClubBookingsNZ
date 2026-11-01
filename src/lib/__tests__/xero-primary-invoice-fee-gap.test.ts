import { PaymentSource } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  payment: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn(), findUniqueOrThrow: vi.fn() },
  memberCredit: { groupBy: vi.fn() },
  bookingModification: { findMany: vi.fn() },
  xeroSyncOperation: { findUnique: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
  xeroObjectLink: { findFirst: vi.fn() },
  booking: { findUniqueOrThrow: vi.fn() },
  enqueue: vi.fn(),
  review: vi.fn(),
  manualRefundTask: { findMany: vi.fn() },
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/prisma", () => {
  const client = {
    payment: mocks.payment,
    memberCredit: mocks.memberCredit,
    bookingModification: mocks.bookingModification,
    xeroSyncOperation: mocks.xeroSyncOperation,
    xeroObjectLink: mocks.xeroObjectLink,
    booking: mocks.booking,
    manualRefundTask: mocks.manualRefundTask,
  };
  // One interactive transaction: the same delegates, so a test sees what it wrote.
  return { prisma: { ...client, $transaction: vi.fn(async (run: (tx: typeof client) => unknown) => run(client)) } };
});
vi.mock("@/lib/xero-operation-outbox", () => ({ enqueueXeroSupplementaryInvoiceOperation: mocks.enqueue }));
// #3953: one recorder per capture. The booking's captured cash is the payment
// fixture's, on one intent; no receipt row claims any unless a case says so.
const recorderMocks = vi.hoisted(() => ({ claimed: new Set<string>(), supplementaryRecorded: new Set<string>(), queueReceipts: vi.fn() }));
vi.mock("@/lib/additional-capture-recorder", async () => {
  const actual = (await vi.importActual("@/lib/additional-capture-recorder")) as typeof import("@/lib/additional-capture-recorder");
  return {
    attributeGapCash: actual.attributeGapCash,
    readReceiptClaimedIntents: async () => recorderMocks.claimed,
    readSupplementaryRecordedIntents: async () => recorderMocks.supplementaryRecorded,
    readCapturedStripeCash: async () => {
      const payment = (await mocks.payment.findUnique()) as { amountCents?: number; refundedAmountCents?: number } | null;
      const net = Math.max(0, (payment?.amountCents ?? 0) - (payment?.refundedAmountCents ?? 0));
      return net > 0 ? [{ paymentIntentId: "pi_booking", netCents: net, bookingModificationId: null }] : [];
    },
  };
});
vi.mock("@/lib/additional-capture-receipt-enqueue", () => ({ queueReceiptsForUnrecordedCaptures: recorderMocks.queueReceipts }));
vi.mock("@/lib/logger", () => ({ default: mocks.logger }));
vi.mock("@/lib/xero-primary-invoice-review-task", () => ({ raisePrimaryInvoiceReviewTask: mocks.review }));

import { CHANGE_FEE_LINE_DESCRIPTION } from "@/lib/xero-modification-line-items";
import {
  billedChangeFeeCents,
  cardSettleAllocatesAppliedCredit,
  cardSettleAppliedCreditCents,
  existingPrimaryInvoiceStripePayment,
  persistPrimaryInvoiceLink,
  primaryInvoiceBilledFee,
  primaryInvoiceStripeCashCents,
  primaryInvoiceStripePaymentReference,
  primaryInvoiceWorthGap,
  queuePrimaryInvoiceWorthGap,
  recheckPrimaryInvoiceWorthGap,
  unrecordedPrimaryInvoiceCash,
  type PrimaryInvoiceBilledFee,
} from "@/lib/xero-primary-invoice-fee-gap";

const guestLine = { description: "Jordan - (ADULT, Member) - 2 nights", quantity: 1, unitAmount: 200 };
const feeLine = (dollars: number) => ({ description: CHANGE_FEE_LINE_DESCRIPTION, quantity: 1, unitAmount: dollars });

const unpaid = {
  changeFeeCents: 6_500,
  source: PaymentSource.STRIPE as PaymentSource,
  status: "PENDING",
  amountCents: 0,
  refundedAmountCents: 0,
  creditAppliedCents: 0,
};

/** The figures the link's save stores: what was billed, the fee recorded then, and the cash on the invoice. */
const atLink = (billed: PrimaryInvoiceBilledFee, recordedChangeFeeCentsAtLink = 6_500, primaryInvoiceCashCents = 0) => ({
  ...billed,
  recordedChangeFeeCentsAtLink,
  primaryInvoiceCashCents,
});

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
    // Two corrections that routed a fee to the primary invoice (#3955).
    mocks.bookingModification.findMany.mockResolvedValue([
      { id: "mod_late", priceDiffCents: 0, changeFeeCents: 4_000, newData: {} },
      { id: "mod_early", priceDiffCents: 0, changeFeeCents: 2_500, newData: {} },
    ]);
    mocks.manualRefundTask.findMany.mockResolvedValue([]);
    mocks.xeroSyncOperation.findFirst.mockResolvedValue(null);
    mocks.xeroObjectLink.findFirst.mockResolvedValue(null);
    mocks.enqueue.mockResolvedValue({ queueOperationId: "op_gap", outcome: "covers-total" });
    mocks.review.mockResolvedValue({ operationId: "op_review", alreadyRaised: false });
    mocks.booking.findUniqueOrThrow.mockResolvedValue({ finalPriceCents: 20_000 });
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

  it("does nothing when the invoice bills the fee recorded at its link", async () => {
    await expect(
      queuePrimaryInvoiceWorthGap({
        bookingId: "booking_1",
        atLink: atLink(primaryInvoiceBilledFee("inv_1", [guestLine, feeLine(25)]), 2_500),
      }),
    ).resolves.toMatchObject({ gapCents: 0, queueOperationId: null });
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("bills the gap UNPAID on the latest correction that routed its fee to the primary invoice", async () => {
    await expect(
      queuePrimaryInvoiceWorthGap({
        bookingId: "booking_1",
        // The invoice Xero returned was built before the 40.00 fee was recorded.
        atLink: atLink(primaryInvoiceBilledFee("inv_1", [guestLine, feeLine(25)])),
        createdByMemberId: "officer_1",
      }),
    ).resolves.toEqual({
      gapCents: 4_000,
      queueOperationId: "op_gap",
      alreadyQueued: false,
      cashTakenCents: 0,
      reviewOperationId: null,
    });
    // #3980: an ordinary edit's marker, or #3955's correction routing its fee.
    expect(mocks.bookingModification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          bookingId: "booking_1",
          OR: [
            { newData: { path: ["primaryInvoiceSettlement", "settledAgainstPrimaryInvoice"], equals: true } },
            { changeFeeCents: { gt: 0 }, newData: { path: ["finishedStayCorrection", "feeOnPrimaryInvoice"], equals: true } },
          ],
        },
        orderBy: { createdAt: "desc" },
        select: { id: true, priceDiffCents: true, changeFeeCents: true, newData: true, createdAt: true },
      }),
    );
    // Round 3, finding 1: never the enqueue's paid-by-Stripe default.
    expect(mocks.enqueue).toHaveBeenCalledWith(
      { bookingId: "booking_1", priceDiffCents: 0, changeFeeCents: 4_000, bookingModificationId: "mod_late" },
      { createdByMemberId: "officer_1", recordPayment: false, primaryInvoiceGap: expect.objectContaining({ coveredCaptures: [] }) },
    );
    expect(mocks.logger.error).not.toHaveBeenCalled();
  });

  it("records a payment only when a captured Stripe payment nets the fee beyond the primary invoice", async () => {
    // The primary invoice (total 22,500) recorded 22,500 of cash.
    const fees = atLink(primaryInvoiceBilledFee("inv_1", [guestLine, feeLine(25)]), 6_500, 22_500);
    // Captured exactly the primary's cash: nothing left over for the gap.
    mocks.payment.findUnique.mockResolvedValue({ ...unpaid, status: "SUCCEEDED", amountCents: 22_500 });
    await expect(queuePrimaryInvoiceWorthGap({ bookingId: "booking_1", atLink: fees })).resolves.toMatchObject({
      cashTakenCents: 0,
    });
    expect(mocks.enqueue).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ recordPayment: false }));

    // Captured the primary's cash plus the 40.00 gap: the gap invoice takes it.
    mocks.payment.findUnique.mockResolvedValue({ ...unpaid, status: "SUCCEEDED", amountCents: 26_500 });
    await expect(queuePrimaryInvoiceWorthGap({ bookingId: "booking_1", atLink: fees })).resolves.toMatchObject({
      cashTakenCents: 4_000,
    });
    expect(mocks.enqueue).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ recordPayment: true }));

    // The same cash by internet banking is never recorded as a Stripe payment.
    mocks.payment.findUnique.mockResolvedValue({
      ...unpaid,
      source: "INTERNET_BANKING",
      status: "SUCCEEDED",
      amountCents: 26_500,
    });
    await queuePrimaryInvoiceWorthGap({ bookingId: "booking_1", atLink: fees });
    expect(mocks.enqueue).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ recordPayment: false }));
  });

  it("#3953: queues the receipts of captures the primary's cash does not cover BEFORE it measures the gap", async () => {
    const fees = atLink(primaryInvoiceBilledFee("inv_1", [guestLine, feeLine(25)]));
    await queuePrimaryInvoiceWorthGap({ bookingId: "booking_1", atLink: fees });
    expect(recorderMocks.queueReceipts).toHaveBeenCalledWith("booking_1", fees);
    expect(recorderMocks.queueReceipts.mock.invocationCallOrder[0]).toBeLessThan(mocks.enqueue.mock.invocationCallOrder[0]);
  });

  it("#3953 MUTATION: names the captures its own payment takes, and never pays itself from a capture a receipt row claimed", async () => {
    const fees = atLink(primaryInvoiceBilledFee("inv_1", [guestLine, feeLine(25)]), 6_500, 22_500);
    mocks.payment.findUnique.mockResolvedValue({ ...unpaid, status: "SUCCEEDED", amountCents: 26_500 });
    await queuePrimaryInvoiceWorthGap({ bookingId: "booking_1", atLink: fees });
    expect(mocks.enqueue).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ recordPayment: true, primaryInvoiceGap: expect.objectContaining({ coveredCaptures: [{ paymentIntentId: "pi_booking", cents: 4_000 }] }) }),
    );

    // The same cash, claimed by that capture's receipt - or (round 3, F3)
    // recorded by a supplementary invoice: the gap is raised unpaid and names nothing.
    for (const claimer of ["claimed", "supplementaryRecorded"] as const) {
      recorderMocks[claimer] = new Set(["pi_booking"]);
      try {
        await expect(queuePrimaryInvoiceWorthGap({ bookingId: "booking_1", atLink: fees })).resolves.toMatchObject({ cashTakenCents: 0 });
        expect(mocks.enqueue).toHaveBeenLastCalledWith(
          expect.anything(),
          expect.objectContaining({ recordPayment: false, primaryInvoiceGap: expect.objectContaining({ coveredCaptures: [] }) }),
        );
      } finally {
        recorderMocks[claimer] = new Set();
      }
    }
  });

  it("#3953 round 3 (F4): reads what the primary recorded from its link's stored list, never re-walking its cash", async () => {
    // The primary's cash figure says 225.00, but its stored list says it covered
    // nothing of this capture: all 265.00 is spare, and the gap's 40.00 is taken.
    const fees = { ...atLink(primaryInvoiceBilledFee("inv_1", [guestLine, feeLine(25)]), 6_500, 22_500), paymentIntentIdsRecordedAtLink: [] };
    mocks.payment.findUnique.mockResolvedValue({ ...unpaid, status: "SUCCEEDED", amountCents: 26_500 });
    await queuePrimaryInvoiceWorthGap({ bookingId: "booking_1", atLink: fees });
    expect(mocks.enqueue).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ recordPayment: true, primaryInvoiceGap: expect.objectContaining({ coveredCaptures: [{ paymentIntentId: "pi_booking", cents: 4_000 }] }) }),
    );
    // Covered wholly by the stored list: nothing spare, so the gap is raised unpaid.
    await queuePrimaryInvoiceWorthGap({ bookingId: "booking_1", atLink: { ...fees, paymentIntentIdsRecordedAtLink: ["pi_booking"] } });
    expect(mocks.enqueue).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ recordPayment: false }));
  });

  it("MUTATION round 4, finding 3: applied credit settles the primary first, so the card's cash pays the gap", async () => {
    // Price 100.00, a 5.00 fee recorded after the invoice was built, 20.00 of
    // credit applied, 85.00 on the card. The primary bills 100.00: it takes
    // 80.00 of cash and the 20.00 credit; the 5.00 left is the gap's.
    expect(primaryInvoiceStripeCashCents({ netCapturedCents: 8_500, amountDueCents: 10_000, appliedCreditCents: 2_000 })).toBe(
      8_000,
    );
    mocks.payment.findUnique.mockResolvedValue({ ...unpaid, status: "SUCCEEDED", amountCents: 8_500, creditAppliedCents: 2_000 });
    await queuePrimaryInvoiceWorthGap({
      bookingId: "booking_1",
      atLink: atLink(primaryInvoiceBilledFee("inv_1", [{ description: "Guest", quantity: 1, unitAmount: 100 }]), 500, 8_000),
    });
    expect(mocks.enqueue).toHaveBeenLastCalledWith(
      expect.objectContaining({ changeFeeCents: 500 }),
      expect.objectContaining({ recordPayment: true }),
    );
  });

  it("MUTATION round 5, finding 4: the gap reads the cash the primary recorded at its link, never a recomputation from the mirror", async () => {
    // The primary recorded 80.00 (20.00 of credit allowed for). Since then a
    // give-back took the mirror to 0. Recomputed from the billed total and
    // that mirror, the primary would have "taken" all 85.00 and the 5.00 gap
    // would be raised unpaid while the card holds the money.
    mocks.payment.findUnique.mockResolvedValue({ ...unpaid, status: "SUCCEEDED", amountCents: 8_500, creditAppliedCents: 0 });
    await expect(
      queuePrimaryInvoiceWorthGap({
        bookingId: "booking_1",
        atLink: atLink(primaryInvoiceBilledFee("inv_1", [{ description: "Guest", quantity: 1, unitAmount: 100 }]), 500, 8_000),
      }),
    ).resolves.toMatchObject({ gapCents: 500, cashTakenCents: 500 });
    expect(mocks.enqueue).toHaveBeenLastCalledWith(
      expect.objectContaining({ changeFeeCents: 500 }),
      expect.objectContaining({ recordPayment: true }),
    );
    expect(mocks.payment.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ select: expect.not.objectContaining({ creditAppliedCents: true }) }),
    );
  });

  it("the primary's cash cap: the credit always fits, never below zero, and Xero's missing amount caps at the capture", () => {
    expect(primaryInvoiceStripeCashCents({ netCapturedCents: 8_000, amountDueCents: 10_000, appliedCreditCents: 2_000 })).toBe(
      8_000,
    );
    // Credit covers the whole invoice: no cash is recorded on it.
    expect(primaryInvoiceStripeCashCents({ netCapturedCents: 500, amountDueCents: 10_000, appliedCreditCents: 10_000 })).toBe(0);
    expect(primaryInvoiceStripeCashCents({ netCapturedCents: 8_500, amountDueCents: null, appliedCreditCents: 2_000 })).toBe(
      8_500,
    );
    // Only a card capture with a credit-reduced mirror allocates credit there.
    const card = { ...unpaid, status: "SUCCEEDED", amountCents: 8_000, creditAppliedCents: 2_000 };
    expect(cardSettleAllocatesAppliedCredit(card)).toBe(true);
    expect(cardSettleAllocatesAppliedCredit({ ...card, source: PaymentSource.INTERNET_BANKING })).toBe(false);
    expect(cardSettleAllocatesAppliedCredit({ ...card, status: "PENDING" })).toBe(false);
    expect(cardSettleAllocatesAppliedCredit({ ...card, refundedAmountCents: 8_000 })).toBe(false);
    expect(cardSettleAllocatesAppliedCredit({ ...card, creditAppliedCents: 0 })).toBe(false);
    // A $0 credit-only card settle allocates too: its credit is all that pays it (#3836).
    expect(cardSettleAllocatesAppliedCredit({ ...card, amountCents: 0 })).toBe(true);
    expect(cardSettleAllocatesAppliedCredit({ ...card, amountCents: 0, source: PaymentSource.INTERNET_BANKING })).toBe(false);
  });

  it("MUTATION round 5, finding 2: the credit the cap allows for is the allocation engine's ledger figure, behind the settle's gate", async () => {
    const card = { ...unpaid, status: "SUCCEEDED", amountCents: 8_500, creditAppliedCents: 2_000 };
    // The mirror says 20.00; the ledger still has 30.00 to allocate.
    mocks.memberCredit.groupBy.mockResolvedValue([{ appliedToBookingId: "booking_1", _sum: { amountCents: -3_000 } }]);
    await expect(cardSettleAppliedCreditCents("booking_1", card)).resolves.toBe(3_000);
    expect(mocks.memberCredit.groupBy).toHaveBeenCalledWith({
      by: ["appliedToBookingId"],
      where: { appliedToBookingId: { in: ["booking_1"] }, type: "BOOKING_APPLIED", xeroCreditNoteId: null },
      _sum: { amountCents: true },
    });

    // Where the settle does not allocate, there is nothing to allow for.
    mocks.memberCredit.groupBy.mockClear();
    await expect(cardSettleAppliedCreditCents("booking_1", { ...card, source: PaymentSource.INTERNET_BANKING })).resolves.toBe(0);
    expect(mocks.memberCredit.groupBy).not.toHaveBeenCalled();
  });

  it("round 5, finding 3: only a partial cap whose remainder no gap invoice takes is reported", () => {
    expect(unrecordedPrimaryInvoiceCash({ netCapturedCents: 8_500, primaryInvoiceCashCents: 8_000, gapInvoiceCashCents: 0 })).toEqual({
      netCapturedCents: 8_500,
      invoicePaymentCents: 8_000,
      gapInvoiceCashCents: 0,
      unrecordedCashCents: 500,
    });
    expect(unrecordedPrimaryInvoiceCash({ netCapturedCents: 8_500, primaryInvoiceCashCents: 8_000, gapInvoiceCashCents: 500 })).toBeNull();
    expect(unrecordedPrimaryInvoiceCash({ netCapturedCents: 8_500, primaryInvoiceCashCents: 8_500, gapInvoiceCashCents: 0 })).toBeNull();
    // A cap at zero is the create's own loud skip, not this report.
    expect(unrecordedPrimaryInvoiceCash({ netCapturedCents: 500, primaryInvoiceCashCents: 0, gapInvoiceCashCents: 0 })).toBeNull();
  });

  it("round 5, finding 4: finds the earlier run's Stripe payment on the invoice by its reference", () => {
    const reference = primaryInvoiceStripePaymentReference("pi_1");
    expect(reference).toBe("Stripe pi_1");
    expect(primaryInvoiceStripePaymentReference(null)).toBe("Stripe payment");
    const invoice = {
      payments: [
        { paymentID: "xpay_other", amount: 5, reference: "Stripe pi_other" },
        { paymentID: "xpay_deleted", amount: 80, reference, status: "DELETED" as never },
        { paymentID: "xpay_run1", amount: 80, reference },
      ],
    };
    expect(existingPrimaryInvoiceStripePayment(invoice, reference)?.paymentID).toBe("xpay_run1");
    expect(existingPrimaryInvoiceStripePayment({ payments: [] }, reference)).toBeNull();
    expect(existingPrimaryInvoiceStripePayment({}, reference)).toBeNull();
  });

  it("never queues the gap twice, and never raises an anchor's queued invoice", async () => {
    mocks.xeroSyncOperation.findFirst.mockResolvedValue({ id: "op_earlier" });
    await expect(
      queuePrimaryInvoiceWorthGap({
        bookingId: "booking_1",
        atLink: atLink(primaryInvoiceBilledFee("inv_1", [guestLine, feeLine(25)])),
      }),
    ).resolves.toEqual({
      gapCents: 4_000,
      queueOperationId: "op_earlier",
      alreadyQueued: true,
      cashTakenCents: 0,
      reviewOperationId: null,
    });
    expect(mocks.xeroSyncOperation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          localModel: "BookingModification",
          localId: { in: ["mod_late", "mod_early"] },
        }),
      }),
    );

    // Round 5, finding 3: what the earlier run's queued invoice takes of the cash.
    mocks.xeroSyncOperation.findFirst.mockResolvedValue({
      id: "op_earlier",
      requestPayload: {
        queueType: "SUPPLEMENTARY_INVOICE",
        bookingId: "booking_1",
        priceDiffCents: 0,
        changeFeeCents: 4_000,
        recordPayment: true,
      },
    });
    await expect(
      queuePrimaryInvoiceWorthGap({
        bookingId: "booking_1",
        atLink: atLink(primaryInvoiceBilledFee("inv_1", [guestLine, feeLine(25)])),
      }),
    ).resolves.toMatchObject({ alreadyQueued: true, cashTakenCents: 4_000 });

    mocks.xeroSyncOperation.findFirst.mockResolvedValue(null);
    mocks.xeroObjectLink.findFirst.mockResolvedValue({ id: "link_sent" });
    await queuePrimaryInvoiceWorthGap({
      bookingId: "booking_1",
      atLink: atLink(primaryInvoiceBilledFee("inv_1", [guestLine, feeLine(25)])),
    });
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("#3980: a gap no edit explains is the treasurer's task; an enqueue that queued nothing fresh is loud", async () => {
    mocks.bookingModification.findMany.mockResolvedValueOnce([]);
    await expect(
      queuePrimaryInvoiceWorthGap({
        bookingId: "booking_1",
        atLink: atLink(primaryInvoiceBilledFee("inv_1", [guestLine])),
      }),
    ).resolves.toMatchObject({ gapCents: 6_500, queueOperationId: null, reviewOperationId: "op_review" });
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.logger.error).toHaveBeenCalledTimes(1);
    expect(mocks.review).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "UNDERBILLED", bookingId: "booking_1", xeroInvoiceId: "inv_1", gapCents: 6_500 }),
    );

    for (const outcome of ["none", "short-sent", "short-in-flight"]) {
      mocks.logger.error.mockClear();
      mocks.enqueue.mockResolvedValueOnce({ queueOperationId: null, outcome });
      await queuePrimaryInvoiceWorthGap({
        bookingId: "booking_1",
        atLink: atLink(primaryInvoiceBilledFee("inv_1", [guestLine])),
      });
      expect(mocks.logger.error, outcome).toHaveBeenCalledTimes(1);
    }
  });

  it("#3980: an invoice billing more fee than was recorded at its link is the treasurer's task, never a credit note", async () => {
    await queuePrimaryInvoiceWorthGap({
      bookingId: "booking_1",
      atLink: atLink(primaryInvoiceBilledFee("inv_1", [feeLine(30)]), 2_500),
    });
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.logger.error).toHaveBeenCalled();
    expect(mocks.review).toHaveBeenCalledWith(expect.objectContaining({ kind: "OVERBILLED", gapCents: -500 }));
  });

  /** The create operation's payload, as the database would hold it. */
  const storedOperation = () => {
    const store: { payload: unknown } = { payload: { invoices: [] } };
    mocks.xeroSyncOperation.findUnique.mockImplementation(async () => ({ requestPayload: store.payload }));
    mocks.xeroSyncOperation.update.mockImplementation(async ({ data }: { data: { requestPayload: unknown } }) => {
      store.payload = data.requestPayload;
      return {};
    });
    mocks.xeroSyncOperation.findFirst.mockImplementation(async (args: { where: { queueType?: string } }) =>
      args.where.queueType ? null : { requestPayload: store.payload },
    );
    return store;
  };

  it("round 4, finding 1: the link's save reads the fee back from its own row update and stores it in the same transaction", async () => {
    const store = storedOperation();
    mocks.payment.updateMany.mockResolvedValue({ count: 1 });
    mocks.payment.findUniqueOrThrow.mockResolvedValue({ changeFeeCents: 6_500, bookingId: "booking_1" });
    const billed = primaryInvoiceBilledFee("inv_1", [guestLine, feeLine(25)]);
    // #3980: the worth read after the link's own update - price 200.00 and the 65.00 fee.
    const worth = { atBuildCents: 22_500, builtTotalCents: 22_500, atLinkCents: 26_500 };

    await expect(
      persistPrimaryInvoiceLink({
        operationId: "op_create",
        paymentId: "pay_1",
        xeroInvoiceNumber: "INV-1",
        billed,
        built: { worthCents: 22_500, lineTotalCents: 22_500 },
        primaryInvoiceCashCents: 8_000,
        primaryInvoiceAttemptedCashCents: 8_000,
      }),
    ).resolves.toEqual({
      ...billed,
      recordedChangeFeeCentsAtLink: 6_500,
      primaryInvoiceCashCents: 8_000,
      primaryInvoiceAttemptedCashCents: 8_000,
      worth,
    });

    const { prisma } = await import("@/lib/prisma");
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    // #3980 review C3: the link's write is guarded on it being unset.
    expect(mocks.payment.updateMany).toHaveBeenCalledWith({
      where: { id: "pay_1", xeroInvoiceId: null },
      data: { xeroInvoiceId: "inv_1", xeroInvoiceNumber: "INV-1" },
    });
    expect(mocks.payment.update).not.toHaveBeenCalled();
    // After the row's write, in the same transaction.
    expect(mocks.booking.findUniqueOrThrow).toHaveBeenCalledWith({
      where: { id: "booking_1" },
      select: { finalPriceCents: true },
    });
    expect(mocks.payment.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.booking.findUniqueOrThrow.mock.invocationCallOrder[0],
    );
    expect(store.payload).toMatchObject({
      invoices: [],
      primaryInvoiceBilledFee: {
        ...billed,
        recordedChangeFeeCentsAtLink: 6_500,
        primaryInvoiceCashCents: 8_000,
        primaryInvoiceAttemptedCashCents: 8_000,
        worth,
      },
    });
  });

  it("MUTATION #3980 review C3: a second save of the same invoice measures nothing; another invoice is overwritten and measured", async () => {
    const store = storedOperation();
    const save = () =>
      persistPrimaryInvoiceLink({
        operationId: "op_retry",
        paymentId: "pay_1",
        xeroInvoiceNumber: "INV-1",
        billed: primaryInvoiceBilledFee("inv_1", [guestLine]),
        built: { worthCents: 20_000, lineTotalCents: 20_000 },
        primaryInvoiceCashCents: 0,
        primaryInvoiceAttemptedCashCents: 0,
      });
    // Already linked to this invoice: found under the guard, nothing re-read or stored.
    mocks.payment.updateMany.mockResolvedValue({ count: 0 });
    mocks.payment.findUniqueOrThrow.mockResolvedValueOnce({ xeroInvoiceId: "inv_1" });
    await expect(save()).resolves.toBeNull();
    expect(mocks.payment.update).not.toHaveBeenCalled();
    expect(mocks.booking.findUniqueOrThrow).not.toHaveBeenCalled();
    expect(mocks.xeroSyncOperation.update).not.toHaveBeenCalled();
    expect(store.payload).toEqual({ invoices: [] });

    // Linked to a different invoice: overwritten and measured, as it always was.
    mocks.payment.findUniqueOrThrow
      .mockResolvedValueOnce({ xeroInvoiceId: "inv_other" })
      .mockResolvedValueOnce({ changeFeeCents: 0, bookingId: "booking_1" });
    await expect(save()).resolves.toMatchObject({ xeroInvoiceId: "inv_1" });
    expect(mocks.payment.update).toHaveBeenCalledWith({
      where: { id: "pay_1" },
      data: { xeroInvoiceId: "inv_1", xeroInvoiceNumber: "INV-1" },
    });
    expect(mocks.xeroSyncOperation.update).toHaveBeenCalledTimes(1);
  });

  it("MUTATION round 4, finding 1: a fee recorded after the link is never billed by the re-check", async () => {
    storedOperation();
    // The invoice billed the 25.00 recorded when its link was saved.
    mocks.payment.updateMany.mockResolvedValue({ count: 1 });
    mocks.payment.findUniqueOrThrow.mockResolvedValue({ changeFeeCents: 2_500, bookingId: "booking_1" });
    await persistPrimaryInvoiceLink({
      operationId: "op_create",
      paymentId: "pay_1",
      xeroInvoiceNumber: null,
      billed: primaryInvoiceBilledFee("inv_1", [guestLine, feeLine(25)]),
      built: { worthCents: 22_500, lineTotalCents: 22_500 },
      primaryInvoiceCashCents: 0,
      primaryInvoiceAttemptedCashCents: 0,
    });
    // A later edit records 30.00 more, billed on its own document.
    mocks.payment.findUnique.mockResolvedValue({ ...unpaid, changeFeeCents: 5_500 });

    await expect(
      recheckPrimaryInvoiceWorthGap({ bookingId: "booking_1", xeroInvoiceId: "inv_1" }),
    ).resolves.toEqual({
      gapCents: 0,
      queueOperationId: null,
      alreadyQueued: false,
      cashTakenCents: 0,
      reviewOperationId: null,
    });
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("round 3, finding 2: a check that throws after the link is saved is billed by the retry", async () => {
    storedOperation();
    // The create saves its link with what it billed and the fee recorded
    // then, and the gap check dies.
    mocks.payment.updateMany.mockResolvedValue({ count: 1 });
    mocks.payment.findUniqueOrThrow.mockResolvedValue({ changeFeeCents: 6_500, bookingId: "booking_1" });
    const fees = await persistPrimaryInvoiceLink({
      operationId: "op_create",
      paymentId: "pay_1",
      xeroInvoiceNumber: null,
      billed: primaryInvoiceBilledFee("inv_1", [guestLine, feeLine(25)]),
      built: { worthCents: 22_500, lineTotalCents: 22_500 },
      primaryInvoiceCashCents: 0,
      primaryInvoiceAttemptedCashCents: 0,
    });
    if (!fees) throw new Error("expected the first save of this link");
    mocks.enqueue.mockRejectedValueOnce(new Error("connection reset"));
    await expect(queuePrimaryInvoiceWorthGap({ bookingId: "booking_1", atLink: fees })).rejects.toThrow(
      "connection reset",
    );

    // The retry takes the create's "invoice already exists" exit, which
    // re-runs the check from the stored figures.
    await expect(
      recheckPrimaryInvoiceWorthGap({ bookingId: "booking_1", xeroInvoiceId: "inv_1" }),
    ).resolves.toEqual({
      gapCents: 4_000,
      queueOperationId: "op_gap",
      alreadyQueued: false,
      cashTakenCents: 0,
      reviewOperationId: null,
    });
    expect(mocks.enqueue).toHaveBeenLastCalledWith(
      { bookingId: "booking_1", priceDiffCents: 0, changeFeeCents: 4_000, bookingModificationId: "mod_late" },
      { createdByMemberId: undefined, recordPayment: false, primaryInvoiceGap: expect.objectContaining({ coveredCaptures: [] }) },
    );
  });

  it("round 5, finding 4: stored figures without the primary's cash are not figures the gap rule can read", async () => {
    mocks.xeroSyncOperation.findFirst.mockResolvedValue({
      requestPayload: {
        primaryInvoiceBilledFee: { xeroInvoiceId: "inv_1", billedChangeFeeCents: 2_500, billedTotalCents: 22_500, recordedChangeFeeCentsAtLink: 6_500 },
      },
    });
    mocks.payment.findUnique.mockResolvedValue({ changeFeeCents: 6_500 });
    await expect(recheckPrimaryInvoiceWorthGap({ bookingId: "booking_1", xeroInvoiceId: "inv_1" })).resolves.toMatchObject({
      gapCents: 0,
      queueOperationId: null,
    });
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.logger.warn).toHaveBeenCalledWith(expect.anything(), expect.stringContaining("not checked"));
  });

  it("round 4, finding 2: a retry of an invoice with no stored figures bills nothing, loudly when a fee is recorded", async () => {
    mocks.payment.findUnique.mockResolvedValue({ changeFeeCents: 0 });
    await expect(
      recheckPrimaryInvoiceWorthGap({ bookingId: "booking_1", xeroInvoiceId: "inv_legacy" }),
    ).resolves.toEqual({
      gapCents: 0,
      queueOperationId: null,
      alreadyQueued: false,
      cashTakenCents: 0,
      reviewOperationId: null,
    });
    expect(mocks.xeroSyncOperation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          requestPayload: { path: ["primaryInvoiceBilledFee", "xeroInvoiceId"], equals: "inv_legacy" },
        }),
      }),
    );
    expect(mocks.logger.warn).not.toHaveBeenCalled();

    mocks.payment.findUnique.mockResolvedValue({ changeFeeCents: 2_500 });
    await recheckPrimaryInvoiceWorthGap({ bookingId: "booking_1", xeroInvoiceId: "inv_legacy" });
    expect(mocks.logger.warn).toHaveBeenCalledTimes(1);
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ xeroInvoiceId: "inv_legacy", recordedChangeFeeCents: 2_500 }),
      expect.stringContaining("not checked"),
    );
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
});

/**
 * #3980 (owner decision, 21 Oct 2026: "refuse, and bill the gap"): the check
 * measures the booking's whole worth at the link, not its fee alone. An edit
 * that committed after the create read the booking and before its link was
 * saved, or a replayed create handed back the original invoice, leaves the
 * invoice billing other than the booking was worth; a shortfall is billed on a
 * supplementary invoice anchored on an edit that settled against the primary
 * invoice, and an overcharge is the treasurer's Xero Operations task.
 */
describe("the primary invoice's worth gap (#3980)", () => {
  const guest = (dollars: number) => ({ description: "Guest - 2 nights", quantity: 1, unitAmount: dollars });
  const promo = (dollars: number) => ({ description: "Promo adjustment", quantity: 1, unitAmount: dollars });
  /** What the link stores: billed lines, fee at link, and the worth figures. */
  const worthAtLink = (input: {
    billed: Array<{ description: string; quantity: number; unitAmount: number }>;
    feeAtLinkCents?: number;
    atBuildCents: number;
    builtTotalCents: number;
    atLinkCents: number;
    cashCents?: number;
  }) => ({
    ...primaryInvoiceBilledFee("inv_1", input.billed),
    recordedChangeFeeCentsAtLink: input.feeAtLinkCents ?? 0,
    primaryInvoiceCashCents: input.cashCents ?? 0,
    worth: { atBuildCents: input.atBuildCents, builtTotalCents: input.builtTotalCents, atLinkCents: input.atLinkCents },
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.payment.findUnique.mockResolvedValue({ ...unpaid, changeFeeCents: 0 });
    mocks.bookingModification.findMany.mockResolvedValue([marked("mod_edit", 8_000)]);
    mocks.manualRefundTask.findMany.mockResolvedValue([]);
    mocks.xeroSyncOperation.findFirst.mockResolvedValue(null);
    mocks.xeroObjectLink.findFirst.mockResolvedValue(null);
    mocks.enqueue.mockResolvedValue({ queueOperationId: "op_gap", outcome: "covers-total" });
    mocks.review.mockResolvedValue({ operationId: "op_review", alreadyRaised: false });
  });

  /** A marked edit (#3980): it read no invoice link, with how it settled. */
  function marked(
    id: string,
    priceDiffCents: number,
    settlement: Record<string, number> = {},
    createdAt = new Date("2026-06-25T00:00:00.000Z"),
  ) {
    return {
      id,
      priceDiffCents,
      changeFeeCents: 0,
      createdAt,
      newData: {
        primaryInvoiceSettlement: {
          settledAgainstPrimaryInvoice: true,
          refundAmountCents: 0,
          accountCreditAmountCents: 0,
          appliedCreditGivenBackCents: 0,
          unpaidAskOffsetCents: 0,
          ...settlement,
        },
      },
    };
  }
  const increaseAtLink = () =>
    worthAtLink({ billed: [guest(300)], atBuildCents: 30_000, builtTotalCents: 30_000, atLinkCents: 38_000 });

  it("MUTATION: measures what moved - an edit after the create's read, or a replayed invoice - never how the lines price the booking", () => {
    // No race: nothing moved.
    expect(
      primaryInvoiceWorthGap(worthAtLink({ billed: [guest(300)], atBuildCents: 30_000, builtTotalCents: 30_000, atLinkCents: 30_000 })),
    ).toEqual({ gapCents: 0, feeGapCents: 0, measuredOn: "worth" });
    // A booking whose lines price it at 295.00 against a 300.00 headline, on
    // every invoice it ever has: not a race, so not a gap.
    expect(
      primaryInvoiceWorthGap(
        worthAtLink({ billed: [guest(300), promo(-5)], atBuildCents: 30_000, builtTotalCents: 29_500, atLinkCents: 30_000 }),
      ).gapCents,
    ).toBe(0);
    // The owner's example: billed 300.00, an edit made it 380.00 before the link.
    expect(
      primaryInvoiceWorthGap(worthAtLink({ billed: [guest(300)], atBuildCents: 30_000, builtTotalCents: 30_000, atLinkCents: 38_000 }))
        .gapCents,
    ).toBe(8_000);
    // A reduction: the invoice bills 50.00 too much.
    expect(
      primaryInvoiceWorthGap(worthAtLink({ billed: [guest(300)], atBuildCents: 30_000, builtTotalCents: 30_000, atLinkCents: 25_000 }))
        .gapCents,
    ).toBe(-5_000);
    // A replayed create read the edited booking, but Xero handed back the original invoice.
    expect(
      primaryInvoiceWorthGap(worthAtLink({ billed: [guest(300)], atBuildCents: 38_000, builtTotalCents: 38_000, atLinkCents: 38_000 }))
        .gapCents,
    ).toBe(8_000);
    // Promotion lines are lines like any other: a 20.00 promo on both sides is no gap.
    expect(
      primaryInvoiceWorthGap(
        worthAtLink({ billed: [guest(300), promo(-20)], atBuildCents: 28_000, builtTotalCents: 28_000, atLinkCents: 28_000 }),
      ).gapCents,
    ).toBe(0);
    // A record from before #3980 is measured on its fee alone.
    expect(primaryInvoiceWorthGap(atLink(primaryInvoiceBilledFee("inv_1", [guestLine, feeLine(25)])))).toEqual({
      gapCents: 4_000,
      feeGapCents: 4_000,
      measuredOn: "fee",
    });
  });

  it("bills a price increase that landed mid-create on a supplementary invoice anchored on the marked edit", async () => {
    await expect(
      queuePrimaryInvoiceWorthGap({
        bookingId: "booking_1",
        atLink: worthAtLink({ billed: [guest(300)], atBuildCents: 30_000, builtTotalCents: 30_000, atLinkCents: 38_000 }),
        createdByMemberId: "member_1",
      }),
    ).resolves.toEqual({
      gapCents: 8_000,
      queueOperationId: "op_gap",
      alreadyQueued: false,
      cashTakenCents: 0,
      reviewOperationId: null,
    });
    expect(mocks.enqueue).toHaveBeenCalledWith(
      { bookingId: "booking_1", priceDiffCents: 8_000, changeFeeCents: 0, bookingModificationId: "mod_edit" },
      { createdByMemberId: "member_1", recordPayment: false, primaryInvoiceGap: expect.objectContaining({ coveredCaptures: [] }) },
    );
    expect(mocks.review).not.toHaveBeenCalled();
  });

  it("MUTATION: splits the gap into the fee recorded since the build and the price, signed as an edit's are (#1356)", async () => {
    // Price up 20.00 and a 15.00 fee recorded after the create read the booking.
    await queuePrimaryInvoiceWorthGap({
      bookingId: "booking_1",
      atLink: worthAtLink({ billed: [guest(300)], feeAtLinkCents: 1_500, atBuildCents: 30_000, builtTotalCents: 30_000, atLinkCents: 33_500 }),
    });
    expect(mocks.enqueue).toHaveBeenLastCalledWith(
      expect.objectContaining({ priceDiffCents: 2_000, changeFeeCents: 1_500 }),
      expect.anything(),
    );
    // A correction that removed 10.00 of stay and kept a 15.00 fee: 5.00 owed,
    // billed as the 15.00 fee and the 10.00 removal, never a 5.00 "fee".
    await queuePrimaryInvoiceWorthGap({
      bookingId: "booking_1",
      atLink: worthAtLink({ billed: [guest(300)], feeAtLinkCents: 1_500, atBuildCents: 30_000, builtTotalCents: 30_000, atLinkCents: 30_500 }),
    });
    expect(mocks.enqueue).toHaveBeenLastCalledWith(
      expect.objectContaining({ priceDiffCents: -1_000, changeFeeCents: 1_500 }),
      expect.anything(),
    );
  });

  it("an invoice billing more than the booking was worth is the treasurer's task: no credit note, no anchor needed", async () => {
    await expect(
      queuePrimaryInvoiceWorthGap({
        bookingId: "booking_1",
        atLink: worthAtLink({ billed: [guest(300)], atBuildCents: 30_000, builtTotalCents: 30_000, atLinkCents: 25_000 }),
        createdByMemberId: "member_1",
      }),
    ).resolves.toEqual({
      gapCents: -5_000,
      queueOperationId: null,
      alreadyQueued: false,
      cashTakenCents: 0,
      reviewOperationId: "op_review",
    });
    expect(mocks.review).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "OVERBILLED",
        bookingId: "booking_1",
        xeroInvoiceId: "inv_1",
        gapCents: -5_000,
        createdByMemberId: "member_1",
        figures: expect.objectContaining({ worthCentsAtBuild: 30_000, worthCentsAtLink: 25_000, billedTotalCents: 30_000 }),
      }),
    );
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("MUTATION review M5 / round 2 M3: an overcharge's task says how the reductions that landed mid-create settled - and nothing when none did", async () => {
    mocks.bookingModification.findMany.mockResolvedValue([
      marked("mod_racing", -5_000, { refundAmountCents: 3_000, unpaidAskOffsetCents: 2_000 }),
      // Marked, but in the create's snapshot: the invoice already billed it.
      marked("mod_known", -1_000, { accountCreditAmountCents: 1_000 }),
    ]);
    const overcharge = (markedAtBuild: string[]) => {
      const atLink = worthAtLink({ billed: [guest(300)], atBuildCents: 30_000, builtTotalCents: 30_000, atLinkCents: 25_000 });
      return { ...atLink, worth: { ...atLink.worth, markedModificationIdsAtBuild: markedAtBuild } };
    };
    await queuePrimaryInvoiceWorthGap({ bookingId: "booking_1", atLink: overcharge(["mod_known"]) });
    const settledBy = {
      refundAmountCents: 3_000,
      accountCreditAmountCents: 0,
      appliedCreditGivenBackCents: 0,
      unpaidAskOffsetCents: 2_000,
    };
    expect(mocks.review).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: "OVERBILLED",
        settledBy,
        figures: expect.objectContaining({ reductionModificationIds: ["mod_racing"], reductionsSettledBy: settledBy }),
      }),
    );
    // Both in the snapshot: no reduction landed mid-create, so no settlement is named.
    await queuePrimaryInvoiceWorthGap({ bookingId: "booking_1", atLink: overcharge(["mod_known", "mod_racing"]) });
    expect(mocks.review).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "OVERBILLED", settledBy: undefined }));
    expect(mocks.review.mock.lastCall![0].figures).not.toHaveProperty("reductionsSettledBy");
  });

  it("MUTATION #4324 (4384-R2): the gap invoice names every racing edit its amount bills, and the task names the one a kept capture's own invoice bills - not only the first anchor", async () => {
    mocks.bookingModification.findMany.mockResolvedValue([marked("mod_first", 8_000), marked("mod_second", 8_000)]);
    mocks.enqueue.mockResolvedValue({ queueOperationId: null, outcome: "none", refusedBy: "kept-late-capture-invoice", keptBilledChangeId: "mod_second" });
    await queuePrimaryInvoiceWorthGap({
      bookingId: "booking_1",
      atLink: worthAtLink({ billed: [guest(100)], atBuildCents: 10_000, builtTotalCents: 10_000, atLinkCents: 26_000 }),
    });
    expect(mocks.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ bookingModificationId: "mod_first", priceDiffCents: 16_000 }),
      expect.objectContaining({ primaryInvoiceGap: expect.objectContaining({ billedChangeIds: ["mod_first", "mod_second"] }) }),
    );
    expect(mocks.review).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "UNDERBILLED",
        figures: expect.objectContaining({ keptLateCaptureInvoiceBillsModificationId: "mod_second" }),
      }),
    );
  });

  it("MUTATION #4324 (`INV-PAY-144`, item D): an anchor a kept late capture's own invoice bills is refused, and the shortfall goes to the treasurer's task naming why", async () => {
    mocks.enqueue.mockResolvedValue({ queueOperationId: null, outcome: "none", refusedBy: "kept-late-capture-invoice" });
    await expect(queuePrimaryInvoiceWorthGap({ bookingId: "booking_1", atLink: increaseAtLink() })).resolves.toMatchObject({
      gapCents: 8_000,
      reviewOperationId: "op_review",
      queueOperationId: null,
    });
    expect(mocks.review).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "UNDERBILLED",
        gapCents: 8_000,
        keptInvoiceBillsChange: true,
        figures: expect.objectContaining({ keptLateCaptureInvoiceBillsModificationId: "mod_edit" }),
      }),
    );
    // Any other refusal is logged as before, and raises no task.
    mocks.review.mockClear();
    mocks.enqueue.mockResolvedValue({ queueOperationId: null, outcome: "none" });
    await expect(queuePrimaryInvoiceWorthGap({ bookingId: "booking_1", atLink: increaseAtLink() })).resolves.toMatchObject({
      reviewOperationId: null,
    });
    expect(mocks.review).not.toHaveBeenCalled();
  });

  it("MUTATION review M3: never anchors on a $0 edit, or one with a financial review - the task instead", async () => {
    mocks.bookingModification.findMany.mockResolvedValue([marked("mod_zero", 0), marked("mod_parked", 8_000)]);
    mocks.manualRefundTask.findMany.mockResolvedValue([{ reviewContext: { bookingModificationId: "mod_parked" } }]);
    await expect(queuePrimaryInvoiceWorthGap({ bookingId: "booking_1", atLink: increaseAtLink() })).resolves.toMatchObject({
      reviewOperationId: "op_review",
      queueOperationId: null,
    });
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.review).toHaveBeenCalledWith(expect.objectContaining({ kind: "UNDERBILLED", gapCents: 8_000 }));
    expect(mocks.manualRefundTask.findMany).toHaveBeenCalledWith({
      where: { bookingId: "booking_1", kind: "EDIT_FINANCIAL_REVIEW" },
      select: { reviewContext: true },
    });

    // The money-moving edit without a review is the anchor, newest first.
    mocks.bookingModification.findMany.mockResolvedValue([
      marked("mod_zero", 0),
      marked("mod_parked", 8_000),
      marked("mod_moved", 8_000),
    ]);
    await queuePrimaryInvoiceWorthGap({ bookingId: "booking_1", atLink: increaseAtLink() });
    expect(mocks.enqueue).toHaveBeenLastCalledWith(
      expect.objectContaining({ bookingModificationId: "mod_moved" }),
      expect.anything(),
    );
  });

  it("MUTATION round 2 F1: anchors only on an edit that landed mid-create - never one the snapshot held, nor one before a replayed create", async () => {
    // A re-base's gap (it marks nothing) with only an old, already-invoiced edit about.
    mocks.bookingModification.findMany.mockResolvedValue([marked("mod_old", 8_000)]);
    const atLink = increaseAtLink();
    await queuePrimaryInvoiceWorthGap({
      bookingId: "booking_1",
      atLink: { ...atLink, worth: { ...atLink.worth, markedModificationIdsAtBuild: ["mod_old"] } },
    });
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.review).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "UNDERBILLED" }));

    // A replay: an edit made before the FIRST create operation is not racing,
    // one made after it is, whatever this run's snapshot held.
    const firstCreateAt = new Date("2026-06-20T00:00:00.000Z");
    mocks.xeroSyncOperation.findFirst.mockImplementation(async (args: { where: { queueType?: string; operationType?: string } }) =>
      args.where.queueType ? null : { id: "op_first", createdAt: firstCreateAt },
    );
    mocks.bookingModification.findMany.mockResolvedValue([
      marked("mod_after", 8_000, {}, new Date("2026-06-21T00:00:00.000Z")),
      marked("mod_before", 8_000, {}, new Date("2026-06-19T00:00:00.000Z")),
    ]);
    await queuePrimaryInvoiceWorthGap({ bookingId: "booking_1", atLink: increaseAtLink(), figuresOperationId: "op_replay" });
    expect(mocks.enqueue).toHaveBeenLastCalledWith(expect.objectContaining({ bookingModificationId: "mod_after" }), expect.anything());
    mocks.bookingModification.findMany.mockResolvedValue([marked("mod_before", 8_000, {}, new Date("2026-06-19T00:00:00.000Z"))]);
    mocks.enqueue.mockClear();
    await queuePrimaryInvoiceWorthGap({ bookingId: "booking_1", atLink: increaseAtLink(), figuresOperationId: "op_replay" });
    expect(mocks.enqueue).not.toHaveBeenCalled();
    // The first create itself is no replay: its own edits count.
    await queuePrimaryInvoiceWorthGap({ bookingId: "booking_1", atLink: increaseAtLink(), figuresOperationId: "op_first" });
    expect(mocks.enqueue).toHaveBeenLastCalledWith(expect.objectContaining({ bookingModificationId: "mod_before" }), expect.anything());
  });

  it("round 2 F6: an invoice another writer linked first, with no figures stored, is measured from this run's and handed to the treasurer", async () => {
    mocks.xeroSyncOperation.findFirst.mockResolvedValue(null);
    mocks.booking.findUniqueOrThrow.mockResolvedValue({ finalPriceCents: 38_000, payment: { changeFeeCents: 0 } });
    await expect(
      recheckPrimaryInvoiceWorthGap({
        bookingId: "booking_1",
        xeroInvoiceId: "inv_1",
        unstoredSave: { built: { worthCents: 30_000, lineTotalCents: 30_000 }, billedTotalCents: 30_000 },
      }),
    ).resolves.toMatchObject({ gapCents: 8_000, reviewOperationId: "op_review", queueOperationId: null });
    expect(mocks.review).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "UNDERBILLED", gapCents: 8_000, figures: expect.objectContaining({ measuredOn: "worth-now" }) }),
    );
    expect(mocks.enqueue).not.toHaveBeenCalled();

    mocks.booking.findUniqueOrThrow.mockResolvedValue({ finalPriceCents: 30_000, payment: { changeFeeCents: 0 } });
    mocks.review.mockClear();
    await expect(
      recheckPrimaryInvoiceWorthGap({
        bookingId: "booking_1",
        xeroInvoiceId: "inv_1",
        unstoredSave: { built: { worthCents: 30_000, lineTotalCents: 30_000 }, billedTotalCents: 30_000 },
      }),
    ).resolves.toMatchObject({ gapCents: 0 });
    expect(mocks.review).not.toHaveBeenCalled();
  });
});
