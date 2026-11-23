/**
 * Real-PostgreSQL proof of #4444 (`INV-PAY-126`): the inbound credit-note
 * recount finds a card payment's earlier edit notes by its Xero invoice, as it
 * finds a bank transfer's (#3979), so a later note's sync keeps them.
 *
 * The bug: $400 captured by card and invoiced. Two edits refund $50 and $30,
 * each with a modification credit note anchored on the edit and allocated to
 * the card payment's invoice. The inbound sync links an edit's note to the
 * edit, not the payment, and only a bank transfer's notes were found by
 * invoice, so the second note's recount (`repairRefundedPaymentBusinessState`)
 * read $30, not $80: the Stripe raise-only floor kept the ledger but raised a
 * false "Xero may be missing a credit note" alert.
 *
 * The cap (owner decision 23 Nov 2026, #4444): a card payment's recounted
 * total never rises above the refunds Stripe recorded
 * (`capCardRefundedTotalAtStripeRefunds`, the #3653 organiser-child cap), so
 * two notes for one refund cannot push it past Stripe, and a total Xero shows
 * before Stripe's sync waits for that sync.
 *
 * The trace first: since #3993 an edit refunded to the card queues the
 * payment's own refund note and no modification note
 * (`queueXeroBookingEditSettlement`), so no current writer raises both for one
 * refund. The edit notes below are the older shape - a card edit's note raised
 * as a modification note and allocated to an invoice that still owed - linked
 * as the outbound writer and the inbound sync link them.
 *
 * Ordinary Vitest runs skip the whole file; CI's `realdb-all` job runs it
 * against its disposable loopback PostgreSQL (#4458). It owns and cleans its own
 * `race-4444-` fixtures. No Stripe or Xero call is made: the refunds are the
 * payloads Stripe sends, and Xero is read from a fake client.
 */
import type Stripe from "stripe";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { releaseBookingJournalForTeardown } from "./support/booking-financial-history-teardown";

import { assertSafeRaceDbUrl } from "./support/race-db-url";
import { resetStripeRaceHooks } from "./support/stripe-race-double";

/** The one shared double: the LAST file to register a factory wins, so every realdb file registers this same one. */
vi.mock("@/lib/stripe", async (importOriginal) =>
  (await import("./support/stripe-race-double")).stripeRaceDouble(await importOriginal()),
);

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const P = "race-4444";
const MEMBER_ID = `${P}-member`;
const LODGE_ID = `${P}-lodge`;
const BOOKING_ID = `${P}-booking`;
const PAYMENT_ID = `${P}-payment`;
const EDIT_1 = `${P}-edit-1`;
const EDIT_2 = `${P}-edit-2`;
const INVOICE = `${P}-inv`;
const INTENT = "pi_race_4444";
const CHARGE = "ch_race_4444";
const NIGHT = new Date("2026-08-01T00:00:00.000Z");
const CHECK_OUT = new Date("2026-08-03T00:00:00.000Z");

const PAID_CENTS = 40_000;
const FIRST_CENTS = 5_000;
const SECOND_CENTS = 3_000;
const FIRST_NOTE = `${P}-cn-1`;
const SECOND_NOTE = `${P}-cn-2`;
const OLD_REFUND_NOTE = `${P}-cn-refund`;
const FIRST_REFUND = "re_race_4444_1";
const SECOND_REFUND = "re_race_4444_2";

const LEDGER_MIGRATION = "20260509090000_enrich_payment_refund_ledger";
const CUTOFF_MIGRATION = "20261115010000_card_refund_failed_later_cutoff";

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let syncRefundsFromStripeCharge: (typeof import("@/lib/payment-transactions"))["syncRefundsFromStripeCharge"];
let queueXeroBookingEditSettlement: (typeof import("@/lib/xero-booking-edit-settlement"))["queueXeroBookingEditSettlement"];
/** When a refund was made: after both migrations its writers read finished on this database. */
let refundCreatedSeconds = 0;

(RUN ? describe : describe.skip)(
  "the inbound recount keeps a card payment's earlier edit notes - real PostgreSQL (#4444)",
  { timeout: 60_000 },
  () => {
    let divergenceAlerts: string[] = [];
    /** Each note's Xero `UpdatedDateUTC`, advanced per reading so a later one is never refused as stale (#4288). */
    let xeroClock = 0;

    async function deletePaymentRows() {
      const localIds = [PAYMENT_ID, BOOKING_ID, EDIT_1, EDIT_2];
      await prisma.auditLog.deleteMany({ where: { OR: [{ targetId: BOOKING_ID }, { entityId: { startsWith: P } }] } });
      await prisma.bookingEvent.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.xeroSyncOperation.deleteMany({ where: { OR: [{ localId: { in: localIds } }, { xeroObjectId: { startsWith: P } }] } });
      await prisma.xeroObjectLink.deleteMany({ where: { OR: [{ localId: { in: localIds } }, { xeroObjectId: { startsWith: P } }] } });
      // #4627: the doors post journal batches bridged to these lines; release them first.
      await releaseBookingJournalForTeardown(prisma, [BOOKING_ID]);
      await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.bookingModification.deleteMany({ where: { id: { in: [EDIT_1, EDIT_2] } } });
      await prisma.paymentRefund.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.paymentTransaction.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.payment.deleteMany({ where: { id: PAYMENT_ID } });
    }

    async function deleteFixtures() {
      await deletePaymentRows();
      await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
    }

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL, "#4444 card recount earlier edit note");
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      ({ syncRefundsFromStripeCharge } = await import("@/lib/payment-transactions"));
      ({ queueXeroBookingEditSettlement } = await import("@/lib/xero-booking-edit-settlement"));

      // Refunds made on this install since the refund ledger and the failed-later cutoff arrived. Read, never rewritten.
      const rows = await prisma.$queryRaw<Array<{ finished_at: Date | null }>>`
        SELECT "finished_at" FROM "_prisma_migrations" WHERE "migration_name" IN (${LEDGER_MIGRATION}, ${CUTOFF_MIGRATION})`;
      if (rows.length !== 2 || rows.some((row) => row.finished_at === null)) {
        throw new Error("The race database lacks the refund ledger migrations: run prisma migrate deploy against it first.");
      }
      refundCreatedSeconds = Math.max(...rows.map((row) => Math.floor(row.finished_at!.getTime() / 1000))) + 3_600;

      await deleteFixtures();
      await prisma.member.create({
        data: { id: MEMBER_ID, email: `${MEMBER_ID}@example.invalid`, passwordHash: "not-a-real-password", firstName: "Card", lastName: "Recount", ageTier: "ADULT" },
      });
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4444 Lodge", slug: P } });
      await prisma.booking.create({
        data: {
          id: BOOKING_ID, memberId: MEMBER_ID, lodgeId: LODGE_ID, checkIn: NIGHT, checkOut: CHECK_OUT,
          status: "CONFIRMED", totalPriceCents: PAID_CENTS, finalPriceCents: PAID_CENTS,
        },
      });
    });

    beforeEach(async () => {
      await deletePaymentRows();
      await prisma.booking.update({ where: { id: BOOKING_ID }, data: { organiserSettled: false } });
      vi.restoreAllMocks();
      divergenceAlerts = [];
      xeroClock = 0;
      const alerts = await import("@/lib/xero-error-alert");
      vi.spyOn(alerts, "notifyXeroSyncError").mockImplementation((async (alert: { errorType: string; errorMessage: string }) => {
        if (alert.errorType === "refund-ledger-divergence") divergenceAlerts.push(alert.errorMessage);
      }) as never);
      await seedCardPayment();
    });

    afterEach(() => {
      resetStripeRaceHooks();
    });

    afterAll(async () => {
      if (!prisma) return;
      vi.restoreAllMocks();
      await deleteFixtures();
    });

    // ---------------------------------------------------------------- fixtures

    /** $400 captured by card and invoiced in Xero, and the two edits that each lowered the price. */
    async function seedCardPayment() {
      await prisma.payment.create({
        data: {
          id: PAYMENT_ID, bookingId: BOOKING_ID, amountCents: PAID_CENTS, source: "STRIPE", status: "SUCCEEDED",
          stripePaymentIntentId: INTENT, xeroInvoiceId: INVOICE,
        },
      });
      await prisma.paymentTransaction.create({
        data: {
          id: `${P}-txn`, paymentId: PAYMENT_ID, kind: "PRIMARY", source: "STRIPE", stripePaymentIntentId: INTENT,
          amountCents: PAID_CENTS, status: "SUCCEEDED", createdAt: new Date(Date.UTC(2026, 4, 1)),
        },
      });
      for (const [id, cents] of [[EDIT_1, FIRST_CENTS], [EDIT_2, SECOND_CENTS]] as const) {
        await prisma.bookingModification.create({
          data: {
            id, bookingId: BOOKING_ID, memberId: MEMBER_ID, modificationType: "GUEST_REMOVE",
            previousData: {}, newData: {}, priceDiffCents: -cents,
          },
        });
      }
    }

    /** A Stripe refund as `charge.refunded` carries it. */
    const stripeRefund = (id: string, cents: number): Stripe.Refund =>
      ({
        id, object: "refund", amount: cents, currency: "nzd", status: "succeeded", reason: "requested_by_customer",
        created: refundCreatedSeconds, charge: CHARGE, payment_intent: INTENT, metadata: {},
      }) as unknown as Stripe.Refund;

    /** The `charge.refunded` sync: Stripe lists every refund on the charge. */
    const syncCharge = (refunds: Stripe.Refund[]) =>
      syncRefundsFromStripeCharge({
        paymentIntentId: INTENT,
        stripeChargeId: CHARGE,
        refundedAmountCents: refunds.reduce((sum, refund) => sum + refund.amount, 0),
        refunds: refunds as never,
      });

    /**
     * An edit's card refund raised as a modification note, as the outbound
     * writer leaves it: its CREATE row (the method it was worded with) and its
     * link on the edit.
     */
    async function editNote(editId: string, noteId: string, cents: number) {
      await prisma.xeroSyncOperation.create({
        data: {
          direction: "OUTBOUND", entityType: "CREDIT_NOTE", operationType: "CREATE", status: "SUCCEEDED",
          localModel: "BookingModification", localId: editId, xeroObjectType: "CREDIT_NOTE", xeroObjectId: noteId,
          queueType: "MODIFICATION_CREDIT_NOTE",
          requestPayload: { queueType: "MODIFICATION_CREDIT_NOTE", bookingId: BOOKING_ID, bookingModificationId: editId, refundAmountCents: cents, refundMethod: "card" },
        },
      });
      await prisma.xeroObjectLink.create({
        data: {
          localModel: "BookingModification", localId: editId, xeroObjectType: "CREDIT_NOTE", xeroObjectId: noteId,
          xeroObjectNumber: `CN-${noteId}`, role: "MODIFICATION_CREDIT_NOTE", active: true,
          metadata: { amountCents: cents, invoiceId: INVOICE },
        },
      });
    }

    /** The inbound reconcile of a note, read from a fake Xero (no provider call). */
    async function inbound(noteId: string, cents: number, { allocatedTo = INVOICE as string | null } = {}) {
      xeroClock += 1;
      const note = {
        creditNoteID: noteId, creditNoteNumber: `CN-${noteId}`, status: "AUTHORISED", total: cents / 100,
        appliedAmount: allocatedTo ? cents / 100 : 0, remainingCredit: allocatedTo ? 0 : cents / 100,
        updatedDateUTC: new Date(Date.UTC(2026, 5, 1, 0, xeroClock)).toISOString(),
        allocations: allocatedTo ? [{ invoice: { invoiceID: allocatedTo }, amount: cents / 100 }] : [],
        payments: [],
      };
      const xero = { accountingApi: { getCreditNote: async () => ({ body: { creditNotes: [note] } }) } };
      const apiClient = await import("@/lib/xero-api-client");
      const spies = [
        vi.spyOn(apiClient, "getAuthenticatedXeroClient").mockResolvedValue({ xero, tenantId: "tenant-4444" } as never),
        vi.spyOn(apiClient, "callXeroApi").mockImplementation(((call: () => unknown) => call()) as never),
      ];
      try {
        const { reconcileXeroCreditNote } = await import("@/lib/xero-inbound/credit-note");
        return await reconcileXeroCreditNote(noteId);
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
    }

    const payment = () =>
      prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID }, select: { refundedAmountCents: true, status: true } });

    /** Both edits' notes synced in turn, each after the Stripe refunds `stripeHolds` says were recorded by then. */
    async function bothEditNotesSynced(stripeHolds: { afterFirst: Stripe.Refund[]; afterSecond: Stripe.Refund[] }) {
      await syncCharge(stripeHolds.afterFirst);
      await editNote(EDIT_1, FIRST_NOTE, FIRST_CENTS);
      await inbound(FIRST_NOTE, FIRST_CENTS);
      if (stripeHolds.afterSecond.length > stripeHolds.afterFirst.length) await syncCharge(stripeHolds.afterSecond);
      await editNote(EDIT_2, SECOND_NOTE, SECOND_CENTS);
      await inbound(SECOND_NOTE, SECOND_CENTS);
    }
    const FIRST = stripeRefund(FIRST_REFUND, FIRST_CENTS);
    const SECOND = stripeRefund(SECOND_REFUND, SECOND_CENTS);

    // ---------------------------------------------------------------- trace

    it("trace: an edit refunded to the card queues the payment's own refund note and no modification note (#3993)", async () => {
      await syncCharge([FIRST]);
      await queueXeroBookingEditSettlement({
        bookingId: BOOKING_ID, bookingModificationId: EDIT_1, paymentId: PAYMENT_ID,
        hasIssuedXeroInvoice: true, originalPaymentStatus: "SUCCEEDED", priceDiffCents: -FIRST_CENTS,
        settlementMethod: "card", settlementAmountCents: FIRST_CENTS, refundedThroughStripe: true,
      });

      const queued = await prisma.xeroSyncOperation.findMany({
        where: { direction: "OUTBOUND", entityType: "CREDIT_NOTE", operationType: "CREATE", localId: { in: [PAYMENT_ID, BOOKING_ID, EDIT_1] } },
        select: { localModel: true, queueType: true, requestPayload: true },
      });
      expect(queued).toEqual([
        expect.objectContaining({ localModel: "Payment", queueType: "REFUND_CREDIT_NOTE", requestPayload: expect.objectContaining({ refundAmountCents: FIRST_CENTS, refundMethod: "card" }) }),
      ]);
    });

    // ---------------------------------------------------------------- proofs

    it("MUTATION (1): Stripe holds $80; the second note's recount reads both notes - no write, no divergence alert", async () => {
      await bothEditNotesSynced({ afterFirst: [FIRST], afterSecond: [FIRST, SECOND] });

      // Before #4444: $30 read, the floor kept $80 and alerted.
      expect(await payment()).toEqual({ refundedAmountCents: FIRST_CENTS + SECOND_CENTS, status: "PARTIALLY_REFUNDED" });
      expect(divergenceAlerts).toEqual([]);
    });

    it("MUTATION (2): Stripe has recorded only the $50; the recount reads $80 but waits for Stripe, then follows its sync", async () => {
      await bothEditNotesSynced({ afterFirst: [FIRST], afterSecond: [FIRST] });

      // Before #4444: $30 read, below the $50 ledger - kept at $50 and alerted.
      // Now $80 read, capped at the $50 Stripe recorded (owner decision 23 Nov 2026): no raise, no alert.
      expect(await payment()).toEqual({ refundedAmountCents: FIRST_CENTS, status: "PARTIALLY_REFUNDED" });
      expect(divergenceAlerts).toEqual([]);

      // Stripe's sync then records the $30: the total follows, and a later recount keeps it without an alert.
      await syncCharge([FIRST, SECOND]);
      expect(await payment()).toEqual({ refundedAmountCents: FIRST_CENTS + SECOND_CENTS, status: "PARTIALLY_REFUNDED" });
      await inbound(SECOND_NOTE, SECOND_CENTS);
      expect(await payment()).toEqual({ refundedAmountCents: FIRST_CENTS + SECOND_CENTS, status: "PARTIALLY_REFUNDED" });
      expect(divergenceAlerts).toEqual([]);
    });

    // The cap at Stripe's refunds hides a card double count here; the count-once
    // mutation is caught by this test's unit twin (the cap set aside) and the
    // bank-transfer cases in xero-credit-note-repairs and allocation-write-real-rules.
    it("(3): a note linked to the payment as its refund note and allocated to its invoice counts once", async () => {
      await syncCharge([FIRST]);
      await editNote(EDIT_1, FIRST_NOTE, FIRST_CENTS);
      // The same note also linked as the payment's refund note, as a refund-note repair links one.
      await prisma.xeroObjectLink.create({
        data: {
          localModel: "Payment", localId: PAYMENT_ID, xeroObjectType: "CREDIT_NOTE", xeroObjectId: FIRST_NOTE,
          xeroObjectNumber: `CN-${FIRST_NOTE}`, role: "REFUND_CREDIT_NOTE", active: true,
          metadata: { amountCents: FIRST_CENTS, status: "AUTHORISED", total: FIRST_CENTS / 100 },
        },
      });
      await inbound(FIRST_NOTE, FIRST_CENTS);
      // Synced itself: once as the payment's note, not again by its allocation.
      expect((await payment()).refundedAmountCents).toBe(FIRST_CENTS);
      await syncCharge([FIRST, SECOND]);
      await editNote(EDIT_2, SECOND_NOTE, SECOND_CENTS);
      await inbound(SECOND_NOTE, SECOND_CENTS);

      // Read from its links by the later note: $50 + $30, never $50 twice.
      expect(await payment()).toEqual({ refundedAmountCents: FIRST_CENTS + SECOND_CENTS, status: "PARTIALLY_REFUNDED" });
    });

    it("(4): an organiser-settled card child is still capped at the refunds Stripe recorded", async () => {
      await prisma.booking.update({ where: { id: BOOKING_ID }, data: { organiserSettled: true } });
      await bothEditNotesSynced({ afterFirst: [FIRST], afterSecond: [FIRST] });

      // #3653 (`INV-PAY-114`): the notes read $80; Stripe recorded $50 for the child.
      expect((await payment()).refundedAmountCents).toBe(FIRST_CENTS);
    });

    it("MUTATION (6) old stored shape, #3993 review: one $50 card refund recorded as both the edit's allocated note and a refund note never passes Stripe's figure", async () => {
      // Before #3993 one card refund of a price cut could leave two notes: the
      // edit's modification note (here allocated to the invoice) and the refund
      // note the nightly self-heal raised on the payment for the same refund.
      await syncCharge([FIRST]);
      await prisma.xeroObjectLink.create({
        data: {
          localModel: "Payment", localId: PAYMENT_ID, xeroObjectType: "CREDIT_NOTE", xeroObjectId: OLD_REFUND_NOTE,
          xeroObjectNumber: `CN-${OLD_REFUND_NOTE}`, role: "REFUND_CREDIT_NOTE", active: true,
          metadata: { amountCents: FIRST_CENTS, status: "AUTHORISED", total: FIRST_CENTS / 100 },
        },
      });
      await editNote(EDIT_1, FIRST_NOTE, FIRST_CENTS);
      await inbound(FIRST_NOTE, FIRST_CENTS);
      // The edit note's own sync reads both, $50 + $50; capped at the $50 Stripe recorded.
      expect((await payment()).refundedAmountCents).toBe(FIRST_CENTS);

      await syncCharge([FIRST, SECOND]);
      await editNote(EDIT_2, SECOND_NOTE, SECOND_CENTS);
      await inbound(SECOND_NOTE, SECOND_CENTS);

      // A later note's recount reads the links: $50 + $50 + $30 = $130. Two note
      // ids, so the count-once rule does not apply; the cap at the $80 Stripe
      // recorded does (owner decision 23 Nov 2026, #4444). No alert: the floor
      // alerts only below the ledger.
      expect(await payment()).toEqual({ refundedAmountCents: FIRST_CENTS + SECOND_CENTS, status: "PARTIALLY_REFUNDED" });
      expect(divergenceAlerts).toEqual([]);
    });

    it("(5): an allocation Xero removed (its link retired, #4447) is not counted", async () => {
      // Stripe holds both refunds, so the cap allows $80 and only the alert tells the counts apart.
      await syncCharge([FIRST, SECOND]);
      await editNote(EDIT_1, FIRST_NOTE, FIRST_CENTS);
      await inbound(FIRST_NOTE, FIRST_CENTS);
      // Xero then lists the first note unallocated: its allocation link is turned off.
      await inbound(FIRST_NOTE, FIRST_CENTS, { allocatedTo: null });
      expect(
        await prisma.xeroObjectLink.count({ where: { xeroObjectType: "ALLOCATION", metadata: { path: ["creditNoteId"], equals: FIRST_NOTE }, active: true } }),
      ).toBe(0);

      await editNote(EDIT_2, SECOND_NOTE, SECOND_CENTS);
      divergenceAlerts = [];
      await inbound(SECOND_NOTE, SECOND_CENTS);

      // Counting the retired $50 would read $80, no alert. The links read $30; the card floor keeps the $80 recorded, and says so.
      expect((await payment()).refundedAmountCents).toBe(FIRST_CENTS + SECOND_CENTS);
      expect(divergenceAlerts).toHaveLength(1);
    });
  },
);
