import { PaymentSource } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  payment: { findUnique: vi.fn(), update: vi.fn() },
  memberCredit: { aggregate: vi.fn() },
  bookingModification: { findMany: vi.fn() },
  xeroSyncOperation: { findUnique: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
  xeroObjectLink: { findFirst: vi.fn() },
  enqueue: vi.fn(),
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/prisma", () => {
  const client = {
    payment: mocks.payment,
    memberCredit: mocks.memberCredit,
    bookingModification: mocks.bookingModification,
    xeroSyncOperation: mocks.xeroSyncOperation,
    xeroObjectLink: mocks.xeroObjectLink,
  };
  // One interactive transaction: the same delegates, so a test sees what it wrote.
  return { prisma: { ...client, $transaction: vi.fn(async (run: (tx: typeof client) => unknown) => run(client)) } };
});
vi.mock("@/lib/xero-operation-outbox", () => ({ enqueueXeroSupplementaryInvoiceOperation: mocks.enqueue }));
vi.mock("@/lib/logger", () => ({ default: mocks.logger }));

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
  queuePrimaryInvoiceChangeFeeGap,
  recheckPrimaryInvoiceChangeFeeGap,
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

  it("does nothing when the invoice bills the fee recorded at its link", async () => {
    await expect(
      queuePrimaryInvoiceChangeFeeGap({
        bookingId: "booking_1",
        atLink: atLink(primaryInvoiceBilledFee("inv_1", [guestLine, feeLine(25)]), 2_500),
      }),
    ).resolves.toMatchObject({ gapCents: 0, queueOperationId: null });
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("bills the gap UNPAID on the latest correction that routed its fee to the primary invoice", async () => {
    await expect(
      queuePrimaryInvoiceChangeFeeGap({
        bookingId: "booking_1",
        // The invoice Xero returned was built before the 40.00 fee was recorded.
        atLink: atLink(primaryInvoiceBilledFee("inv_1", [guestLine, feeLine(25)])),
        createdByMemberId: "officer_1",
      }),
    ).resolves.toEqual({ gapCents: 4_000, queueOperationId: "op_gap", alreadyQueued: false, cashTakenCents: 0 });
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
    // The primary invoice (total 22,500) recorded 22,500 of cash.
    const fees = atLink(primaryInvoiceBilledFee("inv_1", [guestLine, feeLine(25)]), 6_500, 22_500);
    // Captured exactly the primary's cash: nothing left over for the gap.
    mocks.payment.findUnique.mockResolvedValue({ ...unpaid, status: "SUCCEEDED", amountCents: 22_500 });
    await expect(queuePrimaryInvoiceChangeFeeGap({ bookingId: "booking_1", atLink: fees })).resolves.toMatchObject({
      cashTakenCents: 0,
    });
    expect(mocks.enqueue).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ recordPayment: false }));

    // Captured the primary's cash plus the 40.00 gap: the gap invoice takes it.
    mocks.payment.findUnique.mockResolvedValue({ ...unpaid, status: "SUCCEEDED", amountCents: 26_500 });
    await expect(queuePrimaryInvoiceChangeFeeGap({ bookingId: "booking_1", atLink: fees })).resolves.toMatchObject({
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
    await queuePrimaryInvoiceChangeFeeGap({ bookingId: "booking_1", atLink: fees });
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
    await queuePrimaryInvoiceChangeFeeGap({
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
      queuePrimaryInvoiceChangeFeeGap({
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
  });

  it("MUTATION round 5, finding 2: the credit the cap allows for is the allocation engine's ledger figure, behind the settle's gate", async () => {
    const card = { ...unpaid, status: "SUCCEEDED", amountCents: 8_500, creditAppliedCents: 2_000 };
    // The mirror says 20.00; the ledger still has 30.00 to allocate.
    mocks.memberCredit.aggregate.mockResolvedValue({ _sum: { amountCents: -3_000 } });
    await expect(cardSettleAppliedCreditCents("booking_1", card)).resolves.toBe(3_000);
    expect(mocks.memberCredit.aggregate).toHaveBeenCalledWith({
      where: { appliedToBookingId: "booking_1", type: "BOOKING_APPLIED", xeroCreditNoteId: null },
      _sum: { amountCents: true },
    });

    // Where the settle does not allocate, there is nothing to allow for.
    mocks.memberCredit.aggregate.mockClear();
    await expect(cardSettleAppliedCreditCents("booking_1", { ...card, source: PaymentSource.INTERNET_BANKING })).resolves.toBe(0);
    expect(mocks.memberCredit.aggregate).not.toHaveBeenCalled();
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
      queuePrimaryInvoiceChangeFeeGap({
        bookingId: "booking_1",
        atLink: atLink(primaryInvoiceBilledFee("inv_1", [guestLine, feeLine(25)])),
      }),
    ).resolves.toEqual({ gapCents: 4_000, queueOperationId: "op_earlier", alreadyQueued: true, cashTakenCents: 0 });
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
      queuePrimaryInvoiceChangeFeeGap({
        bookingId: "booking_1",
        atLink: atLink(primaryInvoiceBilledFee("inv_1", [guestLine, feeLine(25)])),
      }),
    ).resolves.toMatchObject({ alreadyQueued: true, cashTakenCents: 4_000 });

    mocks.xeroSyncOperation.findFirst.mockResolvedValue(null);
    mocks.xeroObjectLink.findFirst.mockResolvedValue({ id: "link_sent" });
    await queuePrimaryInvoiceChangeFeeGap({
      bookingId: "booking_1",
      atLink: atLink(primaryInvoiceBilledFee("inv_1", [guestLine, feeLine(25)])),
    });
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("is loud when no correction explains the gap, or the enqueue did not queue a fresh invoice", async () => {
    mocks.bookingModification.findMany.mockResolvedValueOnce([]);
    await queuePrimaryInvoiceChangeFeeGap({
      bookingId: "booking_1",
      atLink: atLink(primaryInvoiceBilledFee("inv_1", [guestLine])),
    });
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.logger.error).toHaveBeenCalledTimes(1);

    for (const outcome of ["none", "short-sent", "short-in-flight"]) {
      mocks.logger.error.mockClear();
      mocks.enqueue.mockResolvedValueOnce({ queueOperationId: null, outcome });
      await queuePrimaryInvoiceChangeFeeGap({
        bookingId: "booking_1",
        atLink: atLink(primaryInvoiceBilledFee("inv_1", [guestLine])),
      });
      expect(mocks.logger.error, outcome).toHaveBeenCalledTimes(1);
    }
  });

  it("is loud, and raises nothing, when the invoice bills more fee than was recorded at its link", async () => {
    await queuePrimaryInvoiceChangeFeeGap({
      bookingId: "booking_1",
      atLink: atLink(primaryInvoiceBilledFee("inv_1", [feeLine(30)]), 2_500),
    });
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.logger.error).toHaveBeenCalled();
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
    mocks.payment.update.mockResolvedValue({ changeFeeCents: 6_500 });
    const billed = primaryInvoiceBilledFee("inv_1", [guestLine, feeLine(25)]);

    await expect(
      persistPrimaryInvoiceLink({
        operationId: "op_create",
        paymentId: "pay_1",
        xeroInvoiceNumber: "INV-1",
        billed,
        primaryInvoiceCashCents: 8_000,
      }),
    ).resolves.toEqual({ ...billed, recordedChangeFeeCentsAtLink: 6_500, primaryInvoiceCashCents: 8_000 });

    const { prisma } = await import("@/lib/prisma");
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(mocks.payment.update).toHaveBeenCalledWith({
      where: { id: "pay_1" },
      data: { xeroInvoiceId: "inv_1", xeroInvoiceNumber: "INV-1" },
      select: { changeFeeCents: true },
    });
    expect(store.payload).toMatchObject({
      invoices: [],
      primaryInvoiceBilledFee: { ...billed, recordedChangeFeeCentsAtLink: 6_500, primaryInvoiceCashCents: 8_000 },
    });
  });

  it("MUTATION round 4, finding 1: a fee recorded after the link is never billed by the re-check", async () => {
    storedOperation();
    // The invoice billed the 25.00 recorded when its link was saved.
    mocks.payment.update.mockResolvedValue({ changeFeeCents: 2_500 });
    await persistPrimaryInvoiceLink({
      operationId: "op_create",
      paymentId: "pay_1",
      xeroInvoiceNumber: null,
      billed: primaryInvoiceBilledFee("inv_1", [guestLine, feeLine(25)]),
      primaryInvoiceCashCents: 0,
    });
    // A later edit records 30.00 more, billed on its own document.
    mocks.payment.findUnique.mockResolvedValue({ ...unpaid, changeFeeCents: 5_500 });

    await expect(
      recheckPrimaryInvoiceChangeFeeGap({ bookingId: "booking_1", xeroInvoiceId: "inv_1" }),
    ).resolves.toEqual({ gapCents: 0, queueOperationId: null, alreadyQueued: false, cashTakenCents: 0 });
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("round 3, finding 2: a check that throws after the link is saved is billed by the retry", async () => {
    storedOperation();
    // The create saves its link with what it billed and the fee recorded
    // then, and the gap check dies.
    mocks.payment.update.mockResolvedValue({ changeFeeCents: 6_500 });
    const fees = await persistPrimaryInvoiceLink({
      operationId: "op_create",
      paymentId: "pay_1",
      xeroInvoiceNumber: null,
      billed: primaryInvoiceBilledFee("inv_1", [guestLine, feeLine(25)]),
      primaryInvoiceCashCents: 0,
    });
    mocks.enqueue.mockRejectedValueOnce(new Error("connection reset"));
    await expect(queuePrimaryInvoiceChangeFeeGap({ bookingId: "booking_1", atLink: fees })).rejects.toThrow(
      "connection reset",
    );

    // The retry takes the create's "invoice already exists" exit, which
    // re-runs the check from the stored figures.
    await expect(
      recheckPrimaryInvoiceChangeFeeGap({ bookingId: "booking_1", xeroInvoiceId: "inv_1" }),
    ).resolves.toEqual({ gapCents: 4_000, queueOperationId: "op_gap", alreadyQueued: false, cashTakenCents: 0 });
    expect(mocks.enqueue).toHaveBeenLastCalledWith(
      { bookingId: "booking_1", priceDiffCents: 0, changeFeeCents: 4_000, bookingModificationId: "mod_late" },
      { createdByMemberId: undefined, recordPayment: false },
    );
  });

  it("round 5, finding 4: stored figures without the primary's cash are not figures the gap rule can read", async () => {
    mocks.xeroSyncOperation.findFirst.mockResolvedValue({
      requestPayload: {
        primaryInvoiceBilledFee: { xeroInvoiceId: "inv_1", billedChangeFeeCents: 2_500, billedTotalCents: 22_500, recordedChangeFeeCentsAtLink: 6_500 },
      },
    });
    mocks.payment.findUnique.mockResolvedValue({ changeFeeCents: 6_500 });
    await expect(recheckPrimaryInvoiceChangeFeeGap({ bookingId: "booking_1", xeroInvoiceId: "inv_1" })).resolves.toMatchObject({
      gapCents: 0,
      queueOperationId: null,
    });
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.logger.warn).toHaveBeenCalledWith(expect.anything(), expect.stringContaining("not checked"));
  });

  it("round 4, finding 2: a retry of an invoice with no stored figures bills nothing, loudly when a fee is recorded", async () => {
    mocks.payment.findUnique.mockResolvedValue({ changeFeeCents: 0 });
    await expect(
      recheckPrimaryInvoiceChangeFeeGap({ bookingId: "booking_1", xeroInvoiceId: "inv_legacy" }),
    ).resolves.toEqual({ gapCents: 0, queueOperationId: null, alreadyQueued: false, cashTakenCents: 0 });
    expect(mocks.xeroSyncOperation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          requestPayload: { path: ["primaryInvoiceBilledFee", "xeroInvoiceId"], equals: "inv_legacy" },
        }),
      }),
    );
    expect(mocks.logger.warn).not.toHaveBeenCalled();

    mocks.payment.findUnique.mockResolvedValue({ changeFeeCents: 2_500 });
    await recheckPrimaryInvoiceChangeFeeGap({ bookingId: "booking_1", xeroInvoiceId: "inv_legacy" });
    expect(mocks.logger.warn).toHaveBeenCalledTimes(1);
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ xeroInvoiceId: "inv_legacy", recordedChangeFeeCents: 2_500 }),
      expect.stringContaining("not checked"),
    );
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
});
