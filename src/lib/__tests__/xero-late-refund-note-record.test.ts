/**
 * #4426 (`INV-INT-029`): the payment refund-note create's record of the note
 * Xero returned (`recordCreatedRefundNote`) is claimed on the row first.
 *
 * A create stalls in Xero; "Reset stale running" fails its row; an officer
 * resolves it by hand, recording the note they made (#4421). When the stalled
 * run's note comes back it must not replace the officer's note on the row, nor
 * be linked, nor take the payment's pointer: it is surfaced to the officers
 * through #4374's alert, once. A row reset with no resolve is a row no claim
 * holds, where a success lands (`INV-INT-029`), so the note is recorded there
 * as before.
 *
 * Driven on an in-memory row the claim's `where` is evaluated against
 * (`matchesWhere`), inside a fake transaction that rolls back what it wrote
 * when its callback throws, as PostgreSQL does. The once-ever claim is a fake
 * holding keys in a set, so a repeat is refused as `sendAdminAlertOnceEver`
 * would refuse it. The real-PostgreSQL proof of the race is
 * `xero-late-refund-note-after-resolve.realdb.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { XeroSyncOperation } from "@prisma/client";
import { matchesWhere } from "./support/prisma-where";

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
  payment: { id: "pay-1", xeroRefundCreditNoteId: null as string | null },
  links: [] as Array<Record<string, unknown>>,
  held: new Set<string>(),
}));
const mocks = vi.hoisted(() => ({ claim: vi.fn(), send: vi.fn(), warn: vi.fn() }));

vi.mock("@/lib/prisma", () => {
  const client = {
    payment: {
      update: vi.fn(async ({ data }: { data: Row }) => Object.assign(state.payment, data)),
    },
    xeroSyncOperation: {
      updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
        if (!state.row || !matchesWhere(state.row, where)) return { count: 0 };
        Object.assign(state.row, data);
        return { count: 1 };
      }),
      findUnique: vi.fn(async () => (state.row ? { ...state.row } : null)),
    },
  };
  return {
    prisma: {
      ...client,
      // PostgreSQL's rollback: a callback that throws leaves nothing it wrote.
      $transaction: vi.fn(async (run: (tx: typeof client) => unknown) => {
        const before = JSON.stringify({ row: state.row, payment: state.payment, links: state.links });
        try {
          return await run(client);
        } catch (error) {
          const restored = JSON.parse(before, (key, value) => (key === "manuallyResolvedAt" && value ? new Date(value) : value));
          state.row = restored.row;
          Object.assign(state.payment, restored.payment);
          state.links = restored.links;
          throw error;
        }
      }),
    },
  };
});
vi.mock("@/lib/xero-sync", () => ({
  upsertXeroObjectLink: vi.fn(async (link: Row) => {
    state.links.push(link);
    return link;
  }),
}));
vi.mock("@/lib/alert-cooldown", () => ({
  ALERT_ONCE_EVER_WINDOW_MS: 1_000_000,
  ALERT_NOBODY_ELIGIBLE_RETRY_MS: 1000,
  claimAlertCooldown: mocks.claim,
  deferAlertCooldown: vi.fn(async () => undefined),
  releaseAlertCooldown: vi.fn(async () => undefined),
}));
vi.mock("@/lib/email", () => ({ sendAdminXeroSyncErrorAlert: mocks.send }));
vi.mock("@/lib/logger", () => ({ default: { warn: mocks.warn, error: vi.fn(), info: vi.fn() } }));

import { recordCreatedRefundNote } from "@/lib/xero-refund-note-record";
import { xeroSuccessAfterResolutionAlertKey } from "@/lib/xero-success-after-resolution-alert";

const OPERATION_ID = "op-stalled";
const RESOLVED_AT = new Date("2026-07-01T00:20:00.000Z");
const LATE = {
  paymentId: "pay-1",
  operationId: OPERATION_ID,
  creditNoteId: "cn-late-b",
  creditNoteNumber: "CN-B",
  writesPointer: true,
  linkRole: "REFUND_CREDIT_NOTE",
  linkMetadata: { amountCents: 20_000, watermarkCents: 20_000 },
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

/** What "Reset stale running" and then "Resolve by hand" with note A leave (#4421). */
function resetAndResolvedWithNoteA() {
  seedRow({
    status: "FAILED", lastErrorCode: "XERO_ORPHANED_STALE_RUNNING",
    manuallyResolvedAt: RESOLVED_AT, manuallyResolvedById: "officer-1", manuallyResolvedReason: "Made the note by hand",
    xeroObjectType: "CREDIT_NOTE", xeroObjectId: "cn-hand-a", xeroObjectNumber: "CN-A",
  });
  state.links = [{ localId: "pay-1", xeroObjectId: "cn-hand-a", role: "REFUND_CREDIT_NOTE", recordedByHand: true }];
}

beforeEach(() => {
  vi.clearAllMocks();
  state.payment.xeroRefundCreditNoteId = null;
  state.links = [];
  state.held.clear();
  mocks.claim.mockImplementation(async ({ key }: { key: string }) => {
    if (state.held.has(key)) return false;
    state.held.add(key);
    return true;
  });
  mocks.send.mockResolvedValue({ deliveryAllowed: true, recipients: 1, sent: 1, queuedForRetry: 0, notDelivered: 0 });
});

describe("#4426: a refund-note create records its note only on a row not resolved by hand", () => {
  it("the claim won: the pointer, the row's note and the link are written as before, and nothing is alerted", async () => {
    seedRow();
    await expect(recordCreatedRefundNote(LATE)).resolves.toBe("recorded");
    expect(state.payment.xeroRefundCreditNoteId).toBe("cn-late-b");
    expect(state.row).toMatchObject({ status: "RUNNING", xeroObjectType: "CREDIT_NOTE", xeroObjectId: "cn-late-b", xeroObjectNumber: "CN-B" });
    expect(state.links).toEqual([
      expect.objectContaining({ localModel: "Payment", localId: "pay-1", xeroObjectId: "cn-late-b", xeroObjectNumber: "CN-B", role: "REFUND_CREDIT_NOTE", metadata: LATE.linkMetadata }),
    ]);
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it("the claim won by a note that takes no pointer (a refund request's or a per-refund note) leaves the pointer alone", async () => {
    seedRow();
    await expect(recordCreatedRefundNote({ ...LATE, writesPointer: false })).resolves.toBe("recorded");
    expect(state.payment.xeroRefundCreditNoteId).toBeNull();
    expect(state.row).toMatchObject({ xeroObjectId: "cn-late-b" });
  });

  it("the claim lost to a reset with no resolve is no claim lost: the row no claim holds records the late note (INV-INT-029)", async () => {
    seedRow({ status: "FAILED", lastErrorCode: "XERO_ORPHANED_STALE_RUNNING", startedAt: new Date("2026-07-01T00:00:00.000Z") });
    await expect(recordCreatedRefundNote(LATE)).resolves.toBe("recorded");
    expect(state.row).toMatchObject({ status: "FAILED", xeroObjectId: "cn-late-b", xeroObjectNumber: "CN-B" });
    expect(state.payment.xeroRefundCreditNoteId).toBe("cn-late-b");
    expect(state.links).toHaveLength(1);
    expect(mocks.claim).not.toHaveBeenCalled();
  });

  it("MUTATION: the claim lost to a resolve by hand writes nothing - the officer's note stays, no link, no pointer - and alerts once", async () => {
    resetAndResolvedWithNoteA();
    await expect(recordCreatedRefundNote(LATE)).resolves.toBe("resolved-by-hand");

    expect(state.row).toMatchObject({
      status: "FAILED", manuallyResolvedAt: RESOLVED_AT, xeroObjectType: "CREDIT_NOTE", xeroObjectId: "cn-hand-a", xeroObjectNumber: "CN-A",
    });
    expect(state.links).toEqual([expect.objectContaining({ xeroObjectId: "cn-hand-a" })]);
    expect(state.payment.xeroRefundCreditNoteId).toBeNull();

    expect(mocks.claim).toHaveBeenCalledWith(expect.objectContaining({ key: xeroSuccessAfterResolutionAlertKey(OPERATION_ID, "cn-late-b") }));
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({
      errorType: "XERO_SUCCESS_AFTER_RESOLUTION",
      operation: `CREATE CREDIT_NOTE for Payment pay-1 (outbox operation ${OPERATION_ID})`,
      errorMessage: expect.stringMatching(/"Resolved in Xero".*CREDIT_NOTE CN-B \(Xero id cn-late-b\).*did not record it.*CREDIT_NOTE CN-A, which the resolve recorded.*void it/),
    }));
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: OPERATION_ID, unrecordedXeroObjectId: "cn-late-b", recordedXeroObjectId: "cn-hand-a" }),
      expect.stringContaining("was not recorded"),
    );

    // A repeat of the same late note (a second holder of the row, #1354) writes nothing and sends nothing more.
    await expect(recordCreatedRefundNote(LATE)).resolves.toBe("resolved-by-hand");
    expect(state.row).toMatchObject({ xeroObjectId: "cn-hand-a" });
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it("a plain resolve that recorded no note keeps none, and the late note is still alerted, never linked", async () => {
    seedRow({ status: "FAILED", manuallyResolvedAt: RESOLVED_AT, manuallyResolvedById: "officer-1", manuallyResolvedReason: "Done in Xero" });
    await expect(recordCreatedRefundNote({ ...LATE, writesPointer: false, linkRole: "REFUND_REQUEST_CREDIT_NOTE" })).resolves.toBe("resolved-by-hand");
    expect(state.row).toMatchObject({ xeroObjectId: null, xeroObjectNumber: null });
    expect(state.links).toEqual([]);
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({ errorMessage: expect.stringContaining("the operation keeps its resolution") }));
  });

  it("keys a late note's alert by the note as well, apart from #4374's per-operation completion alert", () => {
    expect(xeroSuccessAfterResolutionAlertKey(OPERATION_ID)).toBe(`xero-success-after-resolution:${OPERATION_ID}`);
    expect(xeroSuccessAfterResolutionAlertKey(OPERATION_ID, "cn-late-b")).toBe(`xero-success-after-resolution:${OPERATION_ID}:cn-late-b`);
  });

  it("never throws into the create when the alert cannot be sent", async () => {
    resetAndResolvedWithNoteA();
    mocks.send.mockRejectedValueOnce(new Error("mail down"));
    await expect(recordCreatedRefundNote(LATE)).resolves.toBe("resolved-by-hand");
    expect(state.row).toMatchObject({ xeroObjectId: "cn-hand-a" });
  });

  it("a row that no longer exists throws, as the unguarded write before #4426 did", async () => {
    state.row = null;
    await expect(recordCreatedRefundNote(LATE)).rejects.toThrow(`Xero operation ${OPERATION_ID} was not found`);
    expect(state.links).toEqual([]);
    expect(mocks.send).not.toHaveBeenCalled();
  });
});
