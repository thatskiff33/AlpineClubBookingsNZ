/**
 * `INV-PAY-101` (#3529): what each Xero refund or credit document SAYS, and
 * which bank account a cash refund note is settled against, per method.
 *
 * Drives the three builders to the provider write and through the settlement
 * leg. `retryXeroWriteWithContactRepair` is stubbed to build the payload for a
 * fixed contact and answer with a created note, so each test reads the exact
 * description and reference the note carries and, for a cash refund, the
 * account and reference on the credit-note payment that settles it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PaymentSource } from "@prisma/client";

const mocks = vi.hoisted(() => ({
  paymentFindUnique: vi.fn(),
  paymentUpdate: vi.fn(),
  bookingFindUnique: vi.fn(),
  bookingModificationFindUnique: vi.fn(),
  bookingModificationFindMany: vi.fn(),
  getInvoice: vi.fn(),
  xeroObjectLinkFindFirst: vi.fn(),
  xeroObjectLinkFindMany: vi.fn(),
  xeroSyncOperationUpdate: vi.fn(),
  memberCreditUpdateMany: vi.fn(),
  startXeroSyncOperation: vi.fn(),
  completeXeroSyncOperation: vi.fn(),
  failXeroSyncOperation: vi.fn(),
  upsertXeroObjectLink: vi.fn(),
  findCanonicalPaymentRefundCreditNote: vi.fn(),
  sumCoveredRefundCreditNoteCents: vi.fn(),
  getAuthenticatedXeroClient: vi.fn(),
  callXeroApi: vi.fn(),
  getResolvedAccountMapping: vi.fn(),
  getAccountMapping: vi.fn(),
  getHutFeeItemCodeMap: vi.fn(),
  getHutFeeSeasonType: vi.fn(),
  bookingFindUniqueOrThrow: vi.fn(),
  manualRefundTaskFindMany: vi.fn(),
  retryXeroWriteWithContactRepair: vi.fn(),
  findOrCreateXeroContactForInvoicedParty: vi.fn(),
  readClubTimeZoneOutsideRequest: vi.fn(),
  createPayments: vi.fn(),
  createCreditNoteAllocation: vi.fn(),
  findLateCapturePaymentIntents: vi.fn(),
  readLateCaptureXeroReceipt: vi.fn(),
}));

const deallocationFence = vi.hoisted(() => ({ findFirst: vi.fn() }));

vi.mock("@/lib/prisma", () => {
  const prisma = {
    // #3548: a new refund note is recorded (payment, link, row) in one transaction.
    $transaction: (run: (tx: unknown) => unknown) => run(prisma),
    payment: { findUnique: mocks.paymentFindUnique, update: mocks.paymentUpdate },
    booking: { findUnique: mocks.bookingFindUnique, findUniqueOrThrow: mocks.bookingFindUniqueOrThrow },
    bookingModification: {
      findUnique: mocks.bookingModificationFindUnique,
      findMany: mocks.bookingModificationFindMany,
    },
    manualRefundTask: { findMany: mocks.manualRefundTaskFindMany },
    xeroObjectLink: {
      findFirst: mocks.xeroObjectLinkFindFirst,
      findMany: mocks.xeroObjectLinkFindMany,
    },
    xeroSyncOperation: {
      update: mocks.xeroSyncOperationUpdate,
      findUnique: async () => null,
      // #3791: the unconverged-deallocation read a review's note defers on.
      findFirst: (...a: unknown[]) => deallocationFence.findFirst(...a),
    },
    memberCredit: { updateMany: mocks.memberCreditUpdateMany },
  };
  return { prisma };
});

vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/xero-links", () => ({
  buildXeroInvoiceUrl: (id: string) => `https://xero.example/invoice/${id}`,
  buildXeroCreditNoteUrl: (id: string) => `https://xero.example/credit-note/${id}`,
}));

vi.mock("@/lib/xero-sync", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/xero-sync");
  return {
    ...actual,
    startXeroSyncOperation: mocks.startXeroSyncOperation,
    completeXeroSyncOperation: mocks.completeXeroSyncOperation,
    failXeroSyncOperation: mocks.failXeroSyncOperation,
    upsertXeroObjectLink: mocks.upsertXeroObjectLink,
    findCanonicalPaymentRefundCreditNote: mocks.findCanonicalPaymentRefundCreditNote,
    sumCoveredRefundCreditNoteCents: mocks.sumCoveredRefundCreditNoteCents,
  };
});

vi.mock("@/lib/xero-api-client", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/xero-api-client");
  return {
    ...actual,
    getAuthenticatedXeroClient: mocks.getAuthenticatedXeroClient,
    callXeroApi: mocks.callXeroApi,
  };
});

vi.mock("@/lib/xero-mappings", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/xero-mappings")),
  getResolvedAccountMapping: mocks.getResolvedAccountMapping,
  getAccountMapping: mocks.getAccountMapping,
  getHutFeeItemCodeMap: mocks.getHutFeeItemCodeMap,
  getHutFeeSeasonType: mocks.getHutFeeSeasonType,
}));

vi.mock("@/lib/xero-contacts", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/xero-contacts");
  return { ...actual, retryXeroWriteWithContactRepair: mocks.retryXeroWriteWithContactRepair };
});

vi.mock("@/lib/organisation-xero-contacts", () => ({
  findOrCreateXeroContactForInvoicedParty: mocks.findOrCreateXeroContactForInvoicedParty,
  invoicedPartyContactRepair: () => async () => "contact_1",
}));

// #3635 round-3 R5: which intents are late captures, and what receipt each has.
vi.mock("@/lib/late-capture-xero-receipt", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/late-capture-xero-receipt")),
  findLateCapturePaymentIntents: mocks.findLateCapturePaymentIntents,
  readLateCaptureXeroReceipt: mocks.readLateCaptureXeroReceipt,
}));

vi.mock("@/lib/club-time-zone-runtime", () => ({
  readClubTimeZoneOutsideRequest: mocks.readClubTimeZoneOutsideRequest,
}));

import {
  createUnappliedXeroCreditNote,
  createXeroCreditNote,
} from "@/lib/xero-credit-notes";
import { createXeroCreditNoteForModification } from "@/lib/xero-modification-credit-notes";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

const BOOKING_ID = "cmbooking0001xyz";
const PAYMENT_ID = "cmpayment0001xyz";

function bookingRow() {
  return {
    id: BOOKING_ID,
    memberId: "member_1",
    organisationId: null,
    checkIn: new Date("2026-08-16T00:00:00.000Z"),
    checkOut: new Date("2026-08-18T00:00:00.000Z"),
    member: { id: "member_1", firstName: "Ada", lastName: "Lovelace", email: "ada@example.test" },
    organisation: null,
    guests: [],
    payment: { id: PAYMENT_ID, xeroInvoiceId: "invoice_1" },
  };
}

function paymentRow(source: PaymentSource) {
  return {
    id: PAYMENT_ID,
    bookingId: BOOKING_ID,
    source,
    xeroInvoiceId: "invoice_1",
    xeroRefundCreditNoteId: null,
    amountCents: 20000,
    refundedAmountCents: 5000,
    booking: bookingRow(),
  };
}

type CreditNoteShape = {
  reference?: string;
  lineItems?: Array<{ description?: string; quantity?: number; unitAmount?: number; accountCode?: string; itemCode?: string }>;
};

/** The note the builder handed the provider, read off the captured closure. */
function builtCreditNote(): CreditNoteShape {
  const call = mocks.retryXeroWriteWithContactRepair.mock.calls[0];
  expect(call, "the builder never reached the provider write").toBeDefined();
  const payload = (call![0] as { buildRequestPayload: (id: string) => { creditNotes: CreditNoteShape[] } })
    .buildRequestPayload("contact_1");
  return payload.creditNotes[0]!;
}

/** The club's mapping rows: the refund line account, and the bank-transfer refund account or none. */
function configureBankTransferRefundAccount(code: string | null) {
  mocks.getResolvedAccountMapping.mockImplementation(async (key: string) =>
    key === "bankTransferRefundAccount"
      ? { code, itemCode: null, codeExplicitlyConfigured: code !== null }
      : { code: "200", itemCode: undefined, codeExplicitlyConfigured: false },
  );
}

/** What the operation was completed with. */
function completion(): Record<string, unknown> {
  const call = mocks.completeXeroSyncOperation.mock.calls.at(-1);
  expect(call, "the builder never completed its operation").toBeDefined();
  return call![1] as Record<string, unknown>;
}

/** The credit-note payment that settled it, or undefined when none was made. */
function settlingPayment(): { account?: { code?: string }; reference?: string; date?: string } | undefined {
  const call = mocks.createPayments.mock.calls[0];
  return call
    ? (call[1] as { payments: Array<{ account?: { code?: string }; reference?: string; date?: string }> }).payments[0]
    : undefined;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getAuthenticatedXeroClient.mockResolvedValue({
    xero: {
      accountingApi: {
        createPayments: mocks.createPayments,
        createCreditNoteAllocation: mocks.createCreditNoteAllocation,
        getInvoice: mocks.getInvoice,
      },
    },
    tenantId: "tenant_1",
  });
  mocks.callXeroApi.mockImplementation((run: () => unknown) => run());
  configureBankTransferRefundAccount("090");
  mocks.getAccountMapping.mockResolvedValue("606");
  mocks.startXeroSyncOperation.mockResolvedValue({ id: "op_1" });
  mocks.completeXeroSyncOperation.mockResolvedValue(undefined);
  mocks.failXeroSyncOperation.mockResolvedValue(undefined);
  mocks.upsertXeroObjectLink.mockResolvedValue(undefined);
  mocks.findCanonicalPaymentRefundCreditNote.mockResolvedValue(null);
  mocks.sumCoveredRefundCreditNoteCents.mockResolvedValue(0);
  mocks.xeroObjectLinkFindFirst.mockResolvedValue(null);
  mocks.xeroObjectLinkFindMany.mockResolvedValue([]);
  mocks.xeroSyncOperationUpdate.mockResolvedValue(undefined);
  mocks.paymentUpdate.mockResolvedValue(undefined);
  mocks.memberCreditUpdateMany.mockResolvedValue({ count: 0 });
  mocks.bookingModificationFindUnique.mockResolvedValue({
    createdAt: new Date("2026-08-10T00:00:00.000Z"),
  });
  mocks.readClubTimeZoneOutsideRequest.mockResolvedValue("Pacific/Auckland");
  mocks.manualRefundTaskFindMany.mockResolvedValue([]);
  mocks.findLateCapturePaymentIntents.mockImplementation(async () => new Set<string>());
  mocks.readLateCaptureXeroReceipt.mockResolvedValue({ kind: "none" });
  mocks.findOrCreateXeroContactForInvoicedParty.mockResolvedValue("contact_1");
  mocks.retryXeroWriteWithContactRepair.mockImplementation(
    async (options: { buildRequestPayload: (id: string) => unknown }) => {
      options.buildRequestPayload("contact_1");
      return { body: { creditNotes: [{ creditNoteID: "cn_1", creditNoteNumber: "CN-0001" }] } };
    },
  );
  mocks.createPayments.mockResolvedValue({ body: { payments: [{ paymentID: "pay_1" }] } });
  mocks.createCreditNoteAllocation.mockResolvedValue({ body: {} });
  mocks.bookingFindUnique.mockResolvedValue(bookingRow());
  // #3535: a booking-anchored clearing note reads each invoice's amount due.
  // By default the booking has no edits and its one invoice owes $150.00.
  mocks.bookingModificationFindMany.mockResolvedValue([]);
  configureInvoicesDue({ invoice_1: 150 });
});

/** Each invoice's live AUTHORISED amount due, in dollars, as Xero returns it. */
function configureInvoicesDue(dueByInvoiceId: Record<string, number>) {
  mocks.getInvoice.mockImplementation(async (_tenant: string, invoiceId: string) => ({
    body: {
      invoices: [
        { invoiceID: invoiceId, status: "AUTHORISED", amountDue: dueByInvoiceId[invoiceId] ?? 0 },
      ],
    },
  }));
}

describe("the cash refund note (createXeroCreditNote)", () => {
  /**
   * #3635 (`INV-PAY-110`): a late capture a treasurer kept, then reopened and
   * refunded, was recorded on its OWN invoice (anchored on its approval task),
   * and a booking paid only late has no primary one. The refund note answers
   * that invoice and settles from Stripe, so the kept $50.00 nets to zero.
   */
  it("#3635: a refund after a reopened keep credits back the kept invoice when there is no primary one", async () => {
    mocks.paymentFindUnique.mockResolvedValue({
      ...paymentRow(PaymentSource.STRIPE),
      xeroInvoiceId: null,
    });
    mocks.manualRefundTaskFindMany.mockResolvedValue([{ id: "task_kept" }]);
    mocks.xeroObjectLinkFindFirst.mockImplementation(async ({ where }: { where: { role?: string } }) =>
      where.role === "KEPT_LATE_CAPTURE_INVOICE" ? { xeroObjectId: "inv_kept" } : null,
    );

    await createXeroCreditNote(PAYMENT_ID, 5000, { refundMethod: "card" });

    expect(builtCreditNote().lineItems?.[0]?.unitAmount).toBe(50);
    expect(settlingPayment()).toMatchObject({ account: { code: "606" } });
    const recorded =
      mocks.xeroSyncOperationUpdate.mock.calls.find((call) => call[0].data.requestPayload)?.[0].data.requestPayload ??
      mocks.startXeroSyncOperation.mock.calls[0][0].requestPayload;
    expect(recorded.allocation).toMatchObject({ invoiceId: "inv_kept" });
  });

  it("#3635: names the kept invoice, not the pre-cancel one the cancel cleared, when the payment has both", async () => {
    mocks.paymentFindUnique.mockResolvedValue(paymentRow(PaymentSource.STRIPE));
    mocks.manualRefundTaskFindMany.mockResolvedValue([{ id: "task_kept" }]);
    mocks.xeroObjectLinkFindFirst.mockImplementation(async ({ where }: { where: { role?: string } }) =>
      where.role === "KEPT_LATE_CAPTURE_INVOICE" ? { xeroObjectId: "inv_kept" } : null,
    );

    await createXeroCreditNote(PAYMENT_ID, 5000, { refundMethod: "card" });

    const recorded =
      mocks.xeroSyncOperationUpdate.mock.calls.find((call) => call[0].data.requestPayload)?.[0].data.requestPayload ??
      mocks.startXeroSyncOperation.mock.calls[0][0].requestPayload;
    expect(recorded.allocation).toMatchObject({ invoiceId: "inv_kept" });
  });

  /**
   * #3635 round-3 R5/R3: a note for a LATE CAPTURE names that capture's own
   * receipt and never the cleared pre-cancel invoice; with no receipt the app
   * recorded it is not raised at all; and one raised after the fact carries
   * the refund's own day.
   */
  describe("a late capture's refund note (round 3)", () => {
    beforeEach(() => {
      mocks.paymentFindUnique.mockResolvedValue(paymentRow(PaymentSource.STRIPE));
      mocks.findLateCapturePaymentIntents.mockImplementation(async () => new Set(["pi_late"]));
    });

    it("names the capture's own receipt, not the payment's pre-cancel invoice, and is dated the refund's day", async () => {
      mocks.readLateCaptureXeroReceipt.mockResolvedValue({ kind: "recorded", invoiceId: "inv_change" });

      await createXeroCreditNote(PAYMENT_ID, 2500, {
        refundMethod: "card",
        paymentIntentId: "pi_late",
        documentDate: "2026-06-12",
      });

      const recorded = mocks.startXeroSyncOperation.mock.calls[0][0].requestPayload;
      expect(recorded.allocation).toMatchObject({ invoiceId: "inv_change" });
      expect(recorded).toMatchObject({ paymentIntentId: "pi_late", documentDate: "2026-06-12" });
      expect(builtCreditNote()).toMatchObject({ date: "2026-06-12" });
      expect(settlingPayment()).toMatchObject({ date: "2026-06-12" });
      // R4: the note's link names its capture, which is what the per-capture
      // sizing counts, so a later credit-back cannot note the same refund twice.
      const noteLink = (completion().extraLinks as Array<{ role: string; metadata?: Record<string, unknown> }>)
        .find((link) => link.role === "REFUND_CREDIT_NOTE");
      expect(noteLink?.metadata).toMatchObject({ amountCents: 2500, paymentIntentId: "pi_late" });
    });

    for (const kind of ["none", "resolved-by-hand"] as const) {
      it(`raises nothing, and completes its row as skipped, when the receipt is ${kind}`, async () => {
        mocks.readLateCaptureXeroReceipt.mockResolvedValue({ kind });

        await expect(
          createXeroCreditNote(PAYMENT_ID, 2500, {
            refundMethod: "card",
            paymentIntentId: "pi_late",
            syncOperationId: "op_note",
          }),
        ).resolves.toBe("");

        expect(mocks.retryXeroWriteWithContactRepair).not.toHaveBeenCalled();
        expect(mocks.completeXeroSyncOperation).toHaveBeenCalledWith(
          "op_note",
          expect.objectContaining({
            responsePayload: expect.objectContaining({ skipped: "late-capture-refund-not-app-recorded", receipt: kind }),
          }),
        );
      });
    }

    it("waits, as a retryable failure, while the released receipt is still on its way to Xero", async () => {
      mocks.readLateCaptureXeroReceipt.mockResolvedValue({ kind: "recorded", invoiceId: null });

      await expect(
        createXeroCreditNote(PAYMENT_ID, 2500, { refundMethod: "card", paymentIntentId: "pi_late" }),
      ).rejects.toThrow(/has not reached Xero yet/);
      expect(mocks.retryXeroWriteWithContactRepair).not.toHaveBeenCalled();
    });
  });

  it("#3635: still refuses a payment with neither a primary nor a kept invoice", async () => {
    mocks.paymentFindUnique.mockResolvedValue({
      ...paymentRow(PaymentSource.STRIPE),
      xeroInvoiceId: null,
    });
    await expect(createXeroCreditNote(PAYMENT_ID, 5000, { refundMethod: "card" })).rejects.toThrow(
      /No Xero invoice linked to payment/,
    );
  });

  it("a card refund says so and settles from the Stripe account", async () => {
    mocks.paymentFindUnique.mockResolvedValue(paymentRow(PaymentSource.STRIPE));

    await createXeroCreditNote(PAYMENT_ID, 5000, { refundMethod: "card" });

    const note = builtCreditNote();
    expect(note.lineItems?.[0]?.description).toBe(
      "Refund against original credit card - Booking cmbookin (2026-08-16 - 2026-08-18)",
    );
    expect(note.reference).toBe("Refund against original credit card - Booking cmbookin");
    expect(mocks.getAccountMapping).toHaveBeenCalledWith("stripeBankAccount");
    expect(settlingPayment()).toMatchObject({
      account: { code: "606" },
      reference: expect.stringMatching(/^Refund against original credit card - .* payment cmpaymen$/),
    });
  });

  it("a bank-transfer refund says so and settles from the club's bank-transfer refund account", async () => {
    mocks.paymentFindUnique.mockResolvedValue(paymentRow(PaymentSource.INTERNET_BANKING));

    await createXeroCreditNote(PAYMENT_ID, 5000, { refundMethod: "internet-banking" });

    const note = builtCreditNote();
    expect(note.lineItems?.[0]?.description).toBe(
      "Refund requested via internet banking - Booking cmbookin (2026-08-16 - 2026-08-18)",
    );
    expect(note.reference).toBe("Refund requested via internet banking - Booking cmbookin");
    expect(settlingPayment()).toMatchObject({
      account: { code: "090" },
      reference: expect.stringMatching(/^Refund requested via internet banking - /),
    });
    expect(completion()).toMatchObject({
      status: "SUCCEEDED",
      responsePayload: expect.objectContaining({ refundPaymentSkipped: false, refundMethod: "internet-banking" }),
    });
  });

  it("a bank-transfer refund with NO refund account chosen is raised UNSETTLED, never paid from Stripe (owner decision, 20 Sep 2026)", async () => {
    configureBankTransferRefundAccount(null);
    mocks.paymentFindUnique.mockResolvedValue(paymentRow(PaymentSource.INTERNET_BANKING));

    await createXeroCreditNote(PAYMENT_ID, 5000, { refundMethod: "internet-banking" });

    expect(builtCreditNote().reference).toBe(
      "Refund requested via internet banking - Booking cmbookin",
    );
    expect(mocks.createPayments).not.toHaveBeenCalled();
    expect(mocks.getAccountMapping).not.toHaveBeenCalledWith("stripeBankAccount");
    expect(completion()).toMatchObject({
      // Complete, not PARTIAL: nothing failed and nothing is waiting to be repaired.
      status: "SUCCEEDED",
      responsePayload: expect.objectContaining({
        refundPayment: null,
        refundPaymentSkipped: true,
        refundPaymentSkipReason: expect.stringContaining("no Bank Transfer Refunds Account is configured"),
      }),
    });
  });

  it("records the method on the operation so a retry or repair settles the same way", async () => {
    mocks.paymentFindUnique.mockResolvedValue(paymentRow(PaymentSource.INTERNET_BANKING));

    await createXeroCreditNote(PAYMENT_ID, 5000, {
      refundMethod: "internet-banking",
      syncOperationId: "op_queued",
    });

    expect(mocks.xeroSyncOperationUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "op_queued" },
        data: { requestPayload: expect.objectContaining({ refundMethod: "internet-banking" }) },
      }),
    );
  });

  it("with no method stated, reads the payment's source: Stripe money left through Stripe", async () => {
    mocks.paymentFindUnique.mockResolvedValue(paymentRow(PaymentSource.STRIPE));

    await createXeroCreditNote(PAYMENT_ID, 5000);

    expect(builtCreditNote().reference).toBe(
      "Refund against original credit card - Booking cmbookin",
    );
    expect(settlingPayment()?.account?.code).toBe("606");
  });

  it("with no method stated, an internet-banking payment reads as a bank transfer and is left unsettled even with an account chosen", async () => {
    // A legacy row nobody vouched for: the wording follows the source, but no
    // payment is recorded, because nothing in the ledger says a transfer was
    // made. Before #3529 this note was marked paid from the Stripe account.
    mocks.paymentFindUnique.mockResolvedValue(paymentRow(PaymentSource.INTERNET_BANKING));

    await createXeroCreditNote(PAYMENT_ID, 5000);

    expect(builtCreditNote().reference).toBe(
      "Refund requested via internet banking - Booking cmbookin",
    );
    expect(mocks.createPayments).not.toHaveBeenCalled();
    expect(completion()).toMatchObject({
      status: "SUCCEEDED",
      responsePayload: expect.objectContaining({
        refundPaymentSkipped: true,
        refundPaymentSkipReason: expect.stringContaining("method was not recorded"),
      }),
    });
  });
});

describe("the account-credit note (createUnappliedXeroCreditNote)", () => {
  it("is Account Credit by construction, on a cancellation", async () => {
    mocks.paymentFindUnique.mockResolvedValue(paymentRow(PaymentSource.STRIPE));

    await createUnappliedXeroCreditNote(PAYMENT_ID, 5000, CLUB_FORMAT_TEST);

    const note = builtCreditNote();
    expect(note.lineItems?.[0]?.description).toBe(
      "Account Credit - Booking cmbookin (2026-08-16 - 2026-08-18)",
    );
    expect(note.reference).toBe("Account Credit - Booking cmbookin");
    expect(mocks.createPayments).not.toHaveBeenCalled();
  });

  it("and on a booking change", async () => {
    mocks.paymentFindUnique.mockResolvedValue(paymentRow(PaymentSource.STRIPE));

    await createUnappliedXeroCreditNote(PAYMENT_ID, 5000, CLUB_FORMAT_TEST, {
      bookingModificationId: "cmmodification01",
    });

    expect(builtCreditNote().lineItems?.[0]?.description).toBe(
      "Account Credit - Booking cmbookin - booking change cmmodifi",
    );
  });
});

describe("#3791: a review task's share is a document of its own", () => {
  beforeEach(() => {
    deallocationFence.findFirst.mockResolvedValue(null);
  });

  const reviewNote = () =>
    createXeroCreditNoteForModification({
      format: CLUB_FORMAT_TEST,
      bookingId: BOOKING_ID,
      refundAmountCents: 1000,
      bookingModificationId: "cmmodification01",
      reviewTaskId: "task-7",
      refundMethod: "account-credit",
      syncOperationId: "op-note",
    });

  it.each(["PENDING", "RUNNING"])("MUTATION: waits, as a transient busy error, while the payment's deallocation is %s - and creates nothing", async (status) => {
    deallocationFence.findFirst.mockResolvedValue({ id: "dealloc-1", status });
    const { XeroAppliedCreditOperationBusyError } = await import("@/lib/xero-applied-credit-operation-serialization");

    await expect(reviewNote()).rejects.toBeInstanceOf(XeroAppliedCreditOperationBusyError);
    expect(mocks.failXeroSyncOperation).not.toHaveBeenCalled();
    expect(mocks.xeroSyncOperationUpdate).not.toHaveBeenCalled();
    expect(mocks.retryXeroWriteWithContactRepair).not.toHaveBeenCalled();
  });

  it.each(["FAILED", "PARTIAL"])("MUTATION: FAILS, naming the deallocation, when it is %s - only an operator's retry moves that, so waiting would spin for ever", async (status) => {
    deallocationFence.findFirst.mockResolvedValue({ id: "dealloc-1", status });
    const { XeroAppliedCreditOperationBusyError } = await import("@/lib/xero-applied-credit-operation-serialization");

    const error = await reviewNote().then(() => null, (e: unknown) => e);

    expect(error).not.toBeInstanceOf(XeroAppliedCreditOperationBusyError);
    expect((error as Error).message).toContain(`deallocation dealloc-1 is ${status}`);
    expect(mocks.failXeroSyncOperation).toHaveBeenCalledWith("op-note", error);
    expect(mocks.retryXeroWriteWithContactRepair).not.toHaveBeenCalled();
  });

  it("MUTATION: once the deallocation has been retried, an operator retry of the note raises it", async () => {
    deallocationFence.findFirst.mockResolvedValueOnce({ id: "dealloc-1", status: "FAILED" });
    await reviewNote().catch(() => undefined);

    // The deallocation converged; the operator retries the note (a fresh row).
    deallocationFence.findFirst.mockResolvedValue(null);
    await createXeroCreditNoteForModification({
      format: CLUB_FORMAT_TEST,
      bookingId: BOOKING_ID,
      refundAmountCents: 1000,
      bookingModificationId: "cmmodification01",
      reviewTaskId: "task-7",
      refundMethod: "account-credit",
      repairExistingLink: true,
    });

    expect(mocks.retryXeroWriteWithContactRepair).toHaveBeenCalledTimes(1);
    expect(mocks.createCreditNoteAllocation).toHaveBeenCalledTimes(1);
  });

  it("MUTATION (#3809): an edit's own note waits on the deallocation too - a credit-paid booking's reduction gives back through the same give-back", async () => {
    deallocationFence.findFirst.mockResolvedValue({ id: "dealloc-1", status: "PENDING" });
    const { XeroAppliedCreditOperationBusyError } = await import("@/lib/xero-applied-credit-operation-serialization");

    await expect(createXeroCreditNoteForModification({
      format: CLUB_FORMAT_TEST,
      bookingId: BOOKING_ID,
      refundAmountCents: 1000,
      bookingModificationId: "cmmodification01",
      refundMethod: "account-credit",
    })).rejects.toBeInstanceOf(XeroAppliedCreditOperationBusyError);
    expect(mocks.retryXeroWriteWithContactRepair).not.toHaveBeenCalled();
  });

  it("an edit's own note with no deallocation on its payment is raised at once", async () => {
    await createXeroCreditNoteForModification({
      format: CLUB_FORMAT_TEST,
      bookingId: BOOKING_ID,
      refundAmountCents: 1000,
      bookingModificationId: "cmmodification01",
    });

    expect(mocks.retryXeroWriteWithContactRepair).toHaveBeenCalledTimes(1);
  });

  it("MUTATION: a queued account note keeps its amount and queue shape when it rewrites the payload, so a retry can rebuild it", async () => {
    mocks.paymentFindUnique.mockResolvedValue(paymentRow(PaymentSource.STRIPE));

    await createUnappliedXeroCreditNote(PAYMENT_ID, 1000, CLUB_FORMAT_TEST, {
      bookingModificationId: "cmmodification01",
      reviewTaskId: "task-7",
      syncOperationId: "op-queued",
    });

    expect(mocks.xeroSyncOperationUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "op-queued" },
      data: {
        requestPayload: expect.objectContaining({
          queueType: "MODIFICATION_ACCOUNT_CREDIT_NOTE",
          refundAmountCents: 1000,
          paymentId: PAYMENT_ID,
          bookingModificationId: "cmmodification01",
          reviewTaskId: "task-7",
        }),
      },
    }));
  });

  it("MUTATION: scopes the invoice-allocated note's keys - the note's and its allocation's - to the task, amount kept, and records the task for a retry", async () => {
    await createXeroCreditNoteForModification({
      format: CLUB_FORMAT_TEST,
      bookingId: BOOKING_ID,
      refundAmountCents: 1000,
      bookingModificationId: "cmmodification01",
      reviewTaskId: "task-7",
      refundMethod: "account-credit",
    });

    expect(mocks.startXeroSyncOperation).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: "booking-mod:cmmodification01:review-task:task-7:mod-credit-note:1000:v1",
      requestPayload: expect.objectContaining({ reviewTaskId: "task-7" }),
    }));
    const allocationKeys = mocks.createCreditNoteAllocation.mock.calls.map((call) => call.at(-1));
    expect(allocationKeys).toEqual(["booking-mod:cmmodification01:review-task:task-7:mod-credit-note-allocation:1000:v1"]);
  });

  it("leaves an edit's own note keyed exactly as before", async () => {
    await createXeroCreditNoteForModification({
      format: CLUB_FORMAT_TEST,
      bookingId: BOOKING_ID,
      refundAmountCents: 1000,
      bookingModificationId: "cmmodification01",
    });

    expect(mocks.startXeroSyncOperation).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: "booking-mod:cmmodification01:mod-credit-note:1000:v1",
    }));
  });

  it("MUTATION: an unallocated note for a review task neither short-cuts on a sibling's link nor shares its key", async () => {
    mocks.paymentFindUnique.mockResolvedValue(paymentRow(PaymentSource.STRIPE));
    // A sibling review's note already on the anchor.
    mocks.xeroObjectLinkFindFirst.mockResolvedValue({ xeroObjectId: "cn-sibling", xeroObjectNumber: "CN-1" });

    await createUnappliedXeroCreditNote(PAYMENT_ID, 1000, CLUB_FORMAT_TEST, {
      bookingModificationId: "cmmodification01",
      reviewTaskId: "task-7",
    });

    expect(mocks.startXeroSyncOperation).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: "booking-mod:cmmodification01:review-task:task-7:mod-unapplied-credit-note:1000:v1",
    }));
    expect(builtCreditNote().reference).toBe("Account Credit - Booking cmbookin");
  });
});

describe("the modification credit note (createXeroCreditNoteForModification)", () => {
  it("carries the method it was handed", async () => {
    await createXeroCreditNoteForModification({
      format: CLUB_FORMAT_TEST,
      bookingId: BOOKING_ID,
      refundAmountCents: 2500,
      bookingModificationId: "cmmodification01",
      refundMethod: "internet-banking",
    });

    const note = builtCreditNote();
    expect(note.lineItems?.[0]?.description).toBe(
      "Refund requested via internet banking - Booking cmbookin - booking change cmmodifi",
    );
    expect(note.reference).toBe("Refund requested via internet banking - Booking cmbookin");
    expect(mocks.xeroSyncOperationUpdate).not.toHaveBeenCalled();
    expect(mocks.startXeroSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        requestPayload: expect.objectContaining({ refundMethod: "internet-banking" }),
      }),
    );
  });

  it("reads as a card refund when handed none, which every pre-#3529 row was", async () => {
    await createXeroCreditNoteForModification({
      format: CLUB_FORMAT_TEST,
      bookingId: BOOKING_ID,
      refundAmountCents: 2500,
      bookingModificationId: "cmmodification01",
    });

    expect(builtCreditNote().reference).toBe(
      "Refund against original credit card - Booking cmbookin",
    );
  });

  // #3535 (`INV-PAY-017`): a released internet-banking hold clears an invoice
  // nobody paid. The note closes it by ALLOCATION, records no payment, and
  // says why the invoice was cleared rather than naming a refund.
  it("clears an unpaid invoice by allocation, records no payment, and names no refund", async () => {
    await createXeroCreditNoteForModification({
      format: CLUB_FORMAT_TEST,
      bookingId: BOOKING_ID,
      refundAmountCents: 15000,
      clearsUnpaidInvoice: true,
    });

    const note = builtCreditNote();
    expect(note.lineItems?.[0]?.description).toBe(
      "Invoice cleared - booking not paid - Booking cmbookin",
    );
    expect(note.reference).toBe("Invoice cleared - booking not paid - Booking cmbookin");
    expect(note.lineItems?.[0]?.unitAmount).toBe(150);
    expect(`${note.reference} ${note.lineItems?.[0]?.description}`).not.toMatch(/refund/i);

    // Allocated against the booking's own invoice for the full amount…
    expect(mocks.createCreditNoteAllocation).toHaveBeenCalledTimes(1);
    const allocation = mocks.createCreditNoteAllocation.mock.calls[0]![2] as {
      allocations: Array<{ invoice: { invoiceID: string }; amount: number }>;
    };
    expect(allocation.allocations).toEqual([
      expect.objectContaining({ invoice: { invoiceID: "invoice_1" }, amount: 150 }),
    ]);
    // …and no credit-note payment: no money is recorded as leaving any account.
    expect(mocks.createPayments).not.toHaveBeenCalled();
    expect(settlingPayment()).toBeUndefined();

    // The choice is recorded on the operation, and no refund method with it.
    const recorded = mocks.startXeroSyncOperation.mock.calls[0]![0] as {
      localModel: string;
      requestPayload: Record<string, unknown>;
    };
    expect(recorded.localModel).toBe("Booking");
    expect(recorded.requestPayload).toEqual(
      expect.objectContaining({ clearsUnpaidInvoice: true, invoiceId: "invoice_1" }),
    );
    expect(recorded.requestPayload).not.toHaveProperty("refundMethod");
    expect(completion()).toEqual(
      expect.objectContaining({
        xeroObjectType: "CREDIT_NOTE",
        xeroObjectId: "cn_1",
        extraLinks: expect.arrayContaining([
          expect.objectContaining({ role: "MODIFICATION_CREDIT_NOTE_ALLOCATION" }),
        ]),
      }),
    );
  });

  // #3643 (`INV-PAY-107`): the cancel path recorded a part payment, so the note
  // clears only the unpaid rest and must not say the booking was not paid. The
  // same allocation, no payment, and the choice recorded for a replay.
  it("words a partly paid booking's note as clearing the unpaid balance", async () => {
    await createXeroCreditNoteForModification({
      format: CLUB_FORMAT_TEST,
      bookingId: BOOKING_ID,
      refundAmountCents: 15000,
      clearsUnpaidInvoice: true,
      clearsUnpaidBalance: true,
    });

    const note = builtCreditNote();
    expect(note.lineItems?.[0]?.description).toBe(
      "Unpaid balance cleared - booking cancelled - Booking cmbookin",
    );
    expect(note.reference).toBe("Unpaid balance cleared - booking cancelled - Booking cmbookin");
    expect(`${note.reference}`).not.toMatch(/not paid/i);
    expect(mocks.createCreditNoteAllocation).toHaveBeenCalledTimes(1);
    expect(mocks.createPayments).not.toHaveBeenCalled();
    const recorded = mocks.startXeroSyncOperation.mock.calls[0]![0] as {
      requestPayload: Record<string, unknown>;
    };
    expect(recorded.requestPayload).toEqual(
      expect.objectContaining({ clearsUnpaidInvoice: true, clearsUnpaidBalance: true }),
    );
  });
});

/**
 * #3535 (`INV-PAY-017`): a clearing note is sized over the booking's whole
 * invoicing, so it is allocated across the primary and any supplementary
 * invoice, each up to what it owes — and not created at all when they owe
 * less than it.
 */
describe("clearing-note allocation across the booking's invoices (#3535)", () => {
  it("spreads an upward-edited booking's note over the primary and the supplementary invoice", async () => {
    mocks.bookingModificationFindMany.mockResolvedValue([{ id: "mod_up" }]);
    mocks.xeroObjectLinkFindMany.mockResolvedValue([{ xeroObjectId: "inv_supp" }]);
    configureInvoicesDue({ invoice_1: 300, inv_supp: 110 });

    await createXeroCreditNoteForModification({
      format: CLUB_FORMAT_TEST,
      bookingId: BOOKING_ID,
      refundAmountCents: 41000,
      clearsUnpaidInvoice: true,
    });

    const allocations = mocks.createCreditNoteAllocation.mock.calls.map((call) => ({
      body: (call[2] as { allocations: Array<{ invoice: { invoiceID: string }; amount: number }> })
        .allocations[0],
      key: call[4] as string,
    }));
    expect(allocations.map((entry) => [entry.body.invoice.invoiceID, entry.body.amount])).toEqual([
      ["invoice_1", 300],
      ["inv_supp", 110],
    ]);
    // Each allocation carries its own idempotency key.
    expect(new Set(allocations.map((entry) => entry.key)).size).toBe(2);
    expect(mocks.createPayments).not.toHaveBeenCalled();
    expect(completion()).not.toHaveProperty("status");
    const links = (completion().extraLinks as Array<{ role: string; metadata?: { invoiceId: string } }>)
      .filter((link) => link.role === "MODIFICATION_CREDIT_NOTE_ALLOCATION")
      .map((link) => link.metadata?.invoiceId);
    expect(links).toEqual(["invoice_1", "inv_supp"]);
    // The plan is recorded, so a PARTIAL repair replays exactly it.
    const recorded = mocks.startXeroSyncOperation.mock.calls[0]![0] as {
      requestPayload: Record<string, unknown>;
    };
    expect(recorded.requestPayload.allocations).toEqual([
      { invoiceId: "invoice_1", amountCents: 30000 },
      { invoiceId: "inv_supp", amountCents: 11000 },
    ]);
  });

  it("creates nothing and fails the operation when the invoices owe less than the note", async () => {
    configureInvoicesDue({ invoice_1: 100 });

    await expect(
      createXeroCreditNoteForModification({
        format: CLUB_FORMAT_TEST,
        bookingId: BOOKING_ID,
        refundAmountCents: 15000,
        clearsUnpaidInvoice: true,
        syncOperationId: "op_queued",
      }),
    ).rejects.toThrow(/owe \$100\.00, less than this \$150\.00 invoice-clearing credit note/);

    expect(mocks.retryXeroWriteWithContactRepair).not.toHaveBeenCalled();
    expect(mocks.createCreditNoteAllocation).not.toHaveBeenCalled();
    expect(mocks.failXeroSyncOperation).toHaveBeenCalledWith("op_queued", expect.any(Error));
  });

  it("goes PARTIAL with the allocations that landed when a later one is refused", async () => {
    mocks.bookingModificationFindMany.mockResolvedValue([{ id: "mod_up" }]);
    mocks.xeroObjectLinkFindMany.mockResolvedValue([{ xeroObjectId: "inv_supp" }]);
    configureInvoicesDue({ invoice_1: 300, inv_supp: 110 });
    mocks.createCreditNoteAllocation
      .mockResolvedValueOnce({ body: { ok: 1 } })
      .mockRejectedValueOnce(new Error("allocation refused"));

    await createXeroCreditNoteForModification({
      format: CLUB_FORMAT_TEST,
      bookingId: BOOKING_ID,
      refundAmountCents: 41000,
      clearsUnpaidInvoice: true,
    });

    expect(completion()).toEqual(expect.objectContaining({ status: "PARTIAL" }));
    const links = (completion().extraLinks as Array<{ role: string; metadata?: { invoiceId: string } }>)
      .filter((link) => link.role === "MODIFICATION_CREDIT_NOTE_ALLOCATION")
      .map((link) => link.metadata?.invoiceId);
    expect(links).toEqual(["invoice_1"]);
  });

  // #3535 delta D3: a retry of a FAILED clearing note opens its own row here;
  // the queue-type column is stamped so the audit and the late-cash alert see it.
  it("stamps the clearing queue type on a row it opens itself, and not on an edit's note", async () => {
    await createXeroCreditNoteForModification({
      format: CLUB_FORMAT_TEST,
      bookingId: BOOKING_ID,
      refundAmountCents: 15000,
      clearsUnpaidInvoice: true,
      repairExistingLink: true,
    });
    expect(mocks.startXeroSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({ localModel: "Booking", queueType: "MODIFICATION_CREDIT_NOTE" }),
    );

    mocks.startXeroSyncOperation.mockClear();
    await createXeroCreditNoteForModification({
      format: CLUB_FORMAT_TEST,
      bookingId: BOOKING_ID,
      refundAmountCents: 2500,
      bookingModificationId: "cmmodification01",
    });
    expect(mocks.startXeroSyncOperation.mock.calls[0]![0]).not.toHaveProperty("queueType");
  });

  it("leaves an edit's reduction note on the original invoice without reading any invoice", async () => {
    await createXeroCreditNoteForModification({
      format: CLUB_FORMAT_TEST,
      bookingId: BOOKING_ID,
      refundAmountCents: 2500,
      bookingModificationId: "cmmodification01",
    });

    expect(mocks.getInvoice).not.toHaveBeenCalled();
    expect(mocks.createCreditNoteAllocation).toHaveBeenCalledTimes(1);
    // The key it always had (#3535 must not change an edit's key): the Xero
    // idempotency key rides as the call's fifth argument.
    expect(mocks.createCreditNoteAllocation.mock.calls[0]![4]).toBe(
      "booking-mod:cmmodification01:mod-credit-note-allocation:2500:v1",
    );
    const recorded = mocks.startXeroSyncOperation.mock.calls[0]![0] as {
      requestPayload: Record<string, unknown>;
    };
    expect(recorded.requestPayload).not.toHaveProperty("allocations");
  });
});

/**
 * #3530 stage 2b: a modification note carries the edit's stored lines,
 * inverted, when they explain exactly what it returns; the single method line
 * otherwise, with the reason recorded. The method wording stays on the
 * reference either way (`INV-PAY-101`).
 */
describe("itemised modification notes (#3530)", () => {
  const removedLines = [
    {
      v: 1, kind: "GUEST_NIGHTS", sign: -1, ageTier: "ADULT", isMember: false,
      rateMembershipTypeId: "type-non-member", unitCents: 8000, nightCount: 2,
      guestCount: 1, quantity: 2, startDate: "2026-08-16", endExclusive: "2026-08-18",
      guestNames: ["Guest b"], amountCents: -16000,
    },
  ];
  beforeEach(() => {
    mocks.bookingModificationFindUnique.mockResolvedValue({
      createdAt: new Date("2026-08-10T00:00:00.000Z"),
      priceLines: removedLines,
      priceDiffCents: -16000,
      changeFeeCents: 0,
    });
    mocks.bookingFindUniqueOrThrow.mockResolvedValue({
      checkIn: new Date("2026-08-16T00:00:00.000Z"),
      lodgeId: "lodge-1",
      promoRedemption: null,
      guests: [{ ageTier: "ADULT", isMember: false, rateMembershipTypeId: "type-non-member" }],
    });
    mocks.getHutFeeItemCodeMap.mockResolvedValue({
      byKey: new Map(), fullTypeId: "type-full", nonMemberTypeId: "type-non-member", legacyItemCode: null, size: 0,
    });
    mocks.getHutFeeSeasonType.mockResolvedValue("WINTER");
  });

  it("the modification credit note lists the removed nights as its credit and keeps the method on the reference", async () => {
    await createXeroCreditNoteForModification({
      format: CLUB_FORMAT_TEST,
      bookingId: BOOKING_ID,
      refundAmountCents: 16000,
      bookingModificationId: "cmmodification01",
      refundMethod: "internet-banking",
    });

    const note = builtCreditNote();
    expect(note.lineItems).toEqual([
      {
        description: "1 x Non-member Adult removed - 2 nights - 16 Aug 2026 - 18 Aug 2026",
        quantity: 2,
        unitAmount: 80,
        taxType: "OUTPUT2",
        accountCode: "200",
      },
    ]);
    expect(note.reference).toBe("Refund requested via internet banking - Booking cmbookin");
    expect(mocks.startXeroSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        requestPayload: expect.objectContaining({
          priceLines: { source: "STORED", reason: null, storedSumCents: -16000, sharesSumCents: null, billedCents: 16000, lineCount: 1, shareCount: 0 },
        }),
      }),
    );
  });

  it.each([
    ["invoice-correction", "Invoice correction — nothing refunded"],
    ["cash", "Refunded in cash"],
  ] as const)(
    "words a %s note with the owner's #3536 words and records it so a replay says the same",
    async (noteWording, words) => {
      await createXeroCreditNoteForModification({
        format: CLUB_FORMAT_TEST,
        bookingId: BOOKING_ID,
        refundAmountCents: 8000,
        bookingModificationId: "cmmodification01",
        noteWording,
      });

      const note = builtCreditNote();
      expect(note.reference).toBe(`${words} - Booking cmbookin`);
      expect(note.lineItems?.[0]?.description).toBe(
        `${words} - Booking cmbookin - booking change cmmodifi`,
      );
      expect(mocks.startXeroSyncOperation).toHaveBeenCalledWith(
        expect.objectContaining({
          requestPayload: expect.objectContaining({ noteWording }),
        }),
      );
    },
  );

  it("a note that returns less than the reduction keeps the single method line and says why", async () => {
    await createXeroCreditNoteForModification({
      format: CLUB_FORMAT_TEST,
      bookingId: BOOKING_ID,
      refundAmountCents: 8000,
      bookingModificationId: "cmmodification01",
    });

    const note = builtCreditNote();
    expect(note.lineItems?.map((line) => line.description)).toEqual([
      "Refund against original credit card - Booking cmbookin - booking change cmmodifi",
    ]);
    expect(mocks.startXeroSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        requestPayload: expect.objectContaining({
          priceLines: expect.objectContaining({ source: "FALLBACK_SINGLE_LINE", reason: "POLICY_RETAINED", storedSumCents: -16000, billedCents: 8000 }),
        }),
      }),
    );
    expect(mocks.bookingFindUniqueOrThrow).not.toHaveBeenCalled();
  });

  it("the account-credit note for a booking change is itemised the same way", async () => {
    mocks.paymentFindUnique.mockResolvedValue(paymentRow(PaymentSource.STRIPE));

    await createUnappliedXeroCreditNote(PAYMENT_ID, 16000, CLUB_FORMAT_TEST, { bookingModificationId: "cmmodification01" });

    const note = builtCreditNote();
    expect(note.lineItems?.map((line) => [line.description, line.quantity, line.unitAmount])).toEqual([
      ["1 x Non-member Adult removed - 2 nights - 16 Aug 2026 - 18 Aug 2026", 2, 80],
    ]);
    expect(note.reference).toBe("Account Credit - Booking cmbookin");
    expect(mocks.startXeroSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        requestPayload: expect.objectContaining({ priceLines: expect.objectContaining({ source: "STORED" }) }),
      }),
    );
  });

  it("a legacy booking-anchored modification note has no edit behind it and records nothing about lines", async () => {
    await createXeroCreditNoteForModification({
      format: CLUB_FORMAT_TEST,
      bookingId: BOOKING_ID,
      refundAmountCents: 2500,
    });

    expect(mocks.bookingModificationFindUnique).not.toHaveBeenCalled();
    const enqueued = mocks.startXeroSyncOperation.mock.calls[0][0];
    expect(enqueued.requestPayload).not.toHaveProperty("priceLines");
    expect(builtCreditNote().lineItems?.[0]?.description).toBe(
      "Refund against original credit card - Booking cmbookin",
    );
  });

  it("a cancellation's account-credit note has no edit behind it and records nothing about lines", async () => {
    mocks.paymentFindUnique.mockResolvedValue(paymentRow(PaymentSource.STRIPE));

    await createUnappliedXeroCreditNote(PAYMENT_ID, 5000, CLUB_FORMAT_TEST);

    expect(mocks.bookingModificationFindUnique).not.toHaveBeenCalled();
    const enqueued = mocks.startXeroSyncOperation.mock.calls[0][0];
    expect(enqueued.requestPayload).not.toHaveProperty("priceLines");
  });
});
