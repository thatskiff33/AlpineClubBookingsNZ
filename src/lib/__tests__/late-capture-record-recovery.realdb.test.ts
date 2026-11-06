/**
 * Real-PostgreSQL proof of #4149 (`INV-PAY-106`, `INV-ADDPAY-037`): a late
 * capture whose automatic refund went out while its record did not is recorded
 * exactly once, and the nightly self-heal never over-notes it.
 *
 * The seed is the state a delivery leaves when it dies after Stripe refunded
 * the late capture and the ledger recorded that refund, but before the record
 * row existed: the booking's own payment captured after its booking was
 * cancelled, marked by the handler's own write, refunded in full, and no
 * `ManualRefundTask` naming it. Then:
 *
 * - Before anything runs, the payment's refund-note gap - the self-heal's
 *   reader - counts the whole capture as uncovered cash: the over-note.
 * - The self-heal's check writes the lost record, and the gap closes.
 * - Two webhook redeliveries racing the self-heal still write ONE record and
 *   ONE `refunded_after_cancellation` entry, and ask Stripe for no refund (the
 *   record row is the claim, under `pg_advisory_xact_lock(1)`).
 * - A redelivery once the record exists asks Stripe nothing.
 * - When the delivery that refunded did write its entry (a lost record write),
 *   the recovery writes only the row and its own recovered entry.
 * - A CHANGE payment, through the real modification handler: an OPEN #2700
 *   task the refund never closed is closed by the redelivery, the self-heal and
 *   a redelivery racing it close it once; and a refunded change capture the
 *   cancel left no claim on (classed `settled_by_cancellation`) is still
 *   recovered from Stripe's refund metadata.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions
 * (#1881), which imports this file so CI reaches it; it owns and cleans its own
 * `race-4149-` fixtures. No Stripe call is made: the refund list goes through
 * the harness's one shared `@/lib/stripe` double (`support/stripe-race-double.ts`).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { releaseBookingJournalForTeardown } from "./support/booking-financial-history-teardown";
import type Stripe from "stripe";

import { assertSafeRaceDbUrl } from "./support/race-db-url";
import { resetStripeRaceHooks, stripeRaceHooks } from "./support/stripe-race-double";

/** The one shared double: the LAST file to register a factory wins, so every realdb file registers this same one. */
vi.mock("@/lib/stripe", async (importOriginal) =>
  (await import("./support/stripe-race-double")).stripeRaceDouble(await importOriginal()),
);

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const MEMBER_ID = "race-4149-member";
const LODGE_ID = "race-4149-lodge";
const BOOKING_ID = "race-4149-booking";
const PAYMENT_ID = "race-4149-payment";
const LATE_TXN = "race-4149-txn-late";
const PAID_TXN = "race-4149-txn-paid";
const LATE_INTENT = "pi_race_4149_late";
const PAID_INTENT = "pi_race_4149_paid";
const NIGHT = new Date("2026-08-01T00:00:00.000Z");
const CHECK_OUT = new Date("2026-08-02T00:00:00.000Z");
const PAID_CENTS = 30_000;
const KEPT_FEE_CENTS = 5_000;
const LATE_CENTS = 24_000;
const REFUND_ENTRY = "booking.payment.refunded_after_cancellation";
const RECOVERED_ENTRY = "booking.payment.auto_refund_record_recovered";
const REFUNDED_ON = new Date("2026-06-25T00:00:00.000Z");
const OUTSIDE_APP_ALERT_KEY = `late-capture-refunded-outside-app:${LATE_INTENT}`;
const SUPERSEDED_ROW_OPENED = new Date("2026-01-01T00:00:00.000Z");
const SUPERSEDED_ROW_CLOSED = new Date("2030-01-01T00:00:00.000Z");
const ALERT_KEYS = [OUTSIDE_APP_ALERT_KEY, `late-capture-double-refund:${LATE_INTENT}`];

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let webhook: typeof import("@/lib/stripe-webhook-service");
let recovery: typeof import("@/lib/late-capture-record-recovery");
let readRefundCreditNoteGap: (typeof import("@/lib/xero-admin-health"))["readRefundCreditNoteGap"];
let deletedBookingModificationRefundReason: (typeof import("@/lib/deleted-booking-modification-payment"))["deletedBookingModificationRefundReason"];
let eventSequence = 0;

/** The late-capture door's refund of the capture, as Stripe lists it. */
function lateCaptureRefund(): Stripe.Refund {
  return {
    id: "re_race_4149_late",
    object: "refund",
    amount: LATE_CENTS,
    currency: "nzd",
    status: "succeeded",
    reason: "requested_by_customer",
    created: Math.floor(REFUNDED_ON.getTime() / 1000),
    charge: `ch_${LATE_INTENT}`,
    payment_intent: LATE_INTENT,
    metadata: { bookingId: BOOKING_ID, reason: "cancelled_booking_late_capture" },
  } as unknown as Stripe.Refund;
}

(RUN ? describe : describe.skip)(
  "a late capture's lost automatic-refund record is written once and never over-noted - real PostgreSQL (#4149)",
  { timeout: 60_000 },
  () => {
    const pendingAuditWrites = new Set<Promise<unknown>>();
    let restoreAuditCreate: (() => void) | undefined;
    let recoveredAuditGate: { release: ReturnType<typeof deferred>; details: string } | undefined;

    function deferred() {
      let resolve!: () => void;
      const promise = new Promise<void>((done) => { resolve = done; });
      return { promise, resolve };
    }

    // logAudit returns before its insert settles. Count polling cannot tell
    // whether an older fixture still has a write waiting to land (#4254).
    async function drainAuditWrites() {
      const failures: unknown[] = [];
      while (pendingAuditWrites.size > 0) {
        const writes = [...pendingAuditWrites];
        const results = await Promise.allSettled(writes);
        for (const write of writes) pendingAuditWrites.delete(write);
        for (const result of results) {
          if (result.status === "rejected") failures.push(result.reason);
        }
      }
      if (failures.length > 0) throw new AggregateError(failures, "Owned recovery audit inserts failed");
    }

    async function deletePaymentRows() {
      await drainAuditWrites();
      await prisma.auditLog.deleteMany({ where: { targetId: BOOKING_ID } });
      await prisma.alertCooldown.deleteMany({ where: { key: { in: ALERT_KEYS } } });
      await prisma.processedWebhookEvent.deleteMany({ where: { eventId: { startsWith: "evt_race_4149_" } } });
      await prisma.webhookLog.deleteMany({ where: { eventId: { startsWith: "evt_race_4149_" } } });
      await prisma.bookingEvent.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.xeroObjectLink.deleteMany({ where: { localId: PAYMENT_ID } });
      await prisma.xeroSyncOperation.deleteMany({ where: { localId: { in: [PAYMENT_ID, BOOKING_ID] } } });
      // #4627: the doors post journal batches bridged to these lines; release them first.
      await releaseBookingJournalForTeardown(prisma, [BOOKING_ID]);
      await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.manualRefundTask.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.paymentRecoveryOperation.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.paymentRefund.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.paymentTransaction.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.payment.deleteMany({ where: { id: PAYMENT_ID } });
      await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
    }

    async function deleteFixtures() {
      await deletePaymentRows();
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
    }

    /**
     * What the dead delivery left: the cancel's own refund of the paid charge
     * (all but a kept fee, its credit note linked in Xero), and the late
     * capture - the handler's marked write - refunded in full with that refund
     * recorded, and no record row.
     */
    async function seedAfterTheCrash(change?: { cancelClaim: boolean; openTask: boolean }, refundRecorded = true) {
      await prisma.booking.create({
        data: {
          id: BOOKING_ID,
          memberId: MEMBER_ID,
          lodgeId: LODGE_ID,
          checkIn: NIGHT,
          checkOut: CHECK_OUT,
          status: "CANCELLED",
          totalPriceCents: PAID_CENTS,
          finalPriceCents: PAID_CENTS,
          // The #2700 raise fires only on a deleted booking.
          deletedAt: change?.openTask ? new Date("2026-06-20T00:00:00.000Z") : null,
        },
      });
      await prisma.payment.create({
        data: {
          id: PAYMENT_ID,
          bookingId: BOOKING_ID,
          amountCents: PAID_CENTS + LATE_CENTS,
          refundedAmountCents: PAID_CENTS - KEPT_FEE_CENTS + (refundRecorded ? LATE_CENTS : 0),
          source: "STRIPE",
          status: "PARTIALLY_REFUNDED",
          stripePaymentIntentId: PAID_INTENT,
          xeroInvoiceId: "inv-race-4149",
          updatedAt: new Date("2026-06-01T00:00:00.000Z"),
          transactions: {
            create: [
              {
                id: PAID_TXN,
                kind: "PRIMARY",
                source: "STRIPE",
                stripePaymentIntentId: PAID_INTENT,
                amountCents: PAID_CENTS,
                refundedAmountCents: PAID_CENTS - KEPT_FEE_CENTS,
                status: "PARTIALLY_REFUNDED",
                createdAt: new Date("2026-05-01T00:00:00.000Z"),
              },
              {
                id: LATE_TXN,
                kind: change ? "ADDITIONAL" : "PRIMARY",
                source: "STRIPE",
                stripePaymentIntentId: LATE_INTENT,
                amountCents: LATE_CENTS,
                // #4170: unrecorded when the process died before the ledger wrote the refund.
                refundedAmountCents: refundRecorded ? LATE_CENTS : 0,
                status: refundRecorded ? "REFUNDED" : "SUCCEEDED",
                // The primary handler's own write, before its refund (#3639);
                // the change handler stamps no marker of its own.
                reason: change ? null : "cancelled_booking_late_capture",
                createdAt: new Date("2026-06-25T00:00:00.000Z"),
              },
            ],
          },
        },
      });
      await prisma.paymentRefund.createMany({
        data: [
          {
            paymentId: PAYMENT_ID,
            paymentTransactionId: PAID_TXN,
            stripeRefundId: "re_race_4149_cancel",
            stripePaymentIntentId: PAID_INTENT,
            amountCents: PAID_CENTS - KEPT_FEE_CENTS,
            currency: "nzd",
            status: "succeeded",
            stripeCreatedAt: new Date("2026-05-20T00:00:00.000Z"),
          },
          ...(refundRecorded
            ? [
                {
                  paymentId: PAYMENT_ID,
                  paymentTransactionId: LATE_TXN,
                  stripeRefundId: "re_race_4149_late",
                  stripePaymentIntentId: LATE_INTENT,
                  amountCents: LATE_CENTS,
                  currency: "nzd",
                  status: "succeeded",
                  stripeCreatedAt: new Date("2026-06-25T00:00:00.000Z"),
                },
              ]
            : []),
        ],
      });
      await prisma.xeroObjectLink.create({
        data: {
          localModel: "Payment",
          localId: PAYMENT_ID,
          xeroObjectType: "CREDIT_NOTE",
          xeroObjectId: "cn-race-4149-cancel",
          role: "REFUND_CREDIT_NOTE",
          metadata: { amountCents: PAID_CENTS - KEPT_FEE_CENTS, invoiceId: "inv-race-4149" },
        },
      });
      if (!change) return;
      // The cancel's decision about the booking's own money (#3639 evidence).
      await prisma.bookingEvent.create({
        data: {
          bookingId: BOOKING_ID,
          type: "CANCELLED",
          snapshot: { refundMethod: "card", refundPercentage: 100, settledAmountCents: PAID_CENTS - KEPT_FEE_CENTS },
        },
      });
      if (change.cancelClaim) {
        // The cancel's claim on the change intent: the capture landed after it.
        await prisma.paymentRecoveryOperation.create({
          data: {
            type: "CANCEL_PAYMENT_INTENT",
            status: "SUCCEEDED",
            bookingId: BOOKING_ID,
            paymentId: PAYMENT_ID,
            paymentIntentId: LATE_INTENT,
            amountCents: LATE_CENTS,
            idempotencyKey: "race-4149-cancel-claim",
          },
        });
      }
      if (change.openTask) {
        // The confirm route won the race to the capture and asked a person (#2700).
        await prisma.manualRefundTask.create({
          data: {
            bookingId: BOOKING_ID,
            paymentId: PAYMENT_ID,
            amountCents: LATE_CENTS,
            raisedAmountCents: LATE_CENTS,
            kind: "DELETED_BOOKING_LATE_CAPTURE",
            reason: deletedBookingModificationRefundReason(LATE_INTENT),
            status: "OPEN",
          },
        });
      }
    }

    /** Stripe's redelivery of `payment_intent.succeeded` for the late capture - the real webhook processor. */
    async function redeliverLateCapture(change = false) {
      eventSequence += 1;
      const event = {
        id: `evt_race_4149_${eventSequence}`,
        object: "event",
        type: "payment_intent.succeeded",
        request: null,
        data: {
          object: {
            id: LATE_INTENT,
            object: "payment_intent",
            amount: LATE_CENTS,
            currency: "nzd",
            status: "succeeded",
            payment_method: "pm_race_4149",
            metadata: change ? { bookingId: BOOKING_ID, type: "modification_additional" } : { bookingId: BOOKING_ID },
            latest_charge: null,
          },
        },
      } as unknown as Stripe.Event;
      return webhook.processStripeWebhookEvent(event);
    }

    /** Stripe lists the late-capture door's refund; any refund asked for is recorded, so a second refund would show. */
    function armStripe() {
      const calls = { listed: 0, refundsAsked: 0 };
      stripeRaceHooks.listRefunds = async () => {
        calls.listed += 1;
        return [lateCaptureRefund()];
      };
      stripeRaceHooks.refund = async () => {
        calls.refundsAsked += 1;
        throw new Error("no refund may be asked for: the capture was refunded before the crash");
      };
      return calls;
    }

    const recordRows = () =>
      prisma.manualRefundTask.findMany({
        where: { bookingId: BOOKING_ID, paymentId: PAYMENT_ID },
        select: { status: true, kind: true, reason: true, amountCents: true, completedAt: true },
      });

    /** Await actual owned inserts, including any unexpected duplicate. */
    async function refundEntries(action = REFUND_ENTRY) {
      await drainAuditWrites();
      return prisma.auditLog.findMany({
        where: { targetId: BOOKING_ID, action },
        select: { details: true },
      });
    }

    const uncoveredCents = async () =>
      (
        await readRefundCreditNoteGap(
          await prisma.payment.findUniqueOrThrow({
            where: { id: PAYMENT_ID },
            select: { id: true, bookingId: true, refundedAmountCents: true },
          }),
        )
      ).uncoveredCents;

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL, "late-capture record recovery"); // the one shared guard (INV-SSOT-001)
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      const createAudit = prisma.auditLog.create.bind(prisma.auditLog);
      const auditCreate = vi.spyOn(prisma.auditLog, "create").mockImplementation((args) => {
        if (args.data.targetId !== BOOKING_ID) return createAudit(args);
        const gate = args.data.action === RECOVERED_ENTRY ? recoveredAuditGate : undefined;
        const write = (async () => {
          if (gate) {
            gate.details = String(args.data.details);
            await gate.release.promise;
          }
          return createAudit(args);
        })();
        pendingAuditWrites.add(write);
        // These audit calls are awaited, never passed to a Prisma transaction.
        return write as ReturnType<typeof createAudit>;
      });
      restoreAuditCreate = () => auditCreate.mockRestore();
      webhook = await import("@/lib/stripe-webhook-service");
      recovery = await import("@/lib/late-capture-record-recovery");
      ({ readRefundCreditNoteGap } = await import("@/lib/xero-admin-health"));
      ({ deletedBookingModificationRefundReason } = await import("@/lib/deleted-booking-modification-payment"));

      await deleteFixtures();
      await prisma.member.create({
        data: {
          id: MEMBER_ID,
          email: `${MEMBER_ID}@example.invalid`,
          passwordHash: "not-a-real-password",
          firstName: "Lost",
          lastName: "Record",
          ageTier: "ADULT",
        },
      });
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4149 Lodge", slug: "race-4149" } });
    }, 120_000); // cold import of the webhook module graph

    beforeEach(async () => {
      resetStripeRaceHooks();
      await deletePaymentRows();
      await seedAfterTheCrash();
    });

    afterAll(async () => {
      resetStripeRaceHooks();
      if (!prisma) return;
      try {
        await deleteFixtures();
      } finally {
        try {
          await drainAuditWrites();
        } finally {
          restoreAuditCreate?.();
        }
      }
    });

    it("the self-heal writes the lost record before it could raise a note, and the over-note it would have raised is gone", async () => {
      const stripe = armStripe();
      // #4170: the primary handler's own marker keeps the capture's refund out
      // of the note-eligible cash even before its record row exists.
      expect(await uncoveredCents()).toBe(0);

      await expect(recovery.recoverLostLateCaptureRecordsForPayment(PAYMENT_ID)).resolves.toEqual({
        recovered: [LATE_INTENT],
        unresolved: false,
      });

      const rows = await recordRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        status: "DISMISSED",
        kind: "AUTOMATIC_LATE_CAPTURE_RECORD",
        amountCents: LATE_CENTS,
        // Dated the refund's day, not the night it was recovered.
        completedAt: REFUNDED_ON,
      });
      expect(rows[0]?.reason).toContain(LATE_INTENT);
      expect(await uncoveredCents()).toBe(0);
      // The delivery that refunded died before its entry and alert, so the recovery writes them.
      const entries = await refundEntries();
      expect(entries).toHaveLength(1);
      expect(JSON.parse(String(entries[0]?.details))).toMatchObject({ paymentIntentId: LATE_INTENT, recoveredLostRecord: true });
      const recovered = await refundEntries(RECOVERED_ENTRY);
      expect(JSON.parse(String(recovered[0]?.details))).toMatchObject({
        paymentIntentId: LATE_INTENT,
        refundTimeReport: "none",
        alertSent: true,
      });
      expect(stripe.refundsAsked).toBe(0);
    });

    it("the nightly self-heal reaches the booking's own payment, which never shows a refund-note gap, and writes its record", async () => {
      armStripe();
      const { reconcileCreditBalances } = await import("@/lib/cron-credit-reconciliation");
      const { getRefundsMissingXeroCreditNotes } = await import("@/lib/xero-admin-health");
      // The marked capture is outside the note-eligible cash, so the gap list never names this payment.
      expect(await uncoveredCents()).toBe(0);
      expect((await getRefundsMissingXeroCreditNotes({ limit: 500 })).payments.map((p) => p.paymentId)).not.toContain(PAYMENT_ID);

      await reconcileCreditBalances();

      const rows = await recordRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: "DISMISSED", kind: "AUTOMATIC_LATE_CAPTURE_RECORD", completedAt: REFUNDED_ON });
      expect(await refundEntries(RECOVERED_ENTRY)).toHaveLength(1);
    });

    it("a change capture with no landed-after evidence reads as uncovered cash until the self-heal writes its record, and not after", async () => {
      await deletePaymentRows();
      await seedAfterTheCrash({ cancelClaim: false, openTask: false });
      armStripe();
      // The defect: no record, so the capture's refund reads as uncovered cash against the pre-cancel invoice.
      expect(await uncoveredCents()).toBe(LATE_CENTS);

      await expect(recovery.recoverLostLateCaptureRecordsForPayment(PAYMENT_ID)).resolves.toEqual({
        recovered: [LATE_INTENT],
        unresolved: false,
      });

      expect(await uncoveredCents()).toBe(0);
    });

    it("drains a delayed change-capture audit before cleanup reuses the booking for a primary capture (#4254)", async () => {
      await deletePaymentRows();
      await seedAfterTheCrash({ cancelClaim: false, openTask: false });
      const stripe = armStripe();
      const gate = { release: deferred(), details: "" };
      recoveredAuditGate = gate;
      let cleanup: Promise<void> | undefined;
      const auditDelete = vi.spyOn(prisma.auditLog, "deleteMany");
      try {
        await recovery.recoverLostLateCaptureRecordsForPayment(PAYMENT_ID);
        // logAudit calls create before recovery returns; a missing entry must fail, not wait forever.
        expect(gate.details).not.toBe("");
        expect(JSON.parse(gate.details)).toMatchObject({ kind: "modification_additional" });
        expect(await recordRows()).toHaveLength(1);
        expect(await prisma.auditLog.count({ where: { targetId: BOOKING_ID, action: RECOVERED_ENTRY } })).toBe(0);
        expect(pendingAuditWrites.size).toBeGreaterThan(0);

        // Without the drain, deletion starts synchronously while this real
        // modification_additional insert can still land after that delete.
        cleanup = deletePaymentRows();
        expect(auditDelete).not.toHaveBeenCalled();
        gate.release.resolve();
        await cleanup;
        expect(auditDelete).toHaveBeenCalledOnce();
        expect(pendingAuditWrites.size).toBe(0);
        recoveredAuditGate = undefined;

        await seedAfterTheCrash();
        await recovery.recoverLostLateCaptureRecordsForPayment(PAYMENT_ID);
        const recovered = await refundEntries(RECOVERED_ENTRY);
        expect(recovered).toHaveLength(1);
        expect(JSON.parse(String(recovered[0]?.details))).toMatchObject({ kind: "primary" });
        expect(await refundEntries()).toHaveLength(1);
        expect(await recordRows()).toHaveLength(1);
        expect(stripe.refundsAsked).toBe(0);
      } finally {
        gate.release.resolve();
        recoveredAuditGate = undefined;
        try {
          await cleanup;
          await drainAuditWrites();
        } finally {
          auditDelete.mockRestore();
        }
      }
    });

    it("two redeliveries racing the self-heal still write one record and one entry, and refund nothing again", async () => {
      const stripe = armStripe();
      const allReading = deferred();
      const releaseReaders = deferred();
      stripeRaceHooks.listRefunds = async () => {
        stripe.listed += 1;
        if (stripe.listed === 3) allReading.resolve();
        await releaseReaders.promise;
        return [lateCaptureRefund()];
      };
      const readers = [
        redeliverLateCapture(),
        redeliverLateCapture(),
        recovery.recoverLostLateCaptureRecordsForPayment(PAYMENT_ID),
      ] as const;
      let readinessDeadline: ReturnType<typeof setTimeout> | undefined;
      try {
        // Each reader has already observed the missing record. The real
        // under-lock claim, rather than scheduling luck, must choose one winner.
        await Promise.race([
          allReading.promise,
          ...readers.map((reader) => reader.then(() => {
            throw new Error("a recovery reader finished before all three readers reached Stripe");
          })),
          new Promise<never>((_resolve, reject) => {
            readinessDeadline = setTimeout(() => reject(new Error("three recovery readers did not reach Stripe")), 5_000);
          }),
        ]);
        releaseReaders.resolve();
        const [first, second, healed] = await Promise.all(readers);
        expect(first.init?.status ?? 200).toBe(200);
        expect(second.init?.status ?? 200).toBe(200);
        expect(healed.unresolved).toBe(false);
        expect(stripe.listed).toBe(3);
      } finally {
        clearTimeout(readinessDeadline);
        releaseReaders.resolve();
        await Promise.allSettled(readers);
      }
      expect(await recordRows()).toHaveLength(1);
      expect(await refundEntries()).toHaveLength(1);
      expect(await refundEntries(RECOVERED_ENTRY)).toHaveLength(1);
      expect(stripe.refundsAsked).toBe(0);
      expect(await uncoveredCents()).toBe(0);
    });

    it("a redelivery once the record exists asks Stripe nothing and writes nothing", async () => {
      armStripe();
      await recovery.recoverLostLateCaptureRecordsForPayment(PAYMENT_ID);
      await refundEntries();
      const stripe = armStripe();

      expect((await redeliverLateCapture()).init?.status ?? 200).toBe(200);

      expect(stripe.listed).toBe(0);
      expect(await recordRows()).toHaveLength(1);
      expect(await refundEntries()).toHaveLength(1);
    });

    it("writes the row and its recovered entry, and no second refund entry, when the refunding delivery's entry says its record write was lost", async () => {
      armStripe();
      // The refunding delivery's entry: its record write was lost, so it is marked.
      await prisma.auditLog.create({
        data: {
          action: REFUND_ENTRY,
          category: "payment",
          entityType: "Booking",
          entityId: BOOKING_ID,
          targetId: BOOKING_ID,
          details: JSON.stringify({ paymentIntentId: LATE_INTENT, refundId: "re_race_4149_late", recordLost: true }),
        },
      });

      expect((await redeliverLateCapture()).init?.status ?? 200).toBe(200);

      expect(await recordRows()).toHaveLength(1);
      const recovered = await refundEntries(RECOVERED_ENTRY);
      // The alert beside that entry read the database that had just failed, so it goes again (#2761).
      expect(JSON.parse(String(recovered[0]?.details))).toMatchObject({
        paymentIntentId: LATE_INTENT,
        refundTimeReport: "record_lost",
        alertSent: true,
      });
      expect(await refundEntries()).toHaveLength(1);
    });

    /** Stripe's `charge.refunded` for the late capture's charge - the real webhook processor. */
    async function chargeRefunded(refund: Stripe.Refund) {
      eventSequence += 1;
      stripeRaceHooks.listChargeRefunds = async () => [refund];
      const event = {
        id: `evt_race_4149_${eventSequence}`,
        object: "event",
        type: "charge.refunded",
        request: null,
        data: {
          object: {
            id: `ch_${LATE_INTENT}`,
            object: "charge",
            payment_intent: LATE_INTENT,
            amount: LATE_CENTS,
            amount_refunded: LATE_CENTS,
            refunds: { data: [refund] },
          },
        },
      } as unknown as Stripe.Event;
      return webhook.processStripeWebhookEvent(event);
    }

    it("recovers the lost record of the repair tool's own refund: its metadata is a late-capture door's too", async () => {
      const stripe = armStripe();
      stripeRaceHooks.listRefunds = async () => {
        stripe.listed += 1;
        return [{ ...lateCaptureRefund(), metadata: { bookingId: BOOKING_ID, reason: "cancelled_booking_late_capture_repair" } }];
      };

      await expect(recovery.recoverLostLateCaptureRecordsForPayment(PAYMENT_ID)).resolves.toEqual({
        recovered: [LATE_INTENT],
        unresolved: false,
      });
      expect(await recordRows()).toHaveLength(1);
      // As the repair tool records its own refund: no "refunded automatically" entry beside the record.
      const recovered = await refundEntries(RECOVERED_ENTRY);
      expect(JSON.parse(String(recovered[0]?.details))).toMatchObject({ repairRefund: true, alertSent: false });
      expect(await refundEntries()).toHaveLength(0);
    });

    it("re-raises a refunded-outside-the-app alert whose claim is not held, from the nightly self-heal (#4170)", async () => {
      await deletePaymentRows();
      await seedAfterTheCrash({ cancelClaim: true, openTask: false });
      const stripe = armStripe();
      // Named at the time, but its alert's send threw and gave the claim back.
      await prisma.auditLog.create({
        data: {
          action: "booking.payment.late_capture_refunded_outside_app",
          category: "payment",
          entityType: "Booking",
          entityId: BOOKING_ID,
          targetId: BOOKING_ID,
          details: JSON.stringify({ paymentIntentId: LATE_INTENT, refundIds: ["re_dashboard"], refundedCents: LATE_CENTS }),
        },
      });
      expect(await prisma.alertCooldown.count({ where: { key: OUTSIDE_APP_ALERT_KEY } })).toBe(0);

      const { reconcileCreditBalances } = await import("@/lib/cron-credit-reconciliation");
      await reconcileCreditBalances();

      // The claim is taken and kept: the alert went to the unmuteable sender.
      expect(await prisma.alertCooldown.count({ where: { key: OUTSIDE_APP_ALERT_KEY } })).toBe(1);
      // No door refund can ever appear for it, so Stripe is not asked.
      expect(stripe.listed).toBe(0);
      expect(await recordRows()).toHaveLength(0);
    });

    /** A SUCCEEDED superseded-payment refund row whose attempt brackets every recorded refund of the capture. */
    async function seedSupersededRowCovering() {
      await prisma.paymentRecoveryOperation.create({
        data: {
          type: "REFUND_SUPERSEDED_PAYMENT",
          status: "SUCCEEDED",
          bookingId: BOOKING_ID,
          paymentId: PAYMENT_ID,
          paymentTransactionId: LATE_TXN,
          paymentIntentId: LATE_INTENT,
          amountCents: LATE_CENTS,
          idempotencyKey: "race-4149-superseded-refund",
          createdAt: SUPERSEDED_ROW_OPENED,
          succeededAt: SUPERSEDED_ROW_CLOSED,
        },
      });
    }

    it("does not skip #4149's crash for a superseded row: the primary handler's marker is a door refund known (#4173)", async () => {
      // The default seed: the handler marked the capture, Stripe refunded it, and the process died - no record, no entry.
      await seedSupersededRowCovering();
      const stripe = armStripe();

      await expect(recovery.recoverLostLateCaptureRecordsForPayment(PAYMENT_ID)).resolves.toEqual({
        recovered: [LATE_INTENT],
        unresolved: false,
      });
      expect(stripe.listed).toBe(1);
      expect(await recordRows()).toHaveLength(1);
    });

    it("does not skip a capture with a replay of the door's refund beside a superseded row: the replay is found by its Stripe key (#4173)", async () => {
      await deletePaymentRows();
      await seedAfterTheCrash({ cancelClaim: true, openTask: false });
      await seedSupersededRowCovering();
      // The door's own refund, replayed by the recovery runner under its Stripe key.
      await prisma.paymentRecoveryOperation.create({
        data: {
          type: "REFUND_BOOKING_MODIFICATION",
          status: "SUCCEEDED",
          bookingId: BOOKING_ID,
          paymentId: PAYMENT_ID,
          paymentTransactionId: LATE_TXN,
          paymentIntentId: LATE_INTENT,
          amountCents: LATE_CENTS,
          idempotencyKey: "race-4149-door-replay",
          stripeKeyPrefix: `late_cancel_refund_${BOOKING_ID}_${LATE_INTENT}`,
        },
      });
      const stripe = armStripe();

      await expect(recovery.recoverLostLateCaptureRecordsForPayment(PAYMENT_ID)).resolves.toEqual({
        recovered: [LATE_INTENT],
        unresolved: false,
      });
      expect(stripe.listed).toBe(1);
    });

    it("leaves a superseded-payment refund on a cancelled booking alone: no note, no alert, no Stripe read, no gap (#4173)", async () => {
      await deletePaymentRows();
      await seedAfterTheCrash({ cancelClaim: true, openTask: false }, false);
      // The superseded-payment refund took the capture back.
      await prisma.paymentRecoveryOperation.create({
        data: {
          type: "REFUND_SUPERSEDED_PAYMENT",
          status: "SUCCEEDED",
          bookingId: BOOKING_ID,
          paymentId: PAYMENT_ID,
          paymentTransactionId: LATE_TXN,
          paymentIntentId: LATE_INTENT,
          amountCents: LATE_CENTS,
          idempotencyKey: "race-4149-superseded-refund",
          // Its attempt brackets the refund it made (recorded below, at the database's now).
          createdAt: SUPERSEDED_ROW_OPENED,
          succeededAt: SUPERSEDED_ROW_CLOSED,
        },
      });
      const stripe = armStripe();
      const superseded = {
        ...lateCaptureRefund(),
        id: "re_race_4149_superseded",
        metadata: { bookingId: BOOKING_ID, reason: "zero_dollar_batch_modification_superseded" },
      } as unknown as Stripe.Refund;

      expect((await chargeRefunded(superseded)).init?.status ?? 200).toBe(200);
      const { reconcileCreditBalances } = await import("@/lib/cron-credit-reconciliation");
      await reconcileCreditBalances();

      expect(await prisma.paymentRefund.count({ where: { stripeRefundId: "re_race_4149_superseded" } })).toBe(1);
      expect(await prisma.xeroSyncOperation.count({ where: { localId: PAYMENT_ID } })).toBe(0);
      expect(await prisma.auditLog.count({ where: { targetId: BOOKING_ID, action: "booking.payment.late_capture_refunded_outside_app" } })).toBe(0);
      expect(await prisma.alertCooldown.count({ where: { key: { in: ALERT_KEYS } } })).toBe(0);
      expect(stripe.listed).toBe(0);
      expect(await uncoveredCents()).toBe(0);
    });

    describe("charge.refunded arriving before the late capture's record (#4170)", () => {
      const queuedNotes = () => prisma.xeroSyncOperation.count({ where: { localId: PAYMENT_ID } });

      it("queues no generic note for a late-capture door refund, and the self-heal's record leaves no gap", async () => {
        await deletePaymentRows();
        await seedAfterTheCrash({ cancelClaim: true, openTask: false }, false);
        armStripe();

        expect((await chargeRefunded(lateCaptureRefund())).init?.status ?? 200).toBe(200);

        // The refund is in the ledger, and no whole-capture card note was queued against the pre-cancel invoice.
        expect(await prisma.paymentRefund.count({ where: { stripeRefundId: "re_race_4149_late" } })).toBe(1);
        expect(await queuedNotes()).toBe(0);
        // The record then arrives (here the self-heal's), and the gap is right.
        await recovery.recoverLostLateCaptureRecordsForPayment(PAYMENT_ID);
        expect(await recordRows()).toHaveLength(1);
        expect(await uncoveredCents()).toBe(0);
      });

      it("still queues the generic note for an ordinary refund of a capture with no landed-after evidence (the control)", async () => {
        await deletePaymentRows();
        await seedAfterTheCrash({ cancelClaim: false, openTask: false }, false);
        armStripe();

        const ordinary = { ...lateCaptureRefund(), metadata: { bookingId: BOOKING_ID, reason: "booking_cancellation" } } as unknown as Stripe.Refund;
        expect((await chargeRefunded(ordinary)).init?.status ?? 200).toBe(200);

        expect(await queuedNotes()).toBe(1);
      });

      it("names a change capture the cancel claimed, refunded outside the app before its late notice, and leaves it out of the gap", async () => {
        await deletePaymentRows();
        await seedAfterTheCrash({ cancelClaim: true, openTask: false }, false);
        armStripe();

        const dashboard = { ...lateCaptureRefund(), id: "re_race_4149_dashboard", metadata: {} } as unknown as Stripe.Refund;
        expect((await chargeRefunded(dashboard)).init?.status ?? 200).toBe(200);

        expect(await queuedNotes()).toBe(0);
        expect(await refundEntries("booking.payment.late_capture_refunded_outside_app")).toHaveLength(1);
        expect(await uncoveredCents()).toBe(0);
      });

      it("names a marked late capture refunded outside the app, queues no note, and leaves it out of the gap", async () => {
        await deletePaymentRows();
        await seedAfterTheCrash(undefined, false);
        armStripe();

        const dashboard = { ...lateCaptureRefund(), id: "re_race_4149_dashboard", metadata: {} } as unknown as Stripe.Refund;
        expect((await chargeRefunded(dashboard)).init?.status ?? 200).toBe(200);

        expect(await queuedNotes()).toBe(0);
        expect(await refundEntries("booking.payment.late_capture_refunded_outside_app")).toHaveLength(1);
        expect(await uncoveredCents()).toBe(0);
      });
    });

    describe("a change payment, through the real modification handler", () => {
      it("closes an OPEN #2700 task the refund never closed, on the redelivery, instead of leaving it asking for money Stripe returned", async () => {
        await deletePaymentRows();
        await seedAfterTheCrash({ cancelClaim: true, openTask: true });
        const stripe = armStripe();

        expect((await redeliverLateCapture(true)).init?.status ?? 200).toBe(200);

        const rows = await recordRows();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ status: "DISMISSED", completedAt: REFUNDED_ON });
        expect(await refundEntries(RECOVERED_ENTRY)).toHaveLength(1);
        expect(stripe.refundsAsked).toBe(0);
      });

      it("closes that OPEN task once when the self-heal races two redeliveries", async () => {
        await deletePaymentRows();
        await seedAfterTheCrash({ cancelClaim: true, openTask: true });
        const stripe = armStripe();

        const [first, second, healed] = await Promise.all([
          redeliverLateCapture(true),
          redeliverLateCapture(true),
          recovery.recoverLostLateCaptureRecordsForPayment(PAYMENT_ID),
        ]);

        expect(first.init?.status ?? 200).toBe(200);
        expect(second.init?.status ?? 200).toBe(200);
        expect(healed.unresolved).toBe(false);
        const rows = await recordRows();
        expect(rows).toHaveLength(1);
        expect(rows[0]?.status).toBe("DISMISSED");
        expect(await refundEntries(RECOVERED_ENTRY)).toHaveLength(1);
        expect(stripe.refundsAsked).toBe(0);
      });

      it("recovers a refunded change capture the cancel left no claim on, though it reads as settled by the cancellation", async () => {
        await deletePaymentRows();
        await seedAfterTheCrash({ cancelClaim: false, openTask: false });
        const stripe = armStripe();

        expect((await redeliverLateCapture(true)).init?.status ?? 200).toBe(200);

        const rows = await recordRows();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ status: "DISMISSED", kind: "AUTOMATIC_LATE_CAPTURE_RECORD" });
        expect(stripe.listed).toBe(1);
        expect(stripe.refundsAsked).toBe(0);
        // Nor is it acknowledged as money the cancellation settled.
        const acknowledged = await prisma.auditLog.count({
          where: { targetId: BOOKING_ID, action: "booking.payment.late_notice_acknowledged" },
        });
        expect(acknowledged).toBe(0);
      });
    });
  },
);
