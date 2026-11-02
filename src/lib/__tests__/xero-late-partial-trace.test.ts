/**
 * #4686 (`INV-INT-029`): the trace of a part-success whose attempt lost its
 * claim - stalled, reset, then queued again by an officer's Retry, withdrawn,
 * or ended by another attempt. Its Xero object is not written over the row and
 * not linked; it is re-checked, audited once per refused delivery and alerted
 * once per object, naming what did not finish, each step caught. The refused
 * write itself is pinned by `xero-sync.test.ts`, the shared skeleton's other
 * users by their own suites, and the whole path against real PostgreSQL by
 * `xero-late-failure-after-retry.realdb.test.ts`.
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

import { afterLostClaimPartial, LATE_PARTIAL_NOT_RECORDED_ACTION, partialFaultSummary, traceLostClaimPartial } from "@/lib/xero-late-partial-trace";
import { xeroClaim } from "./helpers/xero-claim";

const EARLIER = new Date("2026-06-30T23:00:00.000Z");
const partial = { claim: xeroClaim("op_late", EARLIER), xeroObjectType: "INVOICE", xeroObjectId: "inv_late", xeroObjectNumber: "INV-9", fault: null };

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
    // PR #4708 review: the stall is told once, and no raw status enum reaches an officer.
    expect(message.match(/stall/g)).toHaveLength(1);
    expect(message).toContain("Part of its work, such as a payment, an email or an allocation, was not done.");
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

  // PR #4708 review: the part that did not finish reaches the audit row and the alert.
  describe("what did not finish", () => {
    it("MUTATION: a group invoice's failed email is named in the audit metadata, its details and the alert", async () => {
      mocks.findUnique.mockResolvedValue(row({ status: "WAITING_PAYMENT" }));
      const fault = partialFaultSummary({ responsePayload: { invoice: { invoiceID: "inv_late" }, invoiceEmailError: new Error("Xero 500: the email failed") } });
      expect(fault).toBe("invoice email: Xero 500: the email failed");
      await traceLostClaimPartial({ ...partial, fault });
      const audit = mocks.audit.mock.calls[0]![0];
      expect(audit.metadata).toMatchObject({ fault: "invoice email: Xero 500: the email failed" });
      expect(audit.details).toContain("did not finish this: invoice email: Xero 500: the email failed");
      expect(audit.details).toContain("waiting for a payment");
      expect(audit.details).not.toContain("WAITING_PAYMENT");
      const message = mocks.alert.mock.calls[0]![2] as string;
      expect(message).toContain("It did not finish this: invoice email: Xero 500: the email failed.");
      expect(message).toContain("(waiting for a payment)");
      expect(message).not.toMatch(/waiting_payment|WAITING_PAYMENT/);
    });

    it("MUTATION: reads every fault key and the completion's own message, redacted and capped", () => {
      expect(
        partialFaultSummary({
          responsePayload: {
            paymentError: "card declined",
            refundPaymentError: { message: "refund refused" },
            allocationError: { code: 400 },
            emailError: "smtp down",
            invoiceEmailFailureCause: "CONFIGURATION",
          },
          lastErrorMessage: "The invoice email still failed.",
        }),
      ).toBe(
        'payment: card declined; refund payment: refund refused; allocation: {"code":400}; email: smtp down; invoice email cause: CONFIGURATION; The invoice email still failed.',
      );
      expect(partialFaultSummary({ responsePayload: { paymentError: "Bearer abcdefghijklmnopqrstuvwxyz0123456789" } })).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
      expect(partialFaultSummary({ responsePayload: { paymentError: "x".repeat(2000) } })!.length).toBe(500);
      expect(partialFaultSummary({ responsePayload: { invoice: {}, paymentError: null } })).toBeNull();
      expect(partialFaultSummary({})).toBeNull();
    });

    it("the hand-off carries the completion's fault to the trace", async () => {
      mocks.findUnique.mockResolvedValue(row());
      await afterLostClaimPartial(partial.claim, { ...partial, responsePayload: { emailError: "smtp down" } }, false);
      expect(mocks.audit.mock.calls[0]![0].metadata).toMatchObject({ fault: "email: smtp down" });
    });
  });

  // PR #4708 round 2: the email failure must reach an officer in the two likeliest race orders.
  describe("an unfinished step on an object the operation already records", () => {
    it("MUTATION: a faulted part-success is audited and alerted even when the row records its object (the queued run closed on it first)", async () => {
      mocks.findUnique.mockResolvedValue(row({ status: "SUCCEEDED", xeroObjectId: "inv_late", startedAt: new Date("2026-07-01T00:40:00.000Z") }));
      await traceLostClaimPartial({ ...partial, fault: "invoice email: Xero 500: the email failed" });
      expect(mocks.audit).toHaveBeenCalledTimes(1);
      expect(mocks.audit.mock.calls[0]![0].details).toContain("records the same item, but not the unfinished step");
      expect(mocks.alert).toHaveBeenCalledTimes(1);
      const message = mocks.alert.mock.calls[0]![2] as string;
      expect(message).toContain("It did not finish this: invoice email: Xero 500: the email failed.");
      expect(message).toContain("records this same item (succeeded)");
      expect(mocks.info).not.toHaveBeenCalled();
    });

    it("a part-success with no unfinished step still stops on the same object", async () => {
      mocks.findUnique.mockResolvedValue(row({ status: "SUCCEEDED", xeroObjectId: "inv_late" }));
      await traceLostClaimPartial(partial);
      expect(mocks.audit).not.toHaveBeenCalled();
      expect(mocks.alert).not.toHaveBeenCalled();
    });

    it("MUTATION: refused for a later claim's RUNNING row (links already recorded), it is traced only when it names an unfinished step", async () => {
      mocks.findUnique.mockResolvedValue(row({ status: "RUNNING", startedAt: new Date("2026-07-01T00:40:00.000Z") }));
      await afterLostClaimPartial(partial.claim, { ...partial }, false, true);
      expect(mocks.findUnique).not.toHaveBeenCalled();
      expect(mocks.audit).not.toHaveBeenCalled();

      await afterLostClaimPartial(partial.claim, { ...partial, responsePayload: { invoiceEmailError: "Xero 500: the email failed" } }, false, true);
      expect(mocks.audit).toHaveBeenCalledTimes(1);
      expect(mocks.alert).toHaveBeenCalledTimes(1);
      expect(mocks.alert.mock.calls[0]![2]).toContain("Another run of the operation holds it now (running)");
    });
  });

  describe("the fault summary's redaction (PR #4708 round 2)", () => {
    it("MUTATION: a part holding an email is redacted alone, keeping its label and the other parts", () => {
      const summary = partialFaultSummary({
        responsePayload: { paymentError: "card declined", invoiceEmailError: "Xero 400: bad recipient jane@example.org" },
        lastErrorMessage: "Payment reference 123456789 rejected",
      });
      expect(summary).toBe("payment: card declined; invoice email: [REDACTED]; [REDACTED]");
      expect(summary).not.toContain("jane@example.org");
    });

    it("MUTATION: redacts before it caps, so a capped email is never shown", () => {
      const summary = partialFaultSummary({ responsePayload: { paymentError: "x".repeat(495) + "jane@example.org" } });
      expect(summary).toBe("payment: [REDACTED]");
    });

    it("names a subscription invoice raised after its charge closed", () => {
      expect(partialFaultSummary({ responsePayload: { conflict: "STRAY_INVOICE_AFTER_CLOSE", invoice: {} } })).toBe(
        "stray invoice to void (its charge closed while it was raised): STRAY_INVOICE_AFTER_CLOSE",
      );
    });
  });
});
