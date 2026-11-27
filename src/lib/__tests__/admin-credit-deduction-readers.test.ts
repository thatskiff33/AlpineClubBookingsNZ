import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ findMany: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { adminCreditDeductionCorrection: { findMany: mocks.findMany } } }));

import {
  adminCreditDeductionReference,
  buildAdminCreditDeductionPayload,
  readAdminCreditDeductionPayload,
} from "@/lib/admin-credit-deduction-payload";
import { getPendingCreditDeductionCorrections } from "@/lib/admin-credit-deduction-queries";
import {
  noteHasOpenDeductionCorrection,
  notesWithOpenDeductionCorrection,
  noteVoidedByDeductionCorrection,
} from "@/lib/admin-credit-deduction-note-guard";

beforeEach(() => vi.resetAllMocks());

describe("the deduction correction payload (#5241)", () => {
  it("round-trips its queue type and correction id", () => {
    const payload = buildAdminCreditDeductionPayload({ correctionId: "c1" });
    expect(payload).toEqual({ queueType: "ADMIN_CREDIT_DEDUCTION_CORRECTION", correctionId: "c1" });
    expect(readAdminCreditDeductionPayload(JSON.parse(JSON.stringify(payload)))).toEqual(payload);
  });

  it.each([null, "text", {}, { queueType: "ADMIN_CREDIT_GRANT_NOTE", correctionId: "c1" }, { queueType: "ADMIN_CREDIT_DEDUCTION_CORRECTION" }, { queueType: "ADMIN_CREDIT_DEDUCTION_CORRECTION", correctionId: "" }])(
    "reads %j as no payload",
    (value) => expect(readAdminCreditDeductionPayload(value)).toBeNull(),
  );

  it("names the Xero reference from the request and note ids only", () => {
    expect(adminCreditDeductionReference("req", "note")).toBe("Credit deduction req / note");
  });
});

describe("the officers' pending corrections list (#5241)", () => {
  it("lists RESERVED corrections oldest first with their request's cents and reason", async () => {
    const createdAt = new Date("2026-07-01T00:00:00.000Z");
    mocks.findMany.mockResolvedValue([{ id: "c1", requestId: "r1", createdAt, request: { amountCents: -2500, description: "Granted in error" } }]);
    await expect(getPendingCreditDeductionCorrections("m1")).resolves.toEqual([
      { id: "c1", requestId: "r1", createdAt, amountCents: -2500, description: "Granted in error" },
    ]);
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { memberId: "m1", status: "RESERVED" }, orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }));
  });
});

describe("the one open-correction note guard (#5241, INV-SSOT)", () => {
  const db = () => ({ adminCreditDeductionCorrectionLine: { findMany: vi.fn(), findFirst: vi.fn() } });

  it("reads no rows for no notes", async () => {
    const store = db();
    await expect(notesWithOpenDeductionCorrection(store as never, [])).resolves.toEqual(new Set());
    expect(store.adminCreditDeductionCorrectionLine.findMany).not.toHaveBeenCalled();
  });

  it("names the notes whose correction is still RESERVED", async () => {
    const store = db();
    store.adminCreditDeductionCorrectionLine.findMany.mockResolvedValue([{ xeroCreditNoteId: "n1" }]);
    await expect(noteHasOpenDeductionCorrection(store as never, "n1")).resolves.toBe(true);
    expect(store.adminCreditDeductionCorrectionLine.findMany).toHaveBeenCalledWith({
      where: { xeroCreditNoteId: { in: ["n1"] }, correction: { status: "RESERVED" } }, select: { xeroCreditNoteId: true },
    });
    store.adminCreditDeductionCorrectionLine.findMany.mockResolvedValue([]);
    await expect(noteHasOpenDeductionCorrection(store as never, "n2")).resolves.toBe(false);
  });

  it("treats only a COMPLETED VOID line as the app's own void", async () => {
    const store = db();
    store.adminCreditDeductionCorrectionLine.findFirst.mockResolvedValueOnce({ id: "l1" }).mockResolvedValueOnce(null);
    await expect(noteVoidedByDeductionCorrection(store as never, "n1")).resolves.toBe(true);
    await expect(noteVoidedByDeductionCorrection(store as never, "n2")).resolves.toBe(false);
    expect(store.adminCreditDeductionCorrectionLine.findFirst).toHaveBeenCalledWith({
      where: { xeroCreditNoteId: "n1", mode: "VOID", correction: { status: "COMPLETED" } }, select: { id: true },
    });
  });
});
