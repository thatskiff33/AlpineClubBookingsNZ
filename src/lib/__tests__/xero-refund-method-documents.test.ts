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
  retryXeroWriteWithContactRepair: vi.fn(),
  findOrCreateXeroContactForInvoicedParty: vi.fn(),
  readClubTimeZoneOutsideRequest: vi.fn(),
  createPayments: vi.fn(),
  createCreditNoteAllocation: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    payment: { findUnique: mocks.paymentFindUnique, update: mocks.paymentUpdate },
    booking: { findUnique: mocks.bookingFindUnique },
    bookingModification: { findUnique: mocks.bookingModificationFindUnique },
    xeroObjectLink: {
      findFirst: mocks.xeroObjectLinkFindFirst,
      findMany: mocks.xeroObjectLinkFindMany,
    },
    xeroSyncOperation: { update: mocks.xeroSyncOperationUpdate },
    memberCredit: { updateMany: mocks.memberCreditUpdateMany },
  },
}));

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

vi.mock("@/lib/xero-mappings", () => ({
  getResolvedAccountMapping: mocks.getResolvedAccountMapping,
  getAccountMapping: mocks.getAccountMapping,
}));

vi.mock("@/lib/xero-contacts", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/xero-contacts");
  return { ...actual, retryXeroWriteWithContactRepair: mocks.retryXeroWriteWithContactRepair };
});

vi.mock("@/lib/organisation-xero-contacts", () => ({
  findOrCreateXeroContactForInvoicedParty: mocks.findOrCreateXeroContactForInvoicedParty,
  invoicedPartyContactRepair: () => async () => "contact_1",
}));

vi.mock("@/lib/club-time-zone-runtime", () => ({
  readClubTimeZoneOutsideRequest: mocks.readClubTimeZoneOutsideRequest,
}));

import {
  createUnappliedXeroCreditNote,
  createXeroCreditNote,
} from "@/lib/xero-credit-notes";
import { createXeroCreditNoteForModification } from "@/lib/xero-modification-credit-notes";

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
  lineItems?: Array<{ description?: string }>;
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
function settlingPayment(): { account?: { code?: string }; reference?: string } | undefined {
  const call = mocks.createPayments.mock.calls[0];
  return call ? (call[1] as { payments: Array<{ account?: { code?: string }; reference?: string }> }).payments[0] : undefined;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getAuthenticatedXeroClient.mockResolvedValue({
    xero: {
      accountingApi: {
        createPayments: mocks.createPayments,
        createCreditNoteAllocation: mocks.createCreditNoteAllocation,
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
});

describe("the cash refund note (createXeroCreditNote)", () => {
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

    await createUnappliedXeroCreditNote(PAYMENT_ID, 5000);

    const note = builtCreditNote();
    expect(note.lineItems?.[0]?.description).toBe(
      "Account Credit - Booking cmbookin (2026-08-16 - 2026-08-18)",
    );
    expect(note.reference).toBe("Account Credit - Booking cmbookin");
    expect(mocks.createPayments).not.toHaveBeenCalled();
  });

  it("and on a booking change", async () => {
    mocks.paymentFindUnique.mockResolvedValue(paymentRow(PaymentSource.STRIPE));

    await createUnappliedXeroCreditNote(PAYMENT_ID, 5000, {
      bookingModificationId: "cmmodification01",
    });

    expect(builtCreditNote().lineItems?.[0]?.description).toBe(
      "Account Credit - Booking cmbookin - booking change cmmodifi",
    );
  });
});

describe("the modification credit note (createXeroCreditNoteForModification)", () => {
  it("carries the method it was handed", async () => {
    await createXeroCreditNoteForModification({
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
      bookingId: BOOKING_ID,
      refundAmountCents: 2500,
      bookingModificationId: "cmmodification01",
    });

    expect(builtCreditNote().reference).toBe(
      "Refund against original credit card - Booking cmbookin",
    );
  });
});
