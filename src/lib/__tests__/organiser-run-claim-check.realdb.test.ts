/**
 * Real-PostgreSQL proof of #4680 (`INV-INT-034`, `INV-INT-029`): an organiser
 * adjustment run that recorded its credit note on its own claim, then stalled
 * past Reset stale running, never allocates the waiver or pays the refund after
 * an officer took the adjustment over.
 *
 * What is driven through the app's own writers, and what is seeded:
 * - SEEDED: the booking, its payment row, the organiser's completed
 *   bank-transfer hand-back, and the Xero invoice in a fake Xero (a $60
 *   organiser extra with $20 paid, $40 due; paid in full, for the refund; or
 *   unpaid, for #4701's void).
 * - REAL: the queued row (`startXeroSyncOperation`); the outbox worker
 *   (`processQueuedXeroOutboxOperations`) against the fake Xero, whose note
 *   (or invoice) reads wait until the test releases them (no provider call); the note's
 *   record on the run's own claim; the officer's Reset stale running
 *   (`markStaleRunningXeroOperationFailed`, given an instant past the stale
 *   threshold), Resolve mark (`claimResolvedInXeroMark`) and Retry
 *   (`retryXeroSyncOperation`); the claim check (`holdsXeroOperationClaim`); the
 *   refund-note settlement; the audit row and the once-ever alert's claim, with
 *   only the email send replaced.
 *
 * Proven, each after record, stall, reset:
 * - Resolve, then wake: no allocation (waiver) and no refund payment (refund
 *   note, stopped inside the settlement immediately before its payment), the
 *   row exactly as the officer left it, one `xero` audit row and one alert,
 *   and a repeat sends nothing more;
 * - no officer action, then wake: the run stands down, audited, no alert; the
 *   row keeps its note, and the officer's Retry finishes from it, allocating
 *   once;
 * - Retry queued, then wake: the run stands down; the queued run finishes from
 *   the note - one allocation;
 * - #4703 review 2: reset, the refund note paid by hand in Xero, Resolve, then
 *   wake: the settlement finds it settled and pays nothing, and the run, having
 *   lost its claim, completes nothing over the resolved row (no false
 *   "may hold twice" alert), standing down audited and alerted once;
 * - and, as a control, a refund note whose run is never reset pays once.
 *
 * #4701: a waiver of a wholly unpaid extra ($60 due) voids the invoice instead
 * of raising a note, so its run stalls in its first invoice read, before the
 * void, with no note recorded. Proven: reset, Resolve, then wake - the invoice
 * is not voided, the row is as the officer left it, audited once and alerted
 * once; and reset with no officer action, then wake - nothing voided, audited,
 * no alert, and the officer's Retry then voids once.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions, which
 * imports this file so CI reaches it; it owns and cleans its own `race-4680-`
 * fixtures.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";
import { assertSafeRaceDbUrl } from "@/lib/__tests__/support/race-db-url";
import { FROZEN_TEST_CLOCK_BASE_ISO, realElapsedMs } from "@/lib/__tests__/helpers/clock";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const P = "race-4680";
const MEMBER_ID = `${P}-member`;
const OFFICER_ID = `${P}-officer`;
const LODGE_ID = `${P}-lodge`;
const BOOKING_ID = `${P}-booking`;
const PAYMENT_ID = `${P}-payment`;
const HAND_BACK_ID = `${P}-hand-back`;
const INVOICE_ID = `${P}-extra-invoice`;
const NOTE = `${P}-note`;
const STALE_MS = 16 * 60_000;
const STOOD_DOWN_ACTION = "xero.organiser_adjustment_note.run_stood_down";

let prisma: (typeof import("@/lib/prisma"))["prisma"];

interface FakeNote {
  creditNoteID: string;
  creditNoteNumber: string;
  total: number;
  status: string;
  date: string;
  allocations: Array<{ invoice: { invoiceID: string }; amount: number }>;
  payments: unknown[];
  lineItems: Array<{ description: string; quantity: number; unitAmount: number }>;
}

/** What the organiser has paid on the $60 extra: $20 of it, all of it (a refund note's), or none (a waiver voids it, #4701). */
type Paid = "part" | "full" | "none";
const PAID_DOLLARS: Record<Paid, number> = { part: 20, full: 60, none: 0 };

/** A fake Xero: one organiser extra invoice; a note create that answers at once; note and invoice reads the test can hold. */
function fakeXero(paid: Paid) {
  const invoice = {
    invoiceID: INVOICE_ID, invoiceNumber: "EXTRA-1", contact: { contactID: `${P}-organiser-contact` },
    total: 60, amountPaid: PAID_DOLLARS[paid], amountCredited: 0, amountDue: 60 - PAID_DOLLARS[paid], status: paid === "full" ? "PAID" : "AUTHORISED",
  };
  const notes = new Map<string, FakeNote>();
  const allocations: string[] = [];
  const payments: string[] = [];
  const voids: string[] = [];
  const reads = { held: null as Promise<void> | null, reached: 0 };
  const invoiceReads = { held: null as Promise<void> | null, reached: 0 };
  const accountingApi = {
    getInvoice: async () => {
      invoiceReads.reached += 1;
      await invoiceReads.held;
      return { body: { invoices: [{ ...invoice }] } };
    },
    updateInvoice: async (_tenant: string, id: string, body: { invoices: Array<{ status: string }> }) => {
      invoice.status = body.invoices[0]!.status;
      voids.push(id);
      return { body: { invoices: [{ ...invoice }] } };
    },
    createCreditNotes: async (_tenant: string, body: { creditNotes: Array<{ lineItems: Array<{ description: string; unitAmount: number }> }> }) => {
      const line = body.creditNotes[0]!.lineItems[0]!;
      const note: FakeNote = {
        creditNoteID: NOTE, creditNoteNumber: "CN-1", total: line.unitAmount, status: "AUTHORISED", date: "2026-07-01", allocations: [], payments: [],
        lineItems: [{ description: line.description, quantity: 1, unitAmount: line.unitAmount }],
      };
      notes.set(NOTE, note);
      return { body: { creditNotes: [{ ...note }] } };
    },
    getCreditNote: async (_tenant: string, id: string) => {
      reads.reached += 1;
      await reads.held;
      return { body: { creditNotes: [structuredClone(notes.get(id))] } };
    },
    createCreditNoteAllocation: async (_tenant: string, id: string, body: { allocations: Array<{ invoice: { invoiceID: string }; amount: number }> }) => {
      const allocation = body.allocations[0]!;
      notes.get(id)!.allocations.push({ invoice: allocation.invoice, amount: allocation.amount });
      invoice.amountCredited += allocation.amount;
      invoice.amountDue -= allocation.amount;
      allocations.push(id);
      return { body: { allocations: [allocation] } };
    },
    createPayments: async (_tenant: string, body: { payments: Array<{ creditNote: { creditNoteID: string }; amount: number }> }) => {
      const payment = body.payments[0]!;
      payments.push(payment.creditNote.creditNoteID);
      return { body: { payments: [{ paymentID: `${P}-refund-payment`, amount: payment.amount }] } };
    },
  };
  /** Holds every read of `gate` until the returned release is called. */
  function hold(gate: typeof reads): () => void {
    let release!: () => void;
    gate.held = new Promise((resolve) => { release = resolve; });
    return release;
  }
  /** Waits (real time, bounded) until a read of `gate` has reached the fake Xero. */
  async function reached(gate: typeof reads, what: string): Promise<void> {
    const started = process.hrtime.bigint();
    while (gate.reached < 1) {
      if (realElapsedMs(started) > 20_000) throw new Error(`The ${what} read never reached the fake Xero`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  const holdNoteReads = () => hold(reads);
  const readReached = () => reached(reads, "note");
  /** #4701: the run's first read, of the invoice, before it would void it. */
  const holdInvoiceReads = () => hold(invoiceReads);
  const invoiceReadReached = () => reached(invoiceReads, "invoice");
  /** #4703 review 2: an officer pays the refund note by hand in Xero. */
  const payByHand = (id: string) => {
    const note = notes.get(id)!;
    note.payments = [{ paymentID: `${P}-officer-payment`, amount: note.total, status: "AUTHORISED" }];
    note.status = "PAID";
  };
  return { accountingApi, invoice, notes, allocations, payments, voids, holdNoteReads, readReached, holdInvoiceReads, invoiceReadReached, payByHand };
}

(RUN ? describe : describe.skip)(
  "an organiser adjustment run whose claim a reset took after it recorded its note never allocates or pays out - real PostgreSQL (#4680)",
  { timeout: 60_000 },
  () => {
    async function operationIds(): Promise<string[]> {
      return (await prisma.xeroSyncOperation.findMany({ where: { localId: BOOKING_ID }, select: { id: true } })).map((op) => op.id);
    }

    async function clearRun() {
      const ops = await operationIds();
      await prisma.alertCooldown.deleteMany({
        where: { key: { in: ops.flatMap((op) => [`xero-success-after-resolution:${op}`, `xero-success-after-resolution:${op}:${NOTE}`]) } },
      });
      await prisma.auditLog.deleteMany({ where: { OR: [{ memberId: OFFICER_ID }, { targetId: BOOKING_ID }, { entityId: { in: ops } }] } });
      await prisma.xeroSyncOperation.deleteMany({ where: { localId: BOOKING_ID } });
      await prisma.xeroObjectLink.deleteMany({ where: { localId: { in: [BOOKING_ID, PAYMENT_ID] } } });
    }

    async function deleteFixtures() {
      await clearRun();
      await prisma.manualRefundTask.deleteMany({ where: { id: HAND_BACK_ID } });
      await prisma.payment.deleteMany({ where: { id: PAYMENT_ID } });
      await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: { in: [MEMBER_ID, OFFICER_ID] } } });
    }

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL, "Organiser run claim check (#4680)");
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      await deleteFixtures();
      for (const [id, role] of [[MEMBER_ID, "USER"], [OFFICER_ID, "ADMIN"]] as const) {
        await prisma.member.create({
          data: { id, email: `${id}@example.invalid`, passwordHash: "not-a-real-password", firstName: "Stood", lastName: "Down", role, ageTier: "ADULT" },
        });
      }
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4680 Lodge", slug: P } });
      await prisma.booking.create({
        data: {
          id: BOOKING_ID, memberId: MEMBER_ID, lodgeId: LODGE_ID, status: "CANCELLED", totalPriceCents: 6_000, finalPriceCents: 6_000,
          checkIn: new Date("2026-08-01T00:00:00.000Z"), checkOut: new Date("2026-08-03T00:00:00.000Z"),
        },
      });
      await prisma.payment.create({ data: { id: PAYMENT_ID, bookingId: BOOKING_ID, amountCents: 6_000, source: "INTERNET_BANKING", status: "SUCCEEDED" } });
      await prisma.manualRefundTask.create({ data: { id: HAND_BACK_ID, bookingId: BOOKING_ID, reason: "Organiser bank-transfer hand-back", status: "COMPLETED", amountCents: 500 } });
    }, 60_000);

    let send: ReturnType<typeof vi.fn>;
    let xero: ReturnType<typeof fakeXero>;
    async function installXero(paid: Paid = "part") {
      xero = fakeXero(paid);
      const apiClient = await import("@/lib/xero-api-client");
      vi.spyOn(apiClient, "getAuthenticatedXeroClient").mockResolvedValue({ xero: { accountingApi: xero.accountingApi }, tenantId: `tenant-${P}` } as never);
      vi.spyOn(apiClient, "callXeroApi").mockImplementation(((call: () => unknown) => call()) as never);
    }
    beforeEach(async () => {
      await clearRun();
      await installXero();
      // The club's bank-transfer refund account, so a refund note's settlement would pay.
      const mappings = await import("@/lib/xero-mappings");
      vi.spyOn(mappings, "getResolvedAccountMapping").mockResolvedValue({ code: "090" } as never);
      const email = await import("@/lib/email");
      send = vi.fn(async () => ({ deliveryAllowed: true, recipients: 1, sent: 1, queuedForRetry: 0, notDelivered: 0 }));
      vi.spyOn(email, "sendAdminXeroSyncErrorAlert").mockImplementation(send as never);
    });

    afterEach(async () => {
      vi.restoreAllMocks();
      vi.setSystemTime(new Date(FROZEN_TEST_CLOCK_BASE_ISO));
      await clearRun();
    });

    afterAll(async () => {
      if (!prisma) return;
      await deleteFixtures();
    }, 60_000);

    /** The adjustment's row, queued as the netting reserves it: the $40 waiver, the $60 one voiding an unpaid extra, or the $5 bank-transfer refund note. */
    async function queued(purpose: "waive" | "refund" | "void"): Promise<string> {
      const { startXeroSyncOperation } = await import("@/lib/xero-sync");
      const key = `organiser-extra:${BOOKING_ID}:cut:${purpose === "refund" ? "refund" : "waive"}:${INVOICE_ID}`;
      const row = await startXeroSyncOperation({
        direction: "OUTBOUND", entityType: "CREDIT_NOTE", operationType: "CREATE", localModel: "Booking", localId: BOOKING_ID,
        status: "PENDING", correlationKey: key, idempotencyKey: key,
        requestPayload: purpose === "void"
          ? { queueType: "ORGANISER_EXTRA_ADJUSTMENT", bookingId: BOOKING_ID, scopeId: "cut", modificationId: null, invoiceId: INVOICE_ID, amountCents: 6_000, purpose: "waive", cashAtPlanCents: 0, refundPercentage: 50 }
          : purpose === "waive"
          ? { queueType: "ORGANISER_EXTRA_ADJUSTMENT", bookingId: BOOKING_ID, scopeId: "cut", modificationId: null, invoiceId: INVOICE_ID, amountCents: 4_000, purpose, cashAtPlanCents: 2_000, refundPercentage: 50 }
          : { queueType: "ORGANISER_EXTRA_ADJUSTMENT", bookingId: BOOKING_ID, scopeId: "cut", modificationId: null, invoiceId: INVOICE_ID, amountCents: 500, purpose, cashAtPlanCents: 6_000, refundPercentage: 50, handBackTaskId: HAND_BACK_ID },
      });
      await prisma.$executeRaw`UPDATE "XeroSyncOperation" SET "createdAt" = ${new Date("2000-01-01T00:00:00.000Z")} WHERE "id" = ${row.id}`;
      return row.id;
    }

    async function runOutbox() {
      const { processQueuedXeroOutboxOperations } = await import("@/lib/xero-operation-outbox");
      return processQueuedXeroOutboxOperations({ limit: 1 });
    }

    /** Reset stale running on the stalled row, as an officer presses it once the row is past the stale threshold. */
    async function resetStale(operationId: string) {
      const { startedAt, status } = await prisma.xeroSyncOperation.findUniqueOrThrow({ where: { id: operationId }, select: { startedAt: true, status: true } });
      expect(status).toBe("RUNNING");
      const { markStaleRunningXeroOperationFailed } = await import("@/lib/xero-stale-operations");
      const marked = await markStaleRunningXeroOperationFailed(operationId, async () => undefined, new Date(startedAt!.getTime() + STALE_MS));
      expect(marked).toMatchObject({ outcome: "marked", returnedTo: "FAILED" });
    }

    async function resolveByHand(operationId: string, resolvedAt: Date) {
      const { claimResolvedInXeroMark } = await import("@/lib/xero-operation-resolve-guards");
      expect(await claimResolvedInXeroMark({ id: operationId, resolvedAt, reason: "Adjusted by hand in Xero", resolvedById: OFFICER_ID })).toBe(true);
    }

    async function retry(operationId: string) {
      const { retryXeroSyncOperation } = await import("@/lib/xero-operation-retry");
      await expect(retryXeroSyncOperation(operationId, CLUB_FORMAT_TEST)).resolves.toMatchObject({ message: "Queued organiser invoice adjustment retry." });
    }

    /** The run records its note on its own claim, then stalls at its next note read. */
    async function recordedAndStalled(purpose: "waive" | "refund") {
      const operationId = await queued(purpose);
      const release = xero.holdNoteReads();
      const run = runOutbox();
      await xero.readReached();
      expect(await prisma.xeroSyncOperation.findUniqueOrThrow({ where: { id: operationId } })).toMatchObject({ status: "RUNNING", xeroObjectId: NOTE });
      return { operationId, run, release };
    }

    /** #4701: the waiver of a wholly unpaid extra stalls in its first invoice read, before the void, its claim held. */
    async function stalledBeforeVoid() {
      await installXero("none");
      const operationId = await queued("void");
      const release = xero.holdInvoiceReads();
      const run = runOutbox();
      await xero.invoiceReadReached();
      expect(await prisma.xeroSyncOperation.findUniqueOrThrow({ where: { id: operationId } })).toMatchObject({ status: "RUNNING", xeroObjectId: null });
      return { operationId, run, release };
    }

    const stoodDownAudits = () => prisma.auditLog.findMany({ where: { action: STOOD_DOWN_ACTION, targetId: BOOKING_ID } });
    const adjustmentLinks = () => prisma.xeroObjectLink.findMany({ where: { localId: { in: [BOOKING_ID, PAYMENT_ID] }, role: { in: ["ORGANISER_EXTRA_WAIVER", "ORGANISER_EXTRA_REFUND"] } } });

    it.each(["waive", "refund"] as const)("MUTATION: %s - record, stall, reset, Resolve, then wake: no allocation or payment, the officer's row untouched, audited once and alerted once", async (purpose) => {
      if (purpose === "refund") await installXero("full");
      const { operationId, run, release } = await recordedAndStalled(purpose);
      await resetStale(operationId);
      const resolvedAt = new Date("2026-07-01T00:30:00.000Z");
      await resolveByHand(operationId, resolvedAt);
      const officers = await prisma.xeroSyncOperation.findUniqueOrThrow({ where: { id: operationId } });

      release();
      // The run stands down: no failure written over the officer's row, no success either.
      await expect(run).resolves.toMatchObject({ succeeded: 0, skipped: 1, failed: 0 });

      expect(xero.allocations).toEqual([]);
      expect(xero.payments).toEqual([]);
      const row = await prisma.xeroSyncOperation.findUniqueOrThrow({ where: { id: operationId } });
      expect(row).toMatchObject({
        status: "FAILED", manuallyResolvedAt: resolvedAt, xeroObjectId: NOTE, xeroObjectNumber: "CN-1",
        lastErrorCode: officers.lastErrorCode, lastErrorMessage: officers.lastErrorMessage,
      });
      expect(row.completedAt?.getTime()).toBe(officers.completedAt?.getTime());
      expect(await adjustmentLinks()).toEqual([]);

      const audits = await stoodDownAudits();
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ category: "xero", entityType: "XeroSyncOperation", entityId: operationId, outcome: "blocked" });
      expect(audits[0]!.metadata).toMatchObject({
        creditNoteId: NOTE, step: purpose === "waive" ? "allocation" : "refund-payment", rowStatus: "FAILED", resolvedByHand: true,
      });
      expect(send).toHaveBeenCalledTimes(1);
      expect((send.mock.calls[0]![0] as { errorMessage: string }).errorMessage).toContain(
        purpose === "waive" ? "stopped before allocating the note to the organiser's invoice" : "stopped before recording a refund payment against the note",
      );
      expect(await prisma.alertCooldown.count({ where: { key: `xero-success-after-resolution:${operationId}:${NOTE}` } })).toBe(1);

      // A second stand-down of the same note (another holder of the same call): the once-ever claim holds.
      const { traceOrganiserRunStoodDown } = await import("@/lib/organiser-extra-note-record");
      await traceOrganiserRunStoodDown(
        { claim: { id: operationId, startedAt: officers.startedAt }, bookingId: BOOKING_ID, purpose, creditNoteId: NOTE, creditNoteNumber: "CN-1", amountCents: purpose === "waive" ? 4_000 : 500 },
        purpose === "waive" ? "allocation" : "refund-payment",
      );
      expect(send).toHaveBeenCalledTimes(1);
    });

    it("MUTATION: record, stall, reset with no officer action, then wake: the run stands down, audited, no alert; the officer's Retry then finishes from the note, allocating once", async () => {
      const { operationId, run, release } = await recordedAndStalled("waive");
      await resetStale(operationId);
      release();
      await expect(run).resolves.toMatchObject({ succeeded: 0, skipped: 1, failed: 0 });
      expect(xero.allocations).toEqual([]);
      expect(await prisma.xeroSyncOperation.findUniqueOrThrow({ where: { id: operationId } })).toMatchObject({ status: "FAILED", xeroObjectId: NOTE, manuallyResolvedAt: null });
      expect(await stoodDownAudits()).toEqual([expect.objectContaining({ metadata: expect.objectContaining({ rowStatus: "FAILED", resolvedByHand: false }) })]);
      expect(send).not.toHaveBeenCalled();

      vi.setSystemTime(new Date("2026-07-01T00:40:00.000Z"));
      await retry(operationId);
      await expect(runOutbox()).resolves.toMatchObject({ succeeded: 1, failed: 0 });
      expect(await prisma.xeroSyncOperation.findUniqueOrThrow({ where: { id: operationId } })).toMatchObject({ status: "SUCCEEDED", xeroObjectId: NOTE });
      expect(xero.notes.size).toBe(1);
      expect(xero.allocations).toEqual([NOTE]);
    });

    it("MUTATION: record, stall, reset, Retry queued, then wake: the run stands down; the queued run finishes from the note - one allocation, no alert", async () => {
      const { operationId, run, release } = await recordedAndStalled("waive");
      await resetStale(operationId);
      await retry(operationId);
      release();
      await expect(run).resolves.toMatchObject({ succeeded: 0, skipped: 1, failed: 0 });
      expect(xero.allocations).toEqual([]);
      expect(await prisma.xeroSyncOperation.findUniqueOrThrow({ where: { id: operationId } })).toMatchObject({ status: "PENDING", xeroObjectId: NOTE });

      await expect(runOutbox()).resolves.toMatchObject({ succeeded: 1, failed: 0 });
      expect(await prisma.xeroSyncOperation.findUniqueOrThrow({ where: { id: operationId } })).toMatchObject({ status: "SUCCEEDED", xeroObjectId: NOTE });
      expect(xero.allocations).toEqual([NOTE]);
      expect(send).not.toHaveBeenCalled();
    });

    it("MUTATION (#4703 review 2): record, stall, reset, the note paid by hand, Resolve, then wake: nothing paid, nothing completed over the officer's row", async () => {
      await installXero("full");
      const { operationId, run, release } = await recordedAndStalled("refund");
      await resetStale(operationId);
      xero.payByHand(NOTE);
      const resolvedAt = new Date("2026-07-01T00:30:00.000Z");
      await resolveByHand(operationId, resolvedAt);
      release();
      await expect(run).resolves.toMatchObject({ succeeded: 0, skipped: 1, failed: 0 });
      expect(xero.payments).toEqual([]);
      expect(await prisma.xeroSyncOperation.findUniqueOrThrow({ where: { id: operationId } })).toMatchObject({ status: "FAILED", manuallyResolvedAt: resolvedAt });
      expect(await adjustmentLinks()).toEqual([]);
      expect(await stoodDownAudits()).toEqual([expect.objectContaining({ metadata: expect.objectContaining({ step: "completion", resolvedByHand: true, amountCents: 500 }) })]);
      expect(send).toHaveBeenCalledTimes(1);
      expect((send.mock.calls[0]![0] as { errorMessage: string }).errorMessage).toContain("Xero already showed the note settled");
      expect(await prisma.alertCooldown.count({ where: { key: `xero-success-after-resolution:${operationId}` } })).toBe(0);
    });

    it("MUTATION (#4701): stall in the invoice read before the void, reset, Resolve, then wake: the invoice is not voided, the officer's row untouched, audited once and alerted once", async () => {
      const { operationId, run, release } = await stalledBeforeVoid();
      await resetStale(operationId);
      const resolvedAt = new Date("2026-07-01T00:30:00.000Z");
      await resolveByHand(operationId, resolvedAt);
      const officers = await prisma.xeroSyncOperation.findUniqueOrThrow({ where: { id: operationId } });

      release();
      await expect(run).resolves.toMatchObject({ succeeded: 0, skipped: 1, failed: 0 });

      expect(xero.voids).toEqual([]);
      expect(xero.invoice.status).toBe("AUTHORISED");
      expect(xero.notes.size).toBe(0);
      const row = await prisma.xeroSyncOperation.findUniqueOrThrow({ where: { id: operationId } });
      expect(row).toMatchObject({
        status: "FAILED", manuallyResolvedAt: resolvedAt, xeroObjectId: null,
        lastErrorCode: officers.lastErrorCode, lastErrorMessage: officers.lastErrorMessage,
      });
      expect(row.completedAt?.getTime()).toBe(officers.completedAt?.getTime());
      expect(row.responsePayload).toEqual(officers.responsePayload);

      const audits = await stoodDownAudits();
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ category: "xero", entityType: "XeroSyncOperation", entityId: operationId, outcome: "blocked" });
      expect(audits[0]!.metadata).toMatchObject({ step: "void", invoiceId: INVOICE_ID, amountCents: 6_000, rowStatus: "FAILED", resolvedByHand: true });
      expect(send).toHaveBeenCalledTimes(1);
      expect((send.mock.calls[0]![0] as { errorMessage: string }).errorMessage).toContain("stopped before voiding the organiser's invoice EXTRA-1");
      expect(await prisma.alertCooldown.count({ where: { key: `xero-success-after-resolution:${operationId}:${INVOICE_ID}` } })).toBe(1);
    });

    it("MUTATION (#4701): stall before the void, reset with no officer action, then wake: nothing voided, audited, no alert; the officer's Retry then voids once", async () => {
      const { operationId, run, release } = await stalledBeforeVoid();
      await resetStale(operationId);
      release();
      await expect(run).resolves.toMatchObject({ succeeded: 0, skipped: 1, failed: 0 });
      expect(xero.voids).toEqual([]);
      expect(await stoodDownAudits()).toEqual([expect.objectContaining({ metadata: expect.objectContaining({ step: "void", rowStatus: "FAILED", resolvedByHand: false }) })]);
      expect(send).not.toHaveBeenCalled();

      vi.setSystemTime(new Date("2026-07-01T00:40:00.000Z"));
      await retry(operationId);
      await expect(runOutbox()).resolves.toMatchObject({ succeeded: 1, failed: 0 });
      expect(await prisma.xeroSyncOperation.findUniqueOrThrow({ where: { id: operationId } })).toMatchObject({ status: "SUCCEEDED" });
      expect(xero.voids).toEqual([INVOICE_ID]);
      expect(xero.notes.size).toBe(0);
    });

    it("control: a refund note whose run keeps its claim is paid once and completed", async () => {
      await installXero("full");
      const { operationId, run, release } = await recordedAndStalled("refund");
      release();
      await expect(run).resolves.toMatchObject({ succeeded: 1, failed: 0 });
      expect(xero.payments).toEqual([NOTE]);
      expect(await prisma.xeroSyncOperation.findUniqueOrThrow({ where: { id: operationId } })).toMatchObject({ status: "SUCCEEDED", xeroObjectId: NOTE });
      expect(await stoodDownAudits()).toEqual([]);
      expect(send).not.toHaveBeenCalled();
    });
  },
);
