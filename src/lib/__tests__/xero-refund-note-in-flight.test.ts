import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ findFirst: vi.fn(), findMany: vi.fn(), linkFindMany: vi.fn() }));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    xeroSyncOperation: { findFirst: (...a: unknown[]) => mocks.findFirst(...a), findMany: (...a: unknown[]) => mocks.findMany(...a) },
    xeroObjectLink: { findMany: (...a: unknown[]) => mocks.linkFindMany(...a) },
  },
}));

import {
  XeroRefundCreditNoteInFlightError,
  XeroRefundCreditNoteUnrecordedError,
  isXeroAppliedCreditOperationBusyError,
} from "@/lib/xero-applied-credit-operation-serialization";
import {
  assertNoRefundCreditNoteInFlight,
  assertNoUnrecordedRefundNote,
  findUnrecordedRefundNoteOperation,
  holdsUnrecordedRefundNote,
  REFUND_NOTE_AWAITING_RESOLVE_RECHECK_MS,
  scanSpacesRefundNotesAwaitingResolve,
  unrecordedNoteStampPayload,
  unrecordedRefundNoteRetryRefusal,
  UNRECORDED_REFUND_NOTE_RETRY_REASON,
} from "@/lib/xero-refund-note-in-flight";
import { XERO_REFUND_NOTE_AWAITING_RESOLVE_CODE, XERO_REFUND_NOTE_UNRECORDED_ERROR_CODE } from "@/lib/xero-operation-error-codes";
import { matchesWhere } from "./support/prisma-where";
import { STALE_RUNNING_XERO_OPERATION_MINUTES } from "@/lib/xero-stale-operations";

describe("#3880 assertNoRefundCreditNoteInFlight", () => {
  beforeEach(() => {
    mocks.findFirst.mockReset();
  });

  it("asks for a LIVE running refund-note create or credit-note requeue on this payment, other than the caller's own claims", async () => {
    mocks.findFirst.mockResolvedValue(null);
    const before = Date.now();

    await assertNoRefundCreditNoteInFlight("payment_1", ["op_own", undefined, "requeue_own", null]);

    const { where } = mocks.findFirst.mock.calls[0]![0] as { where: Record<string, unknown> };
    expect(where).toMatchObject({
      id: { notIn: ["op_own", "requeue_own"] },
      direction: "OUTBOUND",
      entityType: "CREDIT_NOTE",
      localModel: "Payment",
      localId: "payment_1",
      status: "RUNNING",
      OR: [
        { operationType: "CREATE", queueType: "REFUND_CREDIT_NOTE" },
        { operationType: "CREATE", queueType: null },
        { operationType: "REQUEUE" },
      ],
    });
    const floor = (where.startedAt as { gte: Date }).gte.getTime();
    expect(before - floor).toBeGreaterThanOrEqual(STALE_RUNNING_XERO_OPERATION_MINUTES * 60_000 - 5);
    expect(Date.now() - floor).toBeLessThanOrEqual(STALE_RUNNING_XERO_OPERATION_MINUTES * 60_000 + 1_000);
  });

  it("MUTATION: throws the outbox's busy error, naming the row it waits for", async () => {
    mocks.findFirst.mockResolvedValue({ id: "op_other" });

    const error = await assertNoRefundCreditNoteInFlight("payment_1", ["op_own"]).then(() => null, (e: unknown) => e);

    expect(error).toBeInstanceOf(XeroRefundCreditNoteInFlightError);
    expect(isXeroAppliedCreditOperationBusyError(error)).toBe(true);
    expect((error as Error).message).toContain("op_other");
  });

  it("with no claim of its own, excludes nothing", async () => {
    mocks.findFirst.mockResolvedValue(null);
    await assertNoRefundCreditNoteInFlight("payment_1", [null, undefined]);
    const { where } = mocks.findFirst.mock.calls[0]![0] as { where: Record<string, unknown> };
    expect(where).not.toHaveProperty("id");
  });
});

describe("#4688 the unrecorded-note fence", () => {
  beforeEach(() => {
    mocks.findMany.mockReset();
    mocks.linkFindMany.mockReset();
    mocks.linkFindMany.mockResolvedValue([]);
  });

  /** A payment refund-note create row, as the record stamps it when its wait is lost. */
  const stamped = (overrides: Record<string, unknown> = {}) => ({
    id: "op_unrecorded",
    direction: "OUTBOUND",
    entityType: "CREDIT_NOTE",
    operationType: "CREATE",
    localModel: "Payment",
    localId: "payment_1",
    queueType: "REFUND_CREDIT_NOTE",
    requestPayload: { queueType: "REFUND_CREDIT_NOTE", refundAmountCents: 5_000, watermarkCents: 5_000 },
    responsePayload: unrecordedNoteStampPayload("cn_a"),
    status: "RUNNING",
    startedAt: new Date("2026-06-01T00:00:00.000Z"),
    lastErrorCode: XERO_REFUND_NOTE_UNRECORDED_ERROR_CODE,
    manuallyResolvedAt: null,
    xeroObjectId: null,
    ...overrides,
  });
  const whereOf = (call = 0) => (mocks.findMany.mock.calls[call]![0] as { where: Record<string, unknown> }).where;

  it("MUTATION: fences on a stamped, unresolved row naming no note, whatever its status or age - and nothing else", async () => {
    mocks.findMany.mockResolvedValue([]);
    await assertNoUnrecordedRefundNote("payment_1");
    const where = whereOf();
    // No stale-threshold floor, and no status: a row past 15 minutes, or FAILED by Mark failed, still fences.
    expect(where).not.toHaveProperty("startedAt");
    expect(where).not.toHaveProperty("status");
    for (const row of [stamped(), stamped({ status: "FAILED" }), stamped({ queueType: null }), stamped({ startedAt: new Date("2020-01-01T00:00:00.000Z") })]) {
      expect(matchesWhere(row, where)).toBe(true);
      // The one-row reading agrees with the database's.
      expect(holdsUnrecordedRefundNote(row)).toBe(true);
    }
    for (const row of [
      stamped({ manuallyResolvedAt: new Date("2026-07-01T00:00:00.000Z") }), // Resolve by hand lifts it
      stamped({ xeroObjectId: "cn_recorded" }), // the row records a note after all
      stamped({ lastErrorCode: "ORPHANED_STALE_RUNNING" }),
      stamped({ lastErrorCode: null }),
      stamped({ localId: "payment_2" }),
      stamped({ queueType: "ACCOUNT_CREDIT_NOTE" }),
      stamped({ operationType: "REQUEUE" }),
    ]) {
      expect(matchesWhere(row, where)).toBe(false);
    }
  });

  it("MUTATION: throws the outbox's busy error (an in-flight subclass, so the retry queue waits too), naming the row to resolve, under a wait code the scans space out", async () => {
    mocks.findMany.mockResolvedValue([stamped()]);
    const error = await assertNoUnrecordedRefundNote("payment_1").then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(XeroRefundCreditNoteUnrecordedError);
    expect(error).toBeInstanceOf(XeroRefundCreditNoteInFlightError);
    expect(isXeroAppliedCreditOperationBusyError(error)).toBe(true);
    expect((error as Error).message).toContain("until an officer resolves op_unrecorded by hand");
    // #4692 review (finding 1): the wait can last days, so it names itself for the scans.
    expect((error as XeroRefundCreditNoteUnrecordedError).waitCode).toBe(XERO_REFUND_NOTE_AWAITING_RESOLVE_CODE);
    // The plain in-flight wait (#3880) is short, and keeps no code.
    expect(new XeroRefundCreditNoteInFlightError("payment_1", "op_running").waitCode).toBeNull();
  });

  describe("#4692 review (finding 3): lifted once the stamped row's note is recorded on the payment some other way", () => {
    it("MUTATION: a live link on the payment naming the row's note lifts it - another row resolved with it, or a retry recorded it", async () => {
      mocks.findMany.mockResolvedValue([stamped()]);
      mocks.linkFindMany.mockResolvedValue([{ active: true, metadata: { status: "AUTHORISED" } }]);
      await expect(findUnrecordedRefundNoteOperation("payment_1")).resolves.toBeNull();
      expect((mocks.linkFindMany.mock.calls[0]![0] as { where: unknown }).where).toEqual({
        localModel: "Payment", localId: "payment_1", xeroObjectType: "CREDIT_NOTE", xeroObjectId: "cn_a",
      });
    });

    it("a link recording the note as voided in Xero lifts it too: nothing is left out of coverage", async () => {
      mocks.findMany.mockResolvedValue([stamped()]);
      mocks.linkFindMany.mockResolvedValue([{ active: false, metadata: { status: "VOIDED" } }]);
      await expect(findUnrecordedRefundNoteOperation("payment_1")).resolves.toBeNull();
    });

    it.each([
      ["no link names the note", [], stamped()],
      ["only a link a withdrawn resolve retired", [{ active: false, metadata: { status: "AUTHORISED", resolvedOperationId: "op_x" } }], stamped()],
      ["the stamp named no note", [{ active: true, metadata: {} }], stamped({ responsePayload: null })],
    ])("MUTATION: the fence stays up when %s", async (_label, links, row) => {
      mocks.findMany.mockResolvedValue([row]);
      mocks.linkFindMany.mockResolvedValue(links);
      await expect(findUnrecordedRefundNoteOperation("payment_1")).resolves.toEqual({ id: "op_unrecorded" });
    });

    it("a lifted row does not hide a second stamped row behind it", async () => {
      mocks.findMany.mockResolvedValue([stamped(), stamped({ id: "op_second", responsePayload: unrecordedNoteStampPayload("cn_b") })]);
      mocks.linkFindMany.mockImplementation(async ({ where }: { where: { xeroObjectId: string } }) =>
        where.xeroObjectId === "cn_a" ? [{ active: true, metadata: {} }] : []);
      await expect(findUnrecordedRefundNoteOperation("payment_1")).resolves.toEqual({ id: "op_second" });
    });
  });

  it("holdsUnrecordedRefundNote reads one row the way the fence does", () => {
    expect(holdsUnrecordedRefundNote(stamped())).toBe(true);
    expect(holdsUnrecordedRefundNote(stamped({ manuallyResolvedAt: new Date("2026-07-01T00:00:00.000Z") }))).toBe(false);
    expect(holdsUnrecordedRefundNote(stamped({ xeroObjectId: "cn_recorded" }))).toBe(false);
    expect(holdsUnrecordedRefundNote(stamped({ lastErrorCode: undefined }))).toBe(false);
  });

  it("MUTATION (#4692 review, finding 1): the scans leave a note waiting on the fence out until its recheck is due, and every other row in", () => {
    const now = new Date("2026-07-01T00:00:00.000Z");
    const filter = scanSpacesRefundNotesAwaitingResolve(now);
    const waiting = (ageMs: number) => ({ lastErrorCode: XERO_REFUND_NOTE_AWAITING_RESOLVE_CODE, updatedAt: new Date(now.getTime() - ageMs) });
    expect(matchesWhere(waiting(60_000), filter)).toBe(false);
    expect(matchesWhere(waiting(REFUND_NOTE_AWAITING_RESOLVE_RECHECK_MS), filter)).toBe(true);
    expect(matchesWhere({ lastErrorCode: null, updatedAt: now }, filter)).toBe(true);
    expect(matchesWhere({ lastErrorCode: "SOMETHING_ELSE", updatedAt: now }, filter)).toBe(true);
  });

  describe("unrecordedRefundNoteRetryRefusal", () => {
    it("MUTATION: refuses the stamped row itself, never advising a retry", async () => {
      mocks.findMany.mockResolvedValue([stamped()]);
      await expect(unrecordedRefundNoteRetryRefusal(stamped({ status: "FAILED" }) as never)).resolves.toBe(UNRECORDED_REFUND_NOTE_RETRY_REASON);
      expect(whereOf()).toMatchObject({ localId: "payment_1", lastErrorCode: XERO_REFUND_NOTE_UNRECORDED_ERROR_CODE });
    });

    it("MUTATION: refuses any other refund-note create on the payment - the original a retry ran for - naming the row to resolve", async () => {
      mocks.findMany.mockResolvedValue([stamped()]);
      const refusal = await unrecordedRefundNoteRetryRefusal(stamped({ id: "op_original", status: "FAILED", lastErrorCode: "500" }) as never);
      expect(refusal).toContain("resolve operation op_unrecorded by hand");
      expect(refusal).toContain("then retry this one");
    });

    it("lets the retry go ahead when the payment holds no unrecorded note", async () => {
      mocks.findMany.mockResolvedValue([]);
      await expect(unrecordedRefundNoteRetryRefusal(stamped({ id: "op_original", status: "FAILED" }) as never)).resolves.toBeNull();
    });

    it.each([
      ["a row that records its note (the #3548 repair leg raises none)", { xeroObjectId: "cn_recorded" }],
      ["an account-credit note", { queueType: "ACCOUNT_CREDIT_NOTE" }],
      // #4692 review (finding 5): an inline account-credit row has a null queue type too.
      ["an inline account-credit row (null queue type)", { queueType: null, requestPayload: { creditNotes: [{ lineItems: [{ unitAmount: 50 }] }] } }],
      ["a booking's clearing note", { localModel: "Booking" }],
      ["an invoice", { entityType: "INVOICE" }],
    ])("never reads the fence for %s", async (_label, overrides) => {
      mocks.findMany.mockResolvedValue([stamped()]);
      await expect(unrecordedRefundNoteRetryRefusal(stamped({ id: "op_other", ...overrides }) as never)).resolves.toBeNull();
      expect(mocks.findMany).not.toHaveBeenCalled();
    });
  });
});
