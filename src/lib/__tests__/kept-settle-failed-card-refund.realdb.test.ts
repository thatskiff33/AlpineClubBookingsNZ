/**
 * Real-PostgreSQL proof that a KEPT bank-transfer settle takes a card refund
 * Stripe failed later off the refunded total it decides in its own
 * transaction (#4449 review, item 1; #4370, `INV-PAY-155`).
 *
 * A bank-transfer payment can carry a card capture an edit took; that capture
 * can be refunded, the refund given its own Xero note (#4312) and then failed
 * by Stripe. The note stays in Xero. The keep decides the payment's whole
 * refunded total from its links (`decideLinkedRefundedTotalCents`), on its
 * own locked transaction, so it must subtract that failure as the inbound
 * recount does, or a cancel queued behind it reads a net too high by it.
 *
 * Driven through the REAL writers: the `charge.refunded` sync
 * (`syncRefundsFromStripeCharge`), the failure recorder
 * (`recordRefusedCardRefund`) and the inbound settle
 * (`syncInternetBankingPaymentsForPaidInvoice`). Seeded as their writers
 * leave them: the booking, the payment with its bank receipt and the edit's
 * card capture, the runner's refund row, the invoice link and the two refund
 * notes' links. Stripe answers through the shared race double; no Stripe or
 * Xero call is made.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions,
 * which imports this file so CI reaches it; it cleans its own `race-4449f-`
 * fixtures.
 */
import type Stripe from "stripe";
import type { Invoice } from "xero-node";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { releaseBookingJournalForTeardown } from "./support/booking-financial-history-teardown";

import { assertSafeRaceDbUrl } from "./support/race-db-url";

/** The one shared double: the LAST file to register a factory wins, so every realdb file registers this same one. */
vi.mock("@/lib/stripe", async (importOriginal) =>
  (await import("./support/stripe-race-double")).stripeRaceDouble(await importOriginal()),
);

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const P = "race-4449f";
const MEMBER_ID = `${P}-member`;
const LODGE_ID = `${P}-lodge`;
const BOOKING_ID = `${P}-booking`;
const PAYMENT_ID = `${P}-payment`;
const BANK_TXN_ID = `${P}-bank`;
const CARD_TXN_ID = `${P}-card`;
const OP_ID = `${P}-op`;
const INVOICE_ID = `${P}-invoice`;
const INTENT = "pi_race_4449f";
const CHARGE = "ch_race_4449f";
const CHECK_IN = new Date("2027-10-01T00:00:00.000Z");
const CHECK_OUT = new Date("2027-10-02T00:00:00.000Z");

const PAYMENT_CENTS = 30_000;
const CARD_CENTS = 10_000;
const FAILED_CENTS = 8_000;
const LATER_CENTS = 3_000;
const FAILED_REFUND = "re_race_4449f_failed";
const LATER_REFUND = "re_race_4449f_later";
const FAILED_NOTE = `${P}-cn-failed`;
const LATER_NOTE = `${P}-cn-later`;

const LEDGER_MIGRATION = "20260509090000_enrich_payment_refund_ledger";
const CUTOFF_MIGRATION = "20261115010000_card_refund_failed_later_cutoff";

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let syncRefundsFromStripeCharge: (typeof import("@/lib/payment-transactions"))["syncRefundsFromStripeCharge"];
let recordRefusedCardRefund: (typeof import("@/lib/card-refund-status-sync"))["recordRefusedCardRefund"];
let cardRefundOperationRefundMetadata: (typeof import("@/lib/payment-recovery-keys"))["cardRefundOperationRefundMetadata"];
let paidEffects: typeof import("@/lib/xero-inbound/invoice-paid-effects");
let CLUB_FORMAT_TEST: (typeof import("@/lib/__tests__/support/club-format-fixture"))["CLUB_FORMAT_TEST"];
/** When a refund was made: after both migrations its writers read finished on this database. */
let refundCreatedSeconds = 0;

(RUN ? describe : describe.skip)(
  "a kept bank-transfer settle takes a card refund Stripe failed later off its whole refunded total - real PostgreSQL (#4449, #4370)",
  { timeout: 60_000 },
  () => {
    async function deletePaymentRows() {
      await prisma.alertCooldown.deleteMany({ where: { key: { contains: P } } });
      await prisma.auditLog.deleteMany({ where: { OR: [{ targetId: BOOKING_ID }, { entityId: { in: [BOOKING_ID, PAYMENT_ID] } }] } });
      await prisma.bookingEvent.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.xeroSyncOperation.deleteMany({ where: { localId: { in: [PAYMENT_ID, BOOKING_ID] } } });
      await prisma.xeroObjectLink.deleteMany({ where: { OR: [{ localId: { in: [PAYMENT_ID, BOOKING_ID] } }, { xeroObjectId: INVOICE_ID }] } });
      await releaseBookingJournalForTeardown(prisma, [BOOKING_ID]);
      await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.manualRefundTask.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.paymentRecoveryOperation.deleteMany({ where: { bookingId: BOOKING_ID } });
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
      assertSafeRaceDbUrl(RACE_DB_URL, "#4449 kept settle and a failed-later card refund");
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      ({ syncRefundsFromStripeCharge } = await import("@/lib/payment-transactions"));
      ({ recordRefusedCardRefund } = await import("@/lib/card-refund-status-sync"));
      ({ cardRefundOperationRefundMetadata } = await import("@/lib/payment-recovery-keys"));
      paidEffects = await import("@/lib/xero-inbound/invoice-paid-effects");
      ({ CLUB_FORMAT_TEST } = await import("@/lib/__tests__/support/club-format-fixture"));

      // Refunds made on this install since the refund ledger and the failed-later cutoff arrived. Read, never rewritten.
      const rows = await prisma.$queryRaw<Array<{ finished_at: Date | null }>>`
        SELECT "finished_at" FROM "_prisma_migrations" WHERE "migration_name" IN (${LEDGER_MIGRATION}, ${CUTOFF_MIGRATION})`;
      if (rows.length !== 2 || rows.some((row) => row.finished_at === null)) {
        throw new Error("The race database lacks the refund ledger migrations: run prisma migrate deploy against it first.");
      }
      refundCreatedSeconds = Math.max(...rows.map((row) => Math.floor(row.finished_at!.getTime() / 1000))) + 3_600;

      await deleteFixtures();
      await prisma.member.create({
        data: { id: MEMBER_ID, email: `${MEMBER_ID}@example.invalid`, passwordHash: "not-a-real-password", firstName: "Kept", lastName: "Failed", ageTier: "ADULT" },
      });
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4449f Lodge", slug: P } });
      await prisma.booking.create({
        data: {
          id: BOOKING_ID, memberId: MEMBER_ID, lodgeId: LODGE_ID, checkIn: CHECK_IN, checkOut: CHECK_OUT,
          status: "CONFIRMED", totalPriceCents: PAYMENT_CENTS, finalPriceCents: PAYMENT_CENTS,
        },
      });
    }, 60_000);

    beforeEach(async () => {
      await deletePaymentRows();
      vi.restoreAllMocks();
      const alerts = await import("@/lib/xero-error-alert");
      vi.spyOn(alerts, "notifyXeroSyncError").mockResolvedValue(undefined as never);
      const recoveryAlert = await import("@/lib/payment-recovery-alert");
      vi.spyOn(recoveryAlert, "alertPaymentRecoveryOfficers").mockResolvedValue(null);
    });

    afterAll(async () => {
      if (!prisma) return;
      vi.restoreAllMocks();
      await deleteFixtures();
    });

    /**
     * A $300 bank transfer, invoiced and not yet paid, with a $100 card capture
     * an edit took, and the runner's row that made an $80 refund of it.
     */
    async function seedPayment() {
      await prisma.payment.create({
        data: {
          id: PAYMENT_ID, bookingId: BOOKING_ID, amountCents: PAYMENT_CENTS, source: "INTERNET_BANKING", status: "PENDING",
          reference: "BOOKING-RACE4449F", xeroInvoiceId: INVOICE_ID, xeroInvoiceNumber: "INV-4449F",
        },
      });
      await prisma.paymentTransaction.create({
        data: {
          id: BANK_TXN_ID, paymentId: PAYMENT_ID, kind: "PRIMARY", source: "INTERNET_BANKING", amountCents: PAYMENT_CENTS,
          status: "PENDING", reference: "BOOKING-RACE4449F", reason: "internet_banking_booking_payment",
          xeroInvoiceId: INVOICE_ID, xeroInvoiceNumber: "INV-4449F",
        },
      });
      await prisma.paymentTransaction.create({
        data: {
          id: CARD_TXN_ID, paymentId: PAYMENT_ID, kind: "ADDITIONAL", source: "STRIPE", stripePaymentIntentId: INTENT,
          amountCents: CARD_CENTS, status: "SUCCEEDED", createdAt: new Date("2026-06-01T00:00:00.000Z"),
        },
      });
      await prisma.paymentRecoveryOperation.create({
        data: {
          id: OP_ID, type: "REFUND_BOOKING_MODIFICATION", status: "SUCCEEDED", bookingId: BOOKING_ID, paymentId: PAYMENT_ID,
          paymentIntentId: INTENT, amountCents: FAILED_CENTS,
          allocationPlan: [{ paymentTransactionId: CARD_TXN_ID, amountCents: FAILED_CENTS }],
          idempotencyKey: `booking_modification_refund_${P}`, attempts: 1, nextRetryAt: null,
          createdAt: new Date("2026-06-20T00:00:00.000Z"), succeededAt: new Date((refundCreatedSeconds + 30) * 1000),
        },
      });
      await prisma.xeroObjectLink.create({
        data: { localModel: "Payment", localId: PAYMENT_ID, xeroObjectType: "INVOICE", xeroObjectId: INVOICE_ID, role: "PRIMARY_INVOICE", active: true },
      });
    }

    /** A Stripe refund as `charge.refunded` and `refund.failed` carry it; `madeBy` gives it the runner's metadata. */
    async function stripeRefund(id: string, cents: number, status: string, madeBy: string | null = OP_ID): Promise<Stripe.Refund> {
      const maker = madeBy ? await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { id: madeBy } }) : null;
      return {
        id, object: "refund", amount: cents, currency: "nzd", status, reason: "requested_by_customer",
        created: refundCreatedSeconds, charge: CHARGE, payment_intent: INTENT,
        metadata: maker ? cardRefundOperationRefundMetadata(maker) : {},
      } as unknown as Stripe.Refund;
    }

    const syncCharge = (refunds: Stripe.Refund[]) =>
      syncRefundsFromStripeCharge({
        paymentIntentId: INTENT,
        stripeChargeId: CHARGE,
        refundedAmountCents: refunds.filter((refund) => refund.status === "succeeded").reduce((sum, refund) => sum + refund.amount, 0),
        refunds: refunds as never,
      });

    /** A card refund's own note in Xero (#4312), linked to the payment as the outbound writer links it. */
    async function refundNote(noteId: string, cents: number) {
      await prisma.xeroObjectLink.create({
        data: {
          localModel: "Payment", localId: PAYMENT_ID, xeroObjectType: "CREDIT_NOTE", xeroObjectId: noteId,
          xeroObjectNumber: `CN-${noteId}`, role: "REFUND_CREDIT_NOTE", active: true,
          metadata: { amountCents: cents, status: "AUTHORISED", total: cents / 100 },
        },
      });
    }

    const refunded = () =>
      prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID }, select: { refundedAmountCents: true, status: true } });

    /** Xero reports the invoice PAID with an amount paid it cannot quantify: the settle keeps the stored $300. */
    function settleKept() {
      const invoice = {
        invoiceID: INVOICE_ID,
        invoiceNumber: "INV-4449F",
        status: "PAID",
        amountPaid: "degraded",
        total: PAYMENT_CENTS / 100,
        payments: [{ paymentID: `${P}-xpay`, amount: 0, status: "AUTHORISED" }],
        creditNotes: [],
      } as unknown as Invoice;
      return paidEffects.syncInternetBankingPaymentsForPaidInvoice(invoice, [PAYMENT_ID], CLUB_FORMAT_TEST);
    }

    it("MUTATION (#4449 item 1): the keep subtracts the $80 failure from the $80 and $30 notes, leaving the $30 that went back", async () => {
      await seedPayment();
      // The $80 refund made, synced and noted; then Stripe fails it, which takes the $80 back off the payment.
      const made = await stripeRefund(FAILED_REFUND, FAILED_CENTS, "succeeded");
      await syncCharge([made]);
      await refundNote(FAILED_NOTE, FAILED_CENTS);
      expect((await refunded()).refundedAmountCents).toBe(FAILED_CENTS);
      expect(await recordRefusedCardRefund({ ...made, status: "failed" } as Stripe.Refund)).toBe("recorded");
      expect((await refunded()).refundedAmountCents).toBe(0);
      // A later $30 refund from the Stripe dashboard, synced beside the failed one, and its own note.
      await syncCharge([await stripeRefund(FAILED_REFUND, FAILED_CENTS, "failed"), await stripeRefund(LATER_REFUND, LATER_CENTS, "succeeded", null)]);
      await refundNote(LATER_NOTE, LATER_CENTS);
      expect((await refunded()).refundedAmountCents).toBe(LATER_CENTS);

      await settleKept();

      // Captured at the stored figure, kept; its whole refunded total is the $30 that went back, never $110.
      const receipt = await prisma.paymentTransaction.findUniqueOrThrow({ where: { id: BANK_TXN_ID }, select: { status: true, amountCents: true } });
      expect(receipt).toEqual({ status: "SUCCEEDED", amountCents: PAYMENT_CENTS });
      expect(await refunded()).toEqual({ refundedAmountCents: LATER_CENTS, status: "PARTIALLY_REFUNDED" });
    });
  },
);
