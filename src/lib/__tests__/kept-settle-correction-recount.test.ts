import { beforeEach, describe, expect, it, vi } from "vitest";

// #4095 items 5 and 12 (`INV-PAY-126`): a bank-transfer settle that keeps the
// stored figure recounts the invoice corrections already synced against it.
// The realdb suite (`ib-settle-from-cash.realdb.test.ts`) drives the whole
// settle; this pins which notes are recounted, and with what.

const mocks = vi.hoisted(() => ({
  linkFindFirst: vi.fn(),
  linkFindMany: vi.fn(),
  repair: vi.fn(),
  readModificationNoteCash: vi.fn(),
  loggerError: vi.fn(),
  decideLinked: vi.fn(),
  floor: vi.fn(),
  sendFloorAlert: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: { xeroObjectLink: { findFirst: mocks.linkFindFirst, findMany: mocks.linkFindMany } } }));
vi.mock("@/lib/logger", () => ({ default: { error: mocks.loggerError, warn: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/xero-inbound/credit-note-repairs", () => ({ repairRefundedPaymentBusinessState: mocks.repair }));
// The whole-total decision and its floor are the repair's own, pinned in
// `xero-credit-note-repairs.test.ts` and driven for real by the realdb suites.
vi.mock("@/lib/xero-inbound/linked-refunded-total", () => ({ decideLinkedRefundedTotalCents: mocks.decideLinked }));
vi.mock("@/lib/xero-inbound/credit-note-bank-transfer-floor", () => ({
  bankTransferFloorCents: mocks.floor,
  sendBankTransferFloorAlert: mocks.sendFloorAlert,
}));
vi.mock("@/lib/xero-inbound/account-credit-modification-notes", () => ({
  readModificationNoteCash: mocks.readModificationNoteCash,
}));

import { afterKeptSettleCommits, recountCorrectionsAfterKeptSettle } from "@/lib/xero-inbound/kept-settle-correction-recount";
import { decideInternetBankingReceiptFigure } from "@/lib/xero-inbound/settle-from-cash";

const INVOICE_ID = "inv-4095";
const PAYMENT_ID = "pay-1";

beforeEach(() => {
  vi.clearAllMocks();
  // The repair's own result shape (`RefundedPaymentBusinessStateRepairResult`).
  mocks.repair.mockResolvedValue({ matchedPayments: 1, updatedPayments: 1 });
  mocks.decideLinked.mockResolvedValue(new Map());
  mocks.floor.mockImplementation(async (_store: unknown, input: { xeroDerivedCents: number }) => ({ cents: input.xeroDerivedCents, alert: null }));
});

describe("recountCorrectionsAfterKeptSettle (#4095 items 5 and 12)", () => {
  it("MUTATION: recounts the payment with no note being synced, so every correction counts from its links as the repair reads them (#4095 review, item 2)", async () => {
    await expect(
      recountCorrectionsAfterKeptSettle(INVOICE_ID, PAYMENT_ID, [{ id: "note-1", appliedCents: 10_000 }]),
    ).resolves.toEqual([]);

    expect(mocks.repair).toHaveBeenCalledTimes(1);
    expect(mocks.repair).toHaveBeenCalledWith({
      creditNoteId: null,
      creditNote: {},
      directPaymentIds: [PAYMENT_ID],
      modificationRefundAmountsByPaymentId: new Map(),
    });
    // No status or amount read before the repair reads the payment: a void that
    // commits in between is never overwritten with the note counted.
    expect(mocks.linkFindFirst).not.toHaveBeenCalled();
    expect(mocks.linkFindMany).not.toHaveBeenCalled();
  });

  it("one recount covers every correction on the invoice", async () => {
    await recountCorrectionsAfterKeptSettle(INVOICE_ID, PAYMENT_ID, [
      { id: "note-1", appliedCents: 10_000 },
      { id: "note-2", appliedCents: 5_000 },
    ]);
    expect(mocks.repair).toHaveBeenCalledTimes(1);
  });

  it("recounts nothing when no correction is applied", async () => {
    await expect(recountCorrectionsAfterKeptSettle(INVOICE_ID, PAYMENT_ID, [])).resolves.toEqual([]);
    expect(mocks.repair).not.toHaveBeenCalled();
  });

  it("never fails the committed settle: a failed or lost recount is logged and its corrections returned", async () => {
    const notes = [
      { id: "note-1", appliedCents: 10_000 },
      { id: "note-2", appliedCents: 5_000 },
    ];
    mocks.repair
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ matchedPayments: 1, updatedPayments: 0, unsettledPaymentIds: [PAYMENT_ID] });

    await expect(recountCorrectionsAfterKeptSettle(INVOICE_ID, PAYMENT_ID, notes)).resolves.toEqual(["note-1", "note-2"]);
    await expect(recountCorrectionsAfterKeptSettle(INVOICE_ID, PAYMENT_ID, notes)).resolves.toEqual(["note-1", "note-2"]);
    expect(mocks.loggerError).toHaveBeenCalledTimes(2);
  });
});

describe("afterKeptSettleCommits (#4449)", () => {
  const format = {} as Parameters<typeof afterKeptSettleCommits>[3];

  it("alerts a floor the keep held, then recounts its corrections", async () => {
    const floorAlert = { paymentId: PAYMENT_ID } as unknown as NonNullable<Parameters<typeof afterKeptSettleCommits>[2]["floorAlert"]>;
    const order: string[] = [];
    mocks.sendFloorAlert.mockImplementation(async () => void order.push("alert"));
    mocks.repair.mockImplementation(async () => (order.push("recount"), { matchedPayments: 1, updatedPayments: 1 }));

    await expect(
      afterKeptSettleCommits(INVOICE_ID, PAYMENT_ID, { correctionNotes: [{ id: "note-1", appliedCents: 10_000 }], floorAlert }, format),
    ).resolves.toEqual([]);

    expect(mocks.sendFloorAlert).toHaveBeenCalledWith(floorAlert, format);
    expect(order).toEqual(["alert", "recount"]);
  });

  it("sends no alert and recounts nothing when the keep left neither", async () => {
    await expect(afterKeptSettleCommits(INVOICE_ID, PAYMENT_ID, { correctionNotes: [], floorAlert: null }, format)).resolves.toEqual([]);
    expect(mocks.sendFloorAlert).not.toHaveBeenCalled();
    expect(mocks.repair).not.toHaveBeenCalled();
  });
});

describe("decideInternetBankingReceiptFigure names the applied corrections (#4095)", () => {
  it("returns only the correction notes, never a refund-worded, no-cash or member-credit note", async () => {
    mocks.readModificationNoteCash.mockResolvedValue(
      new Map([
        ["correction", "correction"],
        ["refund", "refund"],
        ["no-cash", "no-cash"],
        ["member-credit", "correction"],
      ]),
    );
    const tx = {
      paymentTransaction: {
        findMany: vi.fn().mockResolvedValue([
          { kind: "PRIMARY", source: "INTERNET_BANKING", status: "PENDING", amountCents: 30_000, refundedAmountCents: 0 },
        ]),
      },
      memberCredit: { findMany: vi.fn().mockResolvedValue([{ xeroCreditNoteId: "member-credit" }]) },
    };
    const decided = await decideInternetBankingReceiptFigure(tx as never, {
      invoiceId: INVOICE_ID,
      payment: { id: "pay-1", bookingId: "booking-1", amountCents: 30_000, refundedAmountCents: 0 },
      cash: { knownCents: 20_000, complete: false },
      matchedPayments: 1,
      secondInstrument: false,
      invoice: {
        totalCents: 30_000,
        appliedCreditNotes: [
          // One note allocated to the invoice in two parts (#4095 review, item 5).
          { id: "correction", appliedCents: 6_000 },
          { id: "correction", appliedCents: 4_000 },
          { id: "refund", appliedCents: 1_000 },
          { id: "no-cash", appliedCents: 2_000 },
          { id: "member-credit", appliedCents: 3_000 },
        ],
      },
    });
    expect(decided.plan).toMatchObject({ kind: "keep" });
    // One entry per note, its parts summed: never counted at one part.
    expect(decided.appliedCorrectionNotes).toEqual([{ id: "correction", appliedCents: 10_000 }]);
    // Kept at the stored $300, a full payment brings $300 less the $100
    // correction, the $20 no-cash note and the member's $30 credit, $150: a
    // mint of that much is no part payment on the cancel arms (#4095 item 2),
    // and a cent less is.
    expect(decided.receiptCents).toBe(30_000);
    expect(decided.isPartPayment({ mintableCents: 15_000, mintPartial: true })).toBe(false);
    expect(decided.isPartPayment({ mintableCents: 14_999, mintPartial: true })).toBe(true);
    expect(decided.isPartPayment({ mintableCents: 30_000, mintPartial: false })).toBe(false);
  });
});

describe("a keep sets the whole refunded total its links decide, in its own transaction (#4449)", () => {
  type Row = { kind: string; source: string; status: string; amountCents: number; refundedAmountCents: number; reason: string | null };
  const pendingReceipt = (overrides: Partial<Row> = {}): Row => ({
    kind: "PRIMARY",
    source: "INTERNET_BANKING",
    status: "PENDING",
    amountCents: 30_000,
    refundedAmountCents: 0,
    reason: "internet_banking_booking_payment",
    ...overrides,
  });

  function decide(input: {
    rows?: Row[];
    refundedAmountCents?: number;
    linkedCents?: number;
    cash?: { knownCents: number; complete: boolean };
    matchedPayments?: number;
  }) {
    mocks.readModificationNoteCash.mockResolvedValue(new Map([["cn-correction", "correction"]]));
    mocks.decideLinked.mockResolvedValue(new Map([[PAYMENT_ID, input.linkedCents ?? 10_000]]));
    const tx = {
      paymentTransaction: { findMany: vi.fn().mockResolvedValue(input.rows ?? [pendingReceipt()]) },
      memberCredit: { findMany: vi.fn().mockResolvedValue([]) },
    };
    return decideInternetBankingReceiptFigure(tx as never, {
      invoiceId: INVOICE_ID,
      payment: { id: PAYMENT_ID, bookingId: "booking-1", amountCents: 30_000, refundedAmountCents: input.refundedAmountCents ?? 0 },
      // Xero's amount paid unquantifiable: the settle keeps the stored $300.
      cash: input.cash ?? { knownCents: 20_000, complete: false },
      matchedPayments: input.matchedPayments ?? 1,
      secondInstrument: false,
      invoice: { totalCents: 30_000, appliedCreditNotes: [{ id: "cn-correction", appliedCents: 10_000 }] },
    });
  }

  it("MUTATION: the $100 correction synced before the transfer is counted with the receipt as the keep captures it", async () => {
    await expect(decide({})).resolves.toMatchObject({
      plan: { kind: "keep" },
      receiptCents: 30_000,
      paymentColumns: { amountCents: 30_000, refundedAmountCents: 10_000, status: "PARTIALLY_REFUNDED" },
      floorAlert: null,
    });
    // Decided in the settle's transaction, for this payment by this invoice,
    // with its bank receipt read as captured - the rows the links count against.
    expect(mocks.decideLinked).toHaveBeenCalledTimes(1);
    const [store, payments, options] = mocks.decideLinked.mock.calls[0];
    expect(store).toHaveProperty("paymentTransaction");
    // #4370: with the booking and stored total the failed-card subtraction reads.
    expect(payments).toEqual([
      { id: PAYMENT_ID, bookingId: "booking-1", amountCents: 30_000, refundedAmountCents: 0, source: "INTERNET_BANKING", xeroInvoiceId: INVOICE_ID },
    ]);
    expect(options.transactionRowsOverride.get(PAYMENT_ID)).toEqual([pendingReceipt({ status: "SUCCEEDED" })]);
    expect(options).not.toHaveProperty("excludeCreditNoteId");
  });

  it("MUTATION: the total is absolute, never an increment on a stored figure that already holds part of it", async () => {
    // CASE 2 of the realdb race: $50 stored, the links decide $150 - $150, not $200.
    await expect(decide({ refundedAmountCents: 5_000, linkedCents: 15_000 })).resolves.toMatchObject({
      paymentColumns: { refundedAmountCents: 15_000, status: "PARTIALLY_REFUNDED" },
    });
  });

  it("a stored total the links already decide writes nothing", async () => {
    await expect(decide({ refundedAmountCents: 10_000 })).resolves.toMatchObject({ plan: { kind: "keep" }, paymentColumns: null });
  });

  it("a receipt with no bank-transfer PRIMARY row is decided as the keep creates one", async () => {
    await decide({ rows: [] });
    const [, , options] = mocks.decideLinked.mock.calls[0];
    expect(options.transactionRowsOverride.get(PAYMENT_ID)).toEqual([
      expect.objectContaining({ kind: "PRIMARY", source: "INTERNET_BANKING", status: "SUCCEEDED" }),
    ]);
  });

  it("never over the payment's amount", async () => {
    await expect(decide({ linkedCents: 45_000 })).resolves.toMatchObject({
      paymentColumns: { refundedAmountCents: 30_000, status: "REFUNDED" },
    });
  });

  it("MUTATION (INV-ADDPAY-021): the bank-transfer floor applies, and its alert is returned for after the commit", async () => {
    const alert = { paymentId: PAYMENT_ID, bookingId: "booking-1", creditNoteId: null, creditNoteNumber: null, xeroDerivedCents: 10_000, floorCents: 4_000 };
    mocks.floor.mockResolvedValueOnce({ cents: 4_000, alert });
    await expect(decide({})).resolves.toMatchObject({ paymentColumns: { refundedAmountCents: 4_000 }, floorAlert: alert });
    expect(mocks.floor).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ xeroDerivedCents: 10_000, creditNoteId: null }));
  });

  it("MUTATION (#4449 review, item 2): a keep held at the floor that leaves the stored total where it was sends no alert", async () => {
    // A $40 card refund on record, its note still in the outbox: Xero's links say $0, the floor keeps the $40.
    const alert = { paymentId: PAYMENT_ID, bookingId: "booking-1", creditNoteId: null, creditNoteNumber: null, xeroDerivedCents: 0, floorCents: 4_000 };
    mocks.floor.mockResolvedValueOnce({ cents: 4_000, alert });
    await expect(decide({ refundedAmountCents: 4_000, linkedCents: 0 })).resolves.toMatchObject({ paymentColumns: null, floorAlert: null });
  });

  it("MUTATION: never on an invoice matched to several payments, whose share of the correction is unknown; nor is it recounted after", async () => {
    await expect(decide({ matchedPayments: 2 })).resolves.toMatchObject({ plan: { kind: "keep" }, paymentColumns: null, appliedCorrectionNotes: [] });
    expect(mocks.decideLinked).not.toHaveBeenCalled();
  });

  it("never on a replay, whose receipt is already captured", async () => {
    await expect(decide({ rows: [pendingReceipt({ status: "SUCCEEDED" })] })).resolves.toMatchObject({ plan: { kind: "replay" }, paymentColumns: null });
    expect(mocks.decideLinked).not.toHaveBeenCalled();
  });

  it("never on a rewrite, whose cash-sized receipt counts no correction", async () => {
    await expect(decide({ cash: { knownCents: 20_000, complete: true } })).resolves.toMatchObject({
      plan: { kind: "rewrite" },
      paymentColumns: { amountCents: 20_000, refundedAmountCents: 0 },
      floorAlert: null,
    });
    expect(mocks.decideLinked).not.toHaveBeenCalled();
  });
});
