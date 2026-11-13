/**
 * #4525 (Ledger M13): a refund credit note's and its payment's export
 * manifests, recorded after the send. Drives `createXeroCreditNote` to the
 * provider write with Xero mocked (the harness of
 * `xero-refund-method-documents.test.ts`), with the manifest writer stubbed,
 * and the recorders against stubbed journal reads. Nothing here changes what is
 * sent: a conflict or a failed write still completes the operation.
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
  writeExportManifest: vi.fn(),
  memberMoneyEventFindUnique: vi.fn(),
  memberMoneyObligationFindUnique: vi.fn(),
  manifestFindFirst: vi.fn(),
  coverageFindFirst: vi.fn(),
  operationFindUnique: vi.fn(),
  operationFindMany: vi.fn(),
}));

const deallocationFence = vi.hoisted(() => ({ findFirst: vi.fn() }));

vi.mock("@/lib/prisma", () => {
  const prisma = {
    // #3548: a new refund note is recorded (payment, link, row) in one transaction.
    $transaction: (run: (tx: unknown) => unknown) => run(prisma),
    // #4656: its first statement takes the Payment row (`lockPaymentForRefundedTotal`).
    $executeRaw: async () => 1,
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
      // #4426: a refund note's record claims its row; no row here is resolved by hand.
      updateMany: async () => ({ count: 1 }),
      findUnique: (...a: unknown[]) => mocks.operationFindUnique(...a),
      // #3791: the unconverged-deallocation read a review's note defers on.
      findFirst: (...a: unknown[]) => deallocationFence.findFirst(...a),
      // #4688: no unrecorded refund note fences these payments.
      findMany: (...a: unknown[]) => mocks.operationFindMany(...a),
    },
    // #4685: the stamp reads which credit holds the note before it writes.
    memberCredit: { findFirst: vi.fn().mockResolvedValue(null), updateMany: mocks.memberCreditUpdateMany },
    // #4525 (M13): the journal the manifest reads, and the manifest it checks before writing.
    memberMoneyEvent: { findUnique: mocks.memberMoneyEventFindUnique },
    memberMoneyObligation: { findUnique: mocks.memberMoneyObligationFindUnique },
    memberMoneyExportManifest: { findFirst: mocks.manifestFindFirst },
    memberMoneyExportCoverage: { findFirst: mocks.coverageFindFirst },
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
  // Round 11: the close's plan reads the paid-another-way verdict; one mock answers both.
  readPaidAnotherWayLateCaptureXeroReceipt: mocks.readLateCaptureXeroReceipt,
}));

vi.mock("@/lib/member-money/internal/store", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/member-money/internal/store")),
  writeExportManifest: mocks.writeExportManifest,
}));

vi.mock("@/lib/club-time-zone-runtime", () => ({
  readClubTimeZoneOutsideRequest: mocks.readClubTimeZoneOutsideRequest,
}));

import { createXeroCreditNote } from "@/lib/xero-credit-notes";
import { recordSentRefundNotePaymentManifest } from "@/lib/xero-refund-note-settlement";
import { recordRefundNoteManifest, recordRefundNotePaymentManifest } from "@/lib/member-money/doors";
import { refundDocumentLineItem } from "@/lib/xero-modification-line-items";

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
  mocks.operationFindUnique.mockResolvedValue(null);
  mocks.operationFindMany.mockResolvedValue([]);
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


/** The manifests the recorders handed the writer, by role. */
function written(role?: string) {
  return mocks.writeExportManifest.mock.calls.map((call) => call[1]).filter((row) => !role || row.documentRole === role);
}

/** An R12's journal, paying one refund debt from Stripe clearing. */
function cardRefundEvent(obligation: { obligationKey: string; faceCents: number; kind?: string; reversed?: boolean }, cashCents: number) {
  return {
    journal: {
      applications: [{ obligation: {
        obligationKey: obligation.obligationKey, kind: obligation.kind ?? "REFUND", faceCents: obligation.faceCents,
        journal: { reversedBy: obligation.reversed ? { id: "rev" } : null },
      } }],
      lines: [
        { account: "REFUND_PAYABLE", side: "DEBIT", amountCents: cashCents },
        { account: "STRIPE_CLEARING", side: "CREDIT", amountCents: cashCents },
      ],
    },
  };
}

const DEBT = "refund-obligation|cancellation|cancel_1";
const line = refundDocumentLineItem("Refund - Booking cmbookin", 5000, { code: "200", itemCode: null, codeExplicitlyConfigured: false });

describe("the refund note's manifest from the sender (createXeroCreditNote)", () => {
  beforeEach(() => {
    mocks.writeExportManifest.mockResolvedValue("WRITTEN");
    mocks.manifestFindFirst.mockResolvedValue(null);
    mocks.coverageFindFirst.mockResolvedValue(null);
    mocks.memberMoneyEventFindUnique.mockResolvedValue(null);
  });

  it("a watermark note answering no one debt records a CONFLICT, and still sends, settles and completes", async () => {
    mocks.paymentFindUnique.mockResolvedValue(paymentRow(PaymentSource.STRIPE));

    await expect(createXeroCreditNote(PAYMENT_ID, 5000, { refundMethod: "card" })).resolves.toBe("cn_1");

    expect(settlingPayment()).toMatchObject({ account: { code: "606" } });
    expect(completion()).toMatchObject({ status: "SUCCEEDED" });
    expect(written("REFUND_NOTE")).toEqual([expect.objectContaining({
      outcome: "CONFLICT", reason: "COMPONENT_UNUSABLE", bookingId: BOOKING_ID, providerInvoiceId: "cn_1", coverage: [], lineTotalCents: 5000,
    })]);
    // The payment's cash names no event either: a conflict too, never coverage.
    expect(written("REFUND_NOTE_PAYMENT")).toEqual([expect.objectContaining({ outcome: "CONFLICT", providerInvoiceId: "pay_1", coverage: [] })]);
  });

  it("a manifest write that fails is swallowed: the note is still returned and the row completed", async () => {
    mocks.paymentFindUnique.mockResolvedValue(paymentRow(PaymentSource.STRIPE));
    mocks.writeExportManifest.mockRejectedValue(new Error("database down"));

    await expect(createXeroCreditNote(PAYMENT_ID, 5000, { refundMethod: "card" })).resolves.toBe("cn_1");
    expect(completion()).toMatchObject({ status: "SUCCEEDED" });
  });

  it("a bank-transfer note left unsettled writes the note's manifest and no payment manifest", async () => {
    configureBankTransferRefundAccount(null);
    mocks.paymentFindUnique.mockResolvedValue(paymentRow(PaymentSource.INTERNET_BANKING));

    await createXeroCreditNote(PAYMENT_ID, 5000, { refundMethod: "internet-banking" });

    expect(mocks.createPayments).not.toHaveBeenCalled();
    expect(written("REFUND_NOTE")).toHaveLength(1);
    expect(written("REFUND_NOTE_PAYMENT")).toEqual([]);
  });

  it("a note an earlier run raised is recorded from its stored request, never rebuilt", async () => {
    mocks.paymentFindUnique.mockResolvedValue(paymentRow(PaymentSource.STRIPE));
    mocks.findCanonicalPaymentRefundCreditNote.mockResolvedValue({ xeroObjectId: "cn_old", xeroObjectNumber: "CN-0000" });

    await expect(createXeroCreditNote(PAYMENT_ID, 5000, { refundMethod: "card" })).resolves.toBe("cn_old");

    expect(mocks.retryXeroWriteWithContactRepair).not.toHaveBeenCalled();
    // The harness's operation store holds no row that raised it: nothing is rebuilt, nothing written.
    expect(written()).toEqual([]);
  });
});

describe("recordRefundNoteManifest", () => {
  beforeEach(() => {
    mocks.writeExportManifest.mockResolvedValue("WRITTEN");
    mocks.manifestFindFirst.mockResolvedValue(null);
    mocks.coverageFindFirst.mockResolvedValue(null);
    mocks.memberMoneyEventFindUnique.mockResolvedValue(null);
  });

  const built = (door: Record<string, string | null>) => ({
    paymentId: PAYMENT_ID, bookingId: BOOKING_ID, creditNoteId: "cn_1",
    source: { kind: "BUILT" as const, lines: [line], legacyKey: "note-key", door },
  });

  it("a card refund's note covers only its refund debt, whole, never revenue or cash", async () => {
    mocks.memberMoneyEventFindUnique.mockImplementation(async ({ where }: { where: { eventKey: string } }) =>
      where.eventKey === "refund:re_1" ? cardRefundEvent({ obligationKey: DEBT, faceCents: 5000 }, 5000) : null);

    await recordRefundNoteManifest(built({ cardRefundId: "re_1" }));

    expect(written()).toEqual([expect.objectContaining({
      documentRole: "REFUND_NOTE", legacyKey: "note-key", outcome: "COVERED", reason: null, lineTotalCents: 5000,
      coverage: [{ account: "REFUND_PAYABLE", chargeIdentity: DEBT, coveredCents: 5000, taxCode: null }],
    })]);
  });

  it("a note short of its debt's face is a CENTS conflict; a reversed debt is unusable", async () => {
    mocks.memberMoneyEventFindUnique.mockResolvedValue(cardRefundEvent({ obligationKey: DEBT, faceCents: 6000 }, 5000));
    await recordRefundNoteManifest(built({ cardRefundId: "re_1" }));
    mocks.memberMoneyEventFindUnique.mockResolvedValue(cardRefundEvent({ obligationKey: DEBT, faceCents: 5000, reversed: true }, 5000));
    await recordRefundNoteManifest(built({ cardRefundId: "re_1" }));

    expect(written().map((row) => [row.outcome, row.reason, row.coverage])).toEqual([
      ["CONFLICT", "CENTS", []],
      ["CONFLICT", "COMPONENT_UNUSABLE", []],
    ]);
  });

  it("a debt an earlier note already covers is recorded ALREADY_COVERED, with no second coverage row", async () => {
    mocks.memberMoneyEventFindUnique.mockResolvedValue(cardRefundEvent({ obligationKey: DEBT, faceCents: 5000 }, 5000));
    mocks.coverageFindFirst.mockResolvedValue({ chargeIdentity: DEBT });

    await recordRefundNoteManifest(built({ cardRefundId: "re_1" }));

    expect(mocks.coverageFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { documentRole: "REFUND_NOTE", OR: [{ account: "REFUND_PAYABLE", chargeIdentity: DEBT }] },
    }));
    expect(written()).toEqual([expect.objectContaining({ outcome: "CONFLICT", reason: "ALREADY_COVERED", coverage: [] })]);
  });

  it("a note this booking already recorded under another key is left as it stands", async () => {
    mocks.manifestFindFirst.mockResolvedValue({ id: "manifest_1" });
    await recordRefundNoteManifest(built({ cardRefundId: "re_1" }));
    expect(written()).toEqual([]);
  });

  it("a replay hashes the stored request's lines under the row's key, and skips a row that stored none", async () => {
    mocks.memberMoneyEventFindUnique.mockResolvedValue(cardRefundEvent({ obligationKey: DEBT, faceCents: 5000 }, 5000));
    mocks.operationFindMany.mockResolvedValue([{ idempotencyKey: "stored-key", correlationKey: "stored-key",
      requestPayload: { creditNotes: [{ lineItems: [line] }], cardRefundId: "re_1" } }]);
    const replay = { paymentId: PAYMENT_ID, bookingId: BOOKING_ID, creditNoteId: "cn_1", source: { kind: "REPLAY" as const, operationId: "op_1" } };

    await recordRefundNoteManifest(replay);
    expect(mocks.operationFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "op_1" } }));
    expect(written()).toEqual([expect.objectContaining({
      legacyKey: "stored-key", outcome: "COVERED", frozenMapping: expect.objectContaining({ source: "STORED_REQUEST" }),
    })]);

    mocks.writeExportManifest.mockClear();
    mocks.operationFindMany.mockResolvedValue([{ idempotencyKey: "k", correlationKey: "k", requestPayload: { refundMethod: "card" } }]);
    await recordRefundNoteManifest(replay);
    expect(written()).toEqual([]);
  });

  it("a request's note reads its live debt from the chain", async () => {
    mocks.memberMoneyEventFindUnique.mockImplementation(async ({ where }: { where: { eventKey: string } }) =>
      where.eventKey === "refund-obligation|refund-request|rr_1" ? { journal: { reversedBy: null } } : null);
    mocks.memberMoneyObligationFindUnique.mockResolvedValue({
      obligationKey: "refund-obligation|refund-request|rr_1", kind: "REFUND", faceCents: 5000, journal: { reversedBy: null },
    });

    await recordRefundNoteManifest(built({ refundRequestId: "rr_1" }));

    expect(written()).toEqual([expect.objectContaining({
      outcome: "COVERED", coverage: [expect.objectContaining({ chargeIdentity: "refund-obligation|refund-request|rr_1" })],
    })]);
  });
});

describe("the refund note's payment manifest", () => {
  beforeEach(() => {
    mocks.writeExportManifest.mockResolvedValue("WRITTEN");
    mocks.manifestFindFirst.mockResolvedValue(null);
    mocks.coverageFindFirst.mockResolvedValue(null);
    mocks.paymentFindUnique.mockResolvedValue({ bookingId: BOOKING_ID });
  });

  const sent = { xeroPaymentId: "pay_1", amountCents: 5000, bankCode: "606", paymentDate: "2026-07-01" };

  it("a card refund's payment covers only its R12 on Stripe clearing", async () => {
    mocks.operationFindUnique.mockResolvedValue({ requestPayload: { cardRefundId: "re_1" } });
    mocks.memberMoneyEventFindUnique.mockImplementation(async ({ where }: { where: { eventKey: string } }) =>
      where.eventKey === "refund:re_1" ? cardRefundEvent({ obligationKey: DEBT, faceCents: 5000 }, 5000) : null);

    await recordRefundNotePaymentManifest({ paymentId: PAYMENT_ID, creditNoteId: "cn_1", operationId: "op_1", refundMethod: "card", legacyKey: "pay-key", sent });

    expect(written()).toEqual([expect.objectContaining({
      documentRole: "REFUND_NOTE_PAYMENT", legacyKey: "pay-key", outcome: "COVERED", providerInvoiceId: "pay_1",
      coverage: [{ account: "STRIPE_CLEARING", chargeIdentity: "refund:re_1", coveredCents: 5000, taxCode: null }],
    })]);
  });

  it("records nothing for a payment skipped, failed or part-settled", async () => {
    const base = { refundPaymentResponseBody: null, refundPaymentErr: null, refundPaymentSkipReason: null };
    const target = { paymentId: PAYMENT_ID, creditNoteId: "cn_1", operationId: "op_1", refundMethod: "card" as const };
    const paid = [{ paymentID: "pay_1", amountCents: 5000, number: null }];
    const sentPayment = { bankCode: "606", paymentDate: "2026-07-01", amountCents: 5000 };
    await recordSentRefundNotePaymentManifest({ ...base, payments: [], refundPaymentSkipReason: "unsettled" }, target);
    await recordSentRefundNotePaymentManifest({ ...base, payments: [], refundPaymentErr: new Error("Xero said no") }, target);
    await recordSentRefundNotePaymentManifest({ ...base, payments: paid, refundPaymentRemainingCents: 1000 }, target);
    // Found already settled in Xero: no payment this leg sent.
    await recordSentRefundNotePaymentManifest({ ...base, payments: paid }, target);
    expect(written()).toEqual([]);

    await recordSentRefundNotePaymentManifest({ ...base, payments: paid, sentPayment }, target);
    expect(written()).toHaveLength(1);
  });
});
