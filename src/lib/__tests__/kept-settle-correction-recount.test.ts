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
}));

vi.mock("@/lib/prisma", () => ({ prisma: { xeroObjectLink: { findFirst: mocks.linkFindFirst, findMany: mocks.linkFindMany } } }));
vi.mock("@/lib/logger", () => ({ default: { error: mocks.loggerError, warn: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/xero-inbound/credit-note-repairs", () => ({ repairRefundedPaymentBusinessState: mocks.repair }));
vi.mock("@/lib/xero-inbound/account-credit-modification-notes", () => ({
  readModificationNoteCash: mocks.readModificationNoteCash,
}));

import { recountCorrectionsAfterKeptSettle } from "@/lib/xero-inbound/kept-settle-correction-recount";
import { decideInternetBankingReceiptFigure } from "@/lib/xero-inbound/settle-from-cash";

const INVOICE_ID = "inv-4095";
const PAYMENT_ID = "pay-1";

beforeEach(() => {
  vi.clearAllMocks();
  // The repair's own result shape (`RefundedPaymentBusinessStateRepairResult`).
  mocks.repair.mockResolvedValue({ matchedPayments: 1, updatedPayments: 1 });
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
      payment: { id: "pay-1", amountCents: 30_000, refundedAmountCents: 0 },
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

describe("a keep counts an applied correction already synced in its own transaction (#4095 review, item 1)", () => {
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
  const noteLink = (status: string | null) => ({ xeroObjectId: "cn-correction", metadata: status === null ? {} : { status } });
  const NOTE_ALLOCATION_ROLE = "MODIFICATION_CREDIT_NOTE_ALLOCATION";
  const ROLELESS_ALLOCATION_ROLE = "CREDIT_NOTE_ALLOCATION";
  const allocationLink = { role: NOTE_ALLOCATION_ROLE, metadata: { creditNoteId: "cn-correction", invoiceId: INVOICE_ID, amountCents: 10_000 } };
  // `null`: no amount recorded.
  const rolelessLink = (amountCents: number | null = 10_000) => ({
    role: ROLELESS_ALLOCATION_ROLE,
    metadata: { creditNoteId: "cn-correction", invoiceId: INVOICE_ID, ...(amountCents === null ? {} : { amountCents }) },
  });

  function decide(input: {
    rows?: Row[];
    refundedAmountCents?: number;
    noteLinks?: unknown[];
    allocationLinks?: unknown[];
    cash?: { knownCents: number; complete: boolean };
    matchedPayments?: number;
  }) {
    mocks.readModificationNoteCash.mockResolvedValue(new Map([["cn-correction", "correction"]]));
    // Only the allocation links whose role the query asked for, as Postgres returns them.
    const linkFindMany = vi.fn(async ({ where }: { where: { role: string | { in: string[] } } }) =>
      where.role === "MODIFICATION_CREDIT_NOTE"
        ? (input.noteLinks ?? [noteLink("AUTHORISED")])
        : ((input.allocationLinks ?? [allocationLink]) as Array<{ role: string }>).filter((link) =>
            typeof where.role === "string" ? link.role === where.role : where.role.in.includes(link.role),
          ),
    );
    const tx = {
      paymentTransaction: { findMany: vi.fn().mockResolvedValue(input.rows ?? [pendingReceipt()]) },
      memberCredit: { findMany: vi.fn().mockResolvedValue([]) },
      xeroObjectLink: { findMany: linkFindMany },
    };
    const decided = decideInternetBankingReceiptFigure(tx as never, {
      invoiceId: INVOICE_ID,
      payment: { id: PAYMENT_ID, amountCents: 30_000, refundedAmountCents: input.refundedAmountCents ?? 0 },
      // Xero's amount paid unquantifiable: the settle keeps the stored $300.
      cash: input.cash ?? { knownCents: 20_000, complete: false },
      matchedPayments: input.matchedPayments ?? 1,
      secondInstrument: false,
      invoice: { totalCents: 30_000, appliedCreditNotes: [{ id: "cn-correction", appliedCents: 10_000 }] },
    });
    return { decided, linkFindMany };
  }

  it("MUTATION: the $100 correction synced before the transfer is counted with the receipt, so the net is the $200 of cash at the commit", async () => {
    const { decided, linkFindMany } = decide({});
    await expect(decided).resolves.toMatchObject({
      plan: { kind: "keep" },
      receiptCents: 30_000,
      paymentColumns: { amountCents: 30_000, refundedAmountCents: 10_000, status: "PARTIALLY_REFUNDED" },
    });
    // Read in the settle's transaction: the note's live link and its allocation to this invoice.
    expect(linkFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ role: "MODIFICATION_CREDIT_NOTE", active: true, xeroObjectId: { in: ["cn-correction"] } }) }),
    );
    expect(linkFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          role: { in: [NOTE_ALLOCATION_ROLE, ROLELESS_ALLOCATION_ROLE] },
          active: true,
          metadata: { path: ["invoiceId"], equals: INVOICE_ID },
        }),
      }),
    );
  });

  it("a note link with no status recorded counts, as the recount counts it", async () => {
    await expect(decide({ noteLinks: [noteLink(null)] }).decided).resolves.toMatchObject({
      paymentColumns: { refundedAmountCents: 10_000 },
    });
  });

  it("MUTATION: never a voided correction", async () => {
    await expect(decide({ noteLinks: [noteLink("VOIDED")] }).decided).resolves.toMatchObject({ paymentColumns: null });
  });

  it("MUTATION: never one whose allocation to this invoice is not linked yet - its sync, and the recount after the commit, count it", async () => {
    await expect(decide({ allocationLinks: [] }).decided).resolves.toMatchObject({ paymentColumns: null });
  });

  // #4786: an older repair could link the note's allocation role-less
  // (`CREDIT_NOTE_ALLOCATION`); it shows the allocation linked as the note's
  // own role does (`distinctClearingAllocations`), and the correction counts
  // once, at what Xero applied.
  it("MUTATION (#4786): an allocation linked only role-less counts", async () => {
    await expect(decide({ allocationLinks: [rolelessLink()] }).decided).resolves.toMatchObject({
      paymentColumns: { refundedAmountCents: 10_000 },
    });
  });

  it("#4786: the inbound mirror's own-role link and the role-less one for the same allocation count the correction once", async () => {
    await expect(decide({ allocationLinks: [allocationLink, rolelessLink()] }).decided).resolves.toMatchObject({
      paymentColumns: { refundedAmountCents: 10_000 },
    });
  });

  it("#4786: a role-less link for another amount beside the own-role one still counts the correction once, at what Xero applied", async () => {
    await expect(decide({ allocationLinks: [allocationLink, rolelessLink(4_000)] }).decided).resolves.toMatchObject({
      paymentColumns: { refundedAmountCents: 10_000 },
    });
  });

  it("MUTATION (#4786): a role-less link with no amount recorded shows nothing linked (fail closed)", async () => {
    await expect(decide({ allocationLinks: [rolelessLink(null)] }).decided).resolves.toMatchObject({ paymentColumns: null });
  });

  it("#4786: an allocation link with any other role shows nothing linked", async () => {
    await expect(
      decide({ allocationLinks: [{ ...allocationLink, role: "APPLIED_CREDIT_ALLOCATION" }] }).decided,
    ).resolves.toMatchObject({ paymentColumns: null });
  });

  it("MUTATION: never over a refunded total its rows do not explain, which may already hold the correction", async () => {
    const { decided, linkFindMany } = decide({ refundedAmountCents: 10_000 });
    await expect(decided).resolves.toMatchObject({ plan: { kind: "keep" }, paymentColumns: null });
    expect(linkFindMany).not.toHaveBeenCalled();
  });

  it("MUTATION: never against a receipt that would not hold the stored figure", async () => {
    const { decided, linkFindMany } = decide({ rows: [pendingReceipt({ reason: "xero_part_payment_recognised_at_cancel" })] });
    await expect(decided).resolves.toMatchObject({ plan: { kind: "keep" }, paymentColumns: null });
    expect(linkFindMany).not.toHaveBeenCalled();
  });

  it("MUTATION: never on an invoice matched to several payments, whose share of the correction is unknown; nor is it recounted after", async () => {
    const { decided, linkFindMany } = decide({ matchedPayments: 2 });
    await expect(decided).resolves.toMatchObject({ plan: { kind: "keep" }, paymentColumns: null, appliedCorrectionNotes: [] });
    expect(linkFindMany).not.toHaveBeenCalled();
  });

  it("never on a replay, whose receipt is already captured", async () => {
    const { decided, linkFindMany } = decide({ rows: [pendingReceipt({ status: "SUCCEEDED" })] });
    await expect(decided).resolves.toMatchObject({ plan: { kind: "replay" }, paymentColumns: null });
    expect(linkFindMany).not.toHaveBeenCalled();
  });

  it("never on a rewrite, whose cash-sized receipt counts no correction", async () => {
    const { decided } = decide({ cash: { knownCents: 20_000, complete: true } });
    await expect(decided).resolves.toMatchObject({ plan: { kind: "rewrite" }, paymentColumns: { amountCents: 20_000, refundedAmountCents: 0 } });
  });
});
