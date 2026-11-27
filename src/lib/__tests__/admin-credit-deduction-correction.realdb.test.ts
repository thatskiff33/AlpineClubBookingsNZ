/**
 * Real-PostgreSQL proof for #5241: an officer's deduction of credit that has a
 * Xero credit note reserves the cents under the member's credit-ledger lock and
 * corrects the note through the outbox handler, against the stateful Xero fake.
 * After completion the app's free credit on the note equals Xero's remaining
 * credit to the cent; a failure part-way keeps the cents reserved; a retry after
 * a lost reply applies the correction once; and racing writers leave one outcome.
 *
 *   RUN_CONCURRENCY_RACE_TESTS=1 \
 *   CONCURRENCY_RACE_DATABASE_URL=postgresql://user:pass@127.0.0.1:55442/concurrency_race_1881 \
 *   pnpm exec vitest run src/lib/__tests__/admin-credit-deduction-correction.realdb.test.ts
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CreditNote, LineAmountTypes } from "xero-node";
import { XeroFake } from "@/test/providers/xero-fake";
import { xeroTransport } from "@/test/providers/xero-transport";
import { assertSafeRaceDbUrl } from "./support/race-db-url";
import type { SuiteEnvironmentRoleDeclaration } from "./helpers/environment-role";

vi.mock("@/lib/xero-api-usage", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/xero-api-usage")),
  recordXeroApiUsage: async () => undefined,
  xeroDailyBudgetAllowsDeferrableCall: async () => true,
}));

// The approval kicks the outbox after commit; each test runs the worker itself instead.
vi.mock("@/lib/xero-operation-outbox", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/xero-operation-outbox")),
  kickQueuedXeroOutboxOperationsIfConnected: async () => undefined,
}));

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";
const MEMBER = "race-5241-member";
const REQUESTER = "race-5241-requester";
const APPROVER = "race-5241-approver";
const SECOND_APPROVER = "race-5241-approver-2";
const PEOPLE = [MEMBER, REQUESTER, APPROVER, SECOND_APPROVER];

let db: (typeof import("@/lib/prisma"))["prisma"];
let credit: typeof import("@/lib/member-credit");
let worker: typeof import("@/lib/xero-admin-credit-deduction-correction");
let cancel: typeof import("@/lib/admin-credit-deduction-cancel");
let lots: typeof import("@/lib/xero-applied-credit-lots");
let mirror: typeof import("@/lib/xero-credit-note-mirror");
let claim: typeof import("@/lib/xero-operation-claim");
let override: typeof import("@/lib/xero-test-client-override");
let resetRateLimits: () => void;
let harnessRole: SuiteEnvironmentRoleDeclaration | undefined;

(RUN ? describe : describe.skip)("#5241: deducting credit that has a Xero note - real PostgreSQL", { timeout: 60_000 }, () => {
  let fake: XeroFake;
  let session: ReturnType<typeof xeroTransport>;
  let contactId: string;
  let sequence = 0;

  async function clean() {
    const corrections = await db.adminCreditDeductionCorrection.findMany({ where: { memberId: MEMBER }, select: { id: true } });
    const ids = corrections.map((c) => c.id);
    await db.adminCreditDeductionCorrectionLine.deleteMany({ where: { correctionId: { in: ids } } });
    await db.xeroObjectLink.deleteMany({ where: { localModel: "AdminCreditDeductionCorrection", localId: { in: ids } } });
    await db.xeroSyncOperation.deleteMany({ where: { localModel: "AdminCreditDeductionCorrection", localId: { in: ids } } });
    await db.adminCreditDeductionCorrection.deleteMany({ where: { id: { in: ids } } });
    await db.memberCredit.deleteMany({ where: { memberId: MEMBER } });
    await db.adminCreditAdjustmentRequest.deleteMany({ where: { memberId: MEMBER } });
    await db.xeroSyncCursor.deleteMany({ where: { resourceType: mirror.CREDIT_NOTE_MIRROR_CURSOR_RESOURCE } });
    await db.auditLog.deleteMany({ where: { OR: [{ memberId: { in: PEOPLE } }, { targetId: MEMBER }, { subjectMemberId: MEMBER }] } });
    await db.member.deleteMany({ where: { id: { in: PEOPLE } } });
  }

  /** A member holding one approved grant whose Xero note (100.00) already exists. */
  async function seedNotedGrant(cents = 10_000) {
    await clean();
    await db.member.createMany({
      data: PEOPLE.map((id) => ({ id, email: `${id}@example.invalid`, passwordHash: "x", firstName: id, lastName: "Race", role: id === MEMBER ? "USER" : "ADMIN", ageTier: "ADULT" })),
    });
    contactId = fake.createContact(`contact-${++sequence}`, "Member Race").contactID;
    const response = await session.xero.accountingApi.createCreditNotes(session.tenantId, { creditNotes: [{
      type: CreditNote.TypeEnum.ACCRECCREDIT, status: CreditNote.StatusEnum.AUTHORISED,
      contact: { contactID: contactId }, lineAmountTypes: LineAmountTypes.Inclusive,
      lineItems: [{ description: "Grant", quantity: 1, unitAmount: cents / 100, accountCode: "400", taxType: "OUTPUT2" }],
    }] });
    const noteId = response.body.creditNotes![0]!.creditNoteID!;
    const lot = await db.memberCredit.create({ data: { memberId: MEMBER, amountCents: cents, type: "ADMIN_ADJUSTMENT", description: "Grant", xeroCreditNoteId: noteId } });
    return { noteId, lotId: lot.id };
  }

  async function approvedDeduction(cents: number, approver = APPROVER) {
    const { request } = await credit.createAdminAdjustmentRequest(MEMBER, -cents, "Granted by mistake", REQUESTER, `key-${++sequence}`, null);
    return credit.reviewAdminAdjustmentRequest(MEMBER, request.id, "APPROVE", approver);
  }

  /** One outbox pass over the correction's operation, as the queue runs it. */
  async function runWorker(correctionId: string) {
    const operation = await db.xeroSyncOperation.findFirstOrThrow({ where: { localModel: "AdminCreditDeductionCorrection", localId: correctionId } });
    if (operation.status === "FAILED") await db.xeroSyncOperation.update({ where: { id: operation.id }, data: { status: "PENDING" } });
    const claimed = await claim.claimXeroSyncOperationToRunning(operation.id, { direction: "OUTBOUND" });
    if (!claimed) throw new Error("operation not claimable");
    await worker.completeAdminCreditDeductionCorrection({ syncOperation: claimed, payload: { queueType: "ADMIN_CREDIT_DEDUCTION_CORRECTION", correctionId } });
  }

  const freeOnNote = async (noteId: string) =>
    (await lots.loadFreeCreditLots(db, [MEMBER])).get(MEMBER)!.lots.filter((l) => l.xeroCreditNoteId === noteId).reduce((sum, l) => sum + l.remainingCents, 0);
  const xeroNote = (noteId: string) => fake.snapshot().creditNotes.find((n) => n.creditNoteID === noteId)!;
  const correctionOf = async (requestId: string) => db.adminCreditDeductionCorrection.findUniqueOrThrow({ where: { requestId }, include: { lines: true } });

  beforeAll(async () => {
    assertSafeRaceDbUrl(DB_URL, "Credit deduction correction");
    process.env.DATABASE_URL = DB_URL;
    ({ prisma: db } = await import("@/lib/prisma"));
    const { declareEnvironmentRoleForSuite } = await import("./helpers/environment-role");
    harnessRole = declareEnvironmentRoleForSuite("non-production");
    credit = await import("@/lib/member-credit");
    worker = await import("@/lib/xero-admin-credit-deduction-correction");
    cancel = await import("@/lib/admin-credit-deduction-cancel");
    lots = await import("@/lib/xero-applied-credit-lots");
    mirror = await import("@/lib/xero-credit-note-mirror");
    claim = await import("@/lib/xero-operation-claim");
    override = await import("@/lib/xero-test-client-override");
    ({ resetXeroRateLimitStateForTests: resetRateLimits } = await import("@/lib/xero-api-client"));
  });

  beforeEach(() => {
    fake = new XeroFake();
    session = xeroTransport(fake);
    override.setXeroClientForTests(session);
  });

  afterEach(() => {
    override.resetXeroClientForTests();
    resetRateLimits();
  });

  afterAll(async () => {
    try {
      if (typeof db !== "undefined") {
        await clean();
        await db.$disconnect().catch(() => {});
      }
    } finally {
      harnessRole?.restore();
    }
  });

  it("a full deduction reserves the whole note, voids it in Xero, and the mirror stays quiet", async () => {
    const { noteId } = await seedNotedGrant();
    const approved = await approvedDeduction(10_000);
    expect(approved.correctionId).toBeTruthy();
    const reserved = await correctionOf(approved.request.id);
    expect(reserved).toMatchObject({ status: "RESERVED", lines: [{ mode: "VOID", amountCents: 10_000, xeroCreditNoteId: noteId }] });
    expect(await credit.getMemberCreditBalance(MEMBER)).toBe(0);
    expect(await freeOnNote(noteId)).toBe(0);
    expect(await db.auditLog.count({ where: { action: "member.credit.adjustment.approve", details: { startsWith: "Xero correction queued" } } })).toBe(1);

    await runWorker(reserved.id);
    expect(xeroNote(noteId).status).toBe("VOIDED");
    expect(fake.snapshot().invoices).toHaveLength(0);
    expect((await correctionOf(approved.request.id)).status).toBe("COMPLETED");
    const completed = await db.auditLog.findFirstOrThrow({ where: { action: "member.credit.deduction.xero_correction.complete", entityId: approved.request.id } });
    expect(completed.category).toBe("payment");

    // A stale second run of a finished operation discloses nothing twice.
    await db.xeroSyncOperation.updateMany({ where: { localModel: "AdminCreditDeductionCorrection", localId: reserved.id }, data: { status: "PENDING" } });
    await runWorker(reserved.id);
    expect(await db.auditLog.count({ where: { action: "member.credit.deduction.xero_correction.complete", entityId: approved.request.id } })).toBe(1);

    const evidence = { creditNoteId: noteId, status: "VOIDED", totalCents: 10_000, remainingCents: 0, allocations: [], payments: [], updatedAt: new Date("2026-06-01T00:00:00Z") };
    await expect(mirror.mirrorCreditNoteOutsideSpend(evidence)).resolves.toEqual({ acted: false, reason: "voided-by-deduction" });
  });

  it("a part deduction bills only the cents taken back, allocated to the note, and the mirror's change is 0", async () => {
    const { noteId } = await seedNotedGrant();
    const approved = await approvedDeduction(2_501);
    const reserved = await correctionOf(approved.request.id);
    expect(reserved.lines).toMatchObject([{ mode: "INVOICE", amountCents: 2_501 }]);

    // While the correction is open the mirror leaves the note alone: Xero still shows 100.00 free.
    const before = { creditNoteId: noteId, status: "AUTHORISED", totalCents: 10_000, remainingCents: 10_000, allocations: [], payments: [], updatedAt: new Date("2026-06-01T00:00:00Z") };
    await expect(mirror.mirrorCreditNoteOutsideSpend(before)).resolves.toEqual({ acted: false, reason: "deduction-correction-open" });

    await runWorker(reserved.id);
    const done = await correctionOf(approved.request.id);
    expect(done.status).toBe("COMPLETED");
    expect(xeroNote(noteId).remainingCreditCents).toBe(7_499);
    expect(await freeOnNote(noteId)).toBe(7_499);
    expect(await credit.getMemberCreditBalance(MEMBER)).toBe(7_499);
    const invoiceId = done.lines[0]!.xeroInvoiceId!;
    expect(fake.snapshot().allocations).toEqual([expect.objectContaining({ invoiceID: invoiceId, amountCents: 2_501 })]);
    expect(await db.xeroObjectLink.count({ where: { localModel: "AdminCreditDeductionCorrection", localId: done.id, xeroObjectId: invoiceId } })).toBe(1);

    const after = { ...before, remainingCents: 7_499, allocations: [{ invoiceId, cents: 2_501 }] };
    const outcome = await mirror.mirrorCreditNoteOutsideSpend(after);
    expect(outcome.acted).toBe(false);
    expect(await credit.getMemberCreditBalance(MEMBER)).toBe(7_499);
  });

  it("exports correction details only to the credit owner, without provider identifiers", async () => {
    const { lotId } = await seedNotedGrant();
    const { correctionId, request } = await approvedDeduction(2_501);
    await runWorker(correctionId!);
    const { readAdditionalSubjectRecords } = await import("@/lib/subject-access-export-additional");
    const own = await readAdditionalSubjectRecords(MEMBER);
    expect(own.AdminCreditDeductionCorrection).toEqual([{
      id: correctionId, requestId: request.id, status: "COMPLETED", createdAt: expect.any(Date),
      completedAt: expect.any(Date), cancelledAt: null,
    }]);
    expect(own.AdminCreditDeductionCorrectionLine).toEqual([{
      correctionId, sourceMemberCreditId: lotId, amountCents: 2_501, mode: "INVOICE", completedAt: expect.any(Date),
    }]);
    const other = await readAdditionalSubjectRecords(APPROVER);
    expect(other.AdminCreditDeductionCorrection).toEqual([]);
    expect(other.AdminCreditDeductionCorrectionLine).toEqual([]);
  });

  it("a note already part spent keeps its earlier allocation and the correction takes only free cents", async () => {
    const { noteId } = await seedNotedGrant();
    const earlier = fake.createInvoice("earlier-invoice", contactId, 4_000);
    fake.allocate("earlier-spend", noteId, earlier.invoiceID, 4_000);
    // The mirror's own record of that outside spend.
    await db.memberCredit.create({ data: { memberId: MEMBER, amountCents: -4_000, type: "ADMIN_ADJUSTMENT", description: "spent outside", xeroCreditNoteId: noteId, outsideSpendConvergedAt: new Date() } });

    await expect(approvedDeduction(6_001)).rejects.toThrow();
    const approved = await approvedDeduction(6_000);
    const reserved = await correctionOf(approved.request.id);
    expect(reserved.lines).toMatchObject([{ mode: "INVOICE", amountCents: 6_000 }]);
    await runWorker(reserved.id);
    expect(fake.snapshot().allocations.filter((a) => a.creditNoteID === noteId).map((a) => a.amountCents)).toEqual([4_000, 6_000]);
    expect(xeroNote(noteId).remainingCreditCents).toBe(0);
    expect(await freeOnNote(noteId)).toBe(0);
  });

  it("a Xero failure part-way keeps the cents reserved and refuses cancel; the retry finishes once", async () => {
    const { noteId } = await seedNotedGrant();
    const approved = await approvedDeduction(3_000);
    const reserved = await correctionOf(approved.request.id);
    // The invoice is created and the allocation lands, but its reply is lost.
    session.failAfterApply("createCreditNoteAllocation", { statusCode: 400, body: { Message: "reply lost" } });
    await expect(runWorker(reserved.id)).rejects.toThrow();
    expect((await correctionOf(approved.request.id)).status).toBe("RESERVED");
    expect(await freeOnNote(noteId)).toBe(7_000);
    expect(await credit.getMemberCreditBalance(MEMBER)).toBe(7_000);
    expect(xeroNote(noteId).remainingCreditCents).toBe(7_000);
    await expect(cancel.cancelAdminCreditDeductionCorrection({ memberId: MEMBER, correctionId: reserved.id, adminId: APPROVER })).rejects.toThrow(/retry/i);
    expect(await credit.getMemberCreditBalance(MEMBER)).toBe(7_000);

    await runWorker(reserved.id);
    expect((await correctionOf(approved.request.id)).status).toBe("COMPLETED");
    expect(fake.snapshot().invoices).toHaveLength(1);
    expect(fake.snapshot().allocations.filter((a) => a.creditNoteID === noteId)).toHaveLength(1);
    expect(xeroNote(noteId).remainingCreditCents).toBe(7_000);
  });

  it("after a lost create reply the retry finds the invoice by reference and applies it once", async () => {
    const { noteId } = await seedNotedGrant();
    const approved = await approvedDeduction(1_234);
    const reserved = await correctionOf(approved.request.id);
    session.failAfterApply("createInvoices", { statusCode: 400, body: { Message: "reply lost" } });
    await expect(runWorker(reserved.id)).rejects.toThrow();
    expect(fake.snapshot().invoices).toHaveLength(1);
    await expect(cancel.cancelAdminCreditDeductionCorrection({ memberId: MEMBER, correctionId: reserved.id, adminId: APPROVER })).rejects.toThrow(/retry/i);

    await runWorker(reserved.id);
    expect(fake.snapshot().invoices).toHaveLength(1);
    expect(fake.snapshot().allocations.filter((a) => a.creditNoteID === noteId)).toEqual([expect.objectContaining({ amountCents: 1_234 })]);
    expect(xeroNote(noteId).remainingCreditCents).toBe(10_000 - 1_234);
    expect(await freeOnNote(noteId)).toBe(10_000 - 1_234);
  });

  it("an untouched failed correction can be cancelled and its cents come back once", async () => {
    const { noteId } = await seedNotedGrant();
    const approved = await approvedDeduction(2_000);
    const reserved = await correctionOf(approved.request.id);
    session.failNext({ statusCode: 400, body: { Message: "note read refused" } });
    await expect(runWorker(reserved.id)).rejects.toThrow();
    await cancel.cancelAdminCreditDeductionCorrection({ memberId: MEMBER, correctionId: reserved.id, adminId: APPROVER });
    expect((await correctionOf(approved.request.id)).status).toBe("CANCELLED");
    expect(await credit.getMemberCreditBalance(MEMBER)).toBe(10_000);
    expect(await freeOnNote(noteId)).toBe(10_000);
    await expect(cancel.cancelAdminCreditDeductionCorrection({ memberId: MEMBER, correctionId: reserved.id, adminId: APPROVER })).rejects.toThrow();
    expect(await credit.getMemberCreditBalance(MEMBER)).toBe(10_000);
    expect(fake.snapshot().invoices).toHaveLength(0);
  });

  it("cancel refuses while a worker holds the operation, even before it writes to Xero", async () => {
    await seedNotedGrant();
    const approved = await approvedDeduction(2_000);
    const reserved = await correctionOf(approved.request.id);
    const operation = await db.xeroSyncOperation.findFirstOrThrow({ where: { localModel: "AdminCreditDeductionCorrection", localId: reserved.id } });
    expect(await claim.claimXeroSyncOperationToRunning(operation.id, { direction: "OUTBOUND" })).not.toBeNull();
    await expect(cancel.cancelAdminCreditDeductionCorrection({ memberId: MEMBER, correctionId: reserved.id, adminId: APPROVER })).rejects.toThrow(/running/i);
    expect((await correctionOf(approved.request.id)).status).toBe("RESERVED");
    expect(await credit.getMemberCreditBalance(MEMBER)).toBe(8_000);
  });

  it("cancel refuses when a worker reached Xero and failed while cancel was reading Xero", async () => {
    await seedNotedGrant();
    const approved = await approvedDeduction(10_000);
    const reserved = await correctionOf(approved.request.id);
    session.failNext({ statusCode: 400, body: { Message: "note read refused" } });
    await expect(runWorker(reserved.id)).rejects.toThrow();
    // During cancel's Xero read, a retried worker sets its fence, its void's reply is lost, and its run fails.
    let interleaved = false;
    const real = session.xero.accountingApi;
    override.setXeroClientForTests({ tenantId: session.tenantId, xero: { accountingApi: new Proxy(real, {
      get(target, name) {
        const method = Reflect.get(target, name) as (...args: unknown[]) => Promise<unknown>;
        if (name !== "getInvoices" || interleaved) return method;
        return async (...args: unknown[]) => {
          interleaved = true;
          await db.adminCreditDeductionCorrection.update({ where: { id: reserved.id }, data: { providerMutationStartedAt: new Date() } });
          await db.xeroSyncOperation.updateMany({ where: { localModel: "AdminCreditDeductionCorrection", localId: reserved.id }, data: { status: "FAILED" } });
          return method.apply(target, args);
        };
      },
    }) } as never });
    await expect(cancel.cancelAdminCreditDeductionCorrection({ memberId: MEMBER, correctionId: reserved.id, adminId: APPROVER })).rejects.toThrow(/retry/i);
    expect(interleaved).toBe(true);
    expect((await correctionOf(approved.request.id)).status).toBe("RESERVED");
    expect(await credit.getMemberCreditBalance(MEMBER)).toBe(0);
    expect((await db.xeroSyncOperation.findFirstOrThrow({ where: { localModel: "AdminCreditDeductionCorrection", localId: reserved.id } })).status).toBe("FAILED");
  });

  it("two officers approving the same request leave one winner and one correction", async () => {
    await seedNotedGrant();
    const { request } = await credit.createAdminAdjustmentRequest(MEMBER, -2_000, "Granted by mistake", REQUESTER, `key-${++sequence}`, null);
    const outcomes = await Promise.allSettled([
      credit.reviewAdminAdjustmentRequest(MEMBER, request.id, "APPROVE", APPROVER),
      credit.reviewAdminAdjustmentRequest(MEMBER, request.id, "APPROVE", SECOND_APPROVER),
    ]);
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    expect(await db.adminCreditDeductionCorrection.count({ where: { memberId: MEMBER } })).toBe(1);
    expect(await credit.getMemberCreditBalance(MEMBER)).toBe(8_000);
  });

  it("two deductions on one note at once never take more than its free cents", async () => {
    const { noteId } = await seedNotedGrant();
    const [a, b] = await Promise.all([6_000, 6_000].map((cents) =>
      credit.createAdminAdjustmentRequest(MEMBER, -cents, "Granted by mistake", REQUESTER, `key-${++sequence}`, null).then((r) => r.request)));
    const outcomes = await Promise.allSettled([
      credit.reviewAdminAdjustmentRequest(MEMBER, a!.id, "APPROVE", APPROVER),
      credit.reviewAdminAdjustmentRequest(MEMBER, b!.id, "APPROVE", SECOND_APPROVER),
    ]);
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    expect(await freeOnNote(noteId)).toBe(4_000);
    expect(await credit.getMemberCreditBalance(MEMBER)).toBe(4_000);
  });

  it("cancel racing the worker gives exactly one outcome", async () => {
    const { noteId } = await seedNotedGrant();
    const approved = await approvedDeduction(2_000);
    const reserved = await correctionOf(approved.request.id);
    session.failNext({ statusCode: 400, body: { Message: "note read refused" } });
    await expect(runWorker(reserved.id)).rejects.toThrow();

    const outcomes = await Promise.allSettled([
      runWorker(reserved.id),
      cancel.cancelAdminCreditDeductionCorrection({ memberId: MEMBER, correctionId: reserved.id, adminId: APPROVER }),
    ]);
    const final = await correctionOf(approved.request.id);
    if (final.status === "CANCELLED") {
      expect(outcomes[1]!.status).toBe("fulfilled");
      expect(xeroNote(noteId).remainingCreditCents).toBe(10_000);
      expect(fake.snapshot().invoices).toHaveLength(0);
      expect(await credit.getMemberCreditBalance(MEMBER)).toBe(10_000);
    } else {
      expect(final.status).toBe("COMPLETED");
      expect(outcomes[1]!.status).toBe("rejected");
      expect(xeroNote(noteId).remainingCreditCents).toBe(8_000);
      expect(await credit.getMemberCreditBalance(MEMBER)).toBe(8_000);
    }
    expect(await freeOnNote(noteId)).toBe(xeroNote(noteId).remainingCreditCents);
  });
});
