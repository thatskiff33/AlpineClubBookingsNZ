import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  db: { adminCreditDeductionCorrection: { findUnique: vi.fn(), updateMany: vi.fn() }, adminCreditDeductionCorrectionLine: { update: vi.fn() }, xeroSyncOperation: { findFirst: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() }, memberCredit: { create: vi.fn() }, $transaction: vi.fn() },
  correct: vi.fn(), untouched: vi.fn(), audit: vi.fn(), complete: vi.fn(), fail: vi.fn(), link: vi.fn(), lock: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: mocks.db }));
vi.mock("@/lib/member-credit", () => ({ lockMemberCreditLedger: mocks.lock }));
vi.mock("@/lib/xero-credit-note-correction", () => ({ correctXeroCreditNote: mocks.correct, assertXeroCreditNoteCorrectionUntouched: mocks.untouched }));
vi.mock("@/lib/audit", () => ({ createAuditLog: mocks.audit }));
vi.mock("@/lib/xero-sync", () => ({ completeXeroSyncOperation: mocks.complete, failXeroSyncOperation: mocks.fail, upsertXeroObjectLink: mocks.link }));
vi.mock("@/lib/club-format-server", () => ({ clubFormatValues: async () => ({ locale: "en-NZ", currency: "NZD", timeZone: "Pacific/Auckland" }) }));
import { completeAdminCreditDeductionCorrection } from "@/lib/xero-admin-credit-deduction-correction";
import { cancelAdminCreditDeductionCorrection } from "@/lib/admin-credit-deduction-cancel";
const claim = { id: "operation", startedAt: new Date("2026-07-01T00:00:00Z") };
const correction = () => ({ id: "correction", requestId: "request", memberId: "member", status: "RESERVED", providerMutationStartedAt: null, request: { amountCents: -300, description: "Mistaken grant", reviewedById: "officer" }, lines: [{ id: "line", memberCreditId: "debit", sourceMemberCreditId: "lot", xeroCreditNoteId: "note", amountCents: 300, mode: "INVOICE", xeroInvoiceId: null, xeroAllocationId: null }] });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.db.$transaction.mockImplementation(async (fn) => fn(mocks.db));
  mocks.db.adminCreditDeductionCorrection.findUnique.mockResolvedValue(correction());
  mocks.db.adminCreditDeductionCorrection.updateMany.mockResolvedValue({ count: 1 });
  mocks.db.xeroSyncOperation.findUnique.mockResolvedValue({ ...claim, status: "RUNNING", idempotencyKey: "stable" });
  mocks.db.xeroSyncOperation.findFirst.mockResolvedValue({ ...claim, status: "FAILED", idempotencyKey: "stable" });
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
