/**
 * #4426 (`INV-INT-029`, `INV-INT-028`): the payment refund-note create's record
 * of the note Xero returned (`recordCreatedRefundNote`) is claimed on the row
 * first, and refused only on a row whose resolve by hand RECORDED a note.
 *
 * A create stalls in Xero; Mark failed fails its row; an officer resolves it by
 * hand, recording the note they made (#4421). When the stalled run's note comes
 * back it must not replace the officer's note on the row, nor be linked, nor
 * take the payment's pointer: it is logged, audited once and surfaced to the
 * officers through #4374's alert - unless it is the very note the officer
 * recorded (Xero committed it and only its answer was lost), when nothing is
 * wrong. A plain resolve records no note, so the late note lands there as it
 * did before #4426 (the completion then raises #4374's alert); and a row
 * marked failed with no resolve is a row no claim holds, where a success
 * lands (`INV-INT-029`).
 *
 * #4656: the record takes the Payment row first, always, then claims the row,
 * then asks under those locks that no other create row records the note
 * (`assertFreshRefundNoteFromCreate`), on the Payment row's budget; a record
 * that cannot get its locks in time writes nothing, fails nothing and is traced
 * as a late note is, with no advice to retry; one that committed although its
 * answer was an error carries on as recorded. Real-PostgreSQL proofs: `xero-refund-note-record-gaps.realdb.test.ts`.
 *
 * Driven on an in-memory row the claim's `where` is evaluated against
 * (`matchesWhere`), inside a fake transaction that rolls back what it wrote
 * when its callback throws, as PostgreSQL does. The once-ever claim is a fake
 * holding keys in a set, so a repeat is refused as `sendAdminAlertOnceEver`
 * would refuse it. The real-PostgreSQL proofs are in
 * `xero-late-refund-note-after-resolve.realdb.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { XeroSyncOperation } from "@prisma/client";
import { matchesWhere } from "./support/prisma-where";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
  /** What a re-read after the lost claim answers, when it differs from the row (a withdrawn resolve). */
  reread: undefined as Record<string, unknown> | null | undefined,
  payment: { id: "pay-1", xeroRefundCreditNoteId: null as string | null },
  links: [] as Array<Record<string, unknown>>,
  held: new Set<string>(),
}));
const mocks = vi.hoisted(() => ({
  claim: vi.fn(), send: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn(), audit: vi.fn(),
  pointer: vi.fn(), rowClaim: vi.fn(), link: vi.fn(), paymentLock: vi.fn(), fresh: vi.fn(), transactionOptions: [] as unknown[],
}));
const BUDGET = vi.hoisted(() => ({ maxWait: 10_000, timeout: 30_000 }));

vi.mock("@/lib/prisma", () => {
  const client = {
    payment: {
      update: vi.fn(async ({ data }: { data: Row }) => {
        mocks.pointer();
        return Object.assign(state.payment, data);
      }),
    },
    xeroSyncOperation: {
      updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
        mocks.rowClaim();
        if (!state.row || !matchesWhere(state.row, where)) return { count: 0 };
        Object.assign(state.row, data);
        return { count: 1 };
      }),
      findUnique: vi.fn(async () => {
        const row = state.reread === undefined ? state.row : state.reread;
        return row ? { ...row } : null;
      }),
    },
  };
  return {
    prisma: {
      ...client,
      // PostgreSQL's rollback: a callback that throws leaves nothing it wrote.
      $transaction: vi.fn(async (run: (tx: typeof client) => unknown, options?: unknown) => {
        mocks.transactionOptions.push(options);
        const before = { row: state.row && { ...state.row }, payment: { ...state.payment }, links: [...state.links] };
        try {
          return await run(client);
        } catch (error) {
          state.row = before.row;
          Object.assign(state.payment, before.payment);
          state.links = before.links;
          throw error;
        }
      }),
    },
  };
});
vi.mock("@/lib/xero-sync", () => ({
  upsertXeroObjectLink: vi.fn(async (link: Row) => {
    mocks.link();
    state.links.push(link);
    return link;
  }),
}));
vi.mock("@/lib/audit", () => ({ createAuditLog: mocks.audit }));
vi.mock("@/lib/payment-transactions", () => ({ lockPaymentForRefundedTotal: mocks.paymentLock, PAYMENT_ROW_WAIT_TRANSACTION_OPTIONS: BUDGET }));
vi.mock("@/lib/xero-refund-note-status", () => ({ assertFreshRefundNoteFromCreate: mocks.fresh }));
vi.mock("@/lib/club-format-server", () => ({ clubFormatValues: async () => CLUB_FORMAT_TEST }));
vi.mock("@/lib/alert-cooldown", () => ({
  ALERT_ONCE_EVER_WINDOW_MS: 1_000_000,
  ALERT_NOBODY_ELIGIBLE_RETRY_MS: 1000,
  claimAlertCooldown: mocks.claim,
  deferAlertCooldown: vi.fn(async () => undefined),
  releaseAlertCooldown: vi.fn(async () => undefined),
}));
vi.mock("@/lib/email", () => ({ sendAdminXeroSyncErrorAlert: mocks.send }));
vi.mock("@/lib/logger", () => ({ default: { warn: mocks.warn, error: mocks.error, info: mocks.info } }));

import { isRecordWaitLost, LATE_REFUND_NOTE_NOT_RECORDED_ACTION, recordCreatedRefundNote } from "@/lib/xero-refund-note-record";
import { xeroSuccessAfterResolutionAlertKey } from "@/lib/xero-success-after-resolution-alert";

const OPERATION_ID = "op-stalled";
const RESOLVED_AT = new Date("2026-07-01T00:20:00.000Z");
const LATE = {
  paymentId: "pay-1",
  bookingId: "booking-1",
  operationId: OPERATION_ID,
  creditNoteId: "cn-late-b",
  creditNoteNumber: "CN-B",
  amountCents: 20_000,
  writesPointer: true,
  linkRole: "REFUND_CREDIT_NOTE",
  linkMetadata: { amountCents: 20_000, watermarkCents: 20_000 },
  claimStartedAt: new Date("2026-07-01T00:00:00.000Z"),
};

function seedRow(overrides: Row = {}) {
  state.row = {
    id: OPERATION_ID, status: "RUNNING", startedAt: new Date("2026-07-01T00:00:00.000Z"),
    operationType: "CREATE", entityType: "CREDIT_NOTE", localModel: "Payment", localId: "pay-1",
    xeroObjectType: null, xeroObjectId: null, xeroObjectNumber: null,
    manuallyResolvedAt: null, manuallyResolvedById: null, manuallyResolvedReason: null,
    ...overrides,
  } as Partial<XeroSyncOperation>;
}

/** What Mark failed and then "Resolve by hand" recording note `id` leave (#4421). */
function markedFailedAndResolvedWithNote(id = "cn-hand-a", number = "CN-A") {
  seedRow({
    status: "FAILED", lastErrorCode: "XERO_ORPHANED_STALE_RUNNING",
    manuallyResolvedAt: RESOLVED_AT, manuallyResolvedById: "officer-1", manuallyResolvedReason: "Made the note by hand",
    xeroObjectType: "CREDIT_NOTE", xeroObjectId: id, xeroObjectNumber: number,
  });
  state.links = [{ localId: "pay-1", xeroObjectId: id, role: "REFUND_CREDIT_NOTE", recordedByHand: true }];
}

beforeEach(() => {
  vi.clearAllMocks();
  state.reread = undefined;
  state.payment.xeroRefundCreditNoteId = null;
  state.links = [];
  state.held.clear();
  mocks.claim.mockImplementation(async ({ key }: { key: string }) => {
    if (state.held.has(key)) return false;
    state.held.add(key);
    return true;
  });
  mocks.send.mockResolvedValue({ deliveryAllowed: true, recipients: 1, sent: 1, queuedForRetry: 0, notDelivered: 0 });
  mocks.audit.mockResolvedValue(undefined);
  mocks.paymentLock.mockResolvedValue(undefined);
  mocks.fresh.mockResolvedValue(undefined);
  mocks.transactionOptions.length = 0;
});

describe("#4426: a refund-note create never records its note over a note a resolve by hand recorded", () => {
  it("MUTATION: the claim won locks the Payment row, claims the row with its note, checks the note fresh, then the pointer and the link - in that order - and alerts nothing", async () => {
    seedRow();
    await expect(recordCreatedRefundNote({ ...LATE, xeroStatus: "AUTHORISED" })).resolves.toBe("recorded");
    expect(state.payment.xeroRefundCreditNoteId).toBe("cn-late-b");
    expect(state.row).toMatchObject({ status: "RUNNING", xeroObjectType: "CREDIT_NOTE", xeroObjectId: "cn-late-b", xeroObjectNumber: "CN-B" });
    expect(state.links).toEqual([
      expect.objectContaining({ localModel: "Payment", localId: "pay-1", xeroObjectId: "cn-late-b", xeroObjectNumber: "CN-B", role: "REFUND_CREDIT_NOTE", metadata: LATE.linkMetadata }),
    ]);
    // The resolve's claim takes the same rows Payment, row, link: the create keeps that order (#4656: the
    // Payment row by its lock, first), and asks freshness under them, on the transaction's own client.
    const order = [mocks.paymentLock, mocks.rowClaim, mocks.fresh, mocks.pointer, mocks.link].map((fn) => fn.mock.invocationCallOrder[0]);
    expect(order.every((at) => at !== undefined)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a! - b!));
    expect(mocks.paymentLock).toHaveBeenCalledWith(expect.objectContaining({ xeroSyncOperation: expect.anything() }), "pay-1");
    expect(mocks.fresh).toHaveBeenCalledWith("pay-1", OPERATION_ID, { creditNoteID: "cn-late-b", status: "AUTHORISED" }, expect.objectContaining({ xeroSyncOperation: expect.anything() }));
    // #4656: the Payment row's budget, not Prisma's 5s default.
    expect(mocks.transactionOptions).toEqual([BUDGET]);
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it("the claim won by a note that takes no pointer (a refund request's or a per-refund note) leaves the pointer alone", async () => {
    seedRow();
    await expect(recordCreatedRefundNote({ ...LATE, writesPointer: false })).resolves.toBe("recorded");
    expect(mocks.pointer).not.toHaveBeenCalled();
    // MUTATION (#4656): it still takes the Payment row first, so two records of one payment queue there.
    expect(mocks.paymentLock).toHaveBeenCalledTimes(1);
    expect(mocks.paymentLock.mock.invocationCallOrder[0]).toBeLessThan(mocks.rowClaim.mock.invocationCallOrder[0]!);
    expect(state.payment.xeroRefundCreditNoteId).toBeNull();
    expect(state.row).toMatchObject({ xeroObjectId: "cn-late-b" });
  });

  it("a Mark failed with no resolve is no claim lost: the row no claim holds records the late note (INV-INT-029)", async () => {
    seedRow({ status: "FAILED", lastErrorCode: "XERO_ORPHANED_STALE_RUNNING" });
    await expect(recordCreatedRefundNote(LATE)).resolves.toBe("recorded");
    expect(state.row).toMatchObject({ status: "FAILED", xeroObjectId: "cn-late-b", xeroObjectNumber: "CN-B" });
    expect(state.payment.xeroRefundCreditNoteId).toBe("cn-late-b");
    expect(state.links).toHaveLength(1);
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  // Delta review F1: the OR's other half. An unresolved row that already names a note (a #1354
  // co-holder recorded one) is no resolve by hand: the claim is won and the late note records as
  // before #4426. Dropping `manuallyResolvedAt: null` from the claim fails this.
  it("MUTATION: an unresolved row that already names another note is no resolve by hand - the late note records and nothing is audited", async () => {
    seedRow({ status: "RUNNING", xeroObjectType: "CREDIT_NOTE", xeroObjectId: "cn-other", xeroObjectNumber: "CN-O" });
    await expect(recordCreatedRefundNote(LATE)).resolves.toBe("recorded");
    expect(state.row).toMatchObject({ xeroObjectId: "cn-late-b", xeroObjectNumber: "CN-B" });
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  // Deliberately changed in review (money F2): a plain resolve recorded no officer's note, so the guard
  // has nothing to protect there; the late note lands as before #4426 and #4374's completion alert tells.
  it("MUTATION: a plain resolve that recorded no note does not hold the late note back - it lands and links as before #4426", async () => {
    seedRow({ status: "FAILED", manuallyResolvedAt: RESOLVED_AT, manuallyResolvedById: "officer-1", manuallyResolvedReason: "Done in Xero" });
    await expect(recordCreatedRefundNote({ ...LATE, writesPointer: false, linkRole: "REFUND_REQUEST_CREDIT_NOTE" })).resolves.toBe("recorded");
    expect(state.row).toMatchObject({ manuallyResolvedAt: RESOLVED_AT, xeroObjectId: "cn-late-b", xeroObjectNumber: "CN-B" });
    expect(state.links).toEqual([expect.objectContaining({ xeroObjectId: "cn-late-b", role: "REFUND_REQUEST_CREDIT_NOTE" })]);
    // This module raises nothing: the completion that follows raises #4374's alert.
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("MUTATION: the claim lost to a resolve recording note A writes nothing, warns first, audits and alerts once with the amount and booking", async () => {
    markedFailedAndResolvedWithNote();
    await expect(recordCreatedRefundNote(LATE)).resolves.toBe("resolved-by-hand");

    expect(state.row).toMatchObject({
      status: "FAILED", manuallyResolvedAt: RESOLVED_AT, xeroObjectType: "CREDIT_NOTE", xeroObjectId: "cn-hand-a", xeroObjectNumber: "CN-A",
    });
    expect(state.links).toEqual([expect.objectContaining({ xeroObjectId: "cn-hand-a" })]);
    expect(state.payment.xeroRefundCreditNoteId).toBeNull();

    const trace = { operationId: OPERATION_ID, paymentId: "pay-1", bookingId: "booking-1", creditNoteId: "cn-late-b", creditNoteNumber: "CN-B", amountCents: 20_000 };
    expect(mocks.warn).toHaveBeenCalledWith(trace, expect.stringContaining("claim was lost to a resolve by hand"));
    expect(mocks.warn.mock.invocationCallOrder[0]).toBeLessThan(mocks.audit.mock.invocationCallOrder[0]!);
    expect(mocks.audit).toHaveBeenCalledTimes(1);
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: LATE_REFUND_NOTE_NOT_RECORDED_ACTION, category: "xero", targetId: "booking-1", entityType: "XeroSyncOperation", entityId: OPERATION_ID,
      metadata: expect.objectContaining({ ...trace, reason: "resolved-by-hand", recordedCreditNoteId: "cn-hand-a" }),
    }));
    // The claim lost first: the freshness check never runs, so it can never fail the officer's row.
    expect(mocks.fresh).not.toHaveBeenCalled();
    expect(mocks.audit.mock.invocationCallOrder[0]).toBeLessThan(mocks.claim.mock.invocationCallOrder[0]!);

    expect(mocks.claim).toHaveBeenCalledWith(expect.objectContaining({ key: xeroSuccessAfterResolutionAlertKey(OPERATION_ID, "cn-late-b") }));
    expect(mocks.send).toHaveBeenCalledTimes(1);
    const sent = mocks.send.mock.calls[0]![0] as { errorType: string; operation: string; errorMessage: string };
    expect(sent).toMatchObject({ errorType: "XERO_SUCCESS_AFTER_RESOLUTION", operation: `CREATE CREDIT_NOTE for Payment pay-1 (outbox operation ${OPERATION_ID})` });
    expect(sent.errorMessage).toContain('marked "Resolved in Xero", recording credit note CN-A');
    expect(sent.errorMessage).toContain("credit note CN-B for $200.00 (Xero id cn-late-b, booking booking-1)");
    expect(sent.errorMessage).toContain("not recorded on the payment before voiding it");
    expect(sent.errorMessage).not.toContain("CREDIT_NOTE");

    // A repeat of the same late note (a second holder of the row, #1354) writes nothing and sends nothing more.
    await expect(recordCreatedRefundNote(LATE)).resolves.toBe("resolved-by-hand");
    expect(state.row).toMatchObject({ xeroObjectId: "cn-hand-a" });
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it("MUTATION: the late answer IS the note the resolve recorded (its answer was lost, the officer found it): nothing written, audited or alerted", async () => {
    markedFailedAndResolvedWithNote("cn-late-b", "CN-B");
    // #4656 re-lens F1: its own outcome, so no caller says the note is unrecorded.
    await expect(recordCreatedRefundNote(LATE)).resolves.toBe("resolved-with-this-note");
    expect(state.row).toMatchObject({ manuallyResolvedAt: RESOLVED_AT, xeroObjectId: "cn-late-b" });
    expect(state.links).toHaveLength(1);
    expect(state.payment.xeroRefundCreditNoteId).toBeNull();
    expect(mocks.info).toHaveBeenCalledWith(expect.objectContaining({ creditNoteId: "cn-late-b" }), expect.stringContaining("the note the resolve recorded"));
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("a resolve withdrawn by the time of the re-read is said so: the operation now records no note, and the advice is to resolve with it, not void it", async () => {
    markedFailedAndResolvedWithNote();
    state.reread = { ...state.row!, manuallyResolvedAt: null, manuallyResolvedById: null, manuallyResolvedReason: null, xeroObjectId: null, xeroObjectNumber: null };
    await expect(recordCreatedRefundNote(LATE)).resolves.toBe("resolved-by-hand");
    const sent = mocks.send.mock.calls[0]![0] as { errorMessage: string };
    expect(sent.errorMessage).toContain("That resolve has since been withdrawn, so the operation now records no credit note");
    expect(sent.errorMessage).toContain("resolve the operation by hand with its number rather than voiding it");
  });

  it("keys a late note's alert by the note as well, apart from #4374's per-operation completion alert", () => {
    expect(xeroSuccessAfterResolutionAlertKey(OPERATION_ID)).toBe(`xero-success-after-resolution:${OPERATION_ID}`);
    expect(xeroSuccessAfterResolutionAlertKey(OPERATION_ID, "cn-late-b")).toBe(`xero-success-after-resolution:${OPERATION_ID}:cn-late-b`);
  });

  it("never throws into the create when the alert cannot be sent", async () => {
    markedFailedAndResolvedWithNote();
    mocks.send.mockRejectedValueOnce(new Error("mail down"));
    await expect(recordCreatedRefundNote(LATE)).resolves.toBe("resolved-by-hand");
    expect(state.row).toMatchObject({ xeroObjectId: "cn-hand-a" });
  });

  it("MUTATION: an audit row that fails, or a re-read that fails, never throws into the create; the warning naming the note is already logged", async () => {
    markedFailedAndResolvedWithNote();
    mocks.audit.mockRejectedValueOnce(new Error("audit down"));
    await expect(recordCreatedRefundNote(LATE)).resolves.toBe("resolved-by-hand");
    expect(mocks.error).toHaveBeenCalledWith(expect.objectContaining({ creditNoteId: "cn-late-b" }), expect.stringContaining("audit row failed"));
    expect(mocks.send).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();
    const { prisma } = await import("@/lib/prisma");
    vi.mocked(prisma.xeroSyncOperation.findUnique).mockRejectedValueOnce(new Error("connection reset"));
    await expect(recordCreatedRefundNote({ ...LATE, creditNoteId: "cn-late-c" })).resolves.toBe("resolved-by-hand");
    expect(mocks.warn).toHaveBeenCalledWith(expect.objectContaining({ creditNoteId: "cn-late-c" }), expect.stringContaining("claim was lost to a resolve by hand"));
    expect(mocks.error).toHaveBeenCalledWith(expect.objectContaining({ creditNoteId: "cn-late-c" }), expect.stringContaining("could not be re-read"));
  });

  it("a row that no longer exists records nothing and is audited, not alerted, and never throws into the create", async () => {
    state.row = null;
    await expect(recordCreatedRefundNote(LATE)).resolves.toBe("resolved-by-hand");
    expect(state.links).toEqual([]);
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ rowFound: false }) }));
    expect(mocks.send).not.toHaveBeenCalled();
  });
});

describe("#4656: the record checks the note fresh under its locks, and a wait that runs out fails nothing", () => {
  const timedOut = () => Object.assign(new Error("Transaction already closed: the timeout for this transaction was 30000 ms"), { code: "P2028" });

  it("MUTATION: a note another create row records is refused under the locks - the record rolls back whole and the refusal throws into the create", async () => {
    seedRow();
    const refusal = new Error("Refusing to record Xero credit note cn-late-b for payment pay-1: operation op-other already raised it");
    mocks.fresh.mockRejectedValueOnce(refusal);
    await expect(recordCreatedRefundNote(LATE)).rejects.toBe(refusal);
    expect(state.row).toMatchObject({ status: "RUNNING", xeroObjectId: null });
    expect(state.payment.xeroRefundCreditNoteId).toBeNull();
    expect(state.links).toEqual([]);
    expect(mocks.pointer).not.toHaveBeenCalled();
    expect(mocks.link).not.toHaveBeenCalled();
    // A refusal is the row's own failure, as before #4656: never traced as a lost note.
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("MUTATION: a wait on the Payment row that runs out (P2028) writes nothing, warns first, audits and alerts once, and never throws", async () => {
    seedRow();
    mocks.paymentLock.mockRejectedValueOnce(timedOut());
    await expect(recordCreatedRefundNote(LATE)).resolves.toBe("record-wait-lost");
    // Nothing written, and the row left RUNNING: this module never fails it.
    expect(state.row).toMatchObject({ status: "RUNNING", xeroObjectId: null });
    expect(state.payment.xeroRefundCreditNoteId).toBeNull();
    expect(state.links).toEqual([]);

    const trace = { operationId: OPERATION_ID, paymentId: "pay-1", bookingId: "booking-1", creditNoteId: "cn-late-b", creditNoteNumber: "CN-B", amountCents: 20_000 };
    expect(mocks.warn).toHaveBeenCalledWith(trace, expect.stringContaining("could not get its locks in time"));
    expect(mocks.warn.mock.invocationCallOrder[0]).toBeLessThan(mocks.audit.mock.invocationCallOrder[0]!);
    expect(mocks.audit).toHaveBeenCalledTimes(1);
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: LATE_REFUND_NOTE_NOT_RECORDED_ACTION, category: "xero", targetId: "booking-1", entityId: OPERATION_ID,
      summary: expect.stringContaining("could not get its locks in time"),
      details: expect.stringContaining("Resolve the operation by hand with this note's number, promptly: until then a later refund note on this payment is sized as if this note did not exist. Do not retry it"),
      metadata: expect.objectContaining({ ...trace, reason: "record-wait-lost", errorCode: "P2028", recordedCreditNoteId: null, rowFound: true }),
    }));
    expect(mocks.claim).toHaveBeenCalledWith(expect.objectContaining({ key: xeroSuccessAfterResolutionAlertKey(OPERATION_ID, "cn-late-b") }));
    expect(mocks.send).toHaveBeenCalledTimes(1);
    const sent = mocks.send.mock.calls[0]![0] as { errorType: string; errorMessage: string };
    expect(sent.errorType).toBe("XERO_SUCCESS_AFTER_RESOLUTION");
    expect(sent.errorMessage).toContain("Xero made credit note CN-B for $200.00 (Xero id cn-late-b, booking booking-1) for this refund");
    expect(sent.errorMessage).toContain("did not mark the operation failed");
    expect(sent.errorMessage).toContain("Resolve it by hand with this note's number");
    expect(sent.errorMessage).toContain("could not get its locks in time");
    // #4656 re-lens F2: the limit the officer races - a later note is sized without this one.
    expect(sent.errorMessage).toContain("Resolve it promptly: until you do, a later refund note on this payment");
    expect(sent.errorMessage).toContain("is sized as if this note did not exist");
    expect(sent.errorMessage).not.toContain("stalled");
    // The alert's log line says why this note is unrecorded, not that a reset or resolve kept it out.
    expect(mocks.warn).toHaveBeenCalledWith(expect.objectContaining({ operationId: OPERATION_ID, unrecordedXeroObjectId: "cn-late-b" }), expect.stringContaining("its record could not get its locks in time"));
    expect(mocks.warn).not.toHaveBeenCalledWith(expect.anything(), expect.stringContaining("reset or resolved"));

    // The same note traced again sends nothing more (the once-ever key is the note's).
    mocks.paymentLock.mockRejectedValueOnce(timedOut());
    await expect(recordCreatedRefundNote(LATE)).resolves.toBe("record-wait-lost");
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it("a wait lost after the claim (a deadlock at the link) rolls the claim back too", async () => {
    seedRow();
    const { upsertXeroObjectLink } = await import("@/lib/xero-sync");
    vi.mocked(upsertXeroObjectLink).mockRejectedValueOnce(Object.assign(new Error("deadlock detected"), { code: "P2034" }));
    await expect(recordCreatedRefundNote(LATE)).resolves.toBe("record-wait-lost");
    expect(state.row).toMatchObject({ status: "RUNNING", xeroObjectId: null });
    expect(state.payment.xeroRefundCreditNoteId).toBeNull();
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it("MUTATION: never advises a retry - the audit row and the alert say resolve by hand with the note's number, and do not retry", async () => {
    seedRow();
    mocks.paymentLock.mockRejectedValueOnce(timedOut());
    await expect(recordCreatedRefundNote(LATE)).resolves.toBe("record-wait-lost");
    const { details } = mocks.audit.mock.calls[0]![0] as { details: string };
    const { errorMessage } = mocks.send.mock.calls[0]![0] as { errorMessage: string };
    for (const text of [details, errorMessage]) {
      expect(text).toMatch(/resolve (it|the operation) by hand with this note's number/i);
      expect(text).toMatch(/do not retry/i);
      // #4656 money lens S1: a retry's key follows what the app recorded, so it is never "the same key".
      expect(text).not.toMatch(/same (key|request)|normally (gets|answers)|or retry/i);
    }
  });

  it("MUTATION: a re-read that finds the note recorded on this run's own claim (the commit's answer was lost) carries on as recorded, alerting nothing", async () => {
    seedRow();
    mocks.paymentLock.mockRejectedValueOnce(timedOut());
    state.reread = { ...state.row!, xeroObjectType: "CREDIT_NOTE", xeroObjectId: "cn-late-b", xeroObjectNumber: "CN-B" };
    await expect(recordCreatedRefundNote(LATE)).resolves.toBe("recorded");
    expect(mocks.info).toHaveBeenCalledWith(expect.objectContaining({ creditNoteId: "cn-late-b" }), expect.stringContaining("records this note after all"));
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("a committed record on a row Mark failed since is still this run's own: recorded", async () => {
    seedRow();
    mocks.paymentLock.mockRejectedValueOnce(timedOut());
    state.reread = { ...state.row!, status: "FAILED", xeroObjectType: "CREDIT_NOTE", xeroObjectId: "cn-late-b" };
    await expect(recordCreatedRefundNote(LATE)).resolves.toBe("recorded");
  });

  it("MUTATION: the same note recorded by a resolve by hand is the officer's, never settled as this run's", async () => {
    seedRow();
    mocks.paymentLock.mockRejectedValueOnce(timedOut());
    state.reread = { ...state.row!, status: "FAILED", manuallyResolvedAt: RESOLVED_AT, xeroObjectType: "CREDIT_NOTE", xeroObjectId: "cn-late-b" };
    await expect(recordCreatedRefundNote(LATE)).resolves.toBe("resolved-with-this-note");
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("MUTATION: the same note on a row another claim holds RUNNING is not this run's to finish", async () => {
    seedRow();
    mocks.paymentLock.mockRejectedValueOnce(timedOut());
    state.reread = { ...state.row!, startedAt: new Date("2026-07-01T00:30:00.000Z"), xeroObjectType: "CREDIT_NOTE", xeroObjectId: "cn-late-b" };
    // Recorded, by that claim: never "nothing records it" (#4656 re-lens F1).
    await expect(recordCreatedRefundNote(LATE)).resolves.toBe("recorded-by-another-claim");
  });

  it("MUTATION: any other error throws into the create as before - it is not a lost wait", async () => {
    seedRow();
    const broken = Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
    mocks.paymentLock.mockRejectedValueOnce(broken);
    await expect(recordCreatedRefundNote(LATE)).rejects.toBe(broken);
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("names the lost waits: P2028, P2034, a raw deadlock and a lock not available, at any depth the adapter puts them", () => {
    expect(isRecordWaitLost({ code: "P2028" })).toBe(true);
    expect(isRecordWaitLost({ code: "P2034" })).toBe(true);
    expect(isRecordWaitLost(Object.assign(new Error("deadlock detected"), { code: "40P01" }))).toBe(true);
    expect(isRecordWaitLost({ code: "P2010", meta: { driverAdapterError: { cause: { originalCode: "55P03" } } } })).toBe(true);
    expect(isRecordWaitLost({ code: "P2002" })).toBe(false);
    expect(isRecordWaitLost(new Error("Refusing to record Xero credit note"))).toBe(false);
    expect(isRecordWaitLost(null)).toBe(false);
  });
});
