import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Invoice, type CreditNote } from "xero-node";
import type { Prisma } from "@prisma/client";
const mocks = vi.hoisted(() => ({
  operation: { xeroObjectId: null as string | null, xeroObjectNumber: null as string | null, correlationKey: "scope" },
  invoice: {} as Invoice,
  note: {} as CreditNote,
  getInvoice: vi.fn(), getCreditNote: vi.fn(), createCreditNotes: vi.fn(), createCreditNoteAllocation: vi.fn(), updateInvoice: vi.fn(),
  complete: vi.fn(), start: vi.fn(), settle: vi.fn(), record: vi.fn(), retake: vi.fn(),
  updateCreditNote: vi.fn(), task: vi.fn(),
  // #4680: the claim check's read (`holdsXeroOperationClaim`) and the stand-down's trace.
  held: vi.fn(), stoodDown: vi.fn(),
  // #4701: the void's stand-down trace.
  voidStoodDown: vi.fn(),
  // Every adjustment row of the booking, oldest first: the waivers' own rows and what they reserve.
  plans: [] as { requestPayload: unknown; correlationKey?: string }[],
  // N1 fix delta: each extra's own change (default: +$50 with a $10 fee).
  modifications: {} as Record<string, { priceDiffCents: number; changeFeeCents: number }>,
}));
const transactionStore = {
  $executeRaw: vi.fn(),
  manualRefundTask: { findUnique: vi.fn(async () => null), create: mocks.task },
  payment: { findUniqueOrThrow: vi.fn(async () => ({ id: "child-payment" })) },
  xeroSyncOperation: {
    findMany: vi.fn(async () => mocks.plans),
    // A reservation's replay test: its scope, or its correlation key, already on a row.
    findFirst: vi.fn(async ({ where }: { where: { correlationKey?: string; requestPayload?: { equals: string } } }) =>
      mocks.plans.find((row) => (where.correlationKey !== undefined && row.correlationKey === where.correlationKey) ||
        (where.requestPayload !== undefined && (row.requestPayload as { scopeId?: string }).scopeId === where.requestPayload.equals)) ? { id: "row" } : null),
    update: vi.fn(),
  },
};
vi.mock("@/lib/prisma", () => ({ prisma: {
  xeroSyncOperation: { findUniqueOrThrow: vi.fn(async () => mocks.operation), findFirst: mocks.held },
  xeroObjectLink: { findMany: vi.fn(async () => []) },
  payment: { findUniqueOrThrow: vi.fn(async () => ({ id: "child-payment" })) },
  manualRefundTask: { findUniqueOrThrow: mocks.task },
  bookingModification: { findUniqueOrThrow: vi.fn(async ({ where }: { where: { id: string } }) => mocks.modifications[where.id] ?? { priceDiffCents: 5_000, changeFeeCents: 1_000 }) },
  $transaction: vi.fn(async (run: (tx: Prisma.TransactionClient) => Promise<unknown>) => run(transactionStore as unknown as Prisma.TransactionClient)),
} }));
vi.mock("@/lib/xero-api-client", () => ({
  getAuthenticatedXeroClient: vi.fn(async () => ({ xero: { accountingApi: mocks }, tenantId: "fake-tenant" })),
  callXeroApi: vi.fn(async (call: () => Promise<unknown>) => call()),
}));
vi.mock("@/lib/xero-sync", () => ({ completeXeroSyncOperation: mocks.complete, startXeroSyncOperation: mocks.start }));
vi.mock("@/lib/xero-refund-note-settlement", () => ({ settleRefundNoteFromXero: mocks.settle }));
// #4655: the note's record on the row has its own suite (`organiser-extra-note-record.test.ts`).
vi.mock("@/lib/organiser-extra-note-record", () => ({ recordCreatedOrganiserNote: mocks.record, traceOrganiserRunStoodDown: mocks.stoodDown, traceOrganiserVoidStoodDown: mocks.voidStoodDown }));
vi.mock("@/lib/xero-mappings", () => ({ getResolvedAccountMapping: vi.fn(async () => ({ code: "219" })) }));
vi.mock("@/lib/club-time-zone-runtime", () => ({ readClubTimeZoneOutsideRequest: vi.fn(async () => "Pacific/Auckland") }));

import { executeOrganiserExtraAdjustment } from "@/lib/organiser-extra-adjustment";
import { XERO_OUTBOX_ORGANISER_EXTRA_ADJUSTMENT_TYPE, type OrganiserExtraAdjustmentPayload } from "@/lib/organiser-extra-adjustment-payload";

const payload = (overrides: Partial<OrganiserExtraAdjustmentPayload> = {}): OrganiserExtraAdjustmentPayload => ({ queueType: XERO_OUTBOX_ORGANISER_EXTRA_ADJUSTMENT_TYPE, bookingId: "child", scopeId: "cut", modificationId: "increase", invoiceId: "extra", amountCents: 4_000, purpose: "waive", cashAtPlanCents: 2_000, refundPercentage: 50, ...overrides });
const claim = { id: "operation", startedAt: new Date("2026-07-01T00:00:00.000Z") };
/** The executor as the outbox runs it, its #4655 re-take hook observed. */
const execute = (input: OrganiserExtraAdjustmentPayload, operation: { id: string; startedAt: Date | null } = claim) =>
  executeOrganiserExtraAdjustment(input, operation, { onRetake: mocks.retake });

describe("organiser extra adjustment provider execution", () => {
  // The executor loads the Xero inbound graph on demand. Load it once here, so
  // no case's own budget pays for a cold import (the one flaky cold run).
  beforeAll(async () => {
    await import("@/lib/xero-inbound/invoice-paid-effects");
    await import("@/lib/xero-group-settlement-invoice-voids");
  }, 60_000);
  beforeEach(() => {
    vi.clearAllMocks();
    // Drop any once-queued answer a failed case left behind, so cases cannot leak into each other.
    for (const fn of Object.values(mocks)) if (vi.isMockFunction(fn)) fn.mockReset();
    mocks.operation = { xeroObjectId: null, xeroObjectNumber: null, correlationKey: "scope" };
    mocks.plans = [];
    mocks.modifications = {};
    mocks.start.mockImplementation(async (input: { requestPayload: unknown }) => { mocks.plans.push(input); return { id: "raced-refund" }; });
    mocks.task.mockResolvedValue({ id: "hand-back", status: "COMPLETED" });
    mocks.invoice = { invoiceID: "extra", invoiceNumber: "EXTRA-1", contact: { contactID: "organiser" }, amountPaid: 20, amountDue: 40, total: 60, status: Invoice.StatusEnum.AUTHORISED };
    mocks.note = { creditNoteID: "waiver", total: 40, allocations: [] };
    mocks.getInvoice.mockImplementation(async () => ({ body: { invoices: [mocks.invoice] } }));
    mocks.getCreditNote.mockImplementation(async () => ({ body: { creditNotes: [mocks.note] } }));
    mocks.createCreditNotes.mockImplementation(async () => ({ body: { creditNotes: [mocks.note] } }));
    mocks.record.mockImplementation(async (input: { creditNoteId: string; claim: unknown }) => { mocks.operation.xeroObjectId = input.creditNoteId; return { outcome: "claimed", claim: input.claim }; });
    mocks.createCreditNoteAllocation.mockImplementation(async () => { mocks.note.allocations = [{ invoice: { invoiceID: "extra" }, amount: 40, date: "2026-07-01" }]; return { body: {} }; });
    mocks.updateInvoice.mockResolvedValue({ body: {} });
    mocks.updateCreditNote.mockResolvedValue({ body: {} });
    mocks.held.mockResolvedValue({ id: "operation" });
    // The settlement asks its `beforePayment` before paying, as the real one does.
    mocks.settle.mockImplementation(async (input: { beforePayment?: () => Promise<boolean> }) => (input.beforePayment && !(await input.beforePayment())
      ? { stoodDown: true, outcome: { refundPaymentErr: null, refundPaymentResponseBody: null, refundPaymentSkipReason: null } }
      : { outcome: { refundPaymentErr: null, refundPaymentResponseBody: { paymentID: "bank-refund" }, refundPaymentSkipReason: null } }));
  });
  it("N4 never voids a partly-paid invoice; credits its unpaid remainder against organiser contact", async () => {
    await execute(payload(), claim);
    expect(mocks.updateInvoice).not.toHaveBeenCalled();
    expect(mocks.createCreditNotes.mock.calls[0]?.[1]).toMatchObject({ creditNotes: [{ contact: { contactID: "organiser" }, lineItems: [{ unitAmount: 40, accountCode: "219" }] }] });
    expect(mocks.createCreditNoteAllocation.mock.calls[0]?.[2]).toEqual({ allocations: [{ invoice: { invoiceID: "extra" }, amount: 40, date: "2026-07-01" }] });
  });
  it("N2 voids a wholly unpaid extra instead of raising a credit", async () => {
    mocks.invoice.amountPaid = 0;
    mocks.invoice.amountDue = 60;
    await execute(payload({ cashAtPlanCents: 0, amountCents: 6_000 }), claim);
    expect(mocks.updateInvoice).toHaveBeenCalledOnce();
    expect(mocks.updateInvoice.mock.calls[0]?.[2]).toMatchObject({ invoices: [{ invoiceID: "extra", status: "VOIDED" }] });
    expect(mocks.createCreditNotes).not.toHaveBeenCalled();
  });
  it("F3: a second waiver of an invoice an earlier waiver credited is a credit note, never a void Xero refuses", async () => {
    // The first waiver credited $30 of the unpaid $60; the second covers the other $30.
    mocks.invoice = { ...mocks.invoice, amountPaid: 0, amountCredited: 30, amountDue: 30, total: 60 };
    mocks.note = { creditNoteID: "second-waiver", total: 30, allocations: [] };
    mocks.createCreditNoteAllocation.mockImplementation(async () => ({ body: {} }));
    await execute(payload({ scopeId: "second-cut", cashAtPlanCents: 0, amountCents: 3_000 }), claim);
    expect(mocks.updateInvoice).not.toHaveBeenCalled();
    expect(mocks.createCreditNotes.mock.calls[0]?.[1]).toMatchObject({ creditNotes: [{ lineItems: [{ unitAmount: 30 }] }] });
    expect(mocks.createCreditNoteAllocation.mock.calls[0]?.[2]).toMatchObject({ allocations: [{ invoice: { invoiceID: "extra" }, amount: 30 }] });
  });
  it("a retry after allocation recovers its recorded note and records no second document or allocation", async () => {
    await execute(payload(), claim);
    await execute(payload(), claim);
    expect(mocks.createCreditNotes).toHaveBeenCalledOnce();
    expect(mocks.createCreditNoteAllocation).toHaveBeenCalledOnce();
  });
  it("a provider failure after note creation leaves its identity recorded for retry", async () => {
    mocks.createCreditNoteAllocation.mockRejectedValueOnce(new Error("connection lost"));
    await expect(execute(payload(), claim)).rejects.toThrow("connection lost");
    expect(mocks.operation.xeroObjectId).toBe("waiver");
    await execute(payload(), claim);
    expect(mocks.createCreditNotes).toHaveBeenCalledOnce();
  });
  it("refuses to act on an unreadable live cash figure", async () => {
    mocks.invoice.amountPaid = undefined;
    await expect(execute(payload(), claim)).rejects.toThrow("unreadable");
    expect(mocks.createCreditNotes).not.toHaveBeenCalled();
    expect(mocks.updateInvoice).not.toHaveBeenCalled();
  });
  /** A waiver runs with its own row on the booking, as the outbox runs it. */
  const run = async (waiver: OrganiserExtraAdjustmentPayload, operation = claim) => {
    const same = (row: { requestPayload: unknown }) => {
      const queued = row.requestPayload as OrganiserExtraAdjustmentPayload;
      return queued.purpose === waiver.purpose && queued.scopeId === waiver.scopeId && queued.modificationId === waiver.modificationId;
    };
    if (!mocks.plans.some(same)) mocks.plans.push({ requestPayload: waiver });
    await execute(waiver, operation);
  };
  const handBacks = () => mocks.task.mock.calls.map(([input]) => (input as { data: { amountCents: number } }).data.amountCents);
  const racedRows = () => mocks.plans.map((row) => row.requestPayload as OrganiserExtraAdjustmentPayload).filter((row) => row.racedPlanScopeId);
  const racedBasisCents = () => racedRows().reduce((sum, row) => sum + (row.priceBasisCents ?? 0), 0);

  it("re-reads cash after creating a waiver, shrinks it, and reserves only the new paid price at policy", async () => {
    mocks.getInvoice.mockResolvedValueOnce({ body: { invoices: [{ ...mocks.invoice }] } });
    mocks.invoice = { ...mocks.invoice, amountPaid: 30, amountDue: 30 };
    await run(payload());
    expect(mocks.updateCreditNote.mock.calls[0]?.[2]).toMatchObject({ creditNotes: [{ lineItems: [{ unitAmount: 30 }] }] });
    expect(mocks.createCreditNoteAllocation.mock.calls[0]?.[2]).toMatchObject({ allocations: [{ amount: 30 }] });
    expect(mocks.task).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ amountCents: 500, reason: expect.stringContaining("the organiser paid an extra invoice") }) }));
    expect(racedRows()).toMatchObject([{ purpose: "refund", amountCents: 500, priceBasisCents: 1_000, modificationId: "increase", racedPlanScopeId: "cut" }]);
  });
  it("N-c: a raced payment's refund rounds as the cancel's policy does, never down", async () => {
    // $10.01 of newly paid price at 50% is $5.005: the policy rounds it to $5.01.
    mocks.getInvoice.mockResolvedValueOnce({ body: { invoices: [{ ...mocks.invoice }] } });
    mocks.invoice = { ...mocks.invoice, amountPaid: 30.01, amountDue: 29.99 };
    await run(payload());
    expect(handBacks()).toEqual([501]);
  });
  it("S2: a $30 waiver of a $60 extra ($50 + $10 fee, $20 paid) frozen at 50%: the organiser's raced $40 hands back $15.00", async () => {
    // The organiser paid the remaining $40 before the waiver ran.
    mocks.invoice = { ...mocks.invoice, amountPaid: 60, amountDue: 0 };
    await run(payload({ amountCents: 3_000, cashAtPlanCents: 2_000, refundPercentage: 50 })).catch(() => undefined);
    expect(handBacks()).toEqual([1_500]);
    expect(racedRows()).toMatchObject([{ purpose: "refund", amountCents: 1_500, priceBasisCents: 3_000 }]);
  });
  it.each([
    { frozen: { planBasisCents: 10_000, fixedFeeCents: 5_000 }, handBackCents: [] },
    { frozen: {}, handBackCents: [1_250] },
  ])("N1: a 25% tier, its 5000c fee frozen with a 10000c basis or none ($frozen): 5000c of raced price hands back $handBackCents", async ({ frozen, handBackCents }) => {
    // The fee was paid at plan time; the organiser then paid the $50 price the waiver covered.
    mocks.invoice = { ...mocks.invoice, amountPaid: 60, amountDue: 0 };
    await run(payload({ amountCents: 5_000, cashAtPlanCents: 1_000, refundPercentage: 25, ...frozen })).catch(() => undefined);
    expect(handBacks()).toEqual(handBackCents);
  });
  it.each([
    { extraCents: 20_000, handBacks: [2_500, 5_000] }, // policy: (10000 + 40000) x 25% - 5000 = 7500
    { extraCents: 8_000, handBacks: [1_500] }, // policy: (10000 + 16000) x 25% - 5000 = 1500
  ])("N1 fix delta: two raced extras of $extraCents under one plan charge its 5000c fee once: hand-backs $handBacks", async ({ extraCents, handBacks: expected }) => {
    // 25% tier, $50 fee, $100 basis: the plan refunded $0, its fee unabsorbed.
    const plan = { scopeId: "cancel", refundPercentage: 25, planBasisCents: 10_000, fixedFeeCents: 5_000, planCancels: true, cashAtPlanCents: 0, amountCents: extraCents };
    const waivers = ["a", "b"].map((id) => payload({ ...plan, modificationId: `increase-${id}`, invoiceId: `extra-${id}` }));
    for (const id of ["a", "b"]) mocks.modifications[`increase-${id}`] = { priceDiffCents: extraCents, changeFeeCents: 0 };
    for (const waiver of waivers) mocks.plans.push({ requestPayload: waiver });
    for (const [index, id] of ["a", "b"].entries()) {
      // Each extra was paid in full while its waiver was queued.
      mocks.invoice = { ...mocks.invoice, invoiceID: `extra-${id}`, amountPaid: extraCents / 100, amountDue: 0, total: extraCents / 100 };
      await run(waivers[index]!, { ...claim, id: `waiver-${id}` }).catch(() => undefined);
    }
    expect(handBacks()).toEqual(expected);
    // Every raced price is recorded against the plan, a $0 hand-back included.
    expect(racedRows().every((row) => row.racedPlanScopeId === "cancel")).toBe(true);
    expect(racedBasisCents()).toBe(2 * extraCents);
  });
  describe("item 5: one $60 extra ($50 + $10 fee) waived $30 by a reduction, then $30 by a cancel", () => {
    // Policy: as if the cash had arrived before the reduction. Cash pays the fee first; the reduction then
    // refunds its covered $30 at its tier, the cancel the price left at its tier, and the fee is kept.
    const reduction = (refundPercentage = 50) => payload({ scopeId: "reduction", amountCents: 3_000, cashAtPlanCents: 0, refundPercentage });
    const cancel = (refundPercentage = 25) => payload({ scopeId: "cancel", amountCents: 3_000, cashAtPlanCents: 0, refundPercentage, planCancels: true });
    const paid = (cents: number) => { mocks.invoice = { ...mocks.invoice, amountPaid: cents / 100, amountDue: 0, status: Invoice.StatusEnum.PAID }; };
    /** Both plans' waivers queued, oldest plan first, then run in `order`. */
    const runBoth = async (order: "reduction-first" | "cancel-first", plans = { reduction: reduction(), cancel: cancel() }) => {
      for (const waiver of [plans.reduction, plans.cancel]) {
        if (!mocks.plans.some((row) => (row.requestPayload as OrganiserExtraAdjustmentPayload).scopeId === waiver.scopeId)) mocks.plans.push({ requestPayload: waiver });
      }
      const runs = order === "reduction-first" ? [plans.reduction, plans.cancel] : [plans.cancel, plans.reduction];
      for (const waiver of runs) await run(waiver, { ...claim, id: `${waiver.scopeId}-waiver` });
    };

    it.each(["reduction-first", "cancel-first"] as const)("all 6000c paid while both were queued, %s: 1500c at 50% and 500c at 25%, in plan order", async (order) => {
      paid(6_000);
      await runBoth(order);
      // Whichever waiver runs reserves both plans, oldest first.
      expect(handBacks()).toEqual([1_500, 500]);
      expect(racedRows().map((row) => [row.racedPlanScopeId, row.priceBasisCents, row.amountCents])).toEqual([["reduction", 3_000, 1_500], ["cancel", 2_000, 500]]);
    });

    it.each(["reduction-first", "cancel-first"] as const)("only 3000c paid, %s: the reduction's waiver is set against the 3000c still unpaid; the cancel hands back 2000c of price at 25%", async (order) => {
      paid(3_000);
      await runBoth(order);
      expect(handBacks()).toEqual([500]);
      expect(racedRows().map((row) => [row.racedPlanScopeId, row.priceBasisCents])).toEqual([["cancel", 2_000]]);
    });

    it("the cancel's tier higher than the reduction's, its waiver first: $7.50 at 25% and $10 at 50%", async () => {
      paid(6_000);
      await runBoth("cancel-first", { reduction: reduction(25), cancel: cancel(50) });
      expect(handBacks()).toEqual([750, 1_000]);
    });

    it("a replay reserves nothing more", async () => {
      paid(6_000);
      await runBoth("cancel-first");
      await runBoth("reduction-first");
      expect(handBacks()).toEqual([1_500, 500]);
    });

    it("a waiver re-run on more raced cash counts its own earlier raced price once", async () => {
      // $40 of the $60 paid when the $40 waiver (planned at $20 paid) first runs; all $60 when it runs again.
      mocks.invoice = { ...mocks.invoice, amountPaid: 40, amountDue: 0, status: Invoice.StatusEnum.AUTHORISED };
      await run(payload());
      paid(6_000);
      await run(payload());
      // $20 then $20 more of the waiver's $40 covered, at 50%.
      expect(handBacks()).toEqual([1_000, 1_000]);
      expect(racedBasisCents()).toBe(4_000);
    });

    it("the cancel saw the cash and its own refund was laid against the extra: the reduction's queued waiver still hands back its $15", async () => {
      // The cancel's base never held the reduction's $30 (the booking's price fell by it), so the reduction keeps its raced cash.
      mocks.plans.push({ requestPayload: reduction() });
      mocks.plans.push({ requestPayload: payload({ scopeId: "cancel", purpose: "refund", amountCents: 1_250, priceBasisCents: 5_000, cashAtPlanCents: 6_000, refundPercentage: 25, planCancels: true }) });
      paid(6_000);
      await run(reduction(), { ...claim, id: "reduction-waiver" });
      expect(handBacks()).toEqual([1_500]);
    });
  });
  it("refuses an unreadable refreshed invoice before allocating a waiver", async () => {
    mocks.getInvoice.mockResolvedValueOnce({ body: { invoices: [mocks.invoice] } }).mockResolvedValueOnce({ body: { invoices: [] } });
    await expect(execute(payload(), claim)).rejects.toThrow("unreadable");
    expect(mocks.createCreditNoteAllocation).not.toHaveBeenCalled();
    expect(mocks.operation.xeroObjectId).toBe("waiver");
  });
  it("records the created note with its number and amount under this run's claim before any allocation, and completes keeping the number (#4672 N2)", async () => {
    mocks.note = { ...mocks.note, creditNoteNumber: "CN-9" };
    await expect(execute(payload(), claim)).resolves.toBe("completed");
    expect(mocks.record).toHaveBeenCalledWith({ claim, bookingId: "child", purpose: "waive", creditNoteId: "waiver", creditNoteNumber: "CN-9", amountCents: 4_000 });
    expect(mocks.record.mock.invocationCallOrder[0]).toBeLessThan(mocks.createCreditNoteAllocation.mock.invocationCallOrder[0]!);
    expect(mocks.complete).toHaveBeenCalledWith(claim, expect.objectContaining({ xeroObjectId: "waiver", xeroObjectNumber: "CN-9" }));
    expect(mocks.retake).not.toHaveBeenCalled();
  });
  it("MUTATION (#4672 N2): a run continuing from a recorded note completes with the number the row records when Xero's read gives none", async () => {
    mocks.operation = { xeroObjectId: "waiver", xeroObjectNumber: "CN-8", correlationKey: "scope" };
    await execute(payload(), claim);
    expect(mocks.createCreditNotes).not.toHaveBeenCalled();
    expect(mocks.complete).toHaveBeenCalledWith(claim, expect.objectContaining({ xeroObjectNumber: "CN-8" }));
  });
  it("MUTATION (#4672 N2): a refund note completes with the number its settlement read", async () => {
    mocks.invoice = { ...mocks.invoice, amountDue: 0, amountCredited: 40 };
    mocks.settle.mockResolvedValueOnce({ creditNoteNumber: "CN-11", outcome: { refundPaymentErr: null, refundPaymentResponseBody: null, refundPaymentSkipReason: null } });
    await execute(payload({ purpose: "refund", amountCents: 500, handBackTaskId: "hand-back" }), claim);
    expect(mocks.complete).toHaveBeenCalledWith(claim, expect.objectContaining({ xeroObjectNumber: "CN-11" }));
  });
  // #4655: a note no row may take is traced by the record; the run stops quietly, so the
  // outbox's catch never fails the row an officer reset, resolved or queued again.
  it("MUTATION: a note not recorded stops before any allocation or payout, and throws nothing into the outbox", async () => {
    mocks.record.mockResolvedValueOnce({ outcome: "not-recorded" });
    await expect(execute(payload(), claim)).resolves.toBe("stood-down");
    expect(mocks.getCreditNote).not.toHaveBeenCalled();
    expect(mocks.createCreditNoteAllocation).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
  });
  it("a note landed on a row queued again stops: the queued run finishes from it", async () => {
    mocks.invoice = { ...mocks.invoice, amountDue: 0, amountCredited: 40 };
    mocks.record.mockResolvedValueOnce({ outcome: "queued" });
    await expect(execute(payload({ purpose: "refund", amountCents: 500, handBackTaskId: "hand-back" }), claim)).resolves.toBe("stood-down");
    expect(mocks.settle).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
  });
  // #4672 review S1/S2: the late note re-took a row a reset failed, under a fresh claim.
  const RETAKEN = { id: "operation", startedAt: new Date("2026-07-01T00:20:00.000Z") };
  const retaken = () => mocks.record.mockImplementationOnce(async (input: { creditNoteId: string }) => {
    mocks.operation.xeroObjectId = input.creditNoteId;
    return { outcome: "retaken", claim: RETAKEN };
  });
  it("MUTATION: a note that re-took a row a reset failed hands the caller the new claim before allocating, and completes under it, never the stalled claim", async () => {
    retaken();
    await expect(execute(payload(), claim)).resolves.toBe("completed");
    expect(mocks.retake).toHaveBeenCalledExactlyOnceWith(RETAKEN);
    expect(mocks.retake.mock.invocationCallOrder[0]).toBeLessThan(mocks.getCreditNote.mock.invocationCallOrder[0]!);
    expect(mocks.createCreditNoteAllocation).toHaveBeenCalledOnce();
    expect(mocks.complete).toHaveBeenCalledExactlyOnceWith(RETAKEN, expect.objectContaining({ xeroObjectId: "waiver", xeroObjectType: "CREDIT_NOTE" }));
  });
  it("MUTATION: a re-taken refund note pays out and completes under the new claim", async () => {
    mocks.invoice = { ...mocks.invoice, amountDue: 0, amountCredited: 40 };
    retaken();
    await execute(payload({ purpose: "refund", amountCents: 500, handBackTaskId: "hand-back" }), claim);
    expect(mocks.retake).toHaveBeenCalledExactlyOnceWith(RETAKEN);
    expect(mocks.settle).toHaveBeenCalledOnce();
    expect(mocks.complete).toHaveBeenCalledExactlyOnceWith(RETAKEN, expect.anything());
  });
  it("a re-taken run that then fails has already handed the caller the new claim, so the outbox fails the row under it", async () => {
    retaken();
    mocks.createCreditNoteAllocation.mockRejectedValueOnce(new Error("connection lost"));
    await expect(execute(payload(), claim)).rejects.toThrow("connection lost");
    expect(mocks.retake).toHaveBeenCalledExactlyOnceWith(RETAKEN);
    expect(mocks.complete).not.toHaveBeenCalled();
  });
  it("holds a refund until the organiser's bank-transfer hand-back completes", async () => {
    mocks.invoice = { ...mocks.invoice, amountDue: 0, amountCredited: 40 };
    mocks.task.mockResolvedValue({ status: "PENDING" });
    await expect(execute(payload({ purpose: "refund", amountCents: 500, handBackTaskId: "hand-back" }), claim)).rejects.toThrow("awaits its bank-transfer hand-back");
    expect(mocks.createCreditNotes).not.toHaveBeenCalled();
    expect(mocks.settle).not.toHaveBeenCalled();
  });
  it("waits for a failed or delayed waiver before paying the refund note", async () => {
    const refund = payload({ purpose: "refund", amountCents: 500, handBackTaskId: "hand-back" });
    await expect(execute(refund, claim)).rejects.toThrow("awaits its unpaid-balance waiver");
    expect(mocks.createCreditNotes).not.toHaveBeenCalled();
    expect(mocks.settle).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();

    mocks.invoice = { ...mocks.invoice, amountDue: 0, amountCredited: 40 };
    await execute(refund, claim);
    expect(mocks.createCreditNotes).toHaveBeenCalledOnce();
    expect(mocks.settle).toHaveBeenCalledOnce();
  });
  it("pays out a settled invoice's refund note using the completed bank-transfer record", async () => {
    mocks.invoice = { ...mocks.invoice, amountPaid: 60, amountDue: 0, status: Invoice.StatusEnum.PAID };
    await execute(payload({ purpose: "refund", amountCents: 500, cashAtPlanCents: 6_000, handBackTaskId: "hand-back" }), claim);
    expect(mocks.createCreditNotes.mock.calls[0]?.[1]).toMatchObject({ creditNotes: [{ reference: expect.stringContaining("EXTRA-1"), lineItems: [{ unitAmount: 5 }] }] });
    expect(mocks.createCreditNoteAllocation).not.toHaveBeenCalled();
    expect(mocks.settle).toHaveBeenCalledWith(expect.objectContaining({ creditNoteId: "waiver", refundMethod: "internet-banking", refundMethodRecorded: true }));
    expect(mocks.complete).toHaveBeenCalledWith(claim, expect.objectContaining({ responsePayload: expect.objectContaining({ invoiceId: "extra", amountCents: 500 }) }));
  });
  it("does not mark a failed refund-note payout complete, and retries its recorded note", async () => {
    mocks.invoice = { ...mocks.invoice, amountDue: 0, amountCredited: 40 };
    mocks.settle.mockResolvedValueOnce({ outcome: { refundPaymentErr: new Error("bank unavailable") } });
    const refund = payload({ purpose: "refund", amountCents: 500, handBackTaskId: "hand-back" });
    await expect(execute(refund, claim)).rejects.toThrow("bank unavailable");
    expect(mocks.complete).not.toHaveBeenCalled();
    await execute(refund, claim);
    expect(mocks.createCreditNotes).toHaveBeenCalledOnce();
    expect(mocks.complete).toHaveBeenCalledOnce();
  });
  describe("#4701: before voiding a wholly unpaid invoice, the waiver run checks it still holds its claim", () => {
    const unpaid = () => { mocks.invoice.amountPaid = 0; mocks.invoice.amountDue = 60; };
    const wholeWaiver = () => payload({ cashAtPlanCents: 0, amountCents: 6_000 });

    it("MUTATION: a claim lost while the invoice read stalled voids nothing, completes nothing, and is traced", async () => {
      unpaid();
      mocks.held.mockResolvedValueOnce(null);
      await expect(execute(wholeWaiver(), claim)).resolves.toBe("stood-down");
      expect(mocks.held).toHaveBeenCalledWith({ where: { id: "operation", status: "RUNNING", startedAt: claim.startedAt }, select: { id: true } });
      expect(mocks.updateInvoice).not.toHaveBeenCalled();
      expect(mocks.createCreditNotes).not.toHaveBeenCalled();
      expect(mocks.complete).not.toHaveBeenCalled();
      expect(mocks.voidStoodDown).toHaveBeenCalledExactlyOnceWith({ claim, bookingId: "child", invoiceId: "extra", invoiceNumber: "EXTRA-1", amountCents: 6_000 });
      expect(mocks.stoodDown).not.toHaveBeenCalled();
    });

    it("the claim is checked after the invoice read, immediately before the void, and a held claim voids and completes", async () => {
      unpaid();
      await expect(execute(wholeWaiver(), claim)).resolves.toBe("completed");
      expect(mocks.held).toHaveBeenCalledOnce();
      expect(mocks.held.mock.invocationCallOrder[0]).toBeGreaterThan(mocks.getInvoice.mock.invocationCallOrder.at(-1)!);
      expect(mocks.held.mock.invocationCallOrder[0]).toBeLessThan(mocks.updateInvoice.mock.invocationCallOrder[0]!);
      expect(mocks.complete).toHaveBeenCalledExactlyOnceWith(claim, { responsePayload: { voided: true, invoiceId: "extra" } });
      expect(mocks.voidStoodDown).not.toHaveBeenCalled();
    });
  });

  describe("#4680: before each money-moving call after the record, the run checks it still holds its claim", () => {
    const refund = () => payload({ purpose: "refund", amountCents: 500, handBackTaskId: "hand-back" });
    const settled = () => { mocks.invoice = { ...mocks.invoice, amountDue: 0, amountCredited: 40 }; };
    /** The claim is lost at the n-th check (1-based): a reset, then perhaps a Resolve, while the run waited on Xero. */
    const lostAt = (n: number) => { for (let i = 1; i < n; i += 1) mocks.held.mockResolvedValueOnce({ id: "operation" }); mocks.held.mockResolvedValueOnce(null); };
    const traced = (step: string, purpose = "waive") => expect(mocks.stoodDown).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ claim, bookingId: "child", purpose, creditNoteId: "waiver" }), step,
    );
    /** The re-read invoice shows $30 due now, so the $40 note is resized to $30 before it is allocated. */
    const racedPayment = () => {
      mocks.getInvoice.mockResolvedValueOnce({ body: { invoices: [{ ...mocks.invoice }] } });
      mocks.invoice = { ...mocks.invoice, amountPaid: 30, amountDue: 30 };
    };

    it("MUTATION: the allocation: a lost claim allocates nothing, completes nothing, and is traced", async () => {
      lostAt(1);
      await expect(execute(payload(), claim)).resolves.toBe("stood-down");
      expect(mocks.held).toHaveBeenCalledWith({ where: { id: "operation", status: "RUNNING", startedAt: claim.startedAt }, select: { id: true } });
      expect(mocks.createCreditNoteAllocation).not.toHaveBeenCalled();
      expect(mocks.complete).not.toHaveBeenCalled();
      traced("allocation");
    });

    it("the allocation is checked after every read, immediately before the call", async () => {
      await expect(execute(payload(), claim)).resolves.toBe("completed");
      expect(mocks.held).toHaveBeenCalledOnce();
      expect(mocks.held.mock.invocationCallOrder[0]).toBeGreaterThan(mocks.getInvoice.mock.invocationCallOrder.at(-1)!);
      expect(mocks.held.mock.invocationCallOrder[0]).toBeLessThan(mocks.createCreditNoteAllocation.mock.invocationCallOrder[0]!);
      expect(mocks.stoodDown).not.toHaveBeenCalled();
    });

    it("MUTATION: the resize: a lost claim resizes nothing and allocates nothing", async () => {
      racedPayment();
      lostAt(1);
      await expect(run(payload())).resolves.toBeUndefined();
      expect(mocks.updateCreditNote).not.toHaveBeenCalled();
      expect(mocks.createCreditNoteAllocation).not.toHaveBeenCalled();
      expect(mocks.complete).not.toHaveBeenCalled();
      traced("resize");
    });

    it("MUTATION: a claim lost between the resize and the allocation allocates nothing", async () => {
      racedPayment();
      lostAt(2);
      await run(payload());
      expect(mocks.updateCreditNote).toHaveBeenCalledOnce();
      expect(mocks.createCreditNoteAllocation).not.toHaveBeenCalled();
      expect(mocks.complete).not.toHaveBeenCalled();
      traced("allocation");
    });

    it("MUTATION: with nothing left to allocate, the completion itself waits on the claim", async () => {
      mocks.operation = { xeroObjectId: "waiver", xeroObjectNumber: "CN-8", correlationKey: "scope" };
      mocks.note = { creditNoteID: "waiver", total: 40, allocations: [{ invoice: { invoiceID: "extra" }, amount: 40, date: "2026-07-01" }] };
      lostAt(1);
      await expect(execute(payload(), claim)).resolves.toBe("stood-down");
      expect(mocks.createCreditNoteAllocation).not.toHaveBeenCalled();
      expect(mocks.complete).not.toHaveBeenCalled();
      traced("completion");
    });

    it("MUTATION: a note resized to nothing (voided) in Xero is recorded: its completion follows the void unchecked", async () => {
      // All $60 paid while the waiver waited: the $40 note is voided, and nothing is left to allocate.
      mocks.getInvoice.mockResolvedValueOnce({ body: { invoices: [{ ...mocks.invoice }] } });
      mocks.invoice = { ...mocks.invoice, amountPaid: 60, amountDue: 0, status: Invoice.StatusEnum.PAID };
      await run(payload());
      expect(mocks.updateCreditNote.mock.calls[0]?.[2]).toMatchObject({ creditNotes: [{ status: "VOIDED" }] });
      expect(mocks.held).toHaveBeenCalledOnce();
      expect(mocks.complete).toHaveBeenCalledOnce();
    });

    it("MUTATION: the settlement: a claim lost before it is never settled, paid or completed", async () => {
      settled();
      lostAt(1);
      await expect(execute(refund(), claim)).resolves.toBe("stood-down");
      expect(mocks.settle).not.toHaveBeenCalled();
      expect(mocks.complete).not.toHaveBeenCalled();
      traced("refund-payment", "refund");
    });

    it("MUTATION: the refund payment: a claim lost while the settlement read the note pays nothing and completes nothing", async () => {
      settled();
      lostAt(2);
      await expect(execute(refund(), claim)).resolves.toBe("stood-down");
      expect(mocks.held).toHaveBeenCalledTimes(2);
      expect(mocks.complete).not.toHaveBeenCalled();
      traced("refund-payment", "refund");
    });

    // #4703 review 1: the trace names the note's own amount, never what this run found due.
    it.each([
      { step: "resize", dueNow: 30, allocated: [] },
      { step: "allocation", dueNow: 40, allocated: [] },
      { step: "completion", dueNow: 0, allocated: [{ invoice: { invoiceID: "extra" }, amount: 40, date: "2026-07-01" }] },
    ])("MUTATION: a retry continuing from a recorded 4000c note that stands down at its $step names the note's 4000c, not the $dueNow dollars due now", async ({ step, dueNow, allocated }) => {
      mocks.operation = { xeroObjectId: "waiver", xeroObjectNumber: "CN-1", correlationKey: "scope" };
      mocks.note = { creditNoteID: "waiver", creditNoteNumber: "CN-1", total: 40, allocations: allocated };
      // The organiser paid since the note was raised: this run's due is less than the note.
      mocks.invoice = { ...mocks.invoice, amountPaid: 60 - dueNow - (allocated.length ? 40 : 0), amountCredited: allocated.length ? 40 : 0, amountDue: dueNow };
      lostAt(1);
      await expect(run(payload())).resolves.toBeUndefined();
      expect(mocks.createCreditNotes).not.toHaveBeenCalled();
      expect(mocks.stoodDown).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ creditNoteId: "waiver", creditNoteNumber: "CN-1", amountCents: 4_000 }), step);
      expect(mocks.complete).not.toHaveBeenCalled();
    });

    // #4703 review 2: a settlement that returns before its payment asked nothing after its note read.
    const settledByHand = () => mocks.settle.mockImplementationOnce(async () => ({
      creditNoteNumber: "CN-1", outcome: { refundPaymentErr: null, refundPaymentResponseBody: { paymentID: "officer-payment" }, refundPaymentSkipReason: null, payments: [] },
    }));
    it("MUTATION: a refund note Xero already shows settled (an officer paid it by hand) completes only while the run holds its claim", async () => {
      settled();
      settledByHand();
      lostAt(2);
      await expect(execute(refund(), claim)).resolves.toBe("stood-down");
      expect(mocks.complete).not.toHaveBeenCalled();
      traced("completion", "refund");
      expect(mocks.stoodDown).toHaveBeenCalledWith(expect.objectContaining({ amountCents: 500 }), "completion");
    });
    it("a refund note settled without the app's payment, the claim held, completes after the second check", async () => {
      settled();
      settledByHand();
      await expect(execute(refund(), claim)).resolves.toBe("completed");
      expect(mocks.held).toHaveBeenCalledTimes(2);
      expect(mocks.held.mock.invocationCallOrder[1]).toBeLessThan(mocks.complete.mock.invocationCallOrder[0]!);
    });
    it("a refund note the settlement paid is not checked again before completing: its payment asked last", async () => {
      settled();
      await expect(execute(refund(), claim)).resolves.toBe("completed");
      expect(mocks.held).toHaveBeenCalledTimes(2);
      expect(mocks.complete).toHaveBeenCalledOnce();
    });

    it("a re-taken run checks its new claim, never the stalled one", async () => {
      retaken();
      await execute(payload(), claim);
      expect(mocks.held).toHaveBeenCalledExactlyOnceWith({ where: { id: "operation", status: "RUNNING", startedAt: RETAKEN.startedAt }, select: { id: true } });
      expect(mocks.complete).toHaveBeenCalledExactlyOnceWith(RETAKEN, expect.anything());
    });
  });
});
