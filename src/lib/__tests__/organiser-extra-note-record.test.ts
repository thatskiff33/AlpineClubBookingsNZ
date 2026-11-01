/**
 * #4655 (`INV-INT-029`): an organiser adjustment's record of the credit note
 * Xero returned (`recordCreatedOrganiserNote`) never loses the note.
 *
 * A create stalls in Xero; Reset stale running fails its row; the run comes
 * back with the note. The organiser adjustment's retry runs on that same row
 * and continues from a note the row records, so the note lands where a
 * success may land (`INV-INT-029`) and no other note is recorded: the run's
 * own claim, a row a reset left FAILED (this run finishes it), or one queued
 * again (the queued run finishes it). Anywhere else - a row resolved by hand,
 * one a later attempt holds RUNNING or recorded another note on, one closed
 * since - nothing is written, and the note is warned first, audited once
 * (`xero`) and alerted once (#4374's alert, keyed per late note), none of it
 * able to throw into the outbox.
 *
 * Driven on an in-memory row the claim's `where` is evaluated against
 * (`matchesWhere`). The once-ever claim is a fake holding keys in a set, so a
 * repeat is refused as `sendAdminAlertOnceEver` would refuse it. The
 * real-PostgreSQL proof is `organiser-late-note-after-reset.realdb.test.ts`.
 *
 * #4672 review S1/S2: the FAILED landing takes the row back RUNNING under a
 * fresh claim, so an officer's Resolve or Retry - both status-guarded off a
 * RUNNING row - is refused until this run completes or fails it under that
 * claim, and the stalled claim writes nothing more there.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { XeroSyncOperation } from "@prisma/client";
import { matchesWhere } from "./support/prisma-where";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
  held: new Set<string>(),
}));
const mocks = vi.hoisted(() => ({
  claim: vi.fn(), send: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn(), audit: vi.fn(), write: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    xeroSyncOperation: {
      updateManyAndReturn: vi.fn(async ({ where, data, select }: { where: Row; data: Row; select: Record<string, true> }) => {
        mocks.write();
        if (!state.row || !matchesWhere(state.row, where)) return [];
        Object.assign(state.row, data);
        return [Object.fromEntries(Object.keys(select).map((key) => [key, state.row![key]]))];
      }),
      findUnique: vi.fn(async () => (state.row ? { ...state.row } : null)),
      // The resolve mark's and the outbox claim's own writes, evaluated on the same row.
      updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
        if (!state.row || !matchesWhere(state.row, where)) return { count: 0 };
        Object.assign(state.row, data);
        return { count: 1 };
      }),
    },
  },
}));
vi.mock("@/lib/audit", () => ({ createAuditLog: mocks.audit }));
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

import { LATE_ORGANISER_NOTE_NOT_RECORDED_ACTION, createdOrganiserNoteWrites, recordCreatedOrganiserNote } from "@/lib/organiser-extra-note-record";
import { claimResolvedInXeroMark } from "@/lib/xero-operation-resolve-guards";
import { claimXeroSyncOperationToRunning } from "@/lib/xero-operation-claim";
import { outcomeWriteGuard } from "@/lib/xero-operation-outcome-guard";
import { xeroSuccessAfterResolutionAlertKey } from "@/lib/xero-success-after-resolution-alert";

const OPERATION_ID = "op-organiser";
const STARTED_AT = new Date("2026-07-01T00:00:00.000Z");
const LATER_CLAIM_AT = new Date("2026-07-01T00:40:00.000Z");
const RESOLVED_AT = new Date("2026-07-01T00:30:00.000Z");
/** When the stalled run's late note lands, past the stale threshold. */
const LANDED_AT = new Date("2026-07-01T00:20:00.000Z");
const LATE = {
  claim: { id: OPERATION_ID, startedAt: STARTED_AT },
  bookingId: "booking-1",
  purpose: "waive" as const,
  creditNoteId: "cn-late",
  creditNoteNumber: "CN-9",
  amountCents: 4_000,
};
const TRACE = { operationId: OPERATION_ID, bookingId: "booking-1", purpose: "waive", creditNoteId: "cn-late", creditNoteNumber: "CN-9", amountCents: 4_000 };

function seedRow(overrides: Row = {}) {
  state.row = {
    id: OPERATION_ID, status: "RUNNING", startedAt: STARTED_AT,
    operationType: "CREATE", entityType: "CREDIT_NOTE", localModel: "Booking", localId: "booking-1",
    xeroObjectType: null, xeroObjectId: null, xeroObjectNumber: null, lastErrorCode: null, lastErrorMessage: null, completedAt: null,
    manuallyResolvedAt: null, manuallyResolvedById: null, manuallyResolvedReason: null,
    ...overrides,
  } as Partial<XeroSyncOperation>;
}

/** What Reset stale running leaves on the stalled run's row. */
const RESET = { status: "FAILED", lastErrorCode: "XERO_ORPHANED_STALE_RUNNING", lastErrorMessage: "Reset stale running", completedAt: new Date("2026-07-01T00:16:00.000Z") };

function sentMessage(): string {
  return (mocks.send.mock.calls[0]![0] as { errorMessage: string }).errorMessage;
}

afterEach(() => {
  vi.setSystemTime(new Date("2026-07-01T00:00:00.000Z"));
});

beforeEach(() => {
  vi.clearAllMocks();
  state.held.clear();
  mocks.claim.mockImplementation(async ({ key }: { key: string }) => {
    if (state.held.has(key)) return false;
    state.held.add(key);
    return true;
  });
  mocks.send.mockResolvedValue({ deliveryAllowed: true, recipients: 1, sent: 1, queuedForRetry: 0, notDelivered: 0 });
  mocks.audit.mockResolvedValue(undefined);
});

describe("#4655: an organiser adjustment's late credit note is recorded where a success lands, or traced once", () => {
  it("the claim won: recorded on this run's own claim, with its number, and nothing logged, audited or alerted", async () => {
    seedRow();
    await expect(recordCreatedOrganiserNote(LATE)).resolves.toEqual({ outcome: "claimed", claim: LATE.claim });
    expect(state.row).toMatchObject({ status: "RUNNING", xeroObjectType: "CREDIT_NOTE", xeroObjectId: "cn-late", xeroObjectNumber: "CN-9" });
    expect(mocks.warn).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(mocks.claim).not.toHaveBeenCalled();
  });

  it("MUTATION: a reset with no resolve lands the note on the FAILED row and takes it back RUNNING under a fresh claim this run finishes", async () => {
    seedRow(RESET);
    vi.setSystemTime(LANDED_AT);
    await expect(recordCreatedOrganiserNote(LATE)).resolves.toEqual({ outcome: "retaken", claim: { id: OPERATION_ID, startedAt: LANDED_AT } });
    expect(state.row).toMatchObject({
      status: "RUNNING", startedAt: LANDED_AT, completedAt: null, lastErrorCode: null, lastErrorMessage: null,
      xeroObjectType: "CREDIT_NOTE", xeroObjectId: "cn-late", xeroObjectNumber: "CN-9",
    });
    expect(mocks.warn).toHaveBeenCalledWith({ ...TRACE, retakenAt: LANDED_AT }, expect.stringContaining("landed on its operation after a reset"));
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  describe("#4672 review S1/S2: the re-taken row is this run's until it completes or fails it", () => {
    async function retake() {
      seedRow(RESET);
      vi.setSystemTime(LANDED_AT);
      const record = await recordCreatedOrganiserNote(LATE);
      if (record.outcome !== "retaken") throw new Error(`expected a re-take, got ${record.outcome}`);
      return record.claim;
    }

    it("MUTATION: an officer's Resolve is refused, so no allocation or payout follows an officer taking the adjustment over", async () => {
      await retake();
      await expect(claimResolvedInXeroMark({ id: OPERATION_ID, resolvedAt: RESOLVED_AT, reason: "Credited by hand", resolvedById: "officer-1" })).resolves.toBe(false);
      expect(state.row).toMatchObject({ status: "RUNNING", manuallyResolvedAt: null });
    });

    it("MUTATION: an officer's Retry finds no FAILED row to queue, and no outbox claim takes the row from under this run", async () => {
      await retake();
      // Retry's in-place requeue moves FAILED or PARTIAL, unresolved, to PENDING (`requeueOutboxRowForRetry`).
      expect(matchesWhere(state.row!, { id: OPERATION_ID, status: { in: ["FAILED", "PARTIAL"] }, manuallyResolvedAt: null })).toBe(false);
      await expect(claimXeroSyncOperationToRunning(OPERATION_ID, {})).resolves.toBeNull();
    });

    it("MUTATION: this run's success and failure land under the new claim; the stalled claim's do not", async () => {
      const claim = await retake();
      for (const status of ["SUCCEEDED", "FAILED"]) {
        expect(matchesWhere(state.row!, { id: OPERATION_ID, ...outcomeWriteGuard(claim, status, {}) })).toBe(true);
        expect(matchesWhere(state.row!, { id: OPERATION_ID, ...outcomeWriteGuard(LATE.claim, status, {}) })).toBe(false);
      }
    });
  });

  it("a re-take that loses to a live row holding the correlation key is not recorded: traced once, nothing thrown", async () => {
    seedRow(RESET);
    const { prisma } = await import("@/lib/prisma");
    vi.mocked(prisma.xeroSyncOperation.updateManyAndReturn)
      .mockImplementationOnce(async () => [])
      .mockRejectedValueOnce(Object.assign(new Error("Unique constraint failed"), { code: "P2002" }));
    await expect(recordCreatedOrganiserNote(LATE)).resolves.toEqual({ outcome: "not-recorded" });
    expect(state.row).toMatchObject({ status: "FAILED", xeroObjectId: null });
    expect(mocks.audit).toHaveBeenCalledTimes(1);
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it("MUTATION: a reset, then a retry queued (PENDING): the note lands and the queued run finishes from it", async () => {
    seedRow({ status: "PENDING", startedAt: null });
    await expect(recordCreatedOrganiserNote(LATE)).resolves.toEqual({ outcome: "queued" });
    expect(state.row).toMatchObject({ status: "PENDING", xeroObjectId: "cn-late" });
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("MUTATION: a reset, then a resolve by hand: nothing written; warned first, audited once and alerted once naming the note, its amount and booking", async () => {
    seedRow({ ...RESET, manuallyResolvedAt: RESOLVED_AT, manuallyResolvedById: "officer-1", manuallyResolvedReason: "Credited by hand" });
    await expect(recordCreatedOrganiserNote(LATE)).resolves.toEqual({ outcome: "not-recorded" });

    expect(state.row).toMatchObject({ status: "FAILED", manuallyResolvedAt: RESOLVED_AT, xeroObjectId: null, xeroObjectNumber: null });
    expect(mocks.warn).toHaveBeenCalledWith(TRACE, expect.stringContaining("re-checking the operation (INV-INT-029, #4655)"));
    expect(mocks.warn.mock.invocationCallOrder[0]).toBeLessThan(mocks.audit.mock.invocationCallOrder[0]!);
    expect(mocks.audit).toHaveBeenCalledTimes(1);
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: LATE_ORGANISER_NOTE_NOT_RECORDED_ACTION, category: "xero", severity: "important", outcome: "blocked",
      targetId: "booking-1", entityType: "XeroSyncOperation", entityId: OPERATION_ID,
      metadata: expect.objectContaining({ ...TRACE, rowFound: true, rowStatus: "FAILED", resolvedByHand: true, recordedCreditNoteId: null }),
    }));
    expect(mocks.audit.mock.invocationCallOrder[0]).toBeLessThan(mocks.claim.mock.invocationCallOrder[0]!);

    expect(mocks.claim).toHaveBeenCalledWith(expect.objectContaining({ key: xeroSuccessAfterResolutionAlertKey(OPERATION_ID, "cn-late") }));
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.send.mock.calls[0]![0]).toMatchObject({ errorType: "XERO_SUCCESS_AFTER_RESOLUTION", operation: `CREATE CREDIT_NOTE for Booking booking-1 (outbox operation ${OPERATION_ID})` });
    expect(sentMessage()).toContain('organiser unpaid-extra waiver operation was marked "Resolved in Xero", and then');
    expect(sentMessage()).toContain("credit note CN-9 for $40.00 (Xero id cn-late, booking booking-1)");
    expect(sentMessage()).toContain("The operation stays as resolved");
    expect(sentMessage()).not.toContain("CREDIT_NOTE");
  });

  it("MUTATION: the same late note again (a second answer of one stalled call) writes nothing and sends nothing more", async () => {
    seedRow({ ...RESET, manuallyResolvedAt: RESOLVED_AT, manuallyResolvedReason: "Credited by hand" });
    await recordCreatedOrganiserNote(LATE);
    await expect(recordCreatedOrganiserNote(LATE)).resolves.toEqual({ outcome: "not-recorded" });
    expect(mocks.claim).toHaveBeenCalledTimes(2);
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(state.row).toMatchObject({ xeroObjectId: null });
  });

  it("MUTATION: a later attempt holding the row RUNNING keeps its claim; the late note is traced and the alert says that run may record the same note", async () => {
    seedRow({ status: "RUNNING", startedAt: LATER_CLAIM_AT });
    await expect(recordCreatedOrganiserNote(LATE)).resolves.toEqual({ outcome: "not-recorded" });
    expect(state.row).toMatchObject({ status: "RUNNING", startedAt: LATER_CLAIM_AT, xeroObjectId: null });
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ rowStatus: "RUNNING", resolvedByHand: false }) }));
    expect(sentMessage()).toContain("is running again");
    expect(sentMessage()).toContain("may record this same note");
  });

  it("MUTATION: a row a later attempt recorded another note on is never overwritten; the late note is traced naming the one it keeps", async () => {
    seedRow({ ...RESET, xeroObjectType: "CREDIT_NOTE", xeroObjectId: "cn-retry", xeroObjectNumber: "CN-10" });
    await expect(recordCreatedOrganiserNote(LATE)).resolves.toEqual({ outcome: "not-recorded" });
    expect(state.row).toMatchObject({ xeroObjectId: "cn-retry", xeroObjectNumber: "CN-10" });
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ recordedCreditNoteId: "cn-retry" }) }));
    expect(sentMessage()).toContain("a later attempt recorded credit note CN-10 on it");
  });

  it("the row already records this very note (a retry's repeat of the call answered with it): nothing written, audited or alerted", async () => {
    seedRow({ status: "SUCCEEDED", xeroObjectType: "CREDIT_NOTE", xeroObjectId: "cn-late", xeroObjectNumber: "CN-9" });
    await expect(recordCreatedOrganiserNote(LATE)).resolves.toEqual({ outcome: "not-recorded" });
    expect(mocks.info).toHaveBeenCalledWith(TRACE, expect.stringContaining("the note the operation records"));
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(mocks.claim).not.toHaveBeenCalled();
  });

  it("an unresolved row a reset left FAILED that records the same note takes it again (idempotent) and this run finishes it", async () => {
    seedRow({ ...RESET, xeroObjectType: "CREDIT_NOTE", xeroObjectId: "cn-late" });
    await expect(recordCreatedOrganiserNote(LATE)).resolves.toMatchObject({ outcome: "retaken" });
    expect(state.row).toMatchObject({ status: "RUNNING", xeroObjectId: "cn-late" });
  });

  it("a row closed since (SUCCEEDED with no note) is not written; the note is traced", async () => {
    seedRow({ status: "SUCCEEDED" });
    await expect(recordCreatedOrganiserNote(LATE)).resolves.toEqual({ outcome: "not-recorded" });
    expect(state.row).toMatchObject({ status: "SUCCEEDED", xeroObjectId: null });
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(sentMessage()).toContain("now stands SUCCEEDED without recording this note");
  });

  it("MUTATION: an audit row that fails never throws into the run, and the alert still goes", async () => {
    seedRow({ status: "RUNNING", startedAt: LATER_CLAIM_AT });
    mocks.audit.mockRejectedValueOnce(new Error("audit down"));
    await expect(recordCreatedOrganiserNote(LATE)).resolves.toEqual({ outcome: "not-recorded" });
    expect(mocks.error).toHaveBeenCalledWith(expect.objectContaining({ creditNoteId: "cn-late" }), expect.stringContaining("audit row failed"));
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it("MUTATION: an alert that fails never throws into the run, and the audit row stands", async () => {
    seedRow({ status: "RUNNING", startedAt: LATER_CLAIM_AT });
    mocks.send.mockRejectedValueOnce(new Error("mail down"));
    await expect(recordCreatedOrganiserNote(LATE)).resolves.toEqual({ outcome: "not-recorded" });
    expect(mocks.audit).toHaveBeenCalledTimes(1);
  });

  it("a re-read that fails never throws into the run; the warning naming the note is already logged", async () => {
    seedRow({ status: "RUNNING", startedAt: LATER_CLAIM_AT });
    const { prisma } = await import("@/lib/prisma");
    vi.mocked(prisma.xeroSyncOperation.findUnique).mockRejectedValueOnce(new Error("connection reset"));
    await expect(recordCreatedOrganiserNote(LATE)).resolves.toEqual({ outcome: "not-recorded" });
    expect(mocks.warn).toHaveBeenCalledWith(TRACE, expect.stringContaining("re-checking the operation"));
    expect(mocks.error).toHaveBeenCalledWith(expect.objectContaining({ creditNoteId: "cn-late" }), expect.stringContaining("could not be re-read"));
  });

  it("a row that no longer exists is audited, not alerted", async () => {
    state.row = null;
    await expect(recordCreatedOrganiserNote(LATE)).resolves.toEqual({ outcome: "not-recorded" });
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ rowFound: false }) }));
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("a write that throws names the note before the error reaches the outbox", async () => {
    seedRow();
    const { prisma } = await import("@/lib/prisma");
    vi.mocked(prisma.xeroSyncOperation.updateManyAndReturn).mockRejectedValueOnce(new Error("connection reset"));
    await expect(recordCreatedOrganiserNote(LATE)).rejects.toThrow("connection reset");
    expect(mocks.error).toHaveBeenCalledWith(expect.objectContaining(TRACE), expect.stringContaining("could not be recorded"));
  });

  it("refuses to build a record with no operation id (an updateMany would read it as no filter)", () => {
    expect(() => createdOrganiserNoteWrites({ ...LATE, claim: { id: "", startedAt: STARTED_AT } }, LANDED_AT)).toThrow("operation's id");
  });
});
