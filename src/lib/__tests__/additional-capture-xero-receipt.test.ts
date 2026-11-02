/**
 * #3953 (`INV-PAY-139`): a booking change's card capture that nothing else
 * records is recorded against the Xero invoice that bills it - the gap invoice
 * where the capture's change is one it bills for, otherwise the primary -
 * capped at what Xero shows due, once, by one recorder, and refused with an
 * officer told wherever the figures do not fit.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findUniqueOperation: vi.fn(),
  findFirstOperation: vi.fn(),
  findManyOperation: vi.fn(),
  updateOperation: vi.fn(),
  updateManyOperation: vi.fn(),
  findFirstLink: vi.fn(),
  findUniqueTransaction: vi.fn(),
  findManyTransaction: vi.fn(),
  findUniqueOrThrowPayment: vi.fn(),
  findFirstRefund: vi.fn(),
  transaction: vi.fn(),
  completeXeroSyncOperation: vi.fn(),
  failXeroSyncOperation: vi.fn(),
  startXeroSyncOperation: vi.fn(),
  sendAdminXeroSyncErrorAlert: vi.fn(),
  readCaptureRecorder: vi.fn(),
  lateCaptureRefundState: vi.fn(),
  cardSettleAppliedCreditCents: vi.fn(),
  recheckPrimaryInvoiceWorthGap: vi.fn(),
  lockSupplementaryInvoiceAnchor: vi.fn(),
  // Round 9: reads inside the switch's and the plan store's transactions.
  txFindFirstLink: vi.fn(),
  txFindManyModification: vi.fn(),
  txFindManyLink: vi.fn(),
  // #4324: the capture's approval task, and what a kept capture's receipt does once recorded.
  findUniqueTask: vi.fn(),
  creditBackLateCaptureRefunds: vi.fn(),
  queueWaitingPaidAnotherWayNote: vi.fn(),
  // #4494: the unpaid payload a gap invoice's payment overlapping the credit-release sweep's share is sent with.
  unpaidGapPayloadIfOverlapping: vi.fn(),
}));
vi.mock("@/lib/credit-release-xero-payment", () => ({ unpaidGapPayloadIfOverlapping: mocks.unpaidGapPayloadIfOverlapping }));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    xeroSyncOperation: {
      findUnique: mocks.findUniqueOperation,
      findFirst: mocks.findFirstOperation,
      findMany: mocks.findManyOperation,
      update: mocks.updateOperation,
      updateMany: mocks.updateManyOperation,
    },
    xeroObjectLink: { findFirst: mocks.findFirstLink },
    paymentTransaction: { findUnique: mocks.findUniqueTransaction, findMany: mocks.findManyTransaction },
    payment: { findUniqueOrThrow: mocks.findUniqueOrThrowPayment },
    paymentRefund: { findFirst: mocks.findFirstRefund },
    manualRefundTask: { findUnique: mocks.findUniqueTask },
    $transaction: mocks.transaction,
  },
}));
vi.mock("@/lib/late-capture-refund-credit-note", () => ({ creditBackLateCaptureRefunds: mocks.creditBackLateCaptureRefunds }));
vi.mock("@/lib/paid-another-way-receipt-note", () => ({ queueWaitingPaidAnotherWayNote: mocks.queueWaitingPaidAnotherWayNote }));
vi.mock("@/lib/logger", () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/email", () => ({ sendAdminXeroSyncErrorAlert: mocks.sendAdminXeroSyncErrorAlert }));
vi.mock("@/lib/club-time-zone-runtime", () => ({
  readClubTimeZoneOutsideRequest: vi.fn().mockResolvedValue("Pacific/Auckland"),
}));
vi.mock("@/lib/club-format-server", () => ({
  clubFormatValues: vi.fn().mockResolvedValue({ currencyCode: "NZD", locale: "en-NZ" }),
}));
vi.mock("@/lib/utils", () => ({ formatCents: (cents: number) => `$${(cents / 100).toFixed(2)}` }));
vi.mock("@/lib/xero-sync", () => ({
  buildXeroIdempotencyKey: (...parts: unknown[]) => parts.join(":"),
  completeXeroSyncOperation: mocks.completeXeroSyncOperation,
  failXeroSyncOperation: mocks.failXeroSyncOperation,
  sanitizeForJson: (value: unknown) => value,
  startXeroSyncOperation: mocks.startXeroSyncOperation,
}));
vi.mock("@/lib/additional-capture-recorder", () => ({ readCaptureRecorder: mocks.readCaptureRecorder }));
vi.mock("@/lib/xero-supplementary-invoice-late-capture", () => ({
  lateCaptureRefundState: mocks.lateCaptureRefundState,
}));
vi.mock("@/lib/xero-primary-invoice-fee-gap", () => ({
  cardSettleAppliedCreditCents: mocks.cardSettleAppliedCreditCents,
  // The real cap, so the applied credit's reservation is exercised here.
  primaryInvoiceStripeCashCents: (input: { netCapturedCents: number; amountDueCents: number | null; appliedCreditCents: number }) =>
    input.amountDueCents === null
      ? input.netCapturedCents
      : Math.max(0, Math.min(input.netCapturedCents, input.amountDueCents - input.appliedCreditCents)),
  recheckPrimaryInvoiceWorthGap: mocks.recheckPrimaryInvoiceWorthGap,
}));
vi.mock("@/lib/xero-operation-outbox", () => ({
  lockSupplementaryInvoiceAnchor: mocks.lockSupplementaryInvoiceAnchor,
}));

import {
  ADDITIONAL_CAPTURE_RECEIPT_REFUSED_CODE,
  chooseAdditionalCaptureReceiptTarget,
  recordAdditionalCaptureReceipt,
  type AdditionalCaptureReceiptProviders,
} from "@/lib/additional-capture-xero-receipt";
import {
  enqueueAdditionalCaptureReceiptOperation,
  queueReceiptsForUnrecordedCaptures,
} from "@/lib/additional-capture-receipt-enqueue";
import { readAdditionalCaptureReceiptPayload } from "@/lib/additional-capture-receipt-payload";
import { ADDITIONAL_CAPTURE_RECEIPT_WAITING_CODE, supplementaryReplayMayRecordPayment } from "@/lib/additional-capture-receipt-gate";
import { ADDITIONAL_CAPTURE_PAYMENT_ROLE } from "@/lib/additional-capture-receipt-link";
import { buildEditFinancialReviewChargeReason } from "@/lib/payment-recovery-keys";
import { XeroAppliedCreditOperationBusyError } from "@/lib/xero-applied-credit-operation-serialization";
import { TEST_XERO_CLAIMED_AT, xeroClaim } from "@/lib/__tests__/helpers/xero-claim";

const PRIMARY = "11111111-1111-4111-8111-111111111111";
const GAP = "22222222-2222-4222-8222-222222222222";
const PAYLOAD = {
  queueType: "ADDITIONAL_CAPTURE_RECEIPT",
  bookingId: "booking_1",
  paymentId: "payment_1",
  paymentTransactionId: "ptx_1",
  paymentIntentId: "pi_change",
};

/** `amountDue` in cents here; Xero sends major units, so the fake divides. */
type InvoiceState = { status?: string; amountDue: number; payments?: Array<Record<string, unknown>> };
let invoices: Record<string, InvoiceState>;
let order: string[];
/** The other writers `waitForOtherWriters` and the primary's own-payment check read. */
let rows: {
  otherReceiptRunning: boolean;
  createRunning: boolean;
  primaryCreate: { status: string; responsePayload: unknown; manuallyResolvedAt: Date | null } | null;
};

function providers(): AdditionalCaptureReceiptProviders & { createXeroPaymentForInvoice: ReturnType<typeof vi.fn> } {
  return {
    getAuthenticatedXeroClient: vi.fn().mockResolvedValue({
      tenantId: "tenant_1",
      xero: {
        accountingApi: {
          getInvoice: vi.fn(async (_tenant: string, id: string) => {
            const state = invoices[id];
            return {
              body: {
                invoices: state
                  ? [{ invoiceID: id, status: state.status ?? "AUTHORISED", amountDue: state.amountDue / 100, payments: state.payments ?? [] }]
                  : [],
              },
            };
          }),
        },
      },
    }),
    callXeroApi: vi.fn(async (call: () => Promise<unknown>) => call()) as never,
    createXeroPaymentForInvoice: vi.fn(async () => {
      order.push("createPayment");
      return "xero_payment_1";
    }),
    readStripeCaptureDocumentDate: vi.fn().mockResolvedValue("2026-06-30"),
  };
}

function capture(overrides: Record<string, unknown> = {}, booking = "CONFIRMED", paymentSource = "STRIPE") {
  return {
    kind: "ADDITIONAL",
    source: "STRIPE",
    status: "SUCCEEDED",
    amountCents: 8000,
    stripePaymentIntentId: "pi_change",
    bookingModificationId: "mod_change",
    payment: {
      id: "payment_1",
      source: paymentSource,
      status: "SUCCEEDED",
      amountCents: 38000,
      refundedAmountCents: 0,
      creditAppliedCents: 0,
      xeroInvoiceId: PRIMARY,
      booking: { status: booking },
    },
    ...overrides,
  };
}

const receiptRecorder = (overrides: Record<string, unknown> = {}) => ({
  kind: "receipt",
  figures: { operationId: "op_primary", atLink: { xeroInvoiceId: PRIMARY, paymentIntentIdsRecordedAtLink: ["pi_primary"] } },
  gap: null,
  target: null,
  alreadyRecordedCents: 0,
  ...overrides,
});
const gapInXero = (status = "SUCCEEDED", recordPayment = false) => ({
  operation: { id: "op_gap", status, requestPayload: { recordPayment }, responsePayload: {}, manuallyResolvedAt: null },
  link: { id: "link_gap", xeroObjectId: GAP, active: status === "SUCCEEDED" || status === "PARTIAL" },
  anchorIds: ["mod_change"],
});
/** The recorder's answer where the gap invoice bills the capture's change (C). */
const gapTarget = (status = "SUCCEEDED") => {
  const gap = gapInXero(status);
  return receiptRecorder({ gap, target: { kind: "GAP_INVOICE", operation: gap.operation, link: gap.link } });
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.unpaidGapPayloadIfOverlapping.mockResolvedValue(null);
  order = [];
  invoices = { [PRIMARY]: { amountDue: 8000 } };
  rows = { otherReceiptRunning: false, createRunning: false, primaryCreate: { status: "SUCCEEDED", responsePayload: {}, manuallyResolvedAt: null } };
  mocks.findUniqueOperation.mockResolvedValue({ requestPayload: PAYLOAD });
  mocks.findFirstOperation.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
    if (where.queueType === "ADDITIONAL_CAPTURE_RECEIPT") return rows.otherReceiptRunning ? { id: "op_other" } : null;
    if (where.status === "RUNNING") return rows.createRunning ? { id: "op_create" } : null;
    if (where.xeroObjectId) return rows.primaryCreate;
    return null;
  });
  mocks.findManyOperation.mockResolvedValue([]);
  mocks.findFirstLink.mockResolvedValue(null);
  mocks.findUniqueTransaction.mockResolvedValue(capture());
  mocks.findFirstRefund.mockResolvedValue(null);
  mocks.findUniqueOrThrowPayment.mockResolvedValue({ source: "STRIPE", status: "SUCCEEDED", amountCents: 38000, refundedAmountCents: 0, creditAppliedCents: 0 });
  mocks.lateCaptureRefundState.mockResolvedValue("kept");
  mocks.readCaptureRecorder.mockResolvedValue(receiptRecorder());
  mocks.cardSettleAppliedCreditCents.mockResolvedValue(0);
  mocks.recheckPrimaryInvoiceWorthGap.mockResolvedValue({
    gapCents: 0,
    queueOperationId: null,
    alreadyQueued: false,
    cashTakenCents: 0,
    reviewOperationId: null,
  });
  mocks.updateOperation.mockImplementation(async () => {
    order.push("storePlan");
    return {};
  });
  mocks.updateManyOperation.mockResolvedValue({ count: 1 });
  // Round 4: the planning gate runs on a transaction of its own; round 6: so
  // does storing the decision, and switching another invoice unpaid.
  mocks.transaction.mockImplementation(async (fn: (client: unknown) => unknown) =>
    fn({
      xeroSyncOperation: {
        findFirst: mocks.findFirstOperation,
        findUnique: mocks.findUniqueOperation,
        findMany: mocks.findManyOperation,
        update: mocks.updateOperation,
        updateMany: mocks.updateManyOperation,
      },
      xeroObjectLink: { findFirst: mocks.txFindFirstLink, findMany: mocks.txFindManyLink },
      bookingModification: { findMany: mocks.txFindManyModification },
      paymentTransaction: { findMany: mocks.findManyTransaction },
      manualRefundTask: { findUnique: mocks.findUniqueTask },
    }),
  );
  mocks.findUniqueTask.mockResolvedValue(null);
  mocks.txFindFirstLink.mockResolvedValue(null);
  mocks.txFindManyModification.mockResolvedValue([]);
  mocks.txFindManyLink.mockResolvedValue([]);
});

const run = (seam = providers()) => recordAdditionalCaptureReceipt({ syncOperation: xeroClaim("op_receipt") }, seam);
const storedPlan = () => mocks.updateOperation.mock.calls[0]?.[0]?.data?.requestPayload?.plan;
const expectRefused = (reason: string) => {
  expect(mocks.failXeroSyncOperation).toHaveBeenCalledWith(
    expect.objectContaining({ id: "op_receipt" }),
    expect.any(Error),
    expect.objectContaining({ refused: reason }),
    expect.objectContaining({ lastErrorMessage: expect.stringContaining("was not recorded in Xero") }),
  );
  expect(mocks.updateManyOperation).toHaveBeenCalledWith({
    where: { id: "op_receipt", status: "FAILED", startedAt: TEST_XERO_CLAIMED_AT },
    data: { lastErrorCode: ADDITIONAL_CAPTURE_RECEIPT_REFUSED_CODE },
  });
  expect(mocks.sendAdminXeroSyncErrorAlert).toHaveBeenCalledTimes(1);
};
const expectWait = async (seam = providers()) => {
  const error = await run(seam).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(XeroAppliedCreditOperationBusyError);
  expect(error).toMatchObject({ waitCode: ADDITIONAL_CAPTURE_RECEIPT_WAITING_CODE });
  expect(mocks.failXeroSyncOperation).not.toHaveBeenCalled();
  expect(seam.createXeroPaymentForInvoice).not.toHaveBeenCalled();
};

describe("chooseAdditionalCaptureReceiptTarget", () => {
  it("takes the first candidate with room, capped at the room", () => {
    expect(
      chooseAdditionalCaptureReceiptTarget(8000, [
        { target: "GAP_INVOICE", invoiceId: GAP, roomCents: 0 },
        { target: "PRIMARY_INVOICE", invoiceId: PRIMARY, roomCents: 5000 },
      ]),
    ).toEqual({ target: "PRIMARY_INVOICE", invoiceId: PRIMARY, amountCents: 5000 });
  });

  it("chooses nothing where no invoice has room or nothing was captured", () => {
    expect(chooseAdditionalCaptureReceiptTarget(8000, [{ target: "PRIMARY_INVOICE", invoiceId: PRIMARY, roomCents: 0 }])).toBeNull();
    expect(chooseAdditionalCaptureReceiptTarget(0, [{ target: "PRIMARY_INVOICE", invoiceId: PRIMARY, roomCents: 100 }])).toBeNull();
  });
});

describe("recordAdditionalCaptureReceipt", () => {
  it("records the capture against the primary invoice that bills it, its decision stored before Xero is asked", async () => {
    const seam = providers();

    await expect(run(seam)).resolves.toBe("xero_payment_1");

    expect(order).toEqual(["storePlan", "createPayment"]);
    expect(storedPlan()).toEqual({
      target: "PRIMARY_INVOICE",
      invoiceId: PRIMARY,
      amountCents: 8000,
      capturedCents: 8000,
      date: "2026-06-30",
    });
    expect(seam.createXeroPaymentForInvoice).toHaveBeenCalledWith(
      expect.objectContaining({
        localModel: "PaymentTransaction",
        localId: "ptx_1",
        invoiceId: PRIMARY,
        amountCents: 8000,
        idempotencyKey: `payment-intent:pi_change:additional-capture-payment:${PRIMARY}:v1`,
        reference: "Stripe pi_change",
        role: ADDITIONAL_CAPTURE_PAYMENT_ROLE,
        date: "2026-06-30",
      }),
    );
    expect(mocks.completeXeroSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({ id: "op_receipt" }),
      expect.objectContaining({
        xeroObjectType: "PAYMENT",
        xeroObjectId: "xero_payment_1",
        extraLinks: [expect.objectContaining({ role: ADDITIONAL_CAPTURE_PAYMENT_ROLE, localId: "ptx_1" })],
      }),
    );
    expect(mocks.sendAdminXeroSyncErrorAlert).not.toHaveBeenCalled();
  });

  it("records it against the #3980 gap invoice where the capture's change is one the gap bills for", async () => {
    invoices[GAP] = { amountDue: 8000 };
    mocks.readCaptureRecorder.mockResolvedValue(gapTarget());
    const seam = providers();

    await run(seam);

    expect(seam.createXeroPaymentForInvoice).toHaveBeenCalledWith(expect.objectContaining({ invoiceId: GAP, amountCents: 8000 }));
    expect(storedPlan()).toEqual(expect.objectContaining({ target: "GAP_INVOICE" }));
    expect(mocks.recheckPrimaryInvoiceWorthGap).not.toHaveBeenCalled();
  });

  it("records it against the primary, never the gap invoice, where the gap bills another change (C)", async () => {
    invoices[GAP] = { amountDue: 8000 };
    mocks.readCaptureRecorder.mockResolvedValue(receiptRecorder({ gap: gapInXero(), target: null }));
    const seam = providers();

    await run(seam);

    expect(seam.createXeroPaymentForInvoice).toHaveBeenCalledWith(expect.objectContaining({ invoiceId: PRIMARY }));
    expect(mocks.recheckPrimaryInvoiceWorthGap).not.toHaveBeenCalled();
  });

  it("leaves room on the primary for the applied credit its settle still allocates there", async () => {
    invoices[PRIMARY] = { amountDue: 10000 };
    mocks.cardSettleAppliedCreditCents.mockResolvedValue(4000);
    const seam = providers();

    await run(seam);

    expect(seam.createXeroPaymentForInvoice).toHaveBeenCalledWith(expect.objectContaining({ amountCents: 6000 }));
    // The 20.00 the invoice could not take is told to an officer, with both figures.
    expect(mocks.sendAdminXeroSyncErrorAlert).toHaveBeenCalledWith(
      expect.objectContaining({ errorMessage: expect.stringContaining("$20.00") }),
    );
  });

  it("records only the part the primary's or the gap invoice's own payment did not take (F2)", async () => {
    // The primary's payment reached 30.00 of it, or the gap invoice's took that much (F2).
    mocks.readCaptureRecorder.mockResolvedValue(receiptRecorder({ alreadyRecordedCents: 3000 }));
    const seam = providers();

    await run(seam);

    expect(seam.createXeroPaymentForInvoice).toHaveBeenCalledWith(expect.objectContaining({ amountCents: 5000 }));
    expect(storedPlan()).toEqual(expect.objectContaining({ capturedCents: 5000 }));
  });

  describe("one recorder per capture (review round 1)", () => {
    it.each([
      ["the primary invoice's own payment", { kind: "primary-invoice" }, "recorded-by-primary-invoice"],
      ["a supplementary invoice for the change, or naming or covering it", { kind: "supplementary-invoice", operationId: "op_supp" }, "recorded-by-supplementary-invoice"],
      ["the credit-release sweep (#4253)", { kind: "credit-release-sweep" }, "recorded-by-credit-release-sweep"],
    ])("stands down, writing nothing to Xero, where %s records it", async (_label, recorder, skipped) => {
      mocks.readCaptureRecorder.mockResolvedValue(recorder);
      const seam = providers();

      await expect(run(seam)).resolves.toBeNull();

      expect(seam.getAuthenticatedXeroClient).not.toHaveBeenCalled();
      expect(mocks.completeXeroSyncOperation).toHaveBeenCalledWith(
        expect.objectContaining({ id: "op_receipt" }),
        expect.objectContaining({ status: "SUCCEEDED", responsePayload: expect.objectContaining({ skipped }) }),
      );
    });

    it("asks who records it with the capture's own change", async () => {
      await run();
      expect(mocks.readCaptureRecorder).toHaveBeenCalledWith({
        bookingId: "booking_1",
        primaryInvoiceId: PRIMARY,
        paymentIntentId: "pi_change",
        bookingModificationId: "mod_change",
      });
    });

    it("waits while another receipt for the booking is being recorded (D)", async () => {
      rows.otherReceiptRunning = true;
      await expectWait();
      expect(mocks.readCaptureRecorder).not.toHaveBeenCalled();
    });

    it("passes a gate under the booking's anchor lock: waits for a LIVE receipt past it, else stamps its own row (round 4, item 2)", async () => {
      await run();
      expect(mocks.lockSupplementaryInvoiceAnchor).toHaveBeenCalledWith(expect.anything(), "booking_1");
      const gateRead = mocks.findFirstOperation.mock.calls.map((call) => call[0].where).find((where) => where.queueType === "ADDITIONAL_CAPTURE_RECEIPT");
      expect(gateRead).toMatchObject({
        id: { not: "op_receipt" },
        lastErrorCode: "ADDITIONAL_CAPTURE_RECEIPT_PLANNING",
        status: "RUNNING",
        // Live only: a dead row past the staleness threshold blocks nothing (C1).
        startedAt: { gte: expect.any(Date) },
      });
      expect(gateRead).not.toHaveProperty("AND");
      expect(mocks.updateManyOperation).toHaveBeenCalledWith({
        where: { id: "op_receipt", status: "RUNNING" },
        data: { lastErrorCode: "ADDITIONAL_CAPTURE_RECEIPT_PLANNING" },
      });
      expect(mocks.lockSupplementaryInvoiceAnchor.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.readCaptureRecorder.mock.invocationCallOrder[0],
      );
      // A create dead past the staleness threshold blocks nothing.
      const createRead = mocks.findFirstOperation.mock.calls.map((call) => call[0].where).find((where) => where.correlationKey && where.status);
      expect(createRead).toMatchObject({ status: "RUNNING", startedAt: { gte: expect.any(Date) } });
    });

    it("stamps nothing, and plans nothing, while another receipt holds the gate", async () => {
      rows.otherReceiptRunning = true;
      await expectWait();
      expect(mocks.updateManyOperation).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: { lastErrorCode: "ADDITIONAL_CAPTURE_RECEIPT_PLANNING" } }),
      );
    });

    it("waits while the booking's invoice create is still running (D)", async () => {
      rows.createRunning = true;
      await expectWait();
    });

    it("waits, before sending even a stored decision, while another writer runs", async () => {
      mocks.findUniqueOperation.mockResolvedValue({
        requestPayload: { ...PAYLOAD, plan: { target: "PRIMARY_INVOICE", invoiceId: PRIMARY, amountCents: 8000, capturedCents: 8000, date: "2026-06-30" } },
      });
      rows.otherReceiptRunning = true;
      await expectWait();
    });
  });

  it("records it against the change's own invoice raised UNPAID, which bills the change (round 3, F1)", async () => {
    const CHANGE = "33333333-3333-4333-8333-333333333333";
    invoices[CHANGE] = { amountDue: 8000 };
    mocks.readCaptureRecorder.mockResolvedValue(
      receiptRecorder({
        target: {
          kind: "CHANGE_INVOICE",
          operation: { id: "op_change", status: "SUCCEEDED", requestPayload: { recordPayment: false }, responsePayload: {}, manuallyResolvedAt: null },
          link: { id: "link_change", xeroObjectId: CHANGE, active: true },
        },
      }),
    );
    const seam = providers();

    await run(seam);

    expect(seam.createXeroPaymentForInvoice).toHaveBeenCalledWith(expect.objectContaining({ invoiceId: CHANGE, amountCents: 8000 }));
    expect(storedPlan()).toEqual(expect.objectContaining({ target: "CHANGE_INVOICE" }));
    expect(mocks.recheckPrimaryInvoiceWorthGap).not.toHaveBeenCalled();
  });

  it("waits, failing nothing, while the gap invoice for its change is still on its way to Xero", async () => {
    mocks.readCaptureRecorder.mockResolvedValue(gapTarget("PENDING"));
    const seam = providers();
    await expectWait(seam);
    expect(seam.getAuthenticatedXeroClient).not.toHaveBeenCalled();
  });

  it("returns at once, and writes nothing to Xero, when the capture's payment is already linked", async () => {
    mocks.findFirstLink.mockResolvedValue({ xeroObjectId: "xero_payment_earlier" });
    const seam = providers();

    await expect(run(seam)).resolves.toBe("xero_payment_earlier");

    expect(seam.getAuthenticatedXeroClient).not.toHaveBeenCalled();
    expect(mocks.findUniqueTransaction).not.toHaveBeenCalled();
  });

  it("links the payment an earlier run recorded, found by its reference, rather than recording a second", async () => {
    invoices[PRIMARY] = {
      amountDue: 0,
      payments: [{ paymentID: "xero_payment_lost", reference: "Stripe pi_change", amount: 80, status: "AUTHORISED" }],
    };
    const seam = providers();

    await run(seam);

    expect(seam.createXeroPaymentForInvoice).not.toHaveBeenCalled();
    expect(mocks.completeXeroSyncOperation).toHaveBeenCalledWith(expect.objectContaining({ id: "op_receipt" }), expect.objectContaining({ xeroObjectId: "xero_payment_lost" }));
  });

  it.each([
    ["a booking since cancelled (K)", capture({}, "CANCELLED"), "booking-cancelled"],
    ["a booking paid by internet banking (H)", capture({}, "CONFIRMED", "INTERNET_BANKING"), "not-a-card-booking"],
  ])("closes the row unsent, telling nobody, for %s", async (_label, transaction, skipped) => {
    mocks.findUniqueTransaction.mockResolvedValue(transaction);
    const seam = providers();

    await expect(run(seam)).resolves.toBeNull();

    expect(mocks.completeXeroSyncOperation).toHaveBeenCalledWith(expect.objectContaining({ id: "op_receipt" }), { status: "CANCELLED", responsePayload: { skipped } });
    expect(mocks.sendAdminXeroSyncErrorAlert).not.toHaveBeenCalled();
    expect(seam.getAuthenticatedXeroClient).not.toHaveBeenCalled();
  });

  /**
   * #4324 (owner decision 25 Oct 2026; `INV-PAY-144`): a late capture a
   * treasurer KEPT on a cancelled booking whose primary invoice bills its
   * change is recorded as a payment on that invoice, capped at what Xero
   * shows due.
   */
  describe("#4324: a kept capture on a cancelled booking", () => {
    beforeEach(() => {
      mocks.findUniqueTransaction.mockResolvedValue(capture({}, "CANCELLED"));
      mocks.findUniqueTask.mockResolvedValue({ id: "task_kept", status: "DISMISSED" });
    });

    it("MUTATION: records it against the primary that bills the change, then answers its refunds and a waiting close's note", async () => {
      const seam = providers();
      await expect(run(seam)).resolves.toBe("xero_payment_1");
      expect(storedPlan()).toEqual(expect.objectContaining({ target: "PRIMARY_INVOICE", invoiceId: PRIMARY, amountCents: 8000 }));
      expect(seam.createXeroPaymentForInvoice).toHaveBeenCalledWith(expect.objectContaining({ invoiceId: PRIMARY, amountCents: 8000 }));
      expect(mocks.creditBackLateCaptureRefunds).toHaveBeenCalledWith("pi_change");
      expect(mocks.queueWaitingPaidAnotherWayNote).toHaveBeenCalledWith("pi_change");
      expect(mocks.creditBackLateCaptureRefunds.mock.invocationCallOrder[0]).toBeGreaterThan(
        mocks.completeXeroSyncOperation.mock.invocationCallOrder[0]!,
      );
    });

    it("keeps the receipt successful when the post-record refund follow-up cannot read its task", async () => {
      const failure = new Error("task lookup unavailable");
      mocks.completeXeroSyncOperation.mockImplementationOnce(async () => {
        // Only the follow-up fails; the locked planning reads already succeeded.
        mocks.findUniqueTask.mockRejectedValueOnce(failure);
      });
      const seam = providers();
      await expect(run(seam)).resolves.toBe("xero_payment_1");
      expect(seam.createXeroPaymentForInvoice).toHaveBeenCalledTimes(1);
      expect(mocks.completeXeroSyncOperation).toHaveBeenCalledTimes(1);
      expect(mocks.failXeroSyncOperation).not.toHaveBeenCalled();
      expect(mocks.creditBackLateCaptureRefunds).not.toHaveBeenCalled();
      expect(mocks.queueWaitingPaidAnotherWayNote).not.toHaveBeenCalled();
    });

    it("MUTATION: caps it at Xero's AmountDue, tells an officer the rest, and never raises a gap invoice on a cancelled booking", async () => {
      invoices[PRIMARY] = { amountDue: 5000 };
      const seam = providers();
      await run(seam);
      expect(seam.createXeroPaymentForInvoice).toHaveBeenCalledWith(expect.objectContaining({ amountCents: 5000 }));
      expect(mocks.recheckPrimaryInvoiceWorthGap).not.toHaveBeenCalled();
      expect(mocks.sendAdminXeroSyncErrorAlert).toHaveBeenCalledTimes(1);
    });

    it("refuses, telling an officer, where the primary has nothing due - never overpaying it", async () => {
      invoices[PRIMARY] = { amountDue: 0 };
      const seam = providers();
      await run(seam);
      expectRefused("nothing-due");
      expect(mocks.recheckPrimaryInvoiceWorthGap).not.toHaveBeenCalled();
      expect(seam.createXeroPaymentForInvoice).not.toHaveBeenCalled();
    });

    // #4673 (PR #4687 review): a refusal whose failure lost its claim (an officer's
    // Retry queued the row again, or a later run failed it) stamps nothing and
    // alerts nobody: the run that holds the row decides.
    it("MUTATION: a refusal whose failure was refused (INV-INT-029) stamps no code and alerts no officer", async () => {
      invoices[PRIMARY] = { amountDue: 0 };
      mocks.failXeroSyncOperation.mockResolvedValueOnce(null);
      const seam = providers();
      await expect(run(seam)).resolves.toBeNull();
      expect(mocks.failXeroSyncOperation).toHaveBeenCalledTimes(1);
      expect(mocks.updateManyOperation).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: { lastErrorCode: ADDITIONAL_CAPTURE_RECEIPT_REFUSED_CODE } }),
      );
      expect(mocks.sendAdminXeroSyncErrorAlert).not.toHaveBeenCalled();
      expect(seam.createXeroPaymentForInvoice).not.toHaveBeenCalled();
    });

    it("MUTATION: stands down, unsent, where the task was reopened or approved before the decision was stored (read under the anchor lock)", async () => {
      mocks.findUniqueTask
        .mockResolvedValueOnce({ id: "task_kept", status: "DISMISSED" })
        .mockResolvedValueOnce({ status: "COMPLETED" });
      const seam = providers();
      await expect(run(seam)).resolves.toBeNull();
      // Review C1: closed in the transaction that read it, guarded on its claim.
      expect(mocks.updateManyOperation).toHaveBeenCalledWith({
        where: { id: "op_receipt", status: "RUNNING", startedAt: TEST_XERO_CLAIMED_AT, manuallyResolvedAt: null },
        data: expect.objectContaining({
          status: "CANCELLED",
          responsePayload: { skipped: "capture-not-kept", decidedAgainUnderLock: true },
        }),
      });
      expect(mocks.completeXeroSyncOperation).not.toHaveBeenCalled();
      expect(mocks.updateOperation).not.toHaveBeenCalled();
      expect(seam.createXeroPaymentForInvoice).not.toHaveBeenCalled();
      const lock = mocks.lockSupplementaryInvoiceAnchor.mock.invocationCallOrder.at(-1)!;
      expect(lock).toBeLessThan(mocks.findUniqueTask.mock.invocationCallOrder.at(-1)!);
    });

    it("MUTATION review C1: a reopened task read before any Xero call is decided again under the anchor and closed there, never left to an unlocked stand-down", async () => {
      mocks.lateCaptureRefundState.mockResolvedValue("pending");
      mocks.findUniqueTask.mockResolvedValueOnce({ id: "task_kept", status: "OPEN" }).mockResolvedValueOnce({ status: "OPEN" });
      const seam = providers();
      await expect(run(seam)).resolves.toBeNull();
      expect(mocks.updateManyOperation).toHaveBeenCalledWith({
        where: { id: "op_receipt", status: "RUNNING", startedAt: TEST_XERO_CLAIMED_AT, manuallyResolvedAt: null },
        data: expect.objectContaining({ status: "CANCELLED", responsePayload: expect.objectContaining({ refundState: "pending" }) }),
      });
      expect(mocks.completeXeroSyncOperation).not.toHaveBeenCalled();
      expect(seam.getAuthenticatedXeroClient).not.toHaveBeenCalled();
      const lock = mocks.lockSupplementaryInvoiceAnchor.mock.invocationCallOrder.at(-1)!;
      expect(lock).toBeLessThan(mocks.findUniqueTask.mock.invocationCallOrder.at(-1)!);
    });

    it("review C1: kept again by the time the anchor is held, it goes on and records", async () => {
      mocks.lateCaptureRefundState.mockResolvedValue("pending");
      mocks.findUniqueTask.mockResolvedValue({ id: "task_kept", status: "DISMISSED" });
      const seam = providers();
      await expect(run(seam)).resolves.toBe("xero_payment_1");
    });

    it("stands down where its kept-capture invoice records it (INV-PAY-139)", async () => {
      mocks.readCaptureRecorder.mockResolvedValue({ kind: "kept-late-capture-invoice", operationId: "op_kept" });
      const seam = providers();
      await expect(run(seam)).resolves.toBeNull();
      expect(mocks.completeXeroSyncOperation).toHaveBeenCalledWith(expect.objectContaining({ id: "op_receipt" }), {
        status: "SUCCEEDED",
        responsePayload: { skipped: "recorded-by-kept-late-capture-invoice", operationId: "op_kept" },
      });
      expect(seam.createXeroPaymentForInvoice).not.toHaveBeenCalled();
    });
  });

  it("refuses while the primary invoice's own card payment is still owed (its create PARTIAL)", async () => {
    rows.primaryCreate = { status: "PARTIAL", responsePayload: { paymentError: { message: "x" } }, manuallyResolvedAt: null };
    const seam = providers();

    await run(seam);

    expectRefused("own-payment-pending");
    expect(seam.createXeroPaymentForInvoice).not.toHaveBeenCalled();
  });

  it("records it once an officer resolved that PARTIAL create in Xero (its payment recorded by hand)", async () => {
    rows.primaryCreate = {
      status: "PARTIAL",
      responsePayload: { paymentError: { message: "x" } },
      manuallyResolvedAt: new Date("2026-06-30T00:00:00.000Z"),
    };
    const seam = providers();

    await run(seam);

    expect(seam.createXeroPaymentForInvoice).toHaveBeenCalledWith(expect.objectContaining({ invoiceId: PRIMARY }));
  });

  it("refuses a gap invoice for its change that never reached Xero", async () => {
    mocks.readCaptureRecorder.mockResolvedValue(gapTarget("FAILED"));
    await run();
    expectRefused("gap-invoice-not-in-xero");
  });

  it("refuses, in words of its own, an invoice Xero did not return (J)", async () => {
    invoices = {};
    await run();
    expectRefused("xero-unreadable");
  });

  it("with nothing due and no gap invoice, asks #3980's check, and refuses when it finds no gap", async () => {
    invoices[PRIMARY] = { amountDue: 0 };
    const seam = providers();

    await run(seam);

    expect(mocks.recheckPrimaryInvoiceWorthGap).toHaveBeenCalledWith(expect.objectContaining({ bookingId: "booking_1", xeroInvoiceId: PRIMARY }));
    expectRefused("nothing-due");
    expect(seam.createXeroPaymentForInvoice).not.toHaveBeenCalled();
  });

  it.each([0, 8000])(
    "waits for a gap invoice #3980's check raised (it took %i cents of other cash, never this receipt's), never finishing as recorded by it (G)",
    async (cashTakenCents) => {
      invoices[PRIMARY] = { amountDue: 0 };
      mocks.recheckPrimaryInvoiceWorthGap.mockResolvedValue({
        gapCents: 8000,
        queueOperationId: "op_gap_new",
        alreadyQueued: false,
        cashTakenCents,
        reviewOperationId: null,
      });
      await expectWait();
      expect(mocks.completeXeroSyncOperation).not.toHaveBeenCalled();
    },
  );

  it("closes the row unsent for a capture the club does not keep", async () => {
    mocks.lateCaptureRefundState.mockResolvedValue("refunded");
    const seam = providers();

    await run(seam);

    expect(mocks.completeXeroSyncOperation).toHaveBeenCalledWith(expect.objectContaining({ id: "op_receipt" }), {
      status: "CANCELLED",
      responsePayload: { skipped: "capture-not-kept", refundState: "refunded" },
    });
    expect(seam.getAuthenticatedXeroClient).not.toHaveBeenCalled();
  });

  it("tells an officer when a refund note queued before the receipt names the booking's invoice, not the gap invoice it paid (L)", async () => {
    invoices[GAP] = { amountDue: 8000 };
    mocks.readCaptureRecorder.mockResolvedValue(gapTarget());
    mocks.findFirstRefund.mockResolvedValue({ createdAt: new Date("2026-06-30T00:00:00.000Z") });
    mocks.findManyOperation.mockResolvedValue([
      { id: "op_note_primary", requestPayload: { queueType: "REFUND_CREDIT_NOTE" } },
      { id: "op_note_gap", requestPayload: { queueType: "REFUND_CREDIT_NOTE", creditsInvoiceId: GAP } },
    ]);

    await run();

    expect(mocks.sendAdminXeroSyncErrorAlert).toHaveBeenCalledTimes(1);
    expect(mocks.sendAdminXeroSyncErrorAlert).toHaveBeenCalledWith(
      expect.objectContaining({ errorMessage: expect.stringContaining("op_note_primary") }),
    );
    expect(mocks.sendAdminXeroSyncErrorAlert.mock.calls[0][0].errorMessage).not.toContain("op_note_gap");
  });

  describe("a retry, with the decision stored", () => {
    const plan = { target: "GAP_INVOICE", invoiceId: GAP, amountCents: 8000, capturedCents: 8000, date: "2026-06-30" };
    beforeEach(() => {
      mocks.findUniqueOperation.mockResolvedValue({ requestPayload: { ...PAYLOAD, plan } });
    });

    it("sends the same invoice, amount, date and Xero key, never deciding again", async () => {
      invoices[GAP] = { amountDue: 8000 };
      const seam = providers();

      await run(seam);

      // Round 4 (1b): who records it is read again, but nothing is decided again.
      expect(mocks.readCaptureRecorder).toHaveBeenCalledTimes(1);
      expect(mocks.updateOperation).not.toHaveBeenCalled();
      expect(seam.createXeroPaymentForInvoice).toHaveBeenCalledWith(
        expect.objectContaining({
          invoiceId: GAP,
          amountCents: 8000,
          date: "2026-06-30",
          idempotencyKey: `payment-intent:pi_change:additional-capture-payment:${GAP}:v1`,
        }),
      );
    });

    it.each([
      ["a supplementary invoice now names or covers it", { kind: "supplementary-invoice", operationId: "op_repair_invoice" }],
      ["the primary's own payment records it", { kind: "primary-invoice" }],
    ])("MUTATION round 4 (1b): refuses, telling an officer, rather than send a stored decision where %s", async (_label, recorder) => {
      invoices[GAP] = { amountDue: 8000 };
      mocks.readCaptureRecorder.mockResolvedValue(recorder);
      const seam = providers();

      await run(seam);

      expectRefused("recorded-elsewhere");
      expect(seam.createXeroPaymentForInvoice).not.toHaveBeenCalled();
    });

    it("MUTATION round 5 (item 2): links its own payment found by reference, rather than refuse it, and tells an officer another document records it too", async () => {
      invoices[GAP] = { amountDue: 0, payments: [{ paymentID: "xero_payment_first", reference: "Stripe pi_change" }] };
      mocks.readCaptureRecorder.mockResolvedValue({ kind: "supplementary-invoice", operationId: "op_repair_invoice" });
      const seam = providers();

      await expect(run(seam)).resolves.toBe("xero_payment_first");

      expect(mocks.failXeroSyncOperation).not.toHaveBeenCalled();
      expect(mocks.completeXeroSyncOperation).toHaveBeenCalledWith(expect.objectContaining({ id: "op_receipt" }), expect.objectContaining({ xeroObjectId: "xero_payment_first" }));
      expect(mocks.sendAdminXeroSyncErrorAlert).toHaveBeenCalledWith(
        expect.objectContaining({ errorMessage: expect.stringContaining("another document now records it too") }),
      );
      expect(seam.createXeroPaymentForInvoice).not.toHaveBeenCalled();
    });

    it("MUTATION round 6 (item 2): switches an invoice that has not sent yet to raise unpaid, under its anchor lock, and says so", async () => {
      invoices[GAP] = { amountDue: 0, payments: [{ paymentID: "xero_payment_first", reference: "Stripe pi_change" }] };
      mocks.readCaptureRecorder.mockResolvedValue({ kind: "supplementary-invoice", operationId: "op_repair_invoice" });
      const repairRow = { status: "PENDING", localModel: "BookingModification", localId: "mod_change", requestPayload: { recordPayment: true, paymentIntentId: "pi_change" } };
      mocks.findUniqueOperation.mockImplementation(async ({ where }: { where: { id: string } }) =>
        where.id === "op_repair_invoice" ? repairRow : { requestPayload: { ...PAYLOAD, plan } },
      );
      const seam = providers();

      await expect(run(seam)).resolves.toBe("xero_payment_first");

      expect(mocks.lockSupplementaryInvoiceAnchor).toHaveBeenCalledWith(expect.anything(), "mod_change");
      expect(mocks.updateManyOperation).toHaveBeenCalledWith({
        where: { id: "op_repair_invoice", status: "PENDING" },
        data: { requestPayload: { recordPayment: false, paymentIntentId: "pi_change" } },
      });
      expect(mocks.sendAdminXeroSyncErrorAlert).toHaveBeenCalledWith(
        expect.objectContaining({ errorMessage: expect.stringContaining("now set to be raised unpaid") }),
      );
    });

    describe("which unsent invoice it switches (round 9, items 2 and 3)", () => {
      const switching = async (row: Record<string, unknown>, secondRead?: Record<string, unknown>) => {
        invoices[GAP] = { amountDue: 0, payments: [{ paymentID: "xero_payment_first", reference: "Stripe pi_change" }] };
        mocks.readCaptureRecorder.mockResolvedValue({ kind: "supplementary-invoice", operationId: "op_other" });
        let reads = 0;
        mocks.findUniqueOperation.mockImplementation(async ({ where }: { where: { id: string } }) => {
          if (where.id !== "op_other") return { requestPayload: { ...PAYLOAD, plan } };
          reads += 1;
          return reads > 2 && secondRead ? secondRead : row;
        });
        await run();
        return mocks.updateManyOperation.mock.calls.filter(([args]) => (args as { where: { id: string } }).where.id === "op_other");
      };
      const base = { localModel: "BookingModification", localId: "mod_change", responsePayload: null, xeroObjectId: null };

      it("MUTATION: never a #3980 gap invoice, which may pay for other captures - an officer checks Xero", async () => {
        const writes = await switching({ ...base, status: "PENDING", requestPayload: { primaryInvoiceGap: true, paymentIntentId: "pi_change" } });
        expect(writes).toEqual([]);
        expect(mocks.sendAdminXeroSyncErrorAlert).toHaveBeenCalledWith(
          expect.objectContaining({ errorMessage: expect.stringContaining("another document now records it too") }),
        );
      });

      it("MUTATION: never an invoice of another change naming another capture", async () => {
        const writes = await switching({ ...base, localId: "mod_other", status: "PENDING", requestPayload: { paymentIntentId: "pi_other" } });
        expect(writes).toEqual([]);
      });

      it("MUTATION: a FAILED row whose response names a Xero invoice is not unsent; one with none is", async () => {
        const failedInXero = { ...base, status: "FAILED", requestPayload: {}, responsePayload: { invoice: { invoices: [{ invoiceID: "inv_made" }] } } };
        expect(await switching(failedInXero)).toEqual([]);
        vi.clearAllMocks();
        mocks.updateManyOperation.mockResolvedValue({ count: 1 });
        mocks.txFindFirstLink.mockResolvedValue(null);
        const failedBeforeXero = { ...base, status: "FAILED", requestPayload: {}, responsePayload: { message: "Xero 500" } };
        expect(await switching(failedBeforeXero)).toEqual([
          [{ where: { id: "op_other", status: "FAILED" }, data: { requestPayload: { recordPayment: false } } }],
        ]);
        expect(mocks.sendAdminXeroSyncErrorAlert).toHaveBeenCalledWith(
          expect.objectContaining({ errorMessage: expect.stringContaining("Check Xero shows the payment once") }),
        );
      });

      it("MUTATION: a waiting invoice released between its read and the guarded write is read again once and switched", async () => {
        mocks.updateManyOperation.mockImplementation(async ({ where }: { where: { id: string; status: string } }) => ({
          count: where.id === "op_other" && where.status === "WAITING_PAYMENT" ? 0 : 1,
        }));
        const writes = await switching(
          { ...base, status: "WAITING_PAYMENT", requestPayload: { paymentIntentId: "pi_change" } },
          { ...base, status: "PENDING", requestPayload: { paymentIntentId: "pi_change" } },
        );
        expect(writes.map(([args]) => (args as { where: { status: string } }).where.status)).toEqual(["WAITING_PAYMENT", "PENDING"]);
      });
    });

    it("leaves an invoice already in Xero as it is, and tells an officer to check for the second recording", async () => {
      invoices[GAP] = { amountDue: 0, payments: [{ paymentID: "xero_payment_first", reference: "Stripe pi_change" }] };
      mocks.readCaptureRecorder.mockResolvedValue({ kind: "supplementary-invoice", operationId: "op_repair_invoice" });
      mocks.findUniqueOperation.mockImplementation(async ({ where }: { where: { id: string } }) =>
        where.id === "op_repair_invoice"
          ? { status: "SUCCEEDED", localModel: "BookingModification", localId: "mod_change", requestPayload: {} }
          : { requestPayload: { ...PAYLOAD, plan } },
      );

      await run();

      expect(mocks.updateManyOperation).not.toHaveBeenCalledWith(expect.objectContaining({ where: { id: "op_repair_invoice", status: "SUCCEEDED" } }));
      expect(mocks.sendAdminXeroSyncErrorAlert).toHaveBeenCalledWith(
        expect.objectContaining({ errorMessage: expect.stringContaining("another document now records it too") }),
      );
    });

    it("MUTATION round 5 (item 1): a stored decision, then an UNPAID invoice the repair tool raised naming the capture, then the retry - records it once, as decided", async () => {
      // What `readCaptureRecorder` answers for an unpaid invoice naming the intent: the receipt still records it.
      mocks.findUniqueOperation.mockResolvedValue({ requestPayload: { ...PAYLOAD, plan: { ...plan, target: "PRIMARY_INVOICE", invoiceId: PRIMARY } } });
      invoices[PRIMARY] = { amountDue: 8000 };
      mocks.readCaptureRecorder.mockResolvedValue(
        receiptRecorder({
          target: {
            kind: "CHANGE_INVOICE",
            operation: { id: "op_repair_invoice", status: "PENDING", requestPayload: { paymentIntentId: "pi_change", recordPayment: false }, responsePayload: null, manuallyResolvedAt: null },
            link: null,
          },
        }),
      );
      const seam = providers();

      await run(seam);

      expect(mocks.failXeroSyncOperation).not.toHaveBeenCalled();
      expect(seam.createXeroPaymentForInvoice).toHaveBeenCalledTimes(1);
      expect(seam.createXeroPaymentForInvoice).toHaveBeenCalledWith(expect.objectContaining({ invoiceId: PRIMARY, amountCents: 8000 }));
    });

    it("links what the first try recorded, if Xero has it", async () => {
      invoices[GAP] = { amountDue: 0, payments: [{ paymentID: "xero_payment_first", reference: "Stripe pi_change" }] };
      const seam = providers();

      await expect(run(seam)).resolves.toBe("xero_payment_first");
      expect(seam.createXeroPaymentForInvoice).not.toHaveBeenCalled();
    });

    it("refuses, saying to record it by hand, rather than choosing another invoice, when that invoice no longer has it due", async () => {
      invoices[GAP] = { amountDue: 3000 };
      const seam = providers();

      await run(seam);

      expectRefused("figures-changed");
      expect(mocks.failXeroSyncOperation.mock.calls[0][3].lastErrorMessage).toContain("Record it by hand in Xero");
      expect(seam.createXeroPaymentForInvoice).not.toHaveBeenCalled();
    });

    it("re-checks a primary decision's room net of the applied credit still to be allocated (I)", async () => {
      mocks.findUniqueOperation.mockResolvedValue({ requestPayload: { ...PAYLOAD, plan: { ...plan, target: "PRIMARY_INVOICE", invoiceId: PRIMARY } } });
      invoices[PRIMARY] = { amountDue: 10000 };
      mocks.cardSettleAppliedCreditCents.mockResolvedValue(4000);
      const seam = providers();

      await run(seam);

      expectRefused("figures-changed");
      expect(seam.createXeroPaymentForInvoice).not.toHaveBeenCalled();
    });
  });

  describe("storing the decision under the change's anchor lock (round 6, 1b)", () => {
    it("stores it in a transaction under the capture's change's lock, after reading who records it again there", async () => {
      await run();
      expect(mocks.lockSupplementaryInvoiceAnchor).toHaveBeenCalledWith(expect.anything(), "mod_change");
      expect(mocks.readCaptureRecorder).toHaveBeenCalledTimes(2);
      expect(mocks.readCaptureRecorder.mock.calls[1]![1]).toBeDefined();
      const lockCalls = mocks.lockSupplementaryInvoiceAnchor.mock.invocationCallOrder;
      expect(lockCalls[lockCalls.length - 1]).toBeLessThan(mocks.readCaptureRecorder.mock.invocationCallOrder[1]!);
      expect(mocks.readCaptureRecorder.mock.invocationCallOrder[1]).toBeLessThan(mocks.updateOperation.mock.invocationCallOrder[0]!);
    });

    it("MUTATION: stands down, storing nothing and sending nothing, where an invoice for the change came to record it meanwhile", async () => {
      mocks.readCaptureRecorder
        .mockResolvedValueOnce(receiptRecorder())
        .mockResolvedValueOnce({ kind: "supplementary-invoice", operationId: "op_repair_invoice" });
      const seam = providers();

      await expect(run(seam)).resolves.toBeNull();

      expect(mocks.updateOperation).not.toHaveBeenCalled();
      expect(seam.createXeroPaymentForInvoice).not.toHaveBeenCalled();
      expect(mocks.completeXeroSyncOperation).toHaveBeenCalledWith(
        expect.objectContaining({ id: "op_receipt" }),
        expect.objectContaining({ status: "SUCCEEDED", responsePayload: expect.objectContaining({ skipped: "recorded-by-supplementary-invoice" }) }),
      );
    });

    it("round 7: a review charge's capture (no stamp) stores under the lock of the change its reason names", async () => {
      mocks.findUniqueTransaction.mockResolvedValue(
        capture({ bookingModificationId: null, reason: buildEditFinancialReviewChargeReason("mod_review") }),
      );
      await run();
      expect(mocks.lockSupplementaryInvoiceAnchor).toHaveBeenLastCalledWith(expect.anything(), "mod_review");
      expect(mocks.readCaptureRecorder.mock.calls[1]![0]).toEqual(expect.objectContaining({ bookingModificationId: "mod_review" }));
      expect(storedPlan()).toEqual(expect.objectContaining({ invoiceId: PRIMARY }));
    });

    it("round 7: a capture no change can be read from stores under the BOOKING's lock where nothing could be recording it", async () => {
      mocks.findUniqueTransaction.mockResolvedValue(capture({ bookingModificationId: null, reason: null }));
      await run();
      expect(mocks.lockSupplementaryInvoiceAnchor).toHaveBeenLastCalledWith(expect.anything(), "booking_1");
      expect(storedPlan()).toEqual(expect.objectContaining({ invoiceId: PRIMARY }));
    });

    it("MUTATION round 7: refuses, telling an officer, a capture no change can be read from where a paid invoice on the booking names no capture", async () => {
      mocks.findUniqueTransaction.mockResolvedValue(capture({ bookingModificationId: null, reason: null }));
      mocks.findManyOperation.mockImplementation(async ({ where }: { where: { queueType?: string } }) =>
        where.queueType === "SUPPLEMENTARY_INVOICE" ? [{ requestPayload: { bookingId: "booking_1", recordPayment: true } }] : [],
      );
      const seam = providers();
      await run(seam);
      expect(mocks.updateOperation).not.toHaveBeenCalled();
      expect(seam.createXeroPaymentForInvoice).not.toHaveBeenCalled();
      expectRefused("change-unknown");
    });

    it("MUTATION round 9 (item 4): refuses a capture no change can be read from where a change of the booking has its invoice's payment linked in Xero", async () => {
      mocks.findUniqueTransaction.mockResolvedValue(capture({ bookingModificationId: null, reason: null }));
      mocks.txFindManyModification.mockResolvedValue([{ id: "mod_old" }]);
      mocks.txFindManyLink.mockResolvedValue([{ localId: "mod_old" }]);
      const seam = providers();
      await run(seam);
      expect(mocks.txFindManyLink).toHaveBeenCalledWith({
        where: { localModel: "BookingModification", localId: { in: ["mod_old"] }, role: "SUPPLEMENTARY_INVOICE_PAYMENT", active: true },
        select: { localId: true },
      });
      expect(seam.createXeroPaymentForInvoice).not.toHaveBeenCalled();
      expectRefused("change-unknown");
    });

    it("MUTATION round 11 (item 1): plans freely where the booking's paid change invoice names its own capture", async () => {
      mocks.findUniqueTransaction.mockResolvedValue(capture({ bookingModificationId: null, reason: null }));
      mocks.txFindManyModification.mockResolvedValue([{ id: "mod_named" }]);
      mocks.txFindManyLink.mockResolvedValue([{ localId: "mod_named" }]);
      mocks.findManyOperation.mockImplementation(async ({ where }: { where: { queueType?: string; localModel?: string } }) =>
        where.queueType === "SUPPLEMENTARY_INVOICE" && where.localModel
          ? [{ localId: "mod_named", requestPayload: { queueType: "SUPPLEMENTARY_INVOICE", paymentIntentId: "pi_named" } }]
          : [],
      );
      await run();
      expect(storedPlan()).toEqual(expect.objectContaining({ invoiceId: PRIMARY }));
    });

    it("decides again on the next run where the invoice it belongs to changed meanwhile", async () => {
      mocks.readCaptureRecorder.mockResolvedValueOnce(receiptRecorder()).mockResolvedValueOnce(gapTarget());
      const seam = providers();
      await expectWait(seam);
      expect(mocks.updateOperation).not.toHaveBeenCalled();
    });
  });

  it("fails the row on a Xero write error, and keeps the stored decision for the retry", async () => {
    const seam = providers();
    seam.createXeroPaymentForInvoice.mockRejectedValueOnce(new Error("Xero 500"));

    await expect(run(seam)).rejects.toThrow("Xero 500");

    expect(storedPlan()).toEqual(expect.objectContaining({ invoiceId: PRIMARY }));
    expect(mocks.failXeroSyncOperation).toHaveBeenCalledWith(expect.objectContaining({ id: "op_receipt" }), expect.objectContaining({ message: "Xero 500" }));
  });
});

describe("supplementaryReplayMayRecordPayment (rounds 9 and 11)", () => {
  const ask = () => supplementaryReplayMayRecordPayment({ operationId: "op_change_invoice", bookingId: "booking_1", bookingModificationId: "mod_change" });
  const writes = () => mocks.updateManyOperation.mock.calls.filter(([args]) => (args as { where: { id: string } }).where.id === "op_change_invoice");

  it("asks under the change's anchor lock, and says no, writing nothing, where the row is already unpaid", async () => {
    mocks.findUniqueOperation.mockResolvedValue({ status: "FAILED", requestPayload: { recordPayment: false } });
    await expect(ask()).resolves.toEqual({ recordPayment: false, raisedUnpaid: false });
    expect(mocks.lockSupplementaryInvoiceAnchor).toHaveBeenCalledWith(expect.anything(), "mod_change");
    expect(mocks.lockSupplementaryInvoiceAnchor.mock.invocationCallOrder[0]).toBeLessThan(mocks.findUniqueOperation.mock.invocationCallOrder[0]!);
    expect(writes()).toEqual([]);
  });

  it("MUTATION round 11: where a capture's receipt records it, sets the row itself unpaid there, guarded on its status, and says so", async () => {
    mocks.findUniqueOperation.mockResolvedValue({ status: "FAILED", requestPayload: { paymentIntentId: "pi_change" } });
    mocks.findManyTransaction.mockResolvedValue([{ id: "ptx_1" }]);
    mocks.txFindFirstLink.mockResolvedValue({ id: "receipt_link" });
    await expect(ask()).resolves.toEqual({ recordPayment: false, raisedUnpaid: true });
    expect(writes()).toEqual([
      [
        {
          where: { id: "op_change_invoice", status: { in: ["FAILED", "PARTIAL"] } },
          data: { requestPayload: { paymentIntentId: "pi_change", recordPayment: false } },
        },
      ],
    ]);
  });

  it("MUTATION round 12: a receipt RUNNING with no decision stored leaves the invoice paying - it reads this row again before it decides", async () => {
    mocks.findUniqueOperation.mockResolvedValue({ status: "FAILED", requestPayload: { paymentIntentId: "pi_change" } });
    mocks.findManyTransaction.mockResolvedValue([{ id: "ptx_1" }]);
    mocks.txFindFirstLink.mockResolvedValue(null);
    mocks.findManyOperation.mockResolvedValue([{ status: "RUNNING", requestPayload: { queueType: "ADDITIONAL_CAPTURE_RECEIPT" } }]);
    await expect(ask()).resolves.toEqual({ recordPayment: true, raisedUnpaid: false });
    expect(writes()).toEqual([]);
    // Control: once it stores its decision, it counts.
    mocks.findManyOperation.mockResolvedValue([{ status: "RUNNING", requestPayload: { plan: { invoiceId: "inv_1" } } }]);
    await expect(ask()).resolves.toEqual({ recordPayment: false, raisedUnpaid: true });
  });

  it("MUTATION round 12: never writes to a row that is not unsent (RUNNING), nor says it raised it unpaid; a lost guard says so too", async () => {
    mocks.findManyTransaction.mockResolvedValue([{ id: "ptx_1" }]);
    mocks.txFindFirstLink.mockResolvedValue({ id: "receipt_link" });
    mocks.findUniqueOperation.mockResolvedValue({ status: "RUNNING", requestPayload: { paymentIntentId: "pi_change" } });
    await expect(ask()).resolves.toEqual({ recordPayment: false, raisedUnpaid: false });
    expect(writes()).toEqual([]);

    mocks.findUniqueOperation.mockResolvedValue({ status: "FAILED", requestPayload: { paymentIntentId: "pi_change" } });
    mocks.updateManyOperation.mockResolvedValueOnce({ count: 0 });
    await expect(ask()).resolves.toEqual({ recordPayment: false, raisedUnpaid: false });
  });

  it("records, writing nothing, where no receipt records it", async () => {
    mocks.findUniqueOperation.mockResolvedValue({ status: "FAILED", requestPayload: { paymentIntentId: "pi_change" } });
    mocks.findManyTransaction.mockResolvedValue([]);
    await expect(ask()).resolves.toEqual({ recordPayment: true, raisedUnpaid: false });
    expect(writes()).toEqual([]);
  });

  it("leaves a #3980 gap invoice as it was asked: it decides its own cash", async () => {
    mocks.findUniqueOperation.mockResolvedValue({ status: "FAILED", requestPayload: { primaryInvoiceGap: true } });
    mocks.findManyTransaction.mockResolvedValue([{ id: "ptx_1" }]);
    mocks.txFindFirstLink.mockResolvedValue({ id: "receipt_link" });
    await expect(ask()).resolves.toEqual({ recordPayment: true, raisedUnpaid: false });
    expect(writes()).toEqual([]);
  });

  it("MUTATION #4494: raises a gap invoice unpaid where its payment would overlap the credit-release sweep's share - asked after the lock, guarded on an unsent status", async () => {
    const gapPayload = { primaryInvoiceGap: true, recordPayment: true, coveredPaymentIntentIds: ["pi_release"], coveredCaptureCents: { pi_release: 3_000 } };
    // Here an earlier attempt may have paid, so the answer still names its captures.
    const unpaid = { ...gapPayload, recordPayment: false };
    mocks.findUniqueOperation.mockResolvedValue({ status: "FAILED", requestPayload: gapPayload });
    mocks.unpaidGapPayloadIfOverlapping.mockResolvedValue(unpaid);
    await expect(ask()).resolves.toEqual({ recordPayment: false, raisedUnpaid: true });
    expect(mocks.unpaidGapPayloadIfOverlapping).toHaveBeenCalledWith({ operationId: "op_change_invoice", bookingId: "booking_1", payload: gapPayload });
    expect(mocks.transaction.mock.invocationCallOrder[0]).toBeLessThan(mocks.unpaidGapPayloadIfOverlapping.mock.invocationCallOrder[0]!);
    expect(writes()).toEqual([[{ where: { id: "op_change_invoice", status: { in: ["FAILED", "PARTIAL"] } }, data: { requestPayload: unpaid } }]]);
  });
});

describe("readAdditionalCaptureReceiptPayload", () => {
  it("refuses a payload whose stored decision does not parse, so a retry never decides again", () => {
    expect(readAdditionalCaptureReceiptPayload(PAYLOAD)).toEqual(PAYLOAD);
    expect(readAdditionalCaptureReceiptPayload({ ...PAYLOAD, plan: { target: "PRIMARY_INVOICE" } })).toBeNull();
    expect(
      readAdditionalCaptureReceiptPayload({
        ...PAYLOAD,
        plan: { target: "PRIMARY_INVOICE", invoiceId: PRIMARY, amountCents: 9000, capturedCents: 8000, date: "2026-06-30" },
      }),
    ).toBeNull();
  });
});

describe("enqueueAdditionalCaptureReceiptOperation", () => {
  const tx = { xeroSyncOperation: { findFirst: vi.fn() } };
  const eligible = (overrides: Record<string, unknown> = {}, payment: Record<string, unknown> = {}) => ({
    id: "ptx_1",
    kind: "ADDITIONAL",
    source: "STRIPE",
    status: "SUCCEEDED",
    bookingModificationId: "mod_1",
    payment: { id: "payment_1", bookingId: "booking_1", xeroInvoiceId: PRIMARY, source: "STRIPE", booking: { status: "CONFIRMED" }, ...payment },
    ...overrides,
  });
  beforeEach(() => {
    tx.xeroSyncOperation.findFirst.mockReset();
    mocks.transaction.mockImplementation(async (fn: (client: typeof tx) => unknown) => fn(tx));
    mocks.findUniqueTransaction.mockResolvedValue(eligible());
    mocks.startXeroSyncOperation.mockResolvedValue({ id: "op_receipt" });
  });

  it("queues one row per capture under the change's supplementary-invoice anchor lock, after asking who records it", async () => {
    tx.xeroSyncOperation.findFirst.mockResolvedValue(null);

    await expect(enqueueAdditionalCaptureReceiptOperation("pi_change")).resolves.toEqual({
      outcome: "queued",
      queueOperationId: "op_receipt",
    });

    expect(mocks.lockSupplementaryInvoiceAnchor).toHaveBeenCalledWith(tx, "mod_1");
    expect(mocks.readCaptureRecorder).toHaveBeenCalledWith(
      { bookingId: "booking_1", primaryInvoiceId: PRIMARY, paymentIntentId: "pi_change", bookingModificationId: "mod_1" },
      tx,
    );
    expect(mocks.lockSupplementaryInvoiceAnchor.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.readCaptureRecorder.mock.invocationCallOrder[0],
    );
    expect(mocks.startXeroSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: "PAYMENT",
        localModel: "PaymentTransaction",
        localId: "ptx_1",
        status: "PENDING",
        correlationKey: "payment-intent:pi_change:additional-capture-receipt:v1",
        idempotencyKey: "payment-intent:pi_change:additional-capture-receipt:v1",
        requestPayload: PAYLOAD,
        store: tx,
      }),
    );
  });

  it.each([
    [{ kind: "primary-invoice" }, "recorded-by-primary-invoice"],
    [{ kind: "supplementary-invoice", operationId: "op_supp" }, "recorded-by-supplementary-invoice"],
    [{ kind: "kept-late-capture-invoice", operationId: "op_kept" }, "recorded-by-kept-late-capture-invoice"],
    [{ kind: "credit-release-sweep" }, "recorded-by-credit-release-sweep"],
  ])("stands down, under the lock, where another writer records it (%o)", async (recorder, reason) => {
    tx.xeroSyncOperation.findFirst.mockResolvedValue(null);
    mocks.readCaptureRecorder.mockResolvedValue(recorder);

    await expect(enqueueAdditionalCaptureReceiptOperation("pi_change")).resolves.toEqual({ outcome: "not-eligible", reason });
    expect(mocks.startXeroSyncOperation).not.toHaveBeenCalled();
  });

  it("finds the row the webhook or the confirm route queued first, and queues no second", async () => {
    tx.xeroSyncOperation.findFirst.mockResolvedValue({ id: "op_first" });

    await expect(enqueueAdditionalCaptureReceiptOperation("pi_change")).resolves.toEqual({
      outcome: "already-queued",
      queueOperationId: "op_first",
    });
    expect(mocks.startXeroSyncOperation).not.toHaveBeenCalled();
  });

  it("round 7: locks the change a review charge's reason names where the ledger row carries no stamp", async () => {
    tx.xeroSyncOperation.findFirst.mockResolvedValue(null);
    mocks.findUniqueTransaction.mockResolvedValue(
      eligible({ bookingModificationId: null, reason: buildEditFinancialReviewChargeReason("mod_review") }),
    );

    await enqueueAdditionalCaptureReceiptOperation("pi_change");
    expect(mocks.lockSupplementaryInvoiceAnchor).toHaveBeenCalledWith(tx, "mod_review");
  });

  it("locks the booking where the ledger row names no change", async () => {
    tx.xeroSyncOperation.findFirst.mockResolvedValue(null);
    mocks.findUniqueTransaction.mockResolvedValue(eligible({ bookingModificationId: null }));

    await enqueueAdditionalCaptureReceiptOperation("pi_change");
    expect(mocks.lockSupplementaryInvoiceAnchor).toHaveBeenCalledWith(tx, "booking_1");
  });

  it.each([
    ["the booking's own payment", eligible({ kind: "PRIMARY" }), "not-a-change-card-capture"],
    ["an uncaptured ask", eligible({ status: "PENDING" }), "not-a-change-card-capture"],
    ["a booking Xero never invoiced", eligible({}, { xeroInvoiceId: null }), "no-primary-invoice"],
    ["a cancelled booking (K)", eligible({}, { booking: { status: "CANCELLED" } }), "booking-cancelled"],
    ["a booking paid by internet banking (H)", eligible({}, { source: "INTERNET_BANKING" }), "not-a-card-booking"],
  ])("queues nothing for %s", async (_label, transaction, reason) => {
    mocks.findUniqueTransaction.mockResolvedValue(transaction);

    await expect(enqueueAdditionalCaptureReceiptOperation("pi_change")).resolves.toEqual({ outcome: "not-eligible", reason });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  describe("#4324: a kept late capture on a cancelled booking", () => {
    const keepTx = {
      xeroSyncOperation: { findFirst: vi.fn() },
      manualRefundTask: { findUnique: vi.fn() },
      paymentTransaction: { findUnique: mocks.findUniqueTransaction },
    };
    beforeEach(() => {
      keepTx.xeroSyncOperation.findFirst.mockReset().mockResolvedValue(null);
      keepTx.manualRefundTask.findUnique.mockReset().mockResolvedValue({ status: "DISMISSED" });
      mocks.findUniqueTransaction.mockResolvedValue(eligible({}, { booking: { status: "CANCELLED" } }));
    });

    it("MUTATION: queues it on the keep's own transaction, under the anchor lock, once the task is read there still kept", async () => {
      await expect(
        enqueueAdditionalCaptureReceiptOperation("pi_change", { store: keepTx as never, keptLateCapture: true }),
      ).resolves.toEqual({ outcome: "queued", queueOperationId: "op_receipt" });
      expect(mocks.transaction).not.toHaveBeenCalled();
      expect(mocks.lockSupplementaryInvoiceAnchor).toHaveBeenCalledWith(keepTx, "mod_1");
      expect(keepTx.manualRefundTask.findUnique).toHaveBeenCalledWith({
        where: { lateCaptureApprovalIntentId: "pi_change" },
        select: { status: true },
      });
      expect(mocks.lockSupplementaryInvoiceAnchor.mock.invocationCallOrder[0]).toBeLessThan(
        keepTx.manualRefundTask.findUnique.mock.invocationCallOrder[0]!,
      );
      expect(mocks.startXeroSyncOperation).toHaveBeenCalledWith(expect.objectContaining({ store: keepTx }));
    });

    for (const target of [null, { kind: "GAP_INVOICE" }]) {
      it(`a release losing a refusal never falls back to ${target?.kind ?? "the primary"}`, async () => {
        mocks.readCaptureRecorder.mockResolvedValue(receiptRecorder({ target }));
        await expect(enqueueAdditionalCaptureReceiptOperation("pi_change", {
          store: keepTx as never, keptLateCapture: true, requireUnpaidChangeInvoice: true,
        })).resolves.toEqual({ outcome: "not-eligible", reason: "no-unpaid-change-invoice" });
        expect(mocks.startXeroSyncOperation).not.toHaveBeenCalled();
      });
    }

    it("a release's follow-up records only its canonical unpaid change invoice, read under the anchor", async () => {
      mocks.readCaptureRecorder.mockResolvedValue(receiptRecorder({ target: { kind: "CHANGE_INVOICE" } }));
      await expect(enqueueAdditionalCaptureReceiptOperation("pi_change", {
        store: keepTx as never, keptLateCapture: true, requireUnpaidChangeInvoice: true,
      })).resolves.toMatchObject({ outcome: "queued" });
      expect(mocks.lockSupplementaryInvoiceAnchor.mock.invocationCallOrder[0])
        .toBeLessThan(mocks.readCaptureRecorder.mock.invocationCallOrder[0]!);
    });

    it("queues nothing for a capture no longer kept", async () => {
      keepTx.manualRefundTask.findUnique.mockResolvedValue({ status: "OPEN" });
      await expect(
        enqueueAdditionalCaptureReceiptOperation("pi_change", { store: keepTx as never, keptLateCapture: true }),
      ).resolves.toEqual({ outcome: "not-eligible", reason: "capture-not-kept" });
      expect(mocks.startXeroSyncOperation).not.toHaveBeenCalled();
    });

    it("MUTATION: any other caller (a replayed release) finds the keep's row, and queues none of its own", async () => {
      mocks.findFirstOperation.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
        where.correlationKey === "payment-intent:pi_change:additional-capture-receipt:v1" ? { id: "op_kept_receipt" } : null,
      );
      await expect(enqueueAdditionalCaptureReceiptOperation("pi_change")).resolves.toEqual({
        outcome: "already-queued",
        queueOperationId: "op_kept_receipt",
      });
      expect(mocks.transaction).not.toHaveBeenCalled();
      expect(mocks.startXeroSyncOperation).not.toHaveBeenCalled();
    });
  });
});

describe("queueReceiptsForUnrecordedCaptures (E)", () => {
  it("queues a receipt for every captured change the primary's recorded cash does not cover", async () => {
    mocks.findManyTransaction.mockResolvedValue([
      { stripePaymentIntentId: "pi_counted" },
      { stripePaymentIntentId: "pi_after_snapshot" },
    ]);
    mocks.findUniqueTransaction.mockResolvedValue({
      id: "ptx_after",
      kind: "ADDITIONAL",
      source: "STRIPE",
      status: "SUCCEEDED",
      bookingModificationId: "mod_after",
      payment: { id: "payment_1", bookingId: "booking_1", xeroInvoiceId: PRIMARY, source: "STRIPE", booking: { status: "CONFIRMED" } },
    });
    const tx = { xeroSyncOperation: { findFirst: vi.fn().mockResolvedValue(null) } };
    mocks.transaction.mockImplementation(async (fn: (client: typeof tx) => unknown) => fn(tx));
    mocks.startXeroSyncOperation.mockResolvedValue({ id: "op_after" });

    await expect(
      queueReceiptsForUnrecordedCaptures("booking_1", { paymentIntentIdsRecordedAtLink: ["pi_primary", "pi_counted"] }),
    ).resolves.toEqual(["op_after"]);
    expect(mocks.findUniqueTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.findUniqueTransaction).toHaveBeenCalledWith(expect.objectContaining({ where: { stripePaymentIntentId: "pi_after_snapshot" } }));
  });

  it("queues nothing for figures written before the covered list existed", async () => {
    await expect(queueReceiptsForUnrecordedCaptures("booking_1", {})).resolves.toEqual([]);
    expect(mocks.findManyTransaction).not.toHaveBeenCalled();
  });
});
