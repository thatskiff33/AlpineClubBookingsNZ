/**
 * #4488, worked example 1, through the REAL writers - one driver, so the
 * floor's proof (`card-refund-reversal-shortfall-floor.realdb.test.ts`) and the
 * member-money ledger's proof of the same example read one story.
 *
 * A $300.00 booking is paid by card ($200.00, charge A) and by internet
 * banking ($100.00, charge B), and cancelled with all of it due back:
 *
 * 1. `cancelBooking` asks Stripe for the card's $200.00 and never hears back:
 *    every send fails, so the real runner spends the row's retries and it is
 *    dead. The $100.00 the card cannot carry is raised in the cancel's claim as
 *    a card refund shortfall to pay by bank (`raiseCancelCardShortfallHandBack`).
 * 2. The treasurer closes the dead card refund "Paid another way" for $200.00
 *    (`closeCardRefundPaidAnotherWay`, on A), then marks the shortfall paid
 *    back (`resolveManualRefundTask`, on B). The app refuses the second until
 *    the first is done.
 * 3. The lost card refund turns up late through the `charge.refunded` sync
 *    (`syncRefundsFromStripeCharge`) - capped, it adds nothing - and then fails
 *    (`recordRefusedCardRefund`).
 *
 * The caller's file registers the harness's one shared `@/lib/stripe` double
 * (`stripe-race-double.ts`); this driver only installs its hooks. No Stripe or
 * Xero call is made. Every fixture is keyed on `prefix` and cleaned by
 * `deleteFixtures`.
 */
import type Stripe from "stripe";
import { vi } from "vitest";

import type { ClubFormat } from "@/lib/club-format";
import { cancelCardShortfallOccurrenceKey } from "@/lib/manual-refund-task-settlement-rules";
import type { prisma as appPrisma } from "@/lib/prisma";

import { releaseBookingJournalForTeardown } from "./booking-financial-history-teardown";
import { stripeRaceHooks } from "./stripe-race-double";

type Db = typeof appPrisma;

export const EXAMPLE_CARD_CENTS = 20_000;
export const EXAMPLE_BANK_CENTS = 10_000;
export const EXAMPLE_PRICE_CENTS = EXAMPLE_CARD_CENTS + EXAMPLE_BANK_CENTS;

const LEDGER_MIGRATION = "20260509090000_enrich_payment_refund_ledger";
const CUTOFF_MIGRATION = "20261115010000_card_refund_failed_later_cutoff";
const NIGHT = new Date("2026-08-01T00:00:00.000Z");
const CHECK_OUT = new Date("2026-08-02T00:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

export function cardShortfallLateRefundExample(prisma: Db, prefix: string, format: ClubFormat) {
  const underscored = prefix.replace(/-/g, "_");
  const ids = {
    member: `${prefix}-member`,
    officer: `${prefix}-officer`,
    lodge: `${prefix}-lodge`,
    booking: `${prefix}-booking`,
    payment: `${prefix}-payment`,
    cardTxn: `${prefix}-txn-a`,
    bankTxn: `${prefix}-txn-b`,
    intent: `pi_${underscored}_a`,
    charge: `ch_${underscored}_a`,
  };
  const cardRefundKey = `booking_cancel_refund_recovery_${ids.booking}`;
  /** When the lost refund was made: after both refund-ledger migrations finished on this database. */
  let refundCreatedSeconds: number | null = null;

  async function deleteBookingRows() {
    await prisma.alertCooldown.deleteMany({ where: { key: { startsWith: `card-refund-cap-overflow:${ids.cardTxn}:` } } });
    await prisma.auditLog.deleteMany({ where: { targetId: ids.booking } });
    await prisma.bookingEvent.deleteMany({ where: { bookingId: ids.booking } });
    await prisma.xeroSyncOperation.deleteMany({ where: { localId: { in: [ids.payment, ids.booking] } } });
    await prisma.xeroObjectLink.deleteMany({ where: { localId: { in: [ids.payment, ids.booking] } } });
    // #4627: the doors post journal batches bridged to these lines; release them first.
    await releaseBookingJournalForTeardown(prisma, [ids.booking]);
    await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: ids.booking } });
    await prisma.manualRefundTask.deleteMany({ where: { bookingId: ids.booking } });
    await prisma.paymentRecoveryOperation.deleteMany({ where: { bookingId: ids.booking } });
    await prisma.paymentRefund.deleteMany({ where: { paymentId: ids.payment } });
    await prisma.paymentTransaction.deleteMany({ where: { paymentId: ids.payment } });
    await prisma.payment.deleteMany({ where: { id: ids.payment } });
    await prisma.bookingGuest.deleteMany({ where: { bookingId: ids.booking } });
    await prisma.booking.deleteMany({ where: { id: ids.booking } });
  }

  async function deleteFixtures() {
    await deleteBookingRows();
    await prisma.cancellationPolicy.deleteMany({ where: { lodgeId: ids.lodge } });
    await prisma.lodge.deleteMany({ where: { id: ids.lodge } });
    await prisma.member.deleteMany({ where: { id: { in: [ids.member, ids.officer] } } });
  }

  /** The member, the officer and a lodge whose one cancellation tier gives everything back. */
  async function createFixtures() {
    await deleteFixtures();
    for (const id of [ids.member, ids.officer]) {
      await prisma.member.create({
        data: { id, email: `${id}@example.invalid`, passwordHash: "not-a-real-password", firstName: "Shortfall", lastName: "Floor", ageTier: "ADULT" },
      });
    }
    await prisma.lodge.create({ data: { id: ids.lodge, name: `${prefix} lodge`, slug: prefix } });
    await prisma.cancellationPolicy.create({ data: { lodgeId: ids.lodge, daysBeforeStay: 0, refundPercentage: 100, fixedFeeCents: 0 } });
  }

  /** The paid booking: $200.00 by card on A, $100.00 by internet banking on B. Invoiced, so refund notes have one to credit. */
  async function seedPaidBooking() {
    await deleteBookingRows();
    await prisma.booking.create({
      data: { id: ids.booking, memberId: ids.member, lodgeId: ids.lodge, checkIn: NIGHT, checkOut: CHECK_OUT, status: "PAID", totalPriceCents: EXAMPLE_PRICE_CENTS, finalPriceCents: EXAMPLE_PRICE_CENTS },
    });
    await prisma.payment.create({
      data: { id: ids.payment, bookingId: ids.booking, amountCents: EXAMPLE_PRICE_CENTS, source: "STRIPE", status: "SUCCEEDED", stripePaymentIntentId: ids.intent, xeroInvoiceId: `${prefix}-invoice` },
    });
    await prisma.paymentTransaction.createMany({
      data: [
        { id: ids.cardTxn, paymentId: ids.payment, kind: "PRIMARY", source: "STRIPE", stripePaymentIntentId: ids.intent, amountCents: EXAMPLE_CARD_CENTS, status: "SUCCEEDED", createdAt: new Date("2026-05-01T00:00:00.000Z") },
        { id: ids.bankTxn, paymentId: ids.payment, kind: "ADDITIONAL", source: "INTERNET_BANKING", amountCents: EXAMPLE_BANK_CENTS, status: "SUCCEEDED", createdAt: new Date("2026-06-01T00:00:00.000Z") },
      ],
    });
  }

  /** Stripe takes no card refund the app hears of: every send fails, and nothing is listed as made. */
  function stripeNeverAnswers() {
    stripeRaceHooks.refund = async () => {
      throw new Error(`${prefix}: Stripe did not answer`);
    };
    stripeRaceHooks.listRefunds = async () => [];
  }

  /** Step 1: the cancel, while Stripe never answers. */
  async function cancel() {
    stripeNeverAnswers();
    const { cancelBooking } = await import("@/lib/booking-cancel");
    return cancelBooking(ids.booking, ids.member, "ADMIN", "127.0.0.1", format, "card");
  }

  const cardRefundRow = () => prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { idempotencyKey: cardRefundKey } });
  const shortfallTask = () => prisma.manualRefundTask.findUniqueOrThrow({ where: { occurrenceKey: cancelCardShortfallOccurrenceKey(ids.booking) } });

  /**
   * Step 1, continued: the real runner spends the card refund's retries, each
   * one due, while Stripe still never answers. The clock steps past each
   * backoff and is handed back to the instant it read before.
   *
   * #5373: `new Date()` here is never the real calendar. Every test file runs
   * on the frozen test clock (`vitest.clock-setup.ts`), so `startedAt` is that
   * fixed instant, or the caller's own pin, and the steps are fixed days after
   * it. The clock goes back to that same instant and not to real timers: the
   * caller's later steps (the close, the late refund) still run inside this
   * test, and docs/TESTING.md, "Writing a date-bearing test", rule 4, keeps
   * a test off the real calendar.
   */
  async function spendCardRefundRetries() {
    stripeNeverAnswers();
    const { runPaymentRecoveryOperationNow } = await import("@/lib/payment-recovery");
    const { MAX_PAYMENT_RECOVERY_ATTEMPTS } = await import("@/lib/payment-recovery-constants");
    const startedAt = new Date();
    try {
      for (let step = 1; step <= MAX_PAYMENT_RECOVERY_ATTEMPTS; step += 1) {
        const row = await cardRefundRow();
        if (row.attempts >= MAX_PAYMENT_RECOVERY_ATTEMPTS) break;
        vi.setSystemTime(new Date(startedAt.getTime() + step * DAY_MS));
        await runPaymentRecoveryOperationNow(row.id, format);
      }
    } finally {
      vi.setSystemTime(startedAt);
    }
    return cardRefundRow();
  }

  /** Step 2: the dead card refund closed "Paid another way" - in full, or in part with the club keeping the rest. */
  async function closeCardRefund(amountCents = EXAMPLE_CARD_CENTS) {
    const { closeCardRefundPaidAnotherWay } = await import("@/lib/card-refund-paid-another-way");
    const full = amountCents === EXAMPLE_CARD_CENTS;
    return closeCardRefundPaidAnotherWay({
      operationId: (await cardRefundRow()).id,
      amountCents,
      paidBack: full ? "full" : "partial",
      rest: full ? null : "club-keeps",
      expectedOwedCents: EXAMPLE_CARD_CENTS,
      note: `Bank transfer, ref ${prefix}`,
      actingMemberId: ids.officer,
    });
  }

  /** Step 2: the shortfall marked paid back, or dismissed with a note. */
  async function resolveShortfall(resolution: "completed" | "dismissed" = "completed") {
    const { resolveManualRefundTask } = await import("@/lib/manual-refund-task-resolution");
    const taskId = (await shortfallTask()).id;
    return resolveManualRefundTask(
      resolution === "completed"
        ? { taskId, resolution, note: null, actingMemberId: ids.officer, confirmedAmountCents: null, direction: "REFUND_TO_MEMBER", recordedNightPrices: null }
        : { taskId, resolution, note: `Settled outside the app (${prefix})`, actingMemberId: ids.officer, recordedNightPrices: null },
      format,
    );
  }

  /**
   * A refund on charge A as Stripe's `charge.refunded` and `refund.failed`
   * carry it: by default the dead row's own lost refund, stamped with its
   * metadata; `madeBy: null` for one made by hand in the Stripe dashboard.
   */
  async function stripeRefund(id: string, cents: number, status: string, { madeBy = "card-refund" }: { madeBy?: "card-refund" | null } = {}): Promise<Stripe.Refund> {
    if (refundCreatedSeconds === null) {
      const rows = await prisma.$queryRaw<Array<{ finished_at: Date | null }>>`
        SELECT "finished_at" FROM "_prisma_migrations" WHERE "migration_name" IN (${LEDGER_MIGRATION}, ${CUTOFF_MIGRATION})`;
      if (rows.length !== 2 || rows.some((row) => row.finished_at === null)) {
        throw new Error("The race database lacks the refund ledger migrations: run prisma migrate deploy against it first.");
      }
      refundCreatedSeconds = Math.max(...rows.map((row) => Math.floor(row.finished_at!.getTime() / 1000))) + 3_600;
    }
    const { cardRefundOperationRefundMetadata } = await import("@/lib/payment-recovery-keys");
    return {
      id,
      object: "refund",
      amount: cents,
      currency: "nzd",
      status,
      reason: "requested_by_customer",
      created: refundCreatedSeconds,
      charge: ids.charge,
      payment_intent: ids.intent,
      metadata: madeBy ? cardRefundOperationRefundMetadata(await cardRefundRow()) : {},
    } as unknown as Stripe.Refund;
  }

  /** Step 3: the `charge.refunded` sync - Stripe lists every refund on the charge. */
  async function syncCardCharge(refunds: Stripe.Refund[]) {
    const { syncRefundsFromStripeCharge } = await import("@/lib/payment-transactions");
    return syncRefundsFromStripeCharge({
      paymentIntentId: ids.intent,
      stripeChargeId: ids.charge,
      refundedAmountCents: refunds.filter((refund) => refund.status === "succeeded").reduce((sum, refund) => sum + refund.amount, 0),
      refunds: refunds as never,
    });
  }

  /** Step 3: `refund.failed` - the webhook's recorder. */
  async function deliverFailure(refund: Stripe.Refund) {
    const { recordRefusedCardRefund } = await import("@/lib/card-refund-status-sync");
    return recordRefusedCardRefund({ ...refund, status: "failed" } as Stripe.Refund);
  }

  /** The payment's refunded total, each charge's, and what the club still holds of what it captured. */
  async function mirrors() {
    const payment = await prisma.payment.findUniqueOrThrow({
      where: { id: ids.payment },
      select: { amountCents: true, refundedAmountCents: true, transactions: { select: { id: true, refundedAmountCents: true } } },
    });
    const charge = (id: string) => payment.transactions.find((row) => row.id === id)?.refundedAmountCents ?? null;
    return {
      payment: payment.refundedAmountCents,
      a: charge(ids.cardTxn),
      b: charge(ids.bankTxn),
      retained: payment.amountCents - payment.refundedAmountCents,
    };
  }

  return {
    ids,
    createFixtures,
    deleteFixtures,
    seedPaidBooking,
    cancel,
    cardRefundRow,
    shortfallTask,
    spendCardRefundRetries,
    closeCardRefund,
    resolveShortfall,
    stripeRefund,
    syncCardCharge,
    deliverFailure,
    mirrors,
  };
}
