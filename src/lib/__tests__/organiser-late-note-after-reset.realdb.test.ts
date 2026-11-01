/**
 * Real-PostgreSQL proof of #4655 (`INV-INT-029`, `INV-PAY-148`): an organiser
 * adjustment's credit note that Xero creates after its stalled job was reset is
 * never silently lost - it is recorded on the job, or surfaced once.
 *
 * What is driven through the app's own writers, and what is seeded:
 * - SEEDED: the booking, its payment row, and the Xero invoice in a fake Xero
 *   (a $60 organiser extra with $20 paid, $40 due).
 * - REAL: the waiver's queued row (`startXeroSyncOperation`, as the netting
 *   reserves it); the outbox worker raising it
 *   (`processQueuedXeroOutboxOperations`) against the fake Xero, whose
 *   credit-note create answers only when the test lets it (no provider call);
 *   the officer's Reset stale running (`markStaleRunningXeroOperationFailed`,
 *   given an instant past the stale threshold); the officer's Retry
 *   (`retryXeroSyncOperation`, which hands an organiser row back to PENDING in
 *   place); the plain resolve mark (`claimResolvedInXeroMark`); the audit row
 *   and the once-ever alert's claim, with only the email send replaced.
 *
 * Proven, each after stall then reset then the late success:
 * - no officer action: the note lands on the FAILED row, and the stalled run
 *   allocates it and completes the row SUCCEEDED - one note, one allocation;
 * - Retry queued: the note lands on the queued row and the stalled run stops;
 *   the queued run continues from it - one note in Xero, never a second;
 * - resolve by hand: nothing written, the row stays as the officer left it
 *   (no failure written over the reset), one `xero` audit row and one alert,
 *   and a repeat of the same note sends nothing more;
 * - a retry running its own create: the late note never lands on the retry's
 *   claim; it is audited and alerted, and the retry records its own note.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions, which
 * imports this file so CI reaches it; it owns and cleans its own `race-4655-`
 * fixtures.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";
import { assertSafeRaceDbUrl } from "@/lib/__tests__/support/race-db-url";
import { FROZEN_TEST_CLOCK_BASE_ISO, realElapsedMs } from "@/lib/__tests__/helpers/clock";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const P = "race-4655";
const MEMBER_ID = `${P}-member`;
const OFFICER_ID = `${P}-officer`;
const LODGE_ID = `${P}-lodge`;
const BOOKING_ID = `${P}-booking`;
const PAYMENT_ID = `${P}-payment`;
const INVOICE_ID = `${P}-extra-invoice`;
const NOTE_LATE = `${P}-note-late`;
const NOTE_RETRY = `${P}-note-retry`;
const STALE_MS = 16 * 60_000;
const LATE_ACTION = "xero.organiser_adjustment_note.late_note_not_recorded";

let prisma: (typeof import("@/lib/prisma"))["prisma"];

interface FakeNote {
  creditNoteID: string;
  creditNoteNumber: string;
  total: number;
  status: string;
  allocations: Array<{ invoice: { invoiceID: string }; amount: number }>;
  payments: unknown[];
  lineItems: Array<{ description: string; quantity: number; unitAmount: number }>;
}

/** A fake Xero: one organiser extra invoice, and a credit-note create that waits for the test. */
function fakeXero() {
  const invoice = {
    invoiceID: INVOICE_ID, invoiceNumber: "EXTRA-1", contact: { contactID: `${P}-organiser-contact` },
    total: 60, amountPaid: 20, amountCredited: 0, amountDue: 40, status: "AUTHORISED",
  };
  const notes = new Map<string, FakeNote>();
  const creates: Array<{ answer: (id: string, number: string) => void }> = [];
  const allocations: string[] = [];
  const accountingApi = {
    getInvoice: async () => ({ body: { invoices: [{ ...invoice }] } }),
    createCreditNotes: (_tenant: string, body: { creditNotes: Array<{ lineItems: Array<{ description: string; unitAmount: number }> }> }) =>
      new Promise((resolve) => {
        const line = body.creditNotes[0]!.lineItems[0]!;
        creates.push({
          answer: (id, number) => {
            const note: FakeNote = {
              creditNoteID: id, creditNoteNumber: number, total: line.unitAmount, status: "AUTHORISED", allocations: [], payments: [],
              lineItems: [{ description: line.description, quantity: 1, unitAmount: line.unitAmount }],
            };
            notes.set(id, note);
            resolve({ body: { creditNotes: [{ ...note }] } });
          },
        });
      }),
    getCreditNote: async (_tenant: string, id: string) => ({ body: { creditNotes: [structuredClone(notes.get(id))] } }),
    createCreditNoteAllocation: async (_tenant: string, id: string, body: { allocations: Array<{ invoice: { invoiceID: string }; amount: number }> }) => {
      const allocation = body.allocations[0]!;
      notes.get(id)!.allocations.push({ invoice: allocation.invoice, amount: allocation.amount });
      invoice.amountCredited += allocation.amount;
      invoice.amountDue -= allocation.amount;
      allocations.push(id);
      return { body: { allocations: [allocation] } };
    },
  };
  /** Waits (real time, bounded) until the n-th create has reached Xero. */
  async function reached(n: number): Promise<void> {
    const started = process.hrtime.bigint();
    while (creates.length < n) {
      if (realElapsedMs(started) > 20_000) throw new Error(`Credit-note create #${n} never reached the fake Xero`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  return { accountingApi, creates, allocations, notes, reached };
}

(RUN ? describe : describe.skip)(
  "an organiser adjustment's credit note created in Xero after its job was reset is recorded or surfaced - real PostgreSQL (#4655)",
  { timeout: 60_000 },
  () => {
    async function operationIds(): Promise<string[]> {
      return (await prisma.xeroSyncOperation.findMany({ where: { localId: BOOKING_ID }, select: { id: true } })).map((op) => op.id);
    }

    async function clearRun() {
      const ops = await operationIds();
      await prisma.alertCooldown.deleteMany({
        where: { key: { in: ops.flatMap((op) => [`xero-success-after-resolution:${op}`, `xero-success-after-resolution:${op}:${NOTE_LATE}`, `xero-success-after-resolution:${op}:${NOTE_RETRY}`]) } },
      });
      await prisma.auditLog.deleteMany({ where: { OR: [{ memberId: OFFICER_ID }, { targetId: BOOKING_ID }, { entityId: { in: ops } }] } });
      await prisma.xeroSyncOperation.deleteMany({ where: { localId: BOOKING_ID } });
      await prisma.xeroObjectLink.deleteMany({ where: { localId: { in: [BOOKING_ID, PAYMENT_ID] } } });
    }

    async function deleteFixtures() {
      await clearRun();
      await prisma.payment.deleteMany({ where: { id: PAYMENT_ID } });
      await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: { in: [MEMBER_ID, OFFICER_ID] } } });
    }

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL, "Organiser late note after reset (#4655)");
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      await deleteFixtures();
      for (const [id, role] of [[MEMBER_ID, "USER"], [OFFICER_ID, "ADMIN"]] as const) {
        await prisma.member.create({
          data: { id, email: `${id}@example.invalid`, passwordHash: "not-a-real-password", firstName: "Late", lastName: "Waiver", role, ageTier: "ADULT" },
        });
      }
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4655 Lodge", slug: P } });
      await prisma.booking.create({
        data: {
          id: BOOKING_ID, memberId: MEMBER_ID, lodgeId: LODGE_ID, status: "CANCELLED", totalPriceCents: 6_000, finalPriceCents: 6_000,
          checkIn: new Date("2026-08-01T00:00:00.000Z"), checkOut: new Date("2026-08-03T00:00:00.000Z"),
        },
      });
      await prisma.payment.create({ data: { id: PAYMENT_ID, bookingId: BOOKING_ID, amountCents: 6_000, source: "INTERNET_BANKING", status: "SUCCEEDED" } });
    }, 60_000);

    let send: ReturnType<typeof vi.fn>;
    let xero: ReturnType<typeof fakeXero>;
    beforeEach(async () => {
      await clearRun();
      xero = fakeXero();
      const apiClient = await import("@/lib/xero-api-client");
      vi.spyOn(apiClient, "getAuthenticatedXeroClient").mockResolvedValue({ xero: { accountingApi: xero.accountingApi }, tenantId: `tenant-${P}` } as never);
      vi.spyOn(apiClient, "callXeroApi").mockImplementation(((call: () => unknown) => call()) as never);
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

    /** The $40 waiver of the extra's unpaid balance, queued as the netting reserves it. */
    async function queuedWaiver(): Promise<string> {
      const { startXeroSyncOperation } = await import("@/lib/xero-sync");
      const key = `organiser-extra:${BOOKING_ID}:cut:waive:${INVOICE_ID}`;
      const row = await startXeroSyncOperation({
        direction: "OUTBOUND", entityType: "CREDIT_NOTE", operationType: "CREATE", localModel: "Booking", localId: BOOKING_ID,
        status: "PENDING", correlationKey: key, idempotencyKey: key,
        requestPayload: {
          queueType: "ORGANISER_EXTRA_ADJUSTMENT", bookingId: BOOKING_ID, scopeId: "cut", modificationId: null, invoiceId: INVOICE_ID,
          amountCents: 4_000, purpose: "waive", cashAtPlanCents: 2_000, refundPercentage: 50,
        },
      });
      // Oldest first is the worker's order: this row goes first, alone.
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

    /** The officer's Retry: an organiser row goes back to PENDING in place, keeping any note it records. */
    async function retry(operationId: string) {
      const { retryXeroSyncOperation } = await import("@/lib/xero-operation-retry");
      await expect(retryXeroSyncOperation(operationId, CLUB_FORMAT_TEST)).resolves.toMatchObject({ message: "Queued organiser invoice adjustment retry." });
    }

    const lateAudits = () => prisma.auditLog.findMany({ where: { action: LATE_ACTION, targetId: BOOKING_ID } });
    const waiverLinks = () => prisma.xeroObjectLink.findMany({ where: { localModel: "Booking", localId: BOOKING_ID, role: "ORGANISER_EXTRA_WAIVER" } });

    it("MUTATION: reset with no resolve, then the late success - the note lands on the FAILED row, and the stalled run allocates it and completes it", async () => {
      const operationId = await queuedWaiver();
      const run = runOutbox();
      await xero.reached(1);
      await resetStale(operationId);
      xero.creates[0]!.answer(NOTE_LATE, "CN-LATE");
      await expect(run).resolves.toMatchObject({ succeeded: 1, failed: 0 });

      expect(await prisma.xeroSyncOperation.findUniqueOrThrow({ where: { id: operationId } })).toMatchObject({
        status: "SUCCEEDED", xeroObjectType: "CREDIT_NOTE", xeroObjectId: NOTE_LATE, manuallyResolvedAt: null,
      });
      expect(xero.creates).toHaveLength(1);
      expect(xero.allocations).toEqual([NOTE_LATE]);
      expect(await waiverLinks()).toEqual([expect.objectContaining({ xeroObjectId: NOTE_LATE, active: true })]);
      expect(await lateAudits()).toHaveLength(0);
      expect(send).not.toHaveBeenCalled();
    });

    it("MUTATION: reset, then Retry queues the row, then the late success - the note lands on the queued row, and the queued run continues from it: one note, never a second", async () => {
      const operationId = await queuedWaiver();
      const stalled = runOutbox();
      await xero.reached(1);
      await resetStale(operationId);
      await retry(operationId);
      xero.creates[0]!.answer(NOTE_LATE, "CN-LATE");
      await stalled;
      expect(await prisma.xeroSyncOperation.findUniqueOrThrow({ where: { id: operationId } })).toMatchObject({ status: "PENDING", xeroObjectId: NOTE_LATE });
      expect(xero.allocations).toEqual([]);

      await expect(runOutbox()).resolves.toMatchObject({ succeeded: 1, failed: 0 });
      expect(await prisma.xeroSyncOperation.findUniqueOrThrow({ where: { id: operationId } })).toMatchObject({ status: "SUCCEEDED", xeroObjectId: NOTE_LATE });
      expect(xero.creates).toHaveLength(1);
      expect(xero.allocations).toEqual([NOTE_LATE]);
      expect(await lateAudits()).toHaveLength(0);
      expect(send).not.toHaveBeenCalled();
    });

    it("MUTATION: reset, resolve by hand, then the late success - nothing written over the officer's row, one xero audit row and one alert, and a repeat sends nothing more", async () => {
      const operationId = await queuedWaiver();
      const run = runOutbox();
      await xero.reached(1);
      await resetStale(operationId);
      const { claimResolvedInXeroMark } = await import("@/lib/xero-operation-resolve-guards");
      const resolvedAt = new Date("2026-07-01T00:30:00.000Z");
      expect(await claimResolvedInXeroMark({ id: operationId, resolvedAt, reason: "Waived by hand in Xero", resolvedById: OFFICER_ID })).toBe(true);
      const officers = await prisma.xeroSyncOperation.findUniqueOrThrow({ where: { id: operationId } });

      xero.creates[0]!.answer(NOTE_LATE, "CN-LATE");
      // The run stops quietly: the outbox writes no failure over the officer's row.
      await expect(run).resolves.toMatchObject({ succeeded: 1, failed: 0 });

      const row = await prisma.xeroSyncOperation.findUniqueOrThrow({ where: { id: operationId } });
      expect(row).toMatchObject({
        status: "FAILED", manuallyResolvedAt: resolvedAt, xeroObjectId: null, xeroObjectNumber: null,
        lastErrorCode: officers.lastErrorCode, lastErrorMessage: officers.lastErrorMessage,
      });
      expect(row.completedAt?.getTime()).toBe(officers.completedAt?.getTime());
      expect(xero.allocations).toEqual([]);
      expect(await waiverLinks()).toEqual([]);

      const audits = await lateAudits();
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ category: "xero", entityType: "XeroSyncOperation", entityId: operationId, outcome: "blocked" });
      expect(audits[0]!.metadata).toMatchObject({ creditNoteId: NOTE_LATE, creditNoteNumber: "CN-LATE", amountCents: 4_000, resolvedByHand: true, rowStatus: "FAILED" });
      expect(send).toHaveBeenCalledTimes(1);
      expect((send.mock.calls[0]![0] as { errorMessage: string }).errorMessage).toContain("credit note CN-LATE for $40.00");
      expect(await prisma.alertCooldown.count({ where: { key: `xero-success-after-resolution:${operationId}:${NOTE_LATE}` } })).toBe(1);

      // The same note answered again (a second holder of the same call): the once-ever claim holds.
      const { recordCreatedOrganiserNote } = await import("@/lib/organiser-extra-note-record");
      await expect(recordCreatedOrganiserNote({
        claim: { id: operationId, startedAt: row.startedAt }, bookingId: BOOKING_ID, purpose: "waive", creditNoteId: NOTE_LATE, creditNoteNumber: "CN-LATE", amountCents: 4_000,
      })).resolves.toBe("not-recorded");
      expect(send).toHaveBeenCalledTimes(1);
    });

    it("MUTATION: reset, Retry running its own create, then the first run's late success - never landed on the retry's claim; audited and alerted once; the retry records its own note", async () => {
      const operationId = await queuedWaiver();
      const first = runOutbox();
      await xero.reached(1);
      await resetStale(operationId);
      await retry(operationId);
      // The retry's claim is a later instant than the stalled run's.
      vi.setSystemTime(new Date("2026-07-01T00:40:00.000Z"));
      const second = runOutbox();
      await xero.reached(2);
      const held = await prisma.xeroSyncOperation.findUniqueOrThrow({ where: { id: operationId } });
      expect(held).toMatchObject({ status: "RUNNING", startedAt: new Date("2026-07-01T00:40:00.000Z"), xeroObjectId: null });

      xero.creates[0]!.answer(NOTE_LATE, "CN-LATE");
      await expect(first).resolves.toMatchObject({ succeeded: 1, failed: 0 });
      expect(await prisma.xeroSyncOperation.findUniqueOrThrow({ where: { id: operationId } })).toMatchObject({
        status: "RUNNING", startedAt: held.startedAt, xeroObjectId: null,
      });
      const audits = await lateAudits();
      expect(audits).toHaveLength(1);
      expect(audits[0]!.metadata).toMatchObject({ creditNoteId: NOTE_LATE, rowStatus: "RUNNING", resolvedByHand: false });
      expect(send).toHaveBeenCalledTimes(1);
      expect((send.mock.calls[0]![0] as { errorMessage: string }).errorMessage).toContain("may record this same note");

      xero.creates[1]!.answer(NOTE_RETRY, "CN-RETRY");
      await expect(second).resolves.toMatchObject({ succeeded: 1, failed: 0 });
      expect(await prisma.xeroSyncOperation.findUniqueOrThrow({ where: { id: operationId } })).toMatchObject({ status: "SUCCEEDED", xeroObjectId: NOTE_RETRY });
      expect(xero.allocations).toEqual([NOTE_RETRY]);
      expect(send).toHaveBeenCalledTimes(1);
    });
  },
);
