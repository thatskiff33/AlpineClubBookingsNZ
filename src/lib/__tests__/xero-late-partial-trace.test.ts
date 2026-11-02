/**
 * #4686 (`INV-INT-029`): the trace of a part-success whose attempt lost its
 * claim - stalled, reset, then queued again by an officer's Retry, withdrawn,
 * or ended by another attempt. Its Xero object is not written over the row and
 * not linked; it is re-checked, audited once and alerted once per object, each
 * step caught. The refused write itself is pinned by `xero-sync.test.ts`, and
 * the whole path against real PostgreSQL by
 * `xero-late-cancelled-partial-after-retry.realdb.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { XeroSyncOperation } from "@prisma/client";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  audit: vi.fn(),
  alert: vi.fn(),
  send: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: { xeroSyncOperation: { findUnique: mocks.findUnique } } }));
vi.mock("@/lib/audit", () => ({ createAuditLog: mocks.audit }));
vi.mock("@/lib/logger", () => ({ default: { warn: mocks.warn, error: mocks.error, info: mocks.info } }));
vi.mock("@/lib/xero-success-after-resolution-alert", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/xero-success-after-resolution-alert")),
  unrecordedLateSuccessAlert: mocks.alert,
}));

import { afterLostClaimPartial, LATE_PARTIAL_NOT_RECORDED_ACTION, traceLostClaimPartial } from "@/lib/xero-late-partial-trace";
import { xeroClaim } from "./helpers/xero-claim";

const EARLIER = new Date("2026-06-30T23:00:00.000Z");
const partial = { claim: xeroClaim("op_late", EARLIER), xeroObjectType: "INVOICE", xeroObjectId: "inv_late", xeroObjectNumber: "INV-9" };

function row(fields: Partial<XeroSyncOperation> = {}): XeroSyncOperation {
  return {
    id: "op_late", status: "PENDING", startedAt: null, xeroObjectId: null, manuallyResolvedAt: null, manuallyResolvedReason: null,
    operationType: "CREATE", entityType: "INVOICE", localModel: "Payment", localId: "pay_1",
    ...fields,
  } as XeroSyncOperation;
}

describe("a part-success that lost its claim is traced, never recorded (#4686)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.alert.mockReturnValue(mocks.send);
    mocks.send.mockResolvedValue(undefined);
    mocks.audit.mockResolvedValue(undefined);
  });

  it("MUTATION: on the Retry's PENDING row, writes one `xero` audit row and alerts once for the object", async () => {
    const queued = row();
    mocks.findUnique.mockResolvedValue(queued);
    await traceLostClaimPartial(partial);
    expect(mocks.audit).toHaveBeenCalledTimes(1);
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "xero.operation.late_partial_not_recorded",
        entityType: "XeroSyncOperation",
        entityId: "op_late",
        category: "xero",
        severity: "important",
        outcome: "blocked",
        metadata: expect.objectContaining({ xeroObjectId: "inv_late", rowStatus: "PENDING", claimStartedAt: EARLIER.toISOString(), recordedXeroObjectId: null }),
      }),
    );
    expect(LATE_PARTIAL_NOT_RECORDED_ACTION).toBe("xero.operation.late_partial_not_recorded");
    expect(mocks.alert).toHaveBeenCalledTimes(1);
    const [alertRow, late, message, warning] = mocks.alert.mock.calls[0]!;
    expect(alertRow).toBe(queued);
    expect(late).toEqual({ xeroObjectType: "INVOICE", xeroObjectId: "inv_late", xeroObjectNumber: "INV-9" });
    expect(message).toContain("invoice INV-9");
    expect(message).toContain("queued to run again");
    expect(warning).toContain("#4686");
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it("names the resolution when the row was resolved by hand", async () => {
    mocks.findUnique.mockResolvedValue(row({ status: "FAILED", manuallyResolvedAt: new Date("2026-07-01T00:00:00.000Z"), manuallyResolvedReason: "Fixed in Xero" }));
    await traceLostClaimPartial(partial);
    expect(mocks.audit.mock.calls[0]![0].details).toContain("resolved by hand");
    expect(mocks.alert.mock.calls[0]![2]).toContain("stays marked");
  });

  it("MUTATION: a row that records this very object needs nothing: no audit row, no alert", async () => {
    mocks.findUnique.mockResolvedValue(row({ status: "SUCCEEDED", xeroObjectId: "inv_late" }));
    await traceLostClaimPartial(partial);
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(mocks.alert).not.toHaveBeenCalled();
    expect(mocks.info).toHaveBeenCalledWith(expect.objectContaining({ xeroObjectId: "inv_late" }), expect.stringContaining("#4686"));
  });

  it("a row gone since is audited, not alerted", async () => {
    mocks.findUnique.mockResolvedValue(null);
    await traceLostClaimPartial(partial);
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ rowFound: false }) }));
    expect(mocks.alert).not.toHaveBeenCalled();
    expect(mocks.error).toHaveBeenCalledWith(expect.anything(), expect.stringContaining("row is gone"));
  });

  it("each step is caught: an unreadable row, a failed audit row and a failed alert never throw", async () => {
    mocks.findUnique.mockRejectedValueOnce(new Error("db down"));
    await expect(traceLostClaimPartial(partial)).resolves.toBeUndefined();
    expect(mocks.audit).not.toHaveBeenCalled();

    mocks.findUnique.mockResolvedValue(row());
    mocks.audit.mockRejectedValueOnce(new Error("audit failed"));
    await expect(traceLostClaimPartial(partial)).resolves.toBeUndefined();
    expect(mocks.alert).toHaveBeenCalledTimes(1);

    mocks.send.mockRejectedValueOnce(new Error("smtp down"));
    await expect(traceLostClaimPartial(partial)).resolves.toBeUndefined();
    expect(mocks.error).toHaveBeenCalledWith(expect.anything(), expect.stringContaining("alert failed"));
  });

  describe("the hand-off after the refused write", () => {
    const object = { xeroObjectType: "INVOICE", xeroObjectId: "inv_late", xeroObjectNumber: "INV-9" };

    it("traces the object after commit", async () => {
      mocks.findUnique.mockResolvedValue(row());
      await afterLostClaimPartial(partial.claim, object, false);
      expect(mocks.findUnique).toHaveBeenCalledWith({ where: { id: "op_late" } });
      expect(mocks.audit).toHaveBeenCalledTimes(1);
      expect(mocks.alert).toHaveBeenCalledTimes(1);
    });

    it("MUTATION: inside a caller's own transaction, only logs the object: no read, audit row or alert before that commit", async () => {
      await afterLostClaimPartial(partial.claim, object, true);
      expect(mocks.findUnique).not.toHaveBeenCalled();
      expect(mocks.audit).not.toHaveBeenCalled();
      expect(mocks.alert).not.toHaveBeenCalled();
      expect(mocks.error).toHaveBeenCalledWith(expect.objectContaining({ xeroObjectId: "inv_late" }), expect.stringContaining("caller's transaction"));
    });

    it("MUTATION: a part-success naming no Xero object made nothing to trace", async () => {
      await afterLostClaimPartial(partial.claim, { xeroObjectId: null }, false);
      expect(mocks.findUnique).not.toHaveBeenCalled();
      expect(mocks.error).not.toHaveBeenCalled();
    });
  });
});
