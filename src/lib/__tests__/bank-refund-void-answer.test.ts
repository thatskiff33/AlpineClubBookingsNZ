/**
 * #4162 (`INV-ADDPAY-042`): the "Yes, I already recorded it in Xero myself"
 * check, against a mocked Xero, and the follow-up's copy leaf. The provider
 * read happens before any transaction (the route calls it); refusals are plain
 * English and say why.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyLinkMetadataMerge, isLinkMetadataMergeStatement, readLinkMetadataMerge } from "./support/xero-link-metadata-merge-double";

const getCreditNotes = vi.fn();
const getInvoice = vi.fn();
const findUnique = vi.fn();
const callXeroApi = vi.fn<(call: () => unknown, options?: unknown) => unknown>((call) => call());

vi.mock("@/lib/xero-api-client", async (importOriginal) => ({
  XeroDailyLimitError: ((await importOriginal()) as typeof import("@/lib/xero-api-client")).XeroDailyLimitError,
  getAuthenticatedXeroClient: vi.fn(async () => ({ xero: { accountingApi: { getCreditNotes, getInvoice } }, tenantId: "tenant" })),
  callXeroApi: (call: () => unknown, options?: unknown) => callXeroApi(call, options),
}));
vi.mock("@/lib/prisma", () => ({ prisma: { manualRefundTask: { findUnique } } }));
vi.mock("@/lib/logger", () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
const reconcileXeroCreditNote = vi.fn();
const notifyXeroSyncError = vi.fn();
vi.mock("@/lib/xero-inbound/credit-note", () => ({ reconcileXeroCreditNote: (id: string) => reconcileXeroCreditNote(id) }));
vi.mock("@/lib/xero-error-alert", () => ({ notifyXeroSyncError: (input: unknown) => notifyXeroSyncError(input) }));

const { prepareBankRefundVoidAnswer, reconcileHandMadeNoteAfterRecording, recordHandMadeRefundNoteLink, verifyHandMadeRefundNote } = await import(
  "@/lib/bank-refund-void-answer"
);
const { CLUB_FORMAT_TEST } = await import("@/lib/__tests__/support/club-format-fixture");
const copy = await import("@/lib/bank-refund-void-follow-up-copy");

const live = {
  creditNoteID: "cn-hand", creditNoteNumber: "CN-0123", status: "AUTHORISED", type: "ACCRECCREDIT", total: 200,
  updatedDateUTC: new Date("2026-06-30T21:15:04.123Z"),
  contact: { contactID: "contact-sam" }, allocations: [{ invoice: { invoiceID: "inv-1" } }],
};
const verify = (number = "CN-0123", over: Partial<{ xeroInvoiceId: string | null; ownerXeroContactId: string | null }> = {}) =>
  verifyHandMadeRefundNote({ creditNoteNumber: number, expectedAmountCents: 20_000, xeroInvoiceId: "inv-1", ownerXeroContactId: null, format: CLUB_FORMAT_TEST, ...over });

describe("verifyHandMadeRefundNote (#4162)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getInvoice.mockResolvedValue({ body: { invoices: [{ contact: { contactID: "contact-sam" } }] } });
  });

  it("finds the note by its number and accepts an approved sales note for the amount, the invoice's contact and that invoice", async () => {
    getCreditNotes.mockResolvedValue({ body: { creditNotes: [live] } });
    await expect(verify(" CN-0123 ")).resolves.toEqual({
      creditNoteId: "cn-hand", creditNoteNumber: "CN-0123", amountCents: 20_000, status: "AUTHORISED", total: 200,
      // #4288: the reading's own Xero timestamp, carried to the link write that orders it.
      updatedDateUTC: "2026-06-30T21:15:04.123Z",
    });
    expect(getCreditNotes).toHaveBeenCalledWith("tenant", undefined, 'CreditNoteNumber=="CN-0123"');
    expect(getInvoice).toHaveBeenCalledWith("tenant", "inv-1");
    // Security 4: a person waits on these reads - one retry, a 5-second wait.
    expect(callXeroApi).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ maxRetries: 1, maxWaitSec: 5 }));
    getCreditNotes.mockResolvedValue({ body: { creditNotes: [{ ...live, status: "PAID" }] } });
    await expect(verify()).resolves.toMatchObject({ status: "PAID" });
  });

  it("checks the owner's contact when the payment has no invoice", async () => {
    getCreditNotes.mockResolvedValue({ body: { creditNotes: [{ ...live, allocations: [] }] } });
    await expect(verify("CN-0123", { xeroInvoiceId: null, ownerXeroContactId: "contact-sam" })).resolves.toMatchObject({ creditNoteId: "cn-hand" });
    expect(getInvoice).not.toHaveBeenCalled();
    await expect(verify("CN-0123", { xeroInvoiceId: null, ownerXeroContactId: "contact-other" })).rejects.toMatchObject({ status: 409 });
  });

  it("MUTATION (security low 2): with no contact to compare, says so instead of naming a different contact", async () => {
    getCreditNotes.mockResolvedValue({ body: { creditNotes: [{ ...live, allocations: [] }] } });
    await expect(verify("CN-0123", { xeroInvoiceId: null, ownerXeroContactId: null })).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("no Xero invoice and the booking's owner has no Xero contact, so there is no Xero contact to check it against"),
    });
    getInvoice.mockResolvedValue({ body: { invoices: [{}] } });
    await expect(verify("CN-0123")).rejects.toMatchObject({ status: 409, message: expect.stringContaining("invoice has no contact to check it against") });
  });

  it.each([
    [[], "Xero has no credit note numbered CN-0123"],
    [[{ ...live, total: 150 }], "is for $150.00 in Xero, not $200.00"],
    [[{ ...live, status: "VOIDED" }], "is voided in Xero"],
    [[{ ...live, status: "DELETED" }], "is deleted in Xero"],
    // MUTATION (money 3): approved or paid only.
    [[{ ...live, status: "DRAFT" }], "is draft in Xero, not approved or paid"],
    [[{ ...live, status: "SUBMITTED" }], "not approved or paid"],
    [[{ ...live, type: "ACCPAYCREDIT" }], "is not a sales credit note"],
    // MUTATION (money 3): the payment's contact, and no other invoice.
    [[{ ...live, contact: { contactID: "contact-other" } }], "is for a different contact"],
    [[{ ...live, allocations: [{ invoice: { invoiceID: "inv-other" } }] }], "is allocated to another invoice"],
    [[live, { ...live, creditNoteID: "cn-other" }], "more than one credit note numbered"],
  ])("refuses %j with a reason", async (notes, reason) => {
    getCreditNotes.mockResolvedValue({ body: { creditNotes: notes } });
    await expect(verify()).rejects.toMatchObject({ status: 409, message: expect.stringContaining(reason) });
  });

  it("refuses a number Xero's filter cannot take, before calling Xero", async () => {
    await expect(verify('CN-1" OR 1==1')).rejects.toMatchObject({ status: 400 });
    expect(getCreditNotes).not.toHaveBeenCalled();
  });

  it("says Xero could not be reached, is busy on a rate limit, or has spent its daily limit, rather than guessing", async () => {
    getCreditNotes.mockRejectedValue(new Error("network"));
    await expect(verify()).rejects.toMatchObject({ status: 409, message: expect.stringContaining("could not reach Xero") });
    getCreditNotes.mockRejectedValue(Object.assign(new Error("Too Many Requests"), { response: { statusCode: 429 } }));
    await expect(verify()).rejects.toMatchObject({ status: 409, message: "Xero is busy, try again in a minute." });
    // MUTATION (security low 1): the daily limit is its own message - a minute will not help.
    const { XeroDailyLimitError } = await import("@/lib/xero-api-client");
    getCreditNotes.mockRejectedValue(new XeroDailyLimitError(3_600, true));
    await expect(verify()).rejects.toMatchObject({ status: 409, message: "Xero's daily limit has been reached; try again tomorrow." });
  });

  it("prepares the answer only for a follow-up, at its own amount; a fresh note needs an invoice and no Xero call", async () => {
    getCreditNotes.mockResolvedValue({ body: { creditNotes: [live] } });
    const followUp = (xeroInvoiceId: string | null) => ({
      kind: "CANCELLED_BOOKING_HAND_BACK",
      occurrenceKey: "bank-refund-void:pay-1:cn-1",
      amountCents: 20_000,
      payment: { xeroInvoiceId },
      booking: { member: { xeroContactId: "contact-sam" }, organisation: null },
      reviewContext: copy.bankRefundVoidFollowUpReviewContext({
        voidedCreditNoteId: "cn-1", voidedCreditNoteNumber: "CN-1", voidedAt: "2026-06-30T00:00:00.000Z", originalTaskId: "t", reversedLineId: "l",
      }),
    });
    findUnique.mockResolvedValue(followUp("inv-1"));
    await expect(
      prepareBankRefundVoidAnswer({ taskId: "f", answer: { answer: "recorded-in-xero", creditNoteNumber: "CN-0123" }, format: CLUB_FORMAT_TEST }),
    ).resolves.toMatchObject({ answer: "recorded-in-xero", note: { creditNoteId: "cn-hand" } });
    getCreditNotes.mockClear();
    await expect(prepareBankRefundVoidAnswer({ taskId: "f", answer: { answer: "fresh-note" }, format: CLUB_FORMAT_TEST })).resolves.toEqual({ answer: "fresh-note" });
    expect(getCreditNotes).not.toHaveBeenCalled();
    // MUTATION (money 5): no invoice, no fresh note - the treasurer is told what to do.
    findUnique.mockResolvedValue(followUp(null));
    await expect(prepareBankRefundVoidAnswer({ taskId: "f", answer: { answer: "fresh-note" }, format: CLUB_FORMAT_TEST })).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("no Xero invoice"),
    });

    findUnique.mockResolvedValue({ ...followUp("inv-1"), occurrenceKey: "edit-refund-hand-back:m", reviewContext: null });
    await expect(
      prepareBankRefundVoidAnswer({ taskId: "f", answer: { answer: "recorded-in-xero", creditNoteNumber: "CN-0123" }, format: CLUB_FORMAT_TEST }),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("recordHandMadeRefundNoteLink under the link's own row lock (#4288)", () => {
  const note = { creditNoteId: "cn-hand", creditNoteNumber: "CN-0123", amountCents: 20_000, status: "AUTHORISED", total: 200, updatedDateUTC: "2026-06-30T21:15:04.123Z" };
  /**
   * A transaction client for the real link funnel. `tracked` is what the
   * unlocked check reads; `stored` is the row as the funnel reads it under its
   * lock - a void that committed in between shows only there.
   */
  function fakeTx(stored: { metadata: unknown; active: boolean } | null, resolvedRow: { id: string } | null = null) {
    // The link row as the funnel leaves it: the upsert's columns, then (#4445)
    // its one-statement metadata merge, applied by the shared double.
    let row: { id: string; active: boolean; metadata: unknown } | null = null;
    const upsert = vi.fn(async (args: { create: { active: boolean; metadata?: unknown }; update: { active: boolean; metadata?: unknown } }) => {
      row = stored
        ? { id: "link-1", active: args.update.active, metadata: "metadata" in args.update ? args.update.metadata : stored.metadata }
        : { id: "link-1", active: args.create.active, metadata: args.create.metadata ?? null };
      return { ...row };
    });
    const findResolvedRow = vi.fn(async () => resolvedRow);
    const tx = {
      $executeRaw: vi.fn(async (template: TemplateStringsArray, ...values: unknown[]) => {
        if (row && isLinkMetadataMergeStatement(template)) row.metadata = applyLinkMetadataMerge(row.metadata, readLinkMetadataMerge(values));
        return 1;
      }),
      xeroSyncOperation: { findFirst: findResolvedRow },
      payment: { findUnique: vi.fn(async () => ({ source: "INTERNET_BANKING", xeroRefundCreditNoteId: null })), updateMany: vi.fn() },
      xeroObjectLink: {
        findMany: vi.fn(async () => []),
        createMany: vi.fn(async () => ({ count: 0 })),
        findUnique: vi.fn(async () => stored),
        findUniqueOrThrow: vi.fn(async () => ({ ...row! })),
        updateMany: vi.fn(),
        upsert,
      },
    };
    return { tx: tx as never, upsert, findResolvedRow, written: () => row };
  }
  const record = (tx: never) => recordHandMadeRefundNoteLink(tx, { paymentId: "pay-1", taskId: "task-1", amountCents: 20_000, note });

  it("MUTATION (#4321): a note a credit-note create row records, resolved by hand or not yet SUCCEEDED, is refused, and nothing is written", async () => {
    const { tx, upsert, findResolvedRow } = fakeTx(null, { id: "op-resolved" });
    await expect(record(tx)).rejects.toMatchObject({ status: 409, message: expect.stringContaining("CN-0123 is already recorded against another refund") });
    expect(upsert).not.toHaveBeenCalled();
    // Any payment's credit-note create naming the note by its id - never its
    // number (an old organisation's, or a reused one) - that a resolve could
    // still flip, or already has.
    expect(findResolvedRow).toHaveBeenCalledWith({
      where: {
        xeroObjectType: "CREDIT_NOTE",
        xeroObjectId: "cn-hand",
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
        OR: [{ manuallyResolvedAt: { not: null } }, { status: { not: "SUCCEEDED" } }],
      },
      select: { id: true },
    });
  });

  it("records the checked note live, stamped with its Xero timestamp", async () => {
    const { tx, upsert, written } = fakeTx(null);
    await record(tx);
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ update: expect.objectContaining({ active: true }) }));
    expect(written()).toEqual(expect.objectContaining({
      active: true,
      metadata: expect.objectContaining({ status: "AUTHORISED", providerUpdatedAt: "2026-06-30T21:15:04.123Z", perDelta: true, handBackTaskId: "task-1" }),
    }));
  });

  it("MUTATION (re-check): a void that committed after the check is refused under the lock, so the completion rolls back", async () => {
    // Stamped earlier or not at all: a recorded void always wins over a live reading.
    for (const providerUpdatedAt of ["2026-06-30T22:00:00.000Z", undefined]) {
      const { tx } = fakeTx({ metadata: { status: "VOIDED", total: 200, ...(providerUpdatedAt ? { providerUpdatedAt } : {}) }, active: false });
      await expect(record(tx)).rejects.toMatchObject({ status: 409, message: expect.stringContaining("CN-0123 was voided in Xero while this answer was being recorded") });
    }
  });

  it("a newer reading recorded meanwhile that leaves the link inactive is refused too", async () => {
    const { tx } = fakeTx({ metadata: { status: "PAID", total: 200, providerUpdatedAt: "2026-06-30T22:00:00.000Z" }, active: false });
    await expect(record(tx)).rejects.toMatchObject({ status: 409, message: expect.stringContaining("changed in Xero") });
  });

  it("MUTATION (review 4): a newer reading kept on an ACTIVE row is refused too - the answer's keys were never written", async () => {
    // The stored row is live and active (an inbound reading newer than the
    // treasurer's check): the funnel keeps it whole, so `handBackTaskId` and
    // the other keys of this answer would be silently lost.
    const { tx, written } = fakeTx({ metadata: { status: "PAID", total: 200, providerUpdatedAt: "2026-06-30T22:00:00.000Z" }, active: true });
    await expect(record(tx)).rejects.toMatchObject({ status: 409, message: expect.stringContaining("changed in Xero") });
    expect(written()!.metadata).not.toHaveProperty("handBackTaskId");
  });
});

describe("the follow-up's copy (#4162)", () => {
  it("round-trips the context it stores, and refuses a partial one", () => {
    const context = {
      voidedCreditNoteId: "cn-1", voidedCreditNoteNumber: null, voidedAt: "2026-06-30T00:00:00.000Z", originalTaskId: "t", reversedLineId: "l",
    };
    expect(copy.readBankRefundVoidFollowUpContext(copy.bankRefundVoidFollowUpReviewContext(context))).toEqual(context);
    expect(copy.readBankRefundVoidFollowUpContext({ bankRefundVoidFollowUp: { voidedCreditNoteId: "cn-1" } })).toBeNull();
    expect(copy.readBankRefundVoidFollowUpContext(null)).toBeNull();
  });

  it("asks the owner's one question", () => {
    expect(
      copy.bankRefundVoidQuestion({ bookingReference: "B-123", amount: "$200.00", memberName: "Sam Lee", creditNoteNumber: "CN-0456", voidedOn: "14 Oct 2026" }),
    ).toBe("Booking B-123: $200.00 to Sam Lee. Its Xero credit note CN-0456 was found voided on 14 Oct 2026, so it's back on this list. Has the $200.00 gone to the member?");
  });
});

describe("the refund list's payload marks a bank refund to re-confirm (#4162)", () => {
  it("carries the voided note's number and date, and never reads its context as unreadable review evidence", async () => {
    const { toOpenManualRefundTaskPayload } = await import("@/lib/manual-refund-task-queue-payload");
    const row = {
      id: "follow-up-1", bookingId: "booking-1", amountCents: 20_000, raisedAmountCents: 20_000, kind: "CANCELLED_BOOKING_HAND_BACK" as const,
      paymentId: "pay-1", payment: null, lateCaptureApprovalIntentId: null, partPaymentReviewPaymentId: null,
      partPaymentReviewXeroPaidAt: null, partPaymentReviewXeroPaidCents: null,
      occurrenceKey: "bank-refund-void:pay-1:cn-1",
      reviewContext: copy.bankRefundVoidFollowUpReviewContext({
        voidedCreditNoteId: "cn-1", voidedCreditNoteNumber: "CN-0456", voidedAt: "2026-06-30T00:00:00.000Z", originalTaskId: "t", reversedLineId: "l",
      }),
      reason: "r", createdAt: new Date("2026-07-01T00:00:00.000Z"),
      booking: {
        checkIn: new Date("2026-08-01T00:00:00.000Z"), checkOut: new Date("2026-08-03T00:00:00.000Z"), member: { firstName: "Sam", lastName: "Lee" },
        organisation: null, memberId: "sam", deletedAt: null, status: "CANCELLED" as const, payment: null,
      },
    };
    expect(toOpenManualRefundTaskPayload(row as never, null, [])).toMatchObject({
      bankRefundVoidFollowUp: { voidedCreditNoteNumber: "CN-0456", voidedAt: "2026-06-30T00:00:00.000Z" },
      reviewEvidence: null,
      reviewEvidenceUnreadable: false,
      editRefundHandBack: false,
    });
    expect(toOpenManualRefundTaskPayload({ ...row, occurrenceKey: "edit-refund-hand-back:m", reviewContext: null } as never, null, []).bankRefundVoidFollowUp).toBeNull();
  });
});

describe("reconcileHandMadeNoteAfterRecording (#4162, #4421)", () => {
  const note = { creditNoteId: "cn-hand", creditNoteNumber: "CN-0123" };
  const context = { alertKey: "bank-refund-void-hand-made-note", recordedFor: "a re-confirmed bank refund" };

  beforeEach(() => {
    vi.clearAllMocks();
    notifyXeroSyncError.mockResolvedValue(undefined);
  });

  it("raises nothing when the re-read and its recount both finish", async () => {
    reconcileXeroCreditNote.mockResolvedValue({ handled: true, kind: "CREDIT_NOTE" });
    await reconcileHandMadeNoteAfterRecording(note, context);
    expect(reconcileXeroCreditNote).toHaveBeenCalledWith("cn-hand");
    expect(notifyXeroSyncError).not.toHaveBeenCalled();
  });

  it("MUTATION: alerts a person when the re-read's refunded-total recount was left unwritten, which nothing retries (#4095 review, item 4)", async () => {
    reconcileXeroCreditNote.mockResolvedValue({ handled: true, kind: "CREDIT_NOTE", recountLeftUnsettled: "lost its claim twice" });
    await reconcileHandMadeNoteAfterRecording(note, context);
    expect(notifyXeroSyncError).toHaveBeenCalledWith(
      expect.objectContaining({
        errorType: "refund-ledger-divergence",
        operation: "bank-refund-void-hand-made-note:recount:cn-hand",
        errorMessage: expect.stringContaining("CN-0123"),
      }),
    );
  });

  it("alerts a person when the re-read fails, never the caller", async () => {
    reconcileXeroCreditNote.mockRejectedValue(new Error("Xero down"));
    await expect(reconcileHandMadeNoteAfterRecording(note, context)).resolves.toBeUndefined();
    expect(notifyXeroSyncError).toHaveBeenCalledWith(expect.objectContaining({ operation: "bank-refund-void-hand-made-note:cn-hand" }));
  });
});
