/**
 * Real-PostgreSQL proof of #4685: an account-credit Xero note stamps the one
 * member credit it was raised for, by id, so two equal credits on one booking
 * each carry their own note.
 *
 * What is driven through the app's own writers, and what is seeded:
 * - SEEDED: the member, the cancelled booking, its Internet Banking payment, and
 *   the cancellation credits (equal amounts, one booking, one description).
 * - REAL: the account-credit enqueue (`enqueueXeroAccountCreditNoteOperation`)
 *   or, for the deployed release's shape, a row queued without the credit id
 *   (`startXeroSyncOperation`); the outbox worker
 *   (`processQueuedXeroOutboxOperations`) parsing the row and running
 *   `createUnappliedXeroCreditNote` against a fake Xero, whose every create
 *   answers with a new note; the stamp (`stampCancellationCreditXeroNote`).
 *
 * Proven:
 * - two equal credits each get their own note: the note queued for the newer
 *   credit stamps that credit only, and the next note the older one. The
 *   payment holds one live account-credit link at a time, so the second note is
 *   raised once the first link is retired, as the inbound void handler retires
 *   it (a stated limit: the enqueue keys a payment's note on its amount);
 * - a row queued without the credit id still stamps, by the old match;
 * - a replay of a linked note stamps no second credit: the old match stamped
 *   every equal credit, and now a note stamps one.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions, which
 * imports this file so CI reaches it; it owns and cleans its own `race-4685-`
 * fixtures.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";
import { assertSafeRaceDbUrl } from "@/lib/__tests__/support/race-db-url";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const P = "race-4685";
const MEMBER_ID = `${P}-member`;
const LODGE_ID = `${P}-lodge`;
const BOOKING_ID = `${P}-booking`;
const PAYMENT_ID = `${P}-payment`;
const OLDER_CREDIT = `${P}-credit-older`;
const NEWER_CREDIT = `${P}-credit-newer`;
const CREDIT_CENTS = 5_000;
/** The already-cancelled Internet Banking arm's description (`invoice-paid-effects.ts`). */
const DESCRIPTION = `Internet Banking payment credit for cancelled booking ${BOOKING_ID.slice(0, 8)}`;

let prisma: (typeof import("@/lib/prisma"))["prisma"];

/** A fake Xero whose every account-credit create answers with a new note. */
function fakeXero() {
  const created: string[] = [];
  const accountingApi = {
    createCreditNotes: async (_tenant: string, body: { creditNotes: Array<{ lineItems: Array<{ unitAmount: number }> }> }) => {
      const id = `${P}-note-${created.length + 1}`;
      created.push(id);
      const total = body.creditNotes[0]!.lineItems[0]!.unitAmount;
      return { body: { creditNotes: [{ creditNoteID: id, creditNoteNumber: `CN-${created.length}`, total, remainingCredit: total, status: "AUTHORISED" }] } };
    },
  };
  return { accountingApi, created };
}

(RUN ? describe : describe.skip)(
  "an account-credit Xero note stamps the one credit it was raised for - real PostgreSQL (#4685)",
  { timeout: 60_000 },
  () => {
    async function clearRun() {
      await prisma.xeroSyncOperation.deleteMany({ where: { localId: PAYMENT_ID } });
      await prisma.xeroObjectLink.deleteMany({ where: { localId: PAYMENT_ID } });
      await prisma.memberCredit.deleteMany({ where: { memberId: MEMBER_ID } });
    }

    async function deleteFixtures() {
      await clearRun();
      await prisma.payment.deleteMany({ where: { id: PAYMENT_ID } });
      await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
    }

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL, "Account-credit note stamp by id (#4685)");
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      await deleteFixtures();
      await prisma.member.create({
        data: { id: MEMBER_ID, email: `${MEMBER_ID}@example.invalid`, passwordHash: "not-a-real-password", firstName: "Stamp", lastName: "ById", role: "USER", ageTier: "ADULT" },
      });
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4685 Lodge", slug: P } });
      await prisma.booking.create({
        data: {
          id: BOOKING_ID, memberId: MEMBER_ID, lodgeId: LODGE_ID, status: "CANCELLED", totalPriceCents: 10_000, finalPriceCents: 10_000,
          checkIn: new Date("2026-08-01T00:00:00.000Z"), checkOut: new Date("2026-08-03T00:00:00.000Z"),
        },
      });
      await prisma.payment.create({ data: { id: PAYMENT_ID, bookingId: BOOKING_ID, amountCents: 10_000, source: "INTERNET_BANKING", status: "SUCCEEDED" } });
    }, 60_000);

    let xero: ReturnType<typeof fakeXero>;
    beforeEach(async () => {
      await clearRun();
      xero = fakeXero();
      const apiClient = await import("@/lib/xero-api-client");
      const contacts = await import("@/lib/xero-contacts");
      const invoicedParty = await import("@/lib/organisation-xero-contacts");
      vi.spyOn(apiClient, "getAuthenticatedXeroClient").mockResolvedValue({ xero: { accountingApi: xero.accountingApi }, tenantId: `tenant-${P}` } as never);
      vi.spyOn(apiClient, "callXeroApi").mockImplementation(((call: () => unknown) => call()) as never);
      vi.spyOn(invoicedParty, "findOrCreateXeroContactForInvoicedParty").mockResolvedValue(`${P}-contact`);
      vi.spyOn(contacts, "retryXeroWriteWithContactRepair").mockImplementation((async (options: { run: (input: { contactId: string }) => unknown; currentContactId: string }) =>
        options.run({ contactId: options.currentContactId })) as never);
      // Two equal credits on one booking, the older first.
      for (const [id, createdAt] of [[OLDER_CREDIT, "2026-06-01T00:00:00.000Z"], [NEWER_CREDIT, "2026-06-02T00:00:00.000Z"]] as const) {
        await prisma.memberCredit.create({
          data: { id, memberId: MEMBER_ID, amountCents: CREDIT_CENTS, type: "CANCELLATION_REFUND", description: DESCRIPTION, sourceBookingId: BOOKING_ID, createdAt: new Date(createdAt) },
        });
      }
    });

    afterEach(async () => {
      vi.restoreAllMocks();
      await clearRun();
    });

    afterAll(async () => {
      if (!prisma) return;
      await deleteFixtures();
    }, 60_000);

    async function runOutbox() {
      const { processQueuedXeroOutboxOperations } = await import("@/lib/xero-operation-outbox");
      return processQueuedXeroOutboxOperations({ limit: 1 });
    }

    async function notes(): Promise<Record<string, string | null>> {
      const rows = await prisma.memberCredit.findMany({ where: { memberId: MEMBER_ID }, select: { id: true, xeroCreditNoteId: true } });
      return Object.fromEntries(rows.map((row) => [row.id, row.xeroCreditNoteId]));
    }

    async function enqueueFor(memberCreditId: string) {
      const { enqueueXeroAccountCreditNoteOperation } = await import("@/lib/xero-operation-outbox");
      const queued = await enqueueXeroAccountCreditNoteOperation(PAYMENT_ID, CREDIT_CENTS, { memberCreditId });
      expect(queued.queueOperationId).not.toBeNull();
      expect((await prisma.xeroSyncOperation.findUniqueOrThrow({ where: { id: queued.queueOperationId! } })).requestPayload)
        .toMatchObject({ queueType: "ACCOUNT_CREDIT_NOTE", refundAmountCents: CREDIT_CENTS, memberCreditId });
    }

    it("MUTATION: two equal credits on one booking each get their own note", async () => {
      // The newer credit's note first: the old match would have stamped both, the older first.
      await enqueueFor(NEWER_CREDIT);
      await expect(runOutbox()).resolves.toMatchObject({ succeeded: 1, failed: 0 });
      expect(xero.created).toEqual([`${P}-note-1`]);
      expect(await notes()).toEqual({ [OLDER_CREDIT]: null, [NEWER_CREDIT]: `${P}-note-1` });

      // The payment's one live account-credit link retired, as the inbound void handler retires it.
      await prisma.xeroObjectLink.updateMany({ where: { localId: PAYMENT_ID, role: "ACCOUNT_CREDIT_NOTE" }, data: { active: false } });
      await enqueueFor(OLDER_CREDIT);
      await expect(runOutbox()).resolves.toMatchObject({ succeeded: 1, failed: 0 });
      expect(xero.created).toEqual([`${P}-note-1`, `${P}-note-2`]);
      expect(await notes()).toEqual({ [OLDER_CREDIT]: `${P}-note-2`, [NEWER_CREDIT]: `${P}-note-1` });
    });

    it("MUTATION: a row queued without the credit id, as the deployed release queues it, still stamps by the old match", async () => {
      const { startXeroSyncOperation } = await import("@/lib/xero-sync");
      const key = `payment:${PAYMENT_ID}:unapplied-credit-note:${CREDIT_CENTS}:v1`;
      await startXeroSyncOperation({
        direction: "OUTBOUND", entityType: "CREDIT_NOTE", operationType: "CREATE", localModel: "Payment", localId: PAYMENT_ID,
        status: "PENDING", idempotencyKey: key, correlationKey: key,
        requestPayload: { queueType: "ACCOUNT_CREDIT_NOTE", refundAmountCents: CREDIT_CENTS },
      });

      await expect(runOutbox()).resolves.toMatchObject({ succeeded: 1, failed: 0 });
      // One credit, the oldest - never both.
      expect(await notes()).toEqual({ [OLDER_CREDIT]: `${P}-note-1`, [NEWER_CREDIT]: null });
    });

    it("a replay of the linked note stamps no second credit", async () => {
      await enqueueFor(NEWER_CREDIT);
      await expect(runOutbox()).resolves.toMatchObject({ succeeded: 1, failed: 0 });

      // A retry that finds the note already linked: named credit, and a row with none.
      const { createUnappliedXeroCreditNote } = await import("@/lib/xero-credit-notes");
      await expect(createUnappliedXeroCreditNote(PAYMENT_ID, CREDIT_CENTS, CLUB_FORMAT_TEST, { memberCreditId: OLDER_CREDIT })).resolves.toBe(`${P}-note-1`);
      await expect(createUnappliedXeroCreditNote(PAYMENT_ID, CREDIT_CENTS, CLUB_FORMAT_TEST)).resolves.toBe(`${P}-note-1`);
      expect(xero.created).toEqual([`${P}-note-1`]);
      expect(await notes()).toEqual({ [OLDER_CREDIT]: null, [NEWER_CREDIT]: `${P}-note-1` });
    });
  },
);
