/**
 * Real-PostgreSQL proof of #4046: when Xero voids the refund credit note a
 * payment's `xeroRefundCreditNoteId` names, the link write that deactivates the
 * local mirror also moves that pointer - to the newest other live note that may
 * be canonical (never a #3880 per-refund note), or to null - in the same
 * transaction. The nightly "Missing refund credit note links" report reads the
 * pointer as a promise that an active link exists, so the pointer must always
 * name an active link or nothing.
 *
 * #4091: the same holds for the one canonical note of a bank-transfer payment,
 * whose mirror the funnel used to keep active after the void.
 *
 * #4161: a mirror voided before #4091 (still active, status recorded, named by
 * the pointer) is healed by the nightly link cleanup through the same write.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions, which
 * imports this file so CI reaches it; it owns and cleans its own `race-4046-`
 * fixtures.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";
import { realElapsedMs } from "@/lib/__tests__/helpers/clock";
import { currentXeroClaim } from "@/lib/__tests__/helpers/xero-claim";
import { releaseBookingJournalForTeardown } from "./support/booking-financial-history-teardown";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const MEMBER_ID = "race-4046-member";
const LODGE_ID = "race-4046-lodge";
const BOOKING_ID = "race-4046-booking";
const PAYMENT_ID = "race-4046-payment";
const CHECK_IN = new Date("2026-08-01T00:00:00.000Z");
const CHECK_OUT = new Date("2026-08-03T00:00:00.000Z");

/** Standalone fail-closed copy: importing this file must not register another suite. */
export function assertSafeVoidPointerRaceDbUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Refund-note void pointer proofs need a valid CONCURRENCY_RACE_DATABASE_URL.");
  }
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isFinite(port) || port === 5432 || port < 55442) {
    throw new Error(
      `Refusing to run refund-note void pointer proofs against port ${parsed.port || "(none)"}: use a throwaway PostgreSQL on 55442+ (never 5432).`,
    );
  }
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname.toLowerCase())) {
    throw new Error("Refund-note void pointer proof DB must be loopback-only.");
  }
  if (!decodeURIComponent(parsed.pathname.replace(/^\//, "")).includes("concurrency_race_1881")) {
    throw new Error("Refund-note void pointer proof DB name must contain 'concurrency_race_1881'.");
  }
}

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let upsertXeroObjectLink: (typeof import("@/lib/xero-sync"))["upsertXeroObjectLink"];
let reconcileXeroCreditNote: (typeof import("@/lib/xero-inbound/credit-note"))["reconcileXeroCreditNote"];
let cleanupStaleCanonicalXeroObjectLinks: (typeof import("@/lib/xero-hardening-canonical-links"))["cleanupStaleCanonicalXeroObjectLinks"];

(RUN ? describe : describe.skip)(
  "a voided refund credit note moves the payment's pointer in the same write - real PostgreSQL (#4046)",
  { timeout: 60_000 },
  () => {
    async function clearRun() {
      // #4525 (M13): the refund note this suite raises leaves an export manifest naming the booking.
      await releaseBookingJournalForTeardown(prisma, [BOOKING_ID]);
      await prisma.xeroSyncOperation.deleteMany({ where: { localModel: "Payment", localId: PAYMENT_ID } });
      await prisma.xeroObjectLink.deleteMany({ where: { localId: PAYMENT_ID } });
      await prisma.payment.deleteMany({ where: { id: PAYMENT_ID } });
    }

    async function deleteFixtures() {
      await clearRun();
      await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
    }

    async function paymentWithNotes(
      source: "STRIPE" | "INTERNET_BANKING",
      pointer: string,
      notes: Array<{ id: string; createdAt: string; metadata: Record<string, unknown> }>,
    ) {
      await prisma.payment.create({
        data: {
          id: PAYMENT_ID, bookingId: BOOKING_ID, amountCents: 20_000, source, status: "SUCCEEDED",
          refundedAmountCents: 20_000, xeroRefundCreditNoteId: pointer,
        },
      });
      for (const note of notes) {
        await prisma.xeroObjectLink.create({
          data: {
            localModel: "Payment", localId: PAYMENT_ID, xeroObjectType: "CREDIT_NOTE", xeroObjectId: note.id,
            role: "REFUND_CREDIT_NOTE", active: true, metadata: note.metadata as never, createdAt: new Date(note.createdAt),
          },
        });
      }
    }

    function voidNote(noteId: string, options?: Parameters<typeof upsertXeroObjectLink>[1]) {
      return upsertXeroObjectLink(
        {
          localModel: "Payment", localId: PAYMENT_ID, xeroObjectType: "CREDIT_NOTE", xeroObjectId: noteId,
          role: "REFUND_CREDIT_NOTE", metadata: { status: "VOIDED" }, mergeMetadata: true,
        },
        options,
      );
    }

    async function state() {
      const payment = await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID }, select: { xeroRefundCreditNoteId: true } });
      const links = await prisma.xeroObjectLink.findMany({
        where: { localId: PAYMENT_ID, role: "REFUND_CREDIT_NOTE" },
        select: { xeroObjectId: true, active: true },
        orderBy: { xeroObjectId: "asc" },
      });
      return { pointer: payment.xeroRefundCreditNoteId, active: links.filter((link) => link.active).map((link) => link.xeroObjectId) };
    }

    /** The report's "missing" predicate: a pointer must name an active link, or be empty. */
    function expectNoMissingLink({ pointer, active }: { pointer: string | null; active: string[] }) {
      expect(pointer === null || active.includes(pointer)).toBe(true);
    }

    beforeAll(async () => {
      assertSafeVoidPointerRaceDbUrl(RACE_DB_URL);
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      ({ upsertXeroObjectLink } = await import("@/lib/xero-sync"));
      ({ reconcileXeroCreditNote } = await import("@/lib/xero-inbound/credit-note"));
      ({ cleanupStaleCanonicalXeroObjectLinks } = await import("@/lib/xero-hardening-canonical-links"));

      await deleteFixtures();
      await prisma.member.create({
        data: { id: MEMBER_ID, email: `${MEMBER_ID}@example.invalid`, passwordHash: "not-a-real-password", firstName: "Void", lastName: "Proof", role: "ADMIN", ageTier: "ADULT" },
      });
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4046 Lodge", slug: "race-4046" } });
      await prisma.booking.create({
        data: { id: BOOKING_ID, memberId: MEMBER_ID, lodgeId: LODGE_ID, checkIn: CHECK_IN, checkOut: CHECK_OUT, status: "CANCELLED", totalPriceCents: 20_000, finalPriceCents: 20_000 },
      });
    }, 60_000);

    beforeEach(async () => {
      await clearRun();
    });

    afterAll(async () => {
      if (!prisma) return;
      await deleteFixtures();
    }, 60_000);

    it("a card payment's voided latest note: mirror off, pointer on the newest other live note", async () => {
      await paymentWithNotes("STRIPE", "cn_latest", [
        { id: "cn_first", createdAt: "2026-06-01T00:00:00.000Z", metadata: { amountCents: 15_000 } },
        { id: "cn_latest", createdAt: "2026-06-02T00:00:00.000Z", metadata: { amountCents: 5_000 } },
      ]);

      await voidNote("cn_latest");

      const after = await state();
      expect(after).toEqual({ pointer: "cn_first", active: ["cn_first"] });
      expectNoMissingLink(after);

      // A redelivery of the same void moves nothing.
      await voidNote("cn_latest");
      expect(await state()).toEqual(after);
    });

    it("the last live note voided: the pointer is cleared", async () => {
      await paymentWithNotes("STRIPE", "cn_only", [
        { id: "cn_only", createdAt: "2026-06-01T00:00:00.000Z", metadata: { amountCents: 20_000 } },
      ]);

      await voidNote("cn_only");

      const after = await state();
      expect(after).toEqual({ pointer: null, active: [] });
      expectNoMissingLink(after);
    });

    it("never records a per-refund note as the pointer (#3880)", async () => {
      // A field an older writer pointed at a per-refund note, which Xero then voids.
      await paymentWithNotes("INTERNET_BANKING", "cn_per_refund_old", [
        { id: "cn_canonical", createdAt: "2026-06-01T00:00:00.000Z", metadata: { amountCents: 10_000 } },
        { id: "cn_per_refund_old", createdAt: "2026-06-02T00:00:00.000Z", metadata: { amountCents: 5_000, perDelta: true } },
        { id: "cn_per_refund_new", createdAt: "2026-06-03T00:00:00.000Z", metadata: { amountCents: 5_000, perDelta: true } },
      ]);

      await voidNote("cn_per_refund_old");

      const after = await state();
      expect(after).toEqual({ pointer: "cn_canonical", active: ["cn_canonical", "cn_per_refund_new"] });
      expectNoMissingLink(after);
    });

    /** The inbound reconcile, reading `note` from a fake Xero (no provider call). */
    async function withFakeXero<T>(note: Record<string, unknown>, run: () => Promise<T>): Promise<T> {
      const xero = { accountingApi: { getCreditNote: async () => ({ body: { creditNotes: [note] } }) } };
      const apiClient = await import("@/lib/xero-api-client");
      const spies = [
        vi.spyOn(apiClient, "getAuthenticatedXeroClient").mockResolvedValue({ xero, tenantId: "tenant-4046" } as never),
        vi.spyOn(apiClient, "callXeroApi").mockImplementation(((call: () => unknown) => call()) as never),
      ];
      try {
        return await run();
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
    }

    /**
     * Every value committed to this payment's pointer while `run` executes,
     * recorded by a temporary trigger so a write that a later step undoes is
     * still seen.
     */
    async function recordPointerWrites(run: () => Promise<unknown>): Promise<Array<string | null>> {
      await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS race_4046_pointer_writes (seq serial PRIMARY KEY, note_id text)`);
      await prisma.$executeRawUnsafe(`TRUNCATE race_4046_pointer_writes`);
      await prisma.$executeRawUnsafe(`
        CREATE OR REPLACE FUNCTION race_4046_record_pointer() RETURNS trigger AS $$
        BEGIN
          IF NEW."id" = '${PAYMENT_ID}' AND NEW."xeroRefundCreditNoteId" IS DISTINCT FROM OLD."xeroRefundCreditNoteId" THEN
            INSERT INTO race_4046_pointer_writes (note_id) VALUES (NEW."xeroRefundCreditNoteId");
          END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql`);
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS race_4046_pointer_trigger ON "Payment"`);
      await prisma.$executeRawUnsafe(
        `CREATE TRIGGER race_4046_pointer_trigger AFTER UPDATE OF "xeroRefundCreditNoteId" ON "Payment" FOR EACH ROW EXECUTE FUNCTION race_4046_record_pointer()`,
      );
      try {
        await run();
        const rows = await prisma.$queryRawUnsafe<Array<{ note_id: string | null }>>(
          `SELECT note_id FROM race_4046_pointer_writes ORDER BY seq`,
        );
        return rows.map((row) => row.note_id);
      } finally {
        await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS race_4046_pointer_trigger ON "Payment"`);
        await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS race_4046_record_pointer()`);
        await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS race_4046_pointer_writes`);
      }
    }

    it("an inbound reconcile of a card payment's only note, voided, never writes the voided note back into the pointer", async () => {
      await paymentWithNotes("STRIPE", "cn_only", [
        { id: "cn_only", createdAt: "2026-06-01T00:00:00.000Z", metadata: { amountCents: 20_000 } },
      ]);
      const voided = {
        creditNoteID: "cn_only", creditNoteNumber: "CN-4046", status: "VOIDED",
        total: 200, appliedAmount: 0, remainingCredit: 0, allocations: [], payments: [],
      };

      // The first link loop clears the pointer. Before the fix the
      // canonical-backfill pass then wrote the voided note straight back (one
      // commit), and only the second link loop cleared it again - so a throw
      // between the two left the report's "missing link" in place.
      const writes = await recordPointerWrites(() => withFakeXero(voided, () => reconcileXeroCreditNote("cn_only")));

      expect(writes).not.toContain("cn_only");
      expect(writes).toEqual([null]);
      const after = await state();
      expect(after).toEqual({ pointer: null, active: [] });
      expectNoMissingLink(after);

      // A redelivery writes nothing.
      expect(await recordPointerWrites(() => withFakeXero(voided, () => reconcileXeroCreditNote("cn_only"))))
        .toEqual([]);
      expect(await state()).toEqual(after);
    });

    /** What the nightly report and the coverage sum say about this payment's refund notes. */
    async function reportedRefundNoteState() {
      const { buildXeroReconciliationReport } = await import("@/lib/xero-hardening-report");
      const { sumCoveredRefundCreditNoteCents } = await import("@/lib/xero-sync");
      const drift = (await buildXeroReconciliationReport(CLUB_FORMAT_TEST, { topLimit: 10_000 })).issueSections
        .filter((section) => section.id === "canonical-link-drift")
        .flatMap((section) => section.items)
        .filter((item) => item.localId === PAYMENT_ID && item.xeroObjectType === "CREDIT_NOTE")
        .map((item) => item.xeroObjectId);
      return { drift, coveredCents: await sumCoveredRefundCreditNoteCents(PAYMENT_ID) };
    }

    it("a bank-transfer payment's one canonical note, voided inbound: mirror off, pointer released, no live note anywhere (#4091)", async () => {
      await paymentWithNotes("INTERNET_BANKING", "cn_canonical", [
        { id: "cn_canonical", createdAt: "2026-06-01T00:00:00.000Z", metadata: { amountCents: 20_000 } },
      ]);
      const before = await reportedRefundNoteState();
      expect(before).toEqual({ drift: [], coveredCents: 20_000 });
      const voided = {
        creditNoteID: "cn_canonical", creditNoteNumber: "CN-4091", status: "VOIDED",
        total: 200, appliedAmount: 0, remainingCredit: 0, allocations: [], payments: [],
      };

      // Before the fix the canonical branch kept the mirror active - the field
      // named it - so the pointer stayed on a voided note and every reader of
      // an active link saw a live refund note that Xero had cancelled.
      const writes = await recordPointerWrites(() => withFakeXero(voided, () => reconcileXeroCreditNote("cn_canonical")));

      expect(writes).toEqual([null]);
      const after = await state();
      expect(after).toEqual({ pointer: null, active: [] });
      expectNoMissingLink(after);
      // The refund has no live note: nothing covers it, and the report shows no
      // pointer promising a link that is not there.
      expect(await reportedRefundNoteState()).toEqual({ drift: [], coveredCents: 0 });

      // The nightly cleanup and a redelivery of the void change nothing.
      const { cleanupStaleCanonicalXeroObjectLinks } = await import("@/lib/xero-hardening-canonical-links");
      await cleanupStaleCanonicalXeroObjectLinks();
      expect(await recordPointerWrites(() => withFakeXero(voided, () => reconcileXeroCreditNote("cn_canonical"))))
        .toEqual([]);
      expect(await state()).toEqual(after);
    });

    it("INV-ADDPAY-041: a refund note requested again after the void raises a fresh note and never re-adopts the voided one", async () => {
      await paymentWithNotes("INTERNET_BANKING", "cn_canonical", [
        { id: "cn_canonical", createdAt: "2026-06-01T00:00:00.000Z", metadata: { amountCents: 20_000, watermarkCents: 20_000 } },
      ]);
      await prisma.payment.update({ where: { id: PAYMENT_ID }, data: { xeroInvoiceId: "inv-race-4091" } });
      const ORIGINAL_KEY = `payment:${PAYMENT_ID}:refund-credit-note:20000:v1`;
      // The create that raised it, which the single-note lookup falls back to.
      await prisma.xeroSyncOperation.create({
        data: {
          direction: "OUTBOUND", entityType: "CREDIT_NOTE", operationType: "CREATE", localModel: "Payment", localId: PAYMENT_ID,
          status: "SUCCEEDED", xeroObjectType: "CREDIT_NOTE", xeroObjectId: "cn_canonical", xeroObjectNumber: "CN-4091",
          correlationKey: ORIGINAL_KEY, idempotencyKey: ORIGINAL_KEY, completedAt: new Date("2026-06-01T00:00:00.000Z"),
        },
      });
      const voided = {
        creditNoteID: "cn_canonical", creditNoteNumber: "CN-4091", status: "VOIDED",
        total: 200, appliedAmount: 0, remainingCredit: 0, allocations: [], payments: [],
      };
      await withFakeXero(voided, () => reconcileXeroCreditNote("cn_canonical"));

      // A rerun of the refund's request. Before the decision it found the
      // voided note through its create, wrote it back into the pointer and
      // re-armed its mirror, and raised nothing.
      const { enqueueXeroRefundCreditNoteOperation } = await import("@/lib/xero-operation-outbox");
      const queued = await enqueueXeroRefundCreditNoteOperation(PAYMENT_ID, 20_000);
      // A redelivery of the void after it changes nothing either.
      await withFakeXero(voided, () => reconcileXeroCreditNote("cn_canonical"));

      expect(queued.queueOperationId).not.toBeNull();
      const fresh = await prisma.xeroSyncOperation.findUniqueOrThrow({ where: { id: queued.queueOperationId! } });
      expect(fresh).toMatchObject({ operationType: "CREATE", entityType: "CREDIT_NOTE", status: "PENDING", xeroObjectId: null });
      // INV-ADDPAY-041: its row key names the voided note too, so the failed
      // panel never reads the voided note's SUCCEEDED create as its repair.
      expect(fresh.correlationKey).toBe(`${ORIGINAL_KEY}:after-void:cn_canonical`);
      const { resolveFailedXeroOperationStates } = await import("@/lib/xero-admin-failures");
      const failed = await prisma.xeroSyncOperation.update({ where: { id: fresh.id }, data: { status: "FAILED" } });
      expect((await resolveFailedXeroOperationStates([failed])).get(fresh.id)?.state).toBe("ACTIVE");
      await prisma.xeroSyncOperation.update({ where: { id: fresh.id }, data: { status: "PENDING" } });
      const after = await state();
      expect(after).toEqual({ pointer: null, active: [] });
      expectNoMissingLink(after);

      // Xero is a bank transfer's payment rail, so the void undid the refund
      // (INV-ADDPAY-021, owner decision) and the worker would size the note at
      // zero. The treasurer records the refund again; the worker then raises the note
      // under a Xero key naming the voided note, so a Xero that still holds
      // the voided note's key cannot replay it back.
      expect((await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID } })).refundedAmountCents).toBe(0);
      await prisma.payment.update({ where: { id: PAYMENT_ID }, data: { refundedAmountCents: 20_000 } });
      const keys = await raiseQueuedNote(queued.queueOperationId!);
      expect(keys).toEqual([`payment:${PAYMENT_ID}:refund-credit-note:20000:v2:after-void:cn_canonical`]);
      expect(await state()).toEqual({ pointer: "cn-race-4091-fresh", active: ["cn-race-4091-fresh"] });
    });

    /**
     * The outbox's own call for a queued refund-note row, against a fake Xero
     * that replays a key it has seen (the voided note's original key returns
     * the voided note). Returns the Xero idempotency keys it was sent.
     */
    async function raiseQueuedNote(operationId: string): Promise<string[]> {
      const keys: string[] = [];
      const xero = {
        accountingApi: {
          createCreditNotes: async (_t: string, body: { creditNotes: Array<{ lineItems: Array<{ unitAmount: number }> }> }, _s?: unknown, _u?: unknown, key?: string) => {
            keys.push(key!);
            const replay = key === `payment:${PAYMENT_ID}:refund-credit-note:20000:v2`;
            const total = body.creditNotes[0]!.lineItems[0]!.unitAmount;
            return {
              body: {
                creditNotes: [{
                  creditNoteID: replay ? "cn_canonical" : "cn-race-4091-fresh", creditNoteNumber: replay ? "CN-4091" : "CN-4091-2",
                  total, remainingCredit: total, status: replay ? "VOIDED" : "AUTHORISED", payments: [],
                }],
              },
            };
          },
          getCreditNote: async () => ({ body: { creditNotes: [] } }),
        },
      };
      const apiClient = await import("@/lib/xero-api-client");
      const contacts = await import("@/lib/xero-contacts");
      const invoicedParty = await import("@/lib/organisation-xero-contacts");
      const invoicePayments = await import("@/lib/xero-invoice-payments");
      const { createXeroCreditNote } = await import("@/lib/xero-credit-notes");
      const spies = [
        vi.spyOn(apiClient, "getAuthenticatedXeroClient").mockResolvedValue({ xero, tenantId: "tenant-4091" } as never),
        vi.spyOn(apiClient, "callXeroApi").mockImplementation(((call: () => unknown) => call()) as never),
        vi.spyOn(invoicedParty, "findOrCreateXeroContactForInvoicedParty").mockResolvedValue("contact-4091"),
        vi.spyOn(contacts, "retryXeroWriteWithContactRepair").mockImplementation((async (options: { run: (input: { contactId: string }) => unknown; currentContactId: string }) =>
          options.run({ contactId: options.currentContactId })) as never),
        // No bank-transfer refund account mapped: the note is left unsettled, which this proof does not read.
        vi.spyOn(invoicePayments, "resolveRefundSettlement").mockResolvedValue({ kind: "unsettled", reason: "race-4091" }),
      ];
      try {
        const row = await prisma.xeroSyncOperation.findUniqueOrThrow({ where: { id: operationId }, select: { requestPayload: true } });
        const payload = row.requestPayload as { refundAmountCents: number; watermarkCents: number };
        await createXeroCreditNote(PAYMENT_ID, payload.refundAmountCents, {
          syncOperation: await currentXeroClaim(prisma, operationId), watermarkCents: payload.watermarkCents, refundMethod: "internet-banking",
        });
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
      return keys;
    }

    it("a bank-transfer canonical note voided beside a live per-refund note: only the canonical mirror goes off (#4091, #3880)", async () => {
      await paymentWithNotes("INTERNET_BANKING", "cn_canonical", [
        { id: "cn_canonical", createdAt: "2026-06-01T00:00:00.000Z", metadata: { amountCents: 15_000 } },
        { id: "cn_per_refund", createdAt: "2026-06-02T00:00:00.000Z", metadata: { amountCents: 5_000, perDelta: true } },
      ]);

      await voidNote("cn_canonical");

      const after = await state();
      // The per-refund note keeps covering its own refund and never becomes the pointer.
      expect(after).toEqual({ pointer: null, active: ["cn_per_refund"] });
      expectNoMissingLink(after);
      expect(await reportedRefundNoteState()).toEqual({ drift: [], coveredCents: 5_000 });
    });

    /** This payment's money, pointer and every refund-note row as stored, to prove a run moved nothing. */
    async function storedRows() {
      const payment = await prisma.payment.findUniqueOrThrow({
        where: { id: PAYMENT_ID }, select: { xeroRefundCreditNoteId: true, refundedAmountCents: true, updatedAt: true },
      });
      const links = await prisma.xeroObjectLink.findMany({
        where: { localId: PAYMENT_ID, role: "REFUND_CREDIT_NOTE" },
        select: { id: true, xeroObjectId: true, xeroObjectNumber: true, xeroObjectUrl: true, active: true, metadata: true, updatedAt: true },
        orderBy: { xeroObjectId: "asc" },
      });
      return { payment, links };
    }

    it("#4161: a bank-transfer canonical mirror voided before #4091 is healed by the nightly cleanup, and a second run changes nothing", async () => {
      // The pre-#4091 shape: Xero's VOIDED status merged onto the link, which
      // stayed active, and the pointer still names it.
      await paymentWithNotes("INTERNET_BANKING", "cn_voided", [
        { id: "cn_voided", createdAt: "2026-06-01T00:00:00.000Z", metadata: { amountCents: 20_000, status: "VOIDED", total: 200 } },
      ]);
      const recordedUrl = "https://go.xero.com/AccountsReceivable/ViewCreditNote.aspx?creditNoteID=cn_voided";
      await prisma.xeroObjectLink.updateMany({ where: { localId: PAYMENT_ID }, data: { xeroObjectNumber: "CN-4161", xeroObjectUrl: recordedUrl } });
      const { id: linkId } = await prisma.xeroObjectLink.findFirstOrThrow({ where: { localId: PAYMENT_ID }, select: { id: true } });
      // The report now lists it (read-only), and it covers nothing.
      expect(await reportedRefundNoteState()).toEqual({ drift: ["cn_voided"], coveredCents: 0 });

      const first = await cleanupStaleCanonicalXeroObjectLinks();

      expect(first.cancelledRefundCreditNoteMirrors).toBeGreaterThanOrEqual(1);
      expect(first.healedCancelledRefundCreditNoteMirrors).toBeGreaterThanOrEqual(1);
      expect(first.deactivatedLinkIds).toContain(linkId);
      expect(first.failedRefundNoteHealLinkIds).not.toContain(linkId);
      const after = await state();
      expect(after).toEqual({ pointer: null, active: [] });
      expectNoMissingLink(after);
      expect(await reportedRefundNoteState()).toEqual({ drift: [], coveredCents: 0 });
      const healed = await storedRows();
      // Only the link and the pointer moved: no money, and every recorded field kept.
      expect(healed.payment.refundedAmountCents).toBe(20_000);
      expect(healed.links).toEqual([
        expect.objectContaining({
          xeroObjectId: "cn_voided", xeroObjectNumber: "CN-4161", xeroObjectUrl: recordedUrl, active: false,
          metadata: { amountCents: 20_000, status: "VOIDED", total: 200 },
        }),
      ]);

      const second = await cleanupStaleCanonicalXeroObjectLinks();

      expect(second.deactivatedLinkIds).not.toContain(linkId);
      expect(await storedRows()).toEqual(healed);
    });

    it("#4161: a payment with a refund-note create that could still mint is deferred, with no write, and healed on a later run", async () => {
      await paymentWithNotes("INTERNET_BANKING", "cn_voided", [
        { id: "cn_voided", createdAt: "2026-06-01T00:00:00.000Z", metadata: { amountCents: 20_000, status: "VOIDED" } },
      ]);
      const { id: linkId } = await prisma.xeroObjectLink.findFirstOrThrow({ where: { localId: PAYMENT_ID }, select: { id: true } });
      const running = await prisma.xeroSyncOperation.create({
        data: { direction: "OUTBOUND", entityType: "CREDIT_NOTE", operationType: "CREATE", localModel: "Payment", localId: PAYMENT_ID, status: "RUNNING" },
      });
      const before = await storedRows();

      const deferred = await cleanupStaleCanonicalXeroObjectLinks();

      expect(deferred.deferredRefundNoteHealLinkIds).toContain(linkId);
      expect(deferred.deactivatedLinkIds).not.toContain(linkId);
      expect(await storedRows()).toEqual(before);

      await prisma.xeroSyncOperation.update({ where: { id: running.id }, data: { status: "SUCCEEDED" } });
      await cleanupStaleCanonicalXeroObjectLinks();
      expect(await state()).toEqual({ pointer: null, active: [] });
    });

    it("#4161: a heal never waits on a Payment row another writer holds: it defers at once with no write, and the next run heals", async () => {
      await paymentWithNotes("INTERNET_BANKING", "cn_voided", [
        { id: "cn_voided", createdAt: "2026-06-01T00:00:00.000Z", metadata: { amountCents: 20_000, status: "VOIDED" } },
      ]);
      const { id: linkId } = await prisma.xeroObjectLink.findFirstOrThrow({ where: { localId: PAYMENT_ID }, select: { id: true } });
      const before = await storedRows();

      // A payment-first writer (the create's record, or the enqueue's
      // existing-note branch in a group cancel) holding the Payment row, on
      // its own connection.
      let releaseHolder!: () => void;
      const holderMayCommit = new Promise<void>((resolve) => (releaseHolder = resolve));
      let markHeld!: () => void;
      const paymentHeld = new Promise<void>((resolve) => (markHeld = resolve));
      const holder = prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT 1 FROM "Payment" WHERE "id" = ${PAYMENT_ID} FOR UPDATE`;
          markHeld();
          await holderMayCommit;
        },
        { timeout: 60_000, maxWait: 10_000 },
      );
      await paymentHeld;
      // Without NOWAIT the heal would wait on the holder; this backstop lets
      // the holder go after 10s so such a run fails on the assertions below
      // instead of hanging.
      const backstop = setTimeout(releaseHolder, 10_000);
      const startedNs = process.hrtime.bigint();
      let busy: Awaited<ReturnType<typeof cleanupStaleCanonicalXeroObjectLinks>>;
      try {
        busy = await cleanupStaleCanonicalXeroObjectLinks();
      } finally {
        clearTimeout(backstop);
        releaseHolder();
        await holder;
      }

      expect(realElapsedMs(startedNs)).toBeLessThan(5_000);
      expect(busy.deferredRefundNoteHealLinkIds).toContain(linkId);
      expect(busy.failedRefundNoteHealLinkIds).not.toContain(linkId);
      expect(busy.deactivatedLinkIds).not.toContain(linkId);
      expect(await storedRows()).toEqual(before);

      await cleanupStaleCanonicalXeroObjectLinks();
      expect(await state()).toEqual({ pointer: null, active: [] });
    });

    it("#4192: a card pointer naming its own inactive voided mirror (the old direct flip) moves to the newest live note, once", async () => {
      await paymentWithNotes("STRIPE", "cn_latest", [
        { id: "cn_first", createdAt: "2026-06-01T00:00:00.000Z", metadata: { amountCents: 15_000, status: "AUTHORISED" } },
        { id: "cn_latest", createdAt: "2026-06-02T00:00:00.000Z", metadata: { amountCents: 5_000, status: "VOIDED" } },
      ]);
      // What the pre-#4161 cleanup left: the mirror flipped directly, the pointer not moved.
      await prisma.xeroObjectLink.updateMany({ where: { localId: PAYMENT_ID, xeroObjectId: "cn_latest" }, data: { active: false } });
      const before = await storedRows();

      const first = await cleanupStaleCanonicalXeroObjectLinks();

      expect(first.pointedInactiveCancelledRefundNoteMirrors).toBeGreaterThanOrEqual(1);
      expect(first.releasedInactiveRefundNotePointers).toBeGreaterThanOrEqual(1);
      const after = await state();
      expect(after).toEqual({ pointer: "cn_first", active: ["cn_first"] });
      expectNoMissingLink(after);
      const healed = await storedRows();
      // Only the pointer moved: money, the live sibling and the voided mirror's fields are as they were.
      expect(healed.payment.refundedAmountCents).toBe(before.payment.refundedAmountCents);
      // The funnel fills a URL the old row never recorded, as on any link write.
      const withoutWriteTime = (links: typeof healed.links) => links.map((link) => ({ ...link, updatedAt: null }));
      expect(withoutWriteTime(healed.links)).toEqual(
        withoutWriteTime(before.links).map((link) =>
          link.xeroObjectId === "cn_latest" ? { ...link, xeroObjectUrl: "https://go.xero.com/AccountsReceivable/ViewCreditNote.aspx?creditNoteID=cn_latest" } : link,
        ),
      );
      expect(healed.links.find((link) => link.xeroObjectId === "cn_first")?.updatedAt).toEqual(before.links.find((link) => link.xeroObjectId === "cn_first")?.updatedAt);

      await cleanupStaleCanonicalXeroObjectLinks();
      expect(await storedRows()).toEqual(healed);
    });

    it("#4192: with no live note left the pointer is cleared; an inactive note whose status is unknown is never touched", async () => {
      await paymentWithNotes("STRIPE", "cn_only", [
        { id: "cn_only", createdAt: "2026-06-01T00:00:00.000Z", metadata: { amountCents: 20_000, status: "DELETED" } },
      ]);
      await prisma.xeroObjectLink.updateMany({ where: { localId: PAYMENT_ID }, data: { active: false } });

      await cleanupStaleCanonicalXeroObjectLinks();
      expect(await state()).toEqual({ pointer: null, active: [] });

      await clearRun();
      await paymentWithNotes("STRIPE", "cn_unknown", [
        { id: "cn_unknown", createdAt: "2026-06-01T00:00:00.000Z", metadata: { amountCents: 20_000 } },
      ]);
      await prisma.xeroObjectLink.updateMany({ where: { localId: PAYMENT_ID }, data: { active: false } });
      const before = await storedRows();

      await cleanupStaleCanonicalXeroObjectLinks();

      expect(await storedRows()).toEqual(before);
    });

    it("#4161 control: the cleanup leaves a live canonical note and a live per-refund note untouched", async () => {
      await paymentWithNotes("INTERNET_BANKING", "cn_live", [
        { id: "cn_live", createdAt: "2026-06-01T00:00:00.000Z", metadata: { amountCents: 15_000, status: "AUTHORISED" } },
        { id: "cn_per_refund", createdAt: "2026-06-02T00:00:00.000Z", metadata: { amountCents: 5_000, perDelta: true } },
      ]);
      const before = await storedRows();

      const result = await cleanupStaleCanonicalXeroObjectLinks();

      for (const link of before.links) expect(result.deactivatedLinkIds).not.toContain(link.id);
      expect(await storedRows()).toEqual(before);
      expect(await reportedRefundNoteState()).toEqual({ drift: [], coveredCents: 20_000 });
    });

    it("#4161: a card payment's still-active voided latest note is healed the same way, its pointer moved to the newest live note", async () => {
      await paymentWithNotes("STRIPE", "cn_latest", [
        { id: "cn_first", createdAt: "2026-06-01T00:00:00.000Z", metadata: { amountCents: 15_000, status: "AUTHORISED" } },
        { id: "cn_latest", createdAt: "2026-06-02T00:00:00.000Z", metadata: { amountCents: 5_000, status: "VOIDED" } },
      ]);

      await cleanupStaleCanonicalXeroObjectLinks();

      const after = await state();
      expect(after).toEqual({ pointer: "cn_first", active: ["cn_first"] });
      expectNoMissingLink(after);
      expect(await reportedRefundNoteState()).toEqual({ drift: [], coveredCents: 15_000 });
    });

    it("the pointer move commits or rolls back with the mirror write", async () => {
      await paymentWithNotes("STRIPE", "cn_latest", [
        { id: "cn_first", createdAt: "2026-06-01T00:00:00.000Z", metadata: { amountCents: 15_000 } },
        { id: "cn_latest", createdAt: "2026-06-02T00:00:00.000Z", metadata: { amountCents: 5_000 } },
      ]);

      await expect(
        prisma.$transaction(async (tx) => {
          await voidNote("cn_latest", { store: tx });
          throw new Error("abort after the void write");
        }),
      ).rejects.toThrow("abort after the void write");

      expect(await state()).toEqual({ pointer: "cn_latest", active: ["cn_first", "cn_latest"] });
    });
  },
);
