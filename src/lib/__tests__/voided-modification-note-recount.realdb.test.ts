/**
 * Real-PostgreSQL proof of #5289 A (owner decision D1, `INV-PAY-126`): an
 * edit's correction voided in Xero is taken back off the bank-transfer payment
 * it was counted on, even when the sync's first reading of the note is the
 * final one (VOIDED or DELETED, no allocations).
 *
 * Before #5289 such a reading listed no invoice, so no allocation write ran;
 * the removal turned nothing off for a voided reading; and the recount found
 * its payments only from the reading's allocations, so it found none. The
 * payment kept the correction as refunded, and a cancel gave back that much
 * too little. Now a cancelled reading of a modification note lists nothing:
 * each still-active allocation link goes off under its payment's Payment row,
 * that payment's whole total is decided there, and the recount decides it
 * again.
 *
 * Each case runs the REAL sync (`reconcileXeroCreditNote`) against a fake Xero
 * (`syncFakeXeroCreditNote`), over a $500 bank transfer kept at the stored
 * figure with a $100 correction counted, seeded as their writers leave them.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions,
 * which imports this file so CI reaches it; it cleans its own `race-5289a-`
 * fixtures.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { releaseBookingJournalForTeardown } from "./support/booking-financial-history-teardown";
import { syncFakeXeroCreditNote } from "./support/fake-xero-credit-note-sync";
import { assertSafeRaceDbUrl } from "./support/race-db-url";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const P = "race-5289a";
const MEMBER_ID = `${P}-member`;
const LODGE_ID = `${P}-lodge`;
const BOOKING_ID = `${P}-booking`;
const PAYMENT_ID = `${P}-payment`;
const INVOICE_ID = `${P}-invoice`;
// A second invoice the note was allocated to, with no payment; its link sorts BEFORE the payment's.
const OTHER_INVOICE_ID = `${P}-ainvoice`;
const NOTE_ID = `${P}-note`;
const MODIFICATION_ID = `${P}-modification`;
const PAYMENT_CENTS = 50_000;
const NOTE_CENTS = 10_000;
const CHECK_IN = new Date("2027-12-01T00:00:00.000Z");
const CHECK_OUT = new Date("2027-12-02T00:00:00.000Z");

let prisma: (typeof import("@/lib/prisma"))["prisma"];

(RUN ? describe : describe.skip)(
  "a correction voided in Xero is taken back off its bank-transfer payment - real PostgreSQL (#5289 A, INV-PAY-126)",
  { timeout: 60_000 },
  () => {
    async function clean() {
      await releaseBookingJournalForTeardown(prisma, [BOOKING_ID]);
      await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.bookingEvent.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.auditLog.deleteMany({ where: { OR: [{ entityId: { in: [BOOKING_ID, PAYMENT_ID] } }, { targetId: BOOKING_ID }, { metadata: { path: ["creditNoteId"], equals: NOTE_ID } }] } });
      await prisma.xeroObjectLink.deleteMany({ where: { OR: [{ localId: { in: [PAYMENT_ID, BOOKING_ID, MODIFICATION_ID] } }, { xeroObjectId: { in: [INVOICE_ID, OTHER_INVOICE_ID, NOTE_ID] } }] } });
      await prisma.xeroSyncOperation.deleteMany({ where: { localId: { in: [PAYMENT_ID, BOOKING_ID, MODIFICATION_ID] } } });
      await prisma.bookingModification.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.paymentTransaction.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.payment.deleteMany({ where: { id: PAYMENT_ID } });
      await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
    }

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL, "#5289 A voided modification note recount");
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      await clean();
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
      await prisma.member.create({
        data: { id: MEMBER_ID, email: `${MEMBER_ID}@example.invalid`, passwordHash: "not-a-real-password", firstName: "Voided", lastName: "Correction", ageTier: "ADULT" },
      });
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 5289a Lodge", slug: P } });
    }, 60_000);

    beforeEach(async () => {
      await clean();
      vi.restoreAllMocks();
    });

    afterAll(async () => {
      if (!prisma) return;
      vi.restoreAllMocks();
      await clean();
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
    });

    function allocationLinkId(invoiceId: string) {
      return `${NOTE_ID}:${invoiceId}:${NOTE_CENTS}`;
    }

    /**
     * A $500 bank transfer the settle kept at the stored figure (its receipt
     * captured with the keep's reason), and an edit's $100 invoice correction,
     * synced AUTHORISED and allocated to the invoice, so the payment shows
     * $100 refunded; `alsoOther` allocates it to a second invoice too.
     */
    async function seed(options: { alsoOther?: boolean } = {}) {
      await prisma.booking.create({
        data: { id: BOOKING_ID, memberId: MEMBER_ID, lodgeId: LODGE_ID, checkIn: CHECK_IN, checkOut: CHECK_OUT, status: "PAID", totalPriceCents: 40_000, finalPriceCents: 40_000 },
      });
      await prisma.payment.create({
        data: {
          id: PAYMENT_ID, bookingId: BOOKING_ID, amountCents: PAYMENT_CENTS, source: "INTERNET_BANKING", status: "PARTIALLY_REFUNDED", refundedAmountCents: NOTE_CENTS,
          reference: "BOOKING-RACE5289A", xeroInvoiceId: INVOICE_ID, xeroInvoiceNumber: "INV-5289A",
          transactions: {
            create: {
              kind: "PRIMARY", source: "INTERNET_BANKING", amountCents: PAYMENT_CENTS, status: "SUCCEEDED", refundedAmountCents: 0,
              reference: "BOOKING-RACE5289A", reason: "xero_invoice_paid_reconciliation", xeroInvoiceId: INVOICE_ID, xeroInvoiceNumber: "INV-5289A",
            },
          },
        },
      });
      await prisma.xeroObjectLink.create({
        data: { localModel: "Payment", localId: PAYMENT_ID, xeroObjectType: "INVOICE", xeroObjectId: INVOICE_ID, role: "PRIMARY_INVOICE", active: true },
      });
      await prisma.bookingModification.create({
        data: { id: MODIFICATION_ID, bookingId: BOOKING_ID, memberId: MEMBER_ID, modificationType: "BATCH_MODIFY", previousData: {}, newData: {}, priceDiffCents: -NOTE_CENTS, changeFeeCents: 0 },
      });
      await prisma.xeroSyncOperation.create({
        data: {
          direction: "OUTBOUND", entityType: "CREDIT_NOTE", operationType: "CREATE", localModel: "BookingModification", localId: MODIFICATION_ID,
          idempotencyKey: `${P}-mod-credit-note`, correlationKey: `${P}-mod-credit-note`, status: "SUCCEEDED", xeroObjectType: "CREDIT_NOTE", xeroObjectId: NOTE_ID,
          requestPayload: { invoiceId: INVOICE_ID, refundAmountCents: NOTE_CENTS, noteWording: "invoice-correction" },
        },
      });
      const syncedAt = "2026-06-29T12:00:00.000Z";
      await prisma.xeroObjectLink.create({
        data: {
          localModel: "BookingModification", localId: MODIFICATION_ID, xeroObjectType: "CREDIT_NOTE", xeroObjectId: NOTE_ID, role: "MODIFICATION_CREDIT_NOTE", active: true,
          metadata: { status: "AUTHORISED", total: NOTE_CENTS / 100, providerUpdatedAt: syncedAt },
        },
      });
      for (const invoiceId of options.alsoOther ? [OTHER_INVOICE_ID, INVOICE_ID] : [INVOICE_ID]) {
        await prisma.xeroObjectLink.create({
          data: {
            localModel: "BookingModification", localId: MODIFICATION_ID, xeroObjectType: "ALLOCATION", xeroObjectId: allocationLinkId(invoiceId),
            role: "MODIFICATION_CREDIT_NOTE_ALLOCATION", active: true, metadata: { creditNoteId: NOTE_ID, invoiceId, amountCents: NOTE_CENTS, providerUpdatedAt: syncedAt },
          },
        });
      }
    }

    /** The sync's first reading of the note is its final one: cancelled in Xero, its allocations removed. */
    function syncCancelled(status: "VOIDED" | "DELETED") {
      return syncFakeXeroCreditNote({
        creditNoteID: NOTE_ID, creditNoteNumber: "CN-5289A", status, total: NOTE_CENTS / 100, appliedAmount: 0, remainingCredit: 0,
        updatedDateUTC: new Date("2026-06-30T12:00:00.000Z"), allocations: [], payments: [],
      });
    }

    const payment = () => prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID }, select: { refundedAmountCents: true, status: true } });
    const activeAllocations = async () =>
      (await prisma.xeroObjectLink.findMany({ where: { xeroObjectType: "ALLOCATION", localId: MODIFICATION_ID, active: true }, select: { xeroObjectId: true } })).map((link) => link.xeroObjectId);

    it.each(["VOIDED", "DELETED"] as const)("MUTATION (D1): a %s reading with no allocations takes the 100-dollar correction back off: nothing refunded, the status refundedTotalStatus gives, and the allocation turned off", async (status) => {
      await seed();
      expect(await payment()).toEqual({ refundedAmountCents: NOTE_CENTS, status: "PARTIALLY_REFUNDED" });
      await syncCancelled(status);
      // Captured, so nothing refunded returns it to SUCCEEDED (`refundedTotalStatus`), never to its uncaptured state.
      expect(await payment()).toEqual({ refundedAmountCents: 0, status: "SUCCEEDED" });
      expect(await activeAllocations()).toEqual([]);
    });

    it("MUTATION (active links only): a removal that throws after the first of two links finishes the second on the retry", async () => {
      await seed({ alsoOther: true });
      const xeroSync = await import("@/lib/xero-sync");
      const original = xeroSync.upsertXeroObjectLink;
      const failure = new Error("race-5289a second removal failed");
      const spy = vi.spyOn(xeroSync, "upsertXeroObjectLink").mockImplementation((async (...args: Parameters<typeof original>) => {
        if (args[0].xeroObjectId === allocationLinkId(INVOICE_ID) && args[0].active === false) throw failure;
        return original(...args);
      }) as never);
      try {
        await expect(syncCancelled("VOIDED")).rejects.toBe(failure);
      } finally {
        spy.mockRestore();
      }
      // The first link went off; the payment's write rolled back with its decision.
      expect(await activeAllocations()).toEqual([allocationLinkId(INVOICE_ID)]);
      expect(await payment()).toEqual({ refundedAmountCents: NOTE_CENTS, status: "PARTIALLY_REFUNDED" });

      // The retried event reads the same final note and finds only the link still active.
      await syncCancelled("VOIDED");
      expect(await activeAllocations()).toEqual([]);
      expect(await payment()).toEqual({ refundedAmountCents: 0, status: "SUCCEEDED" });
    });

    // #5289 review: the booking repair tool sees only active links, so it reads the retired allocation as missing
    // and offers its backfill from the completed allocation operation. It takes no Payment row, so it never
    // switches the retired row (and the $100 its metadata counts) back on; a link that is truly missing it creates.
    it("MUTATION (repair backfill): the repair tool never switches a retired allocation back on; a missing one it creates bare", async () => {
      const { applyActionsForPass } = await import("@/lib/xero-booking-repair-passes");
      const { upsertXeroObjectLink } = await import("@/lib/xero-sync");
      const backfill = (xeroObjectId: string) => ({
        key: `${P}-backfill-${xeroObjectId}`, type: "SYNC_BOOKING_SCOPED_LINK", status: "planned", safeToAutoApply: true,
        payload: { localModel: "BookingModification", localId: MODIFICATION_ID, xeroObjectType: "ALLOCATION", xeroObjectId, role: "MODIFICATION_CREDIT_NOTE_ALLOCATION" },
      });
      await seed();
      await syncCancelled("VOIDED");
      const missingId = `${NOTE_ID}:${OTHER_INVOICE_ID}:backfilled`;
      const actions = [backfill(allocationLinkId(INVOICE_ID)), backfill(missingId)];
      await applyActionsForPass([{ bookingId: BOOKING_ID, actions } as never], { prisma, upsertXeroObjectLink } as never, false, {} as never);

      expect(actions.map((action) => action.status)).toEqual(["manual_review", "applied"]);
      expect(await activeAllocations()).toEqual([missingId]);
      // A bare row carries no amounts, so it counts nothing; the next sync of the note writes it.
      expect(await prisma.xeroObjectLink.findFirstOrThrow({ where: { xeroObjectId: missingId }, select: { metadata: true } })).toEqual({ metadata: null });
      await syncCancelled("VOIDED");
      expect(await payment()).toEqual({ refundedAmountCents: 0, status: "SUCCEEDED" });
    });
  },
);
