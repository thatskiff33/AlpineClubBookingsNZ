import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  db: { adminCreditDeductionCorrection: { findUnique: vi.fn(), updateMany: vi.fn() }, adminCreditDeductionCorrectionLine: { update: vi.fn(), findMany: vi.fn() }, xeroSyncOperation: { findFirst: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() }, memberCredit: { create: vi.fn() }, $transaction: vi.fn() },
  correct: vi.fn(), untouched: vi.fn(), audit: vi.fn(), complete: vi.fn(), fail: vi.fn(), link: vi.fn(), lock: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: mocks.db }));
vi.mock("@/lib/member-credit", () => ({ lockMemberCreditLedger: mocks.lock }));
vi.mock("@/lib/xero-credit-note-correction", () => ({ correctXeroCreditNote: mocks.correct, assertXeroCreditNoteCorrectionUntouched: mocks.untouched }));
vi.mock("@/lib/audit", () => ({ createAuditLog: mocks.audit }));
vi.mock("@/lib/logger", () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/xero-sync", () => ({ completeXeroSyncOperation: mocks.complete, failXeroSyncOperation: mocks.fail, upsertXeroObjectLink: mocks.link }));
vi.mock("@/lib/club-format-server", async () => ({ clubFormatValues: async () => (await import("./support/club-format-fixture")).CLUB_FORMAT_TEST }));
import { completeAdminCreditDeductionCorrection } from "@/lib/xero-admin-credit-deduction-correction";
import { cancelAdminCreditDeductionCorrection } from "@/lib/admin-credit-deduction-cancel";
const claim = { id: "operation", startedAt: new Date("2026-07-01T00:00:00Z") };
const seenAt = new Date("2026-07-01T00:00:05Z");
/** As the real helper raises it: callers key on the name and code. */
const refusal = (code: string) => Object.assign(new Error(`${code}: refused`), { name: "XeroCreditNoteCorrectionRefusal", code });
const correction = () => ({ id: "correction", requestId: "request", memberId: "member", status: "RESERVED", providerMutationStartedAt: null, request: { amountCents: -300, description: "Mistaken grant", reviewedById: "officer" }, lines: [{ id: "line", memberCreditId: "debit", sourceMemberCreditId: "lot", xeroCreditNoteId: "note", amountCents: 300, mode: "INVOICE", xeroInvoiceId: null, xeroAllocationId: null }] });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.db.$transaction.mockImplementation(async (fn) => fn(mocks.db));
  mocks.db.adminCreditDeductionCorrection.findUnique.mockResolvedValue(correction());
  mocks.db.adminCreditDeductionCorrection.updateMany.mockResolvedValue({ count: 1 });
  mocks.db.xeroSyncOperation.findUnique.mockResolvedValue({ ...claim, status: "RUNNING", idempotencyKey: "stable" });
  mocks.db.xeroSyncOperation.findFirst.mockResolvedValue({ ...claim, status: "FAILED", idempotencyKey: "stable", updatedAt: seenAt });
  mocks.db.xeroSyncOperation.updateMany.mockResolvedValue({ count: 1 });
  mocks.correct.mockResolvedValue({ xeroInvoiceId: "invoice", xeroAllocationId: "allocation" });
  mocks.complete.mockResolvedValue({ id: "operation" });
});
describe("admin deduction completion and cancellation", () => {
  it("leaves the reserve intact when Xero fails", async () => {
    mocks.correct.mockRejectedValue(new Error("reply lost"));
    await expect(completeAdminCreditDeductionCorrection({ syncOperation: claim, payload: { queueType: "ADMIN_CREDIT_DEDUCTION_CORRECTION", correctionId: "correction" } })).rejects.toThrow("reply lost");
    expect(mocks.fail).toHaveBeenCalled();
    expect(mocks.db.memberCredit.create).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });
  it("discloses completion only after winning RESERVED to COMPLETED", async () => {
    mocks.db.adminCreditDeductionCorrection.updateMany.mockResolvedValue({ count: 0 });
    await completeAdminCreditDeductionCorrection({ syncOperation: claim, payload: { queueType: "ADMIN_CREDIT_DEDUCTION_CORRECTION", correctionId: "correction" } });
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(mocks.link).not.toHaveBeenCalled();
  });
  it("refuses cancel after a provider mutation may have started", async () => {
    mocks.db.adminCreditDeductionCorrection.findUnique.mockResolvedValue({ ...correction(), providerMutationStartedAt: claim.startedAt });
    await expect(cancelAdminCreditDeductionCorrection({ memberId: "member", correctionId: "correction", adminId: "officer" })).rejects.toThrow(/retry/i);
    expect(mocks.db.memberCredit.create).not.toHaveBeenCalled();
  });
  it("does not restore when the worker wins the operation claim during the Xero read", async () => {
    mocks.db.xeroSyncOperation.updateMany.mockResolvedValue({ count: 0 });
    await expect(cancelAdminCreditDeductionCorrection({ memberId: "member", correctionId: "correction", adminId: "officer" })).rejects.toThrow();
    expect(mocks.db.memberCredit.create).not.toHaveBeenCalled();
  });

});

const payload = { queueType: "ADMIN_CREDIT_DEDUCTION_CORRECTION" as const, correctionId: "correction" };
const run = () => completeAdminCreditDeductionCorrection({ syncOperation: claim, payload });
const cancel = () => cancelAdminCreditDeductionCorrection({ memberId: "member", correctionId: "correction", adminId: "officer", ipAddress: "127.0.0.1" });

describe("the deduction correction worker (#5241)", () => {
  it("fences before the write, records the line, then completes, links, discloses and alerts after commit", async () => {
    const alert = vi.fn();
    mocks.complete.mockResolvedValue({ id: "operation", deferredPostCommit: alert });
    mocks.db.xeroSyncOperation.findFirst.mockResolvedValue({ id: "operation" });
    mocks.db.adminCreditDeductionCorrectionLine.findMany.mockResolvedValue([{ xeroInvoiceId: "invoice" }, { xeroInvoiceId: null }]);
    mocks.correct.mockImplementation(async (input) => {
      await input.beforeMutation();
      return { xeroInvoiceId: "invoice", xeroAllocationId: "allocation" };
    });
    await run();
    expect(mocks.correct).toHaveBeenCalledWith(expect.objectContaining({
      noteId: "note", cents: 300, mode: "INVOICE", keyBase: "stable", reference: "Credit deduction request / note",
    }));
    expect(mocks.db.adminCreditDeductionCorrection.updateMany).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: { id: "correction", status: "RESERVED" }, data: { providerMutationStartedAt: expect.any(Date) },
    }));
    expect(mocks.db.adminCreditDeductionCorrectionLine.update).toHaveBeenCalledWith({
      where: { id: "line" }, data: { xeroInvoiceId: "invoice", xeroAllocationId: "allocation", completedAt: expect.any(Date) },
    });
    expect(mocks.link).toHaveBeenCalledTimes(1);
    expect(mocks.link).toHaveBeenCalledWith(expect.objectContaining({ xeroObjectId: "invoice", role: "CREDIT_DEDUCTION_CORRECTION" }), { store: mocks.db });
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: "member.credit.deduction.xero_correction.complete", targetId: "member", memberId: "officer",
      memberDisclosure: expect.objectContaining({ visibility: "member-facing", text: expect.stringContaining("Mistaken grant") }),
    }), mocks.db);
    expect(mocks.complete).toHaveBeenCalledWith(claim, {}, { store: mocks.db });
    expect(alert).toHaveBeenCalledTimes(1);
    expect(mocks.fail).not.toHaveBeenCalled();
  });

  it("skips a line Xero already confirmed and still completes", async () => {
    mocks.db.adminCreditDeductionCorrection.findUnique.mockResolvedValue({ ...correction(), lines: [{ ...correction().lines[0], completedAt: new Date() }] });
    mocks.db.adminCreditDeductionCorrectionLine.findMany.mockResolvedValue([]);
    await run();
    expect(mocks.correct).not.toHaveBeenCalled();
    expect(mocks.complete).toHaveBeenCalled();
  });

  it("writes nothing to Xero once its claim is no longer the running one", async () => {
    mocks.db.xeroSyncOperation.findUnique.mockResolvedValue({ ...claim, status: "SUCCEEDED", idempotencyKey: "stable" });
    await run();
    expect(mocks.correct).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it.each([
    ["a missing correction", () => mocks.db.adminCreditDeductionCorrection.findUnique.mockResolvedValue(null), /not found/],
    ["a cancelled correction", () => mocks.db.adminCreditDeductionCorrection.findUnique.mockResolvedValue({ ...correction(), status: "CANCELLED" }), /cancelled/],
    ["an operation with no key", () => mocks.db.xeroSyncOperation.findUnique.mockResolvedValue({ ...claim, status: "RUNNING", idempotencyKey: null }), /idempotency key/],
  ])("fails the operation for %s", async (_name, arrange, message) => {
    arrange();
    await expect(run()).rejects.toThrow(message);
    expect(mocks.correct).not.toHaveBeenCalled();
    expect(mocks.fail).toHaveBeenCalled();
  });

  it("refuses to write when the fence finds its claim lost", async () => {
    mocks.db.xeroSyncOperation.findFirst.mockResolvedValue(null);
    mocks.correct.mockImplementation(async (input) => { await input.beforeMutation(); return { xeroInvoiceId: null, xeroAllocationId: null }; });
    await expect(run()).rejects.toThrow(/lost its claim/);
    expect(mocks.db.adminCreditDeductionCorrection.updateMany).not.toHaveBeenCalledWith(expect.objectContaining({ data: { providerMutationStartedAt: expect.any(Date) } }));
  });

  it("refuses to write when a cancel won the correction first", async () => {
    mocks.db.xeroSyncOperation.findFirst.mockResolvedValue({ id: "operation" });
    mocks.db.adminCreditDeductionCorrection.updateMany.mockResolvedValue({ count: 0 });
    mocks.correct.mockImplementation(async (input) => { await input.beforeMutation(); return { xeroInvoiceId: null, xeroAllocationId: null }; });
    await expect(run()).rejects.toThrow(/no longer reserved/);
  });

  it("does not record a line once the correction left RESERVED", async () => {
    mocks.db.adminCreditDeductionCorrection.findUnique
      .mockResolvedValueOnce(correction())
      .mockResolvedValueOnce({ status: "CANCELLED" });
    await expect(run()).rejects.toThrow(/no longer reserved/);
    expect(mocks.db.adminCreditDeductionCorrectionLine.update).not.toHaveBeenCalled();
  });

  it("lifts the fence after an outright Xero refusal while no line completed", async () => {
    mocks.correct.mockRejectedValue(Object.assign(new Error("Validation"), { statusCode: 400 }));
    await expect(run()).rejects.toThrow("Validation");
    expect(mocks.db.adminCreditDeductionCorrection.updateMany).toHaveBeenCalledWith({
      where: { id: "correction", status: "RESERVED", providerMutationStartedAt: { not: null }, lines: { none: { completedAt: { not: null } } } },
      data: { providerMutationStartedAt: null },
    });
  });

  it.each([429, 408, 500])("keeps the fence after a %s, which may have landed", async (statusCode) => {
    mocks.correct.mockRejectedValue(Object.assign(new Error("busy"), { statusCode }));
    await expect(run()).rejects.toThrow("busy");
    expect(mocks.db.adminCreditDeductionCorrection.updateMany).not.toHaveBeenCalled();
  });

  const fenceLift = { where: expect.objectContaining({ providerMutationStartedAt: { not: null } }), data: { providerMutationStartedAt: null } };
  it.each([
    ["Xero's own state refused the correction before this run wrote", refusal("CORRECTION_INVOICE_CHANGED")],
    ["the call was refused before anything was sent", Object.assign(new Error("daily limit"), { name: "XeroDailyLimitError", preHttp: true })],
  ])("lifts the fence when %s, so a correction that cannot finish can be cancelled", async (_name, error) => {
    mocks.correct.mockRejectedValue(error);
    await expect(run()).rejects.toThrow(error.message);
    expect(mocks.db.adminCreditDeductionCorrection.updateMany).toHaveBeenCalledWith(fenceLift);
  });

  it("keeps the fence when Xero's state refuses after this run already wrote", async () => {
    mocks.db.xeroSyncOperation.findFirst.mockResolvedValue({ id: "operation" });
    mocks.correct.mockImplementation(async (input) => { await input.beforeMutation(); throw refusal("CORRECTION_INVOICE_CHANGED"); });
    await expect(run()).rejects.toThrow("CORRECTION_INVOICE_CHANGED");
    expect(mocks.db.adminCreditDeductionCorrection.updateMany).not.toHaveBeenCalledWith(fenceLift);
  });
});

describe("cancelling a deduction correction (#5241)", () => {
  it("restores the noteless part and each note's reserve after an untouched Xero read", async () => {
    mocks.db.adminCreditDeductionCorrection.findUnique.mockResolvedValue({ ...correction(), request: { ...correction().request, amountCents: -500 } });
    await cancel();
    expect(mocks.untouched).toHaveBeenCalledWith({ noteId: "note", mode: "INVOICE", reference: "Credit deduction request / note" });
    // The claim demands the operation exactly as it was seen before Xero was read.
    expect(mocks.db.xeroSyncOperation.updateMany).toHaveBeenCalledWith({
      where: { id: "operation", status: { in: ["PENDING", "FAILED"] }, startedAt: claim.startedAt, updatedAt: seenAt },
      data: { status: "CANCELLED", completedAt: expect.any(Date) },
    });
    expect(mocks.db.adminCreditDeductionCorrection.updateMany).toHaveBeenCalledWith({
      where: { id: "correction", status: "RESERVED", providerMutationStartedAt: null },
      data: { status: "CANCELLED", cancelledById: "officer", cancelledAt: expect.any(Date) },
    });
    const rows = mocks.db.memberCredit.create.mock.calls.map(([arg]) => arg.data);
    expect(rows).toEqual([
      expect.objectContaining({ memberId: "member", amountCents: 200, type: "ADMIN_ADJUSTMENT" }),
      expect.objectContaining({ memberId: "member", amountCents: 300, type: "ADMIN_ADJUSTMENT", xeroCreditNoteId: "note", outsideSpendConvergedAt: expect.any(Date) }),
    ]);
    expect(rows[0]).not.toHaveProperty("xeroCreditNoteId");
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "member.credit.deduction.xero_correction.cancel", ipAddress: "127.0.0.1" }), mocks.db);
  });

  it.each([
    ["is missing", () => mocks.db.adminCreditDeductionCorrection.findUnique.mockResolvedValue(null), /not found/],
    ["belongs to another member", () => mocks.db.adminCreditDeductionCorrection.findUnique.mockResolvedValue({ ...correction(), memberId: "other" }), /not found/],
    ["has already ended", () => mocks.db.adminCreditDeductionCorrection.findUnique.mockResolvedValue({ ...correction(), status: "COMPLETED" }), /already ended/],
    ["shows a change in Xero", () => mocks.untouched.mockRejectedValue(refusal("CORRECTION_ALREADY_STARTED")), /Retry it/],
    ["has no operation", () => mocks.db.xeroSyncOperation.findFirst.mockResolvedValue(null), /operation not found/],
    ["is running", () => mocks.db.xeroSyncOperation.findFirst.mockResolvedValue({ ...claim, status: "RUNNING", updatedAt: seenAt }), /is running/],
    ["ran while Xero was being read", () => mocks.db.xeroSyncOperation.updateMany.mockResolvedValue({ count: 0 }), /ran while it was being checked/],
    ["was fenced by a worker during the read", () => mocks.db.adminCreditDeductionCorrection.updateMany.mockResolvedValue({ count: 0 }), /Retry it/],
  ])("restores nothing when the correction %s", async (_name, arrange, message) => {
    arrange();
    await expect(cancel()).rejects.toThrow(message);
    expect(mocks.db.memberCredit.create).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it.each([
    ["Xero is unreachable", Object.assign(new Error("gateway timeout"), { statusCode: 504 })],
    ["the note cannot be verified", refusal("NOTE_CHANGED_IN_XERO")],
  ])("does not tell the officer to retry, which would perform the write, when %s", async (_name, error) => {
    mocks.untouched.mockRejectedValue(error);
    const failure = await cancel().catch((caught: Error) => caught);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/could not be checked just now/);
    expect((failure as Error).message).not.toMatch(/retry/i);
    expect(mocks.db.xeroSyncOperation.updateMany).not.toHaveBeenCalled();
    expect(mocks.db.memberCredit.create).not.toHaveBeenCalled();
  });
});
