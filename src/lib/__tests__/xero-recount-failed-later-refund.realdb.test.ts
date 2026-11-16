/**
 * Real-PostgreSQL proof of #4370 (`INV-PAY-128`, `INV-PAY-151`; owner decision
 * 11 Nov 2026, option (a)): the inbound credit-note recount takes every card
 * refund Stripe failed later off once - a reversed one through its live
 * reversal, an older one through the failure record.
 *
 * The bug, through the real writers: $200 captured by card; an $80 refund made
 * by the runner and synced, its $80 refund note in Xero; Stripe then fails it
 * (`recordRefusedCardRefund`), which takes the $80 off and raises a row owing it.
 * The note stays in Xero. A later $30 refund's note arrives inbound
 * (`reconcileXeroCreditNote`), and the recount (`repairRefundedPaymentBusinessState`)
 * added $80 + $30 - raising the card payment's total over a refund that never
 * happened, and its status with it.
 *
 * Proven here, each through the real sync, refusal writer, close, runner and
 * inbound reconcile:
 *
 * - reversed (#4369): the failure closed "Paid another way" queues a reversal
 *   and a bank note; once both reach Xero the recount reads what went back -
 *   the bank cash and the later $30 - and writes nothing;
 * - the reversal voided in Xero (`retiredCardRefundReversalLink`): it stops being
 *   taken off, as #4369's net coverage reads it, and the failure record does
 *   not take its place;
 * - never reversed: the failure record takes the $80 off once, and never more
 *   than its notes cover above the cash - nothing for a failure never noted;
 * - re-sent by the runner and made: the new refund's note covers cash that went
 *   back, so nothing more comes off.
 *
 * Ordinary Vitest runs skip the whole file; CI's `realdb-all` job runs it
 * against its disposable loopback PostgreSQL (#4458). It owns and cleans its own
 * `race-4370-` fixtures. No Stripe or Xero call is made: the refunds are the
 * payloads Stripe sends, the runner's refund call goes through the shared
 * `@/lib/stripe` double, and Xero is read from a fake client.
 */
import type Stripe from "stripe";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { releaseBookingJournalForTeardown } from "./support/booking-financial-history-teardown";

import { assertSafeRaceDbUrl } from "./support/race-db-url";
import { resetStripeRaceHooks, stripeRaceHooks } from "./support/stripe-race-double";

/** The one shared double: the LAST file to register a factory wins, so every realdb file registers this same one. */
vi.mock("@/lib/stripe", async (importOriginal) =>
  (await import("./support/stripe-race-double")).stripeRaceDouble(await importOriginal()),
);

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const P = "race-4370";
const MEMBER_ID = `${P}-member`;
const OFFICER_ID = `${P}-officer`;
const LODGE_ID = `${P}-lodge`;
const BOOKING_ID = `${P}-booking`;
const PAYMENT_ID = `${P}-payment`;
const TXN_ID = `${P}-txn`;
const OP_ID = `${P}-op`;
const INTENT = "pi_race_4370";
const CHARGE = "ch_race_4370";
const NIGHT = new Date("2026-08-01T00:00:00.000Z");
const CHECK_OUT = new Date("2026-08-02T00:00:00.000Z");
const RAISED_AT = new Date("2026-06-20T00:00:00.000Z");

const PAID_CENTS = 20_000;
const FAILED_CENTS = 8_000;
const LATER_CENTS = 3_000;
const FAILED_REFUND = "re_race_4370_failed";
const LATER_REFUND = "re_race_4370_later";
const FAILED_NOTE = `${P}-cn-failed`;
const LATER_NOTE = `${P}-cn-later`;

const LEDGER_MIGRATION = "20260509090000_enrich_payment_refund_ledger";
const CUTOFF_MIGRATION = "20261115010000_card_refund_failed_later_cutoff";

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let syncRefundsFromStripeCharge: (typeof import("@/lib/payment-transactions"))["syncRefundsFromStripeCharge"];
let recordRefusedCardRefund: (typeof import("@/lib/card-refund-status-sync"))["recordRefusedCardRefund"];
let closeCardRefundPaidAnotherWay: (typeof import("@/lib/card-refund-paid-another-way"))["closeCardRefundPaidAnotherWay"];
let runPaymentRecoveryOperationNow: (typeof import("@/lib/payment-recovery"))["runPaymentRecoveryOperationNow"];
let cardRefundOperationRefundMetadata: (typeof import("@/lib/payment-recovery-keys"))["cardRefundOperationRefundMetadata"];
let upsertXeroObjectLink: (typeof import("@/lib/xero-sync"))["upsertXeroObjectLink"];
let retiredCardRefundReversalLink: (typeof import("@/lib/xero-card-refund-reversal-outbox"))["retiredCardRefundReversalLink"];
let CARD_REFUND_REVERSAL_INVOICE_ROLE: string;
let CLUB_FORMAT_TEST: (typeof import("@/lib/__tests__/support/club-format-fixture"))["CLUB_FORMAT_TEST"];
/** When a refund was made: after both migrations its writers read finished on this database. */
let refundCreatedSeconds = 0;

(RUN ? describe : describe.skip)(
  "the inbound recount takes a card refund Stripe failed later off once - real PostgreSQL (#4370)",
  { timeout: 60_000 },
  () => {
    let divergenceAlerts: string[] = [];

    async function deletePaymentRows() {
      await prisma.alertCooldown.deleteMany({ where: { key: { contains: TXN_ID } } });
      await prisma.auditLog.deleteMany({ where: { OR: [{ targetId: BOOKING_ID }, { entityId: PAYMENT_ID }, { entityId: { startsWith: P } }] } });
      await prisma.bookingEvent.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.xeroSyncOperation.deleteMany({ where: { localId: { in: [PAYMENT_ID, BOOKING_ID] } } });
      await prisma.xeroObjectLink.deleteMany({ where: { localId: { in: [PAYMENT_ID, BOOKING_ID] } } });
      // #4627: the doors post journal batches bridged to these lines; release them first.
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
      await prisma.member.deleteMany({ where: { id: { in: [MEMBER_ID, OFFICER_ID] } } });
    }

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL, "#4370 failed-later refund recount");
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      ({ syncRefundsFromStripeCharge } = await import("@/lib/payment-transactions"));
      ({ recordRefusedCardRefund } = await import("@/lib/card-refund-status-sync"));
      ({ closeCardRefundPaidAnotherWay } = await import("@/lib/card-refund-paid-another-way"));
      ({ runPaymentRecoveryOperationNow } = await import("@/lib/payment-recovery"));
      ({ cardRefundOperationRefundMetadata } = await import("@/lib/payment-recovery-keys"));
      ({ upsertXeroObjectLink } = await import("@/lib/xero-sync"));
      ({ retiredCardRefundReversalLink, CARD_REFUND_REVERSAL_INVOICE_ROLE } = await import("@/lib/xero-card-refund-reversal-outbox"));
      ({ CLUB_FORMAT_TEST } = await import("@/lib/__tests__/support/club-format-fixture"));

      // Refunds made on this install since the refund ledger and the failed-later cutoff arrived. Read, never rewritten.
      const rows = await prisma.$queryRaw<Array<{ finished_at: Date | null }>>`
        SELECT "finished_at" FROM "_prisma_migrations" WHERE "migration_name" IN (${LEDGER_MIGRATION}, ${CUTOFF_MIGRATION})`;
      if (rows.length !== 2 || rows.some((row) => row.finished_at === null)) {
        throw new Error("The race database lacks the refund ledger migrations: run prisma migrate deploy against it first.");
      }
      refundCreatedSeconds = Math.max(...rows.map((row) => Math.floor(row.finished_at!.getTime() / 1000))) + 3_600;

      await deleteFixtures();
      for (const id of [MEMBER_ID, OFFICER_ID]) {
        await prisma.member.create({
          data: { id, email: `${id}@example.invalid`, passwordHash: "not-a-real-password", firstName: "Failed", lastName: "Recount", ageTier: "ADULT" },
        });
      }
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4370 Lodge", slug: P } });
      await prisma.booking.create({
        data: {
          id: BOOKING_ID, memberId: MEMBER_ID, lodgeId: LODGE_ID, checkIn: NIGHT, checkOut: CHECK_OUT,
          status: "CANCELLED", totalPriceCents: PAID_CENTS, finalPriceCents: PAID_CENTS,
        },
      });
    });

    beforeEach(async () => {
      await deletePaymentRows();
      vi.restoreAllMocks();
      divergenceAlerts = [];
      const alerts = await import("@/lib/xero-error-alert");
      vi.spyOn(alerts, "notifyXeroSyncError").mockImplementation((async (alert: { errorType: string; errorMessage: string }) => {
        if (alert.errorType === "refund-ledger-divergence") divergenceAlerts.push(alert.errorMessage);
      }) as never);
      const recoveryAlert = await import("@/lib/payment-recovery-alert");
      vi.spyOn(recoveryAlert, "alertPaymentRecoveryOfficers").mockResolvedValue(null);
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

    /** $200 captured by card, invoiced; the runner's row made the $80 refund. */
    async function seedPaymentAndRefundRow() {
      await prisma.payment.create({
        data: {
          id: PAYMENT_ID, bookingId: BOOKING_ID, amountCents: PAID_CENTS, source: "STRIPE", status: "SUCCEEDED",
          stripePaymentIntentId: INTENT, xeroInvoiceId: `inv-${P}`,
        },
      });
      await prisma.paymentTransaction.create({
        data: {
          id: TXN_ID, paymentId: PAYMENT_ID, kind: "PRIMARY", source: "STRIPE", stripePaymentIntentId: INTENT,
          amountCents: PAID_CENTS, status: "SUCCEEDED", createdAt: new Date(Date.UTC(2026, 4, 1)),
        },
      });
      await prisma.paymentRecoveryOperation.create({
        data: {
          id: OP_ID, type: "REFUND_BOOKING_MODIFICATION", status: "SUCCEEDED", bookingId: BOOKING_ID, paymentId: PAYMENT_ID,
          paymentIntentId: INTENT, amountCents: FAILED_CENTS,
          allocationPlan: [{ paymentTransactionId: TXN_ID, amountCents: FAILED_CENTS }],
          idempotencyKey: `booking_cancel_refund_recovery_${BOOKING_ID}`, attempts: 1, nextRetryAt: null,
          createdAt: RAISED_AT, succeededAt: new Date((refundCreatedSeconds + 30) * 1000),
        },
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

    /** The `charge.refunded` sync: Stripe lists every refund on the charge. */
    const syncCharge = (refunds: Stripe.Refund[]) =>
      syncRefundsFromStripeCharge({
        paymentIntentId: INTENT,
        stripeChargeId: CHARGE,
        refundedAmountCents: refunds.filter((refund) => refund.status === "succeeded").reduce((sum, refund) => sum + refund.amount, 0),
        refunds: refunds as never,
      });

    /** A refund note in Xero, linked to the payment as the outbound writer links it. */
    async function refundNote(noteId: string, cents: number) {
      await prisma.xeroObjectLink.create({
        data: {
          localModel: "Payment", localId: PAYMENT_ID, xeroObjectType: "CREDIT_NOTE", xeroObjectId: noteId,
          xeroObjectNumber: `CN-${noteId}`, role: "REFUND_CREDIT_NOTE", active: true,
          metadata: { amountCents: cents, status: "AUTHORISED", total: cents / 100 },
        },
      });
    }

    /** The $80 refund made, synced and (unless `noted` is false) noted; then Stripe fails it. Returns the row the failure raised. */
    async function failTheRefund({ noted = true }: { noted?: boolean } = {}) {
      await seedPaymentAndRefundRow();
      const made = await stripeRefund(FAILED_REFUND, FAILED_CENTS, "succeeded");
      await syncCharge([made]);
      if (noted) await refundNote(FAILED_NOTE, FAILED_CENTS);
      expect((await payment()).refundedAmountCents).toBe(FAILED_CENTS);

      expect(await recordRefusedCardRefund({ ...made, status: "failed" } as Stripe.Refund)).toBe("recorded");

      expect((await payment()).refundedAmountCents).toBe(0);
      return prisma.paymentRecoveryOperation.findFirstOrThrow({ where: { idempotencyKey: `card_refund_failed_later_${FAILED_REFUND}` } });
    }

    /** The later $30 refund from the Stripe dashboard, synced beside the failed one, and its note. */
    async function laterRefund() {
      const failed = await stripeRefund(FAILED_REFUND, FAILED_CENTS, "failed");
      const later = await stripeRefund(LATER_REFUND, LATER_CENTS, "succeeded", null);
      await syncCharge([failed, later]);
      await refundNote(LATER_NOTE, LATER_CENTS);
    }

    /** The inbound reconcile of a note, read from a fake Xero (no provider call). */
    async function inbound(noteId: string, cents: number) {
      const note = { creditNoteID: noteId, creditNoteNumber: `CN-${noteId}`, status: "AUTHORISED", total: cents / 100, appliedAmount: 0, remainingCredit: 0, allocations: [], payments: [] };
      const xero = { accountingApi: { getCreditNote: async () => ({ body: { creditNotes: [note] } }) } };
      const apiClient = await import("@/lib/xero-api-client");
      const spies = [
        vi.spyOn(apiClient, "getAuthenticatedXeroClient").mockResolvedValue({ xero, tenantId: "tenant-4370" } as never),
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

    /**
     * The failed-later row's runner spent its retries (its re-sends refused), so
     * the treasurer pays the $80 by bank and closes it "Paid another way". The card
     * note covers the close, so it queues a #4369 reversal and a bank note; both
     * then reach Xero and are linked as the outbox links them.
     */
    async function closeWithReversal(rowId: string) {
      await prisma.paymentRecoveryOperation.update({ where: { id: rowId }, data: { status: "FAILED", attempts: 5, nextRetryAt: null } });
      const result = await closeCardRefundPaidAnotherWay({
        operationId: rowId, amountCents: FAILED_CENTS, paidBack: "full", rest: null, expectedOwedCents: FAILED_CENTS,
        note: "Bank transfer, ref RACE 4370", actingMemberId: OFFICER_ID,
      });
      expect(result.xeroQueued).toBe("stripe-reversal-and-bank-note");
      const record = await prisma.manualRefundTask.findFirstOrThrow({ where: { bookingId: BOOKING_ID } });
      await prisma.xeroObjectLink.create({
        data: {
          localModel: "Payment", localId: PAYMENT_ID, xeroObjectType: "INVOICE", xeroObjectId: `${P}-inv-reversal`,
          role: CARD_REFUND_REVERSAL_INVOICE_ROLE, active: true,
          metadata: { closeTaskId: record.id, amountCents: FAILED_CENTS, bookingId: BOOKING_ID },
        },
      });
      await refundNote(`${P}-cn-bank`, FAILED_CENTS);
      // The close recorded the bank cash.
      expect((await payment()).refundedAmountCents).toBe(FAILED_CENTS);
    }

    // ---------------------------------------------------------------- proofs

    it("MUTATION (reversed): after the reversal, a later note's recount reads the bank cash and the later $30 - no write, no alert", async () => {
      const row = await failTheRefund();
      await closeWithReversal(row.id);
      await laterRefund();
      expect(await payment()).toEqual({ refundedAmountCents: FAILED_CENTS + LATER_CENTS, status: "PARTIALLY_REFUNDED" });

      await inbound(LATER_NOTE, LATER_CENTS);

      // Before #4370: $80 + $80 + $30 = $190 raised over Stripe's figure.
      expect(await payment()).toEqual({ refundedAmountCents: FAILED_CENTS + LATER_CENTS, status: "PARTIALLY_REFUNDED" });
      expect(divergenceAlerts).toEqual([]);
    });

    it("the reversal voided in Xero stops being taken off, as #4369's net coverage reads it, and the failure record does not take its place", async () => {
      const row = await failTheRefund();
      await closeWithReversal(row.id);
      await laterRefund();
      // The inbound invoice read's void: the link retired, its cents kept.
      const retired = retiredCardRefundReversalLink(CARD_REFUND_REVERSAL_INVOICE_ROLE, "VOIDED");
      expect(retired).not.toBeNull();
      await upsertXeroObjectLink({
        localModel: "Payment", localId: PAYMENT_ID, xeroObjectType: "INVOICE", xeroObjectId: `${P}-inv-reversal`,
        role: CARD_REFUND_REVERSAL_INVOICE_ROLE, ...retired!,
      });

      await inbound(LATER_NOTE, LATER_CENTS);

      // Every note counted again: $80 + $80 + $30.
      expect(await payment()).toEqual({ refundedAmountCents: 2 * FAILED_CENTS + LATER_CENTS, status: "PARTIALLY_REFUNDED" });
    });

    it("MUTATION (never reversed): the failure record takes the $80 off once - no write, no alert", async () => {
      await failTheRefund();
      await laterRefund();
      expect(await payment()).toEqual({ refundedAmountCents: LATER_CENTS, status: "PARTIALLY_REFUNDED" });

      await inbound(LATER_NOTE, LATER_CENTS);

      // Before #4370: $80 + $30 = $110 against the $30 that went back.
      expect(await payment()).toEqual({ refundedAmountCents: LATER_CENTS, status: "PARTIALLY_REFUNDED" });
      expect(divergenceAlerts).toEqual([]);
    });

    it("MUTATION (sized by the notes): a failure whose note never reached Xero takes nothing off - the recount reads its notes, no alert", async () => {
      await failTheRefund({ noted: false });
      await laterRefund();

      await inbound(LATER_NOTE, LATER_CENTS);

      // Taking the $80 off a $30 note would read $0 and be kept off and alerted by the #1353 floor.
      expect(await payment()).toEqual({ refundedAmountCents: LATER_CENTS, status: "PARTIALLY_REFUNDED" });
      expect(divergenceAlerts).toEqual([]);
    });

    it("re-sent by the runner and made: its own note covers cash that went back, so nothing more comes off", async () => {
      const row = await failTheRefund();
      stripeRaceHooks.refund = async (args) => ({
        id: "re_race_4370_resent", object: "refund", amount: args.amountCents, currency: "nzd", status: "succeeded",
        created: refundCreatedSeconds + 60, charge: CHARGE, payment_intent: args.paymentIntentId, metadata: args.metadata ?? {},
      });
      await runPaymentRecoveryOperationNow(row.id, CLUB_FORMAT_TEST);
      expect((await payment()).refundedAmountCents).toBe(FAILED_CENTS);
      await refundNote(`${P}-cn-resent`, FAILED_CENTS);
      await laterRefund();
      expect((await payment()).refundedAmountCents).toBe(FAILED_CENTS + LATER_CENTS);

      await inbound(LATER_NOTE, LATER_CENTS);

      // $80 + $80 + $30 of notes, less the failed $80: the $110 that went back.
      expect(await payment()).toEqual({ refundedAmountCents: FAILED_CENTS + LATER_CENTS, status: "PARTIALLY_REFUNDED" });
      expect(divergenceAlerts).toEqual([]);
    });
  },
);
