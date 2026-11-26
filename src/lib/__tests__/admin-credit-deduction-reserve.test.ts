import { beforeEach, describe, expect, it, vi } from "vitest";
import { CreditType, type Prisma } from "@prisma/client";
import { matchesWhere } from "./support/prisma-where";
import { reserveNotedCreditDeduction } from "@/lib/admin-credit-deduction-reserve";

const queue = vi.hoisted(() => vi.fn());
vi.mock("@/lib/xero-sync", () => ({
  startXeroSyncOperation: queue,
  buildXeroIdempotencyKey: (...parts: unknown[]) => parts.join(":"),
}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));

type Row = Record<string, unknown> & { id: string; amountCents: number };
const request = { id: "request", memberId: "member", amountCents: -600, description: "Correct mistaken grant", requestedById: "requester", approvedById: "approver" };
function credit(id: string, amountCents: number, fields: Record<string, unknown> = {}): Row {
  return { id, amountCents, memberId: "member", type: CreditType.ADMIN_ADJUSTMENT, xeroCreditNoteId: null,
    xeroCashCreditId: null, openingCreditBatchId: null, openingCreditBatch: null, outsideSpendConvergedAt: null, ...fields };
}
function store(initial: Row[], allocated: Row[] = [], queued: Row[] = []) {
  const credits = [...initial];
  const lines: Row[] = [];
  const corrections: Row[] = [];
  const selectRows = (rows: Row[], where: unknown) => rows.filter((row) => matchesWhere(row, where));
  const group = (rows: Row[], by: string[], where: unknown) => {
    const grouped = new Map<string, Row[]>();
    for (const row of selectRows(rows, where)) {
      const key = JSON.stringify(by.map((field) => row[field]));
      grouped.set(key, [...(grouped.get(key) ?? []), row]);
    }
    return [...grouped.values()].map((members) => ({ ...Object.fromEntries(by.map((key) => [key, members[0]?.[key]])), _sum: { amountCents: members.reduce((sum, row) => sum + row.amountCents, 0) } }));
  };
  const db = {
    memberCredit: {
      findMany: async ({ where }: { where: unknown }) => selectRows(credits, where),
      aggregate: async ({ where }: { where: unknown }) => ({ _sum: { amountCents: selectRows(credits, where).reduce((sum, row) => sum + row.amountCents, 0) } }),
      groupBy: async ({ by, where }: { by: string[]; where: unknown }) => group(credits, by, where),
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = credit(`reserved-${credits.length}`, Number(data.amountCents), data);
        credits.push(row);
        return row;
      },
    },
    memberCreditNoteAllocation: {
      findMany: async ({ where }: { where: unknown }) => selectRows(allocated, where),
      groupBy: async ({ by, where }: { by: string[]; where: unknown }) => group(allocated, by, where),
    },
    xeroSyncOperation: { findFirst: async ({ where }: { where: unknown }) => selectRows(queued, where)[0] ?? null },
    adminCreditDeductionCorrection: { create: async ({ data }: { data: Record<string, unknown> }) => {
      const row = { id: `correction-${corrections.length}`, amountCents: 0, ...data }; corrections.push(row); return row;
    } },
    adminCreditDeductionCorrectionLine: { create: async ({ data }: { data: Record<string, unknown> }) => {
      const row = { id: `line-${lines.length}`, amountCents: Number(data.amountCents), ...data }; lines.push(row); return row;
    } },
  };
  return { db: db as unknown as Prisma.TransactionClient, credits, lines, corrections };
}

beforeEach(() => queue.mockReset());
describe("reserveNotedCreditDeduction", () => {
  it("reserves noted cents with write-down markers and one outbox operation", async () => {
    const state = store([credit("lot", 1000, { xeroCreditNoteId: "note" })]);
    const result = await reserveNotedCreditDeduction(state.db, request);
    expect(result.correctionId).toBe("correction-0");
    expect(state.credits[1]).toMatchObject({ amountCents: -600, xeroCreditNoteId: "note", approvalRequestId: "request", outsideSpendConvergedAt: expect.any(Date) });
    expect(state.lines[0]).toMatchObject({ memberCreditId: "reserved-1", sourceMemberCreditId: "lot", mode: "INVOICE" });
    expect(queue).toHaveBeenCalledOnce();
    expect(queue).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: "admin-credit-deduction:request:credit-note-correction:600:v1" }));
  });
  it("permits repeated partial deductions without reusing the unique reservation row", async () => {
    const state = store([credit("lot", 1000, { xeroCreditNoteId: "note" })]);
    await reserveNotedCreditDeduction(state.db, { ...request, amountCents: -400 });
    await reserveNotedCreditDeduction(state.db, { ...request, id: "request-2", amountCents: -300 });
    expect(state.lines.map((row) => row.memberCreditId)).toEqual(["reserved-1", "reserved-2"]);
    expect(state.credits.reduce((sum, row) => sum + row.amountCents, 0)).toBe(300);
  });
  it("does not restore already deducted noteless credit to the available pool", async () => {
    const state = store([credit("legacy", 500), credit("old-deduction", -500), credit("noted", 1000, { xeroCreditNoteId: "note" })]);
    await reserveNotedCreditDeduction(state.db, request);
    expect(state.credits[3]).toMatchObject({ xeroCreditNoteId: "note", amountCents: -600 });
  });
  it("plain legacy deductions need no correction", async () => {
    const state = store([credit("legacy", 1000)]);
    const result = await reserveNotedCreditDeduction(state.db, request);
    expect(result.correctionId).toBeNull();
    expect(state.credits[1]).toMatchObject({ amountCents: -600, outsideSpendConvergedAt: null });
    expect(queue).not.toHaveBeenCalled();
  });
  it("refuses while a grant note is queued", async () => {
    const state = store([credit("grant", 1000)], [], [{ id: "operation", amountCents: 0, localModel: "MemberCredit", localId: "grant", queueType: "ADMIN_GRANT_CREDIT_NOTE", status: "PENDING" }]);
    await expect(reserveNotedCreditDeduction(state.db, request)).rejects.toThrow(/approve once/);
    expect(state.credits).toHaveLength(1);
  });
  it("does not deduct more than the free part of a partly-spent note", async () => {
    const state = store([credit("lot", 1000, { xeroCreditNoteId: "note" }), credit("booking", -500)], [{ id: "slice", amountCents: 500, memberCreditId: "lot" }]);
    await expect(reserveNotedCreditDeduction(state.db, request)).rejects.toThrow(/balance/);
    expect(state.lines).toHaveLength(0);
  });
  it("refuses cash backing rather than disguising it as a noteless deduction", async () => {
    const state = store([credit("cash", 1000, { xeroCashCreditId: "cash-document" })]);
    await expect(reserveNotedCreditDeduction(state.db, request)).rejects.toThrow(/overpayment|prepayment/);
    expect(state.credits).toHaveLength(1);
  });
});
