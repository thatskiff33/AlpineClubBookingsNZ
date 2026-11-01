/**
 * Real-PostgreSQL proof for #4491 (`INV-ADDPAY-052`, the owner's 24 Oct 2026
 * decision on #4253): a credit release that lands on a booking with an unpaid
 * EDIT request merges into it - one request for the combined amount - and the
 * one card payment is recorded in Xero against both invoices: the released
 * credit on the booking's own invoice, the edit on its supplementary invoice.
 *
 * Every state is reached through the real writers: the edit's mint
 * (`createModificationAdditionalPaymentIntent`) and its Xero leg
 * (`queueXeroBookingEditSettlement`, which parks the edit's invoice on its
 * ask); the credit converge, run by the allocation worker against a Xero that
 * shows the credit note spent elsewhere (`allocateAppliedCreditForBooking`,
 * #4219); the release sweep's enqueue (`enqueueCreditReleaseAsks`) and the
 * recovery runner (`runPaymentRecoveryOperationNow`); Stripe's success event
 * (`processStripeWebhookEvent`); a price reduction's retire of the unpaid ask
 * (`retireUnpaidAskChain`, then the mirror rebuild); and the credit-release
 * payment sweep (`recordCreditReleasePayments`) with the real Xero payment
 * writer. Only the providers are fakes: Stripe, an in-memory intent store in
 * which a capture is something the test does, and Xero at its client seam
 * (`getAuthenticatedXeroClient`, `callXeroApi`), spied for this describe only
 * and restored after it, keeping each invoice's amount due and honouring
 * idempotency keys.
 *
 * Cases:
 *  - the merge: one request for both, the edit's ask superseded and its invoice
 *    moved onto the release request; the capture releases the edit's invoice for
 *    the edit's own amount and the sweep records the released credit on the
 *    booking's invoice, once, however often the runner, the webhook and the
 *    sweep repeat; Xero's amount due and the app's owed both reach zero;
 *  - the wait (#4378) still holds where the edit's invoice cannot follow, and
 *    lets the release be asked for alone once the edit is paid, or withdrawn;
 *  - a race: the edit paid, or withdrawn, between the release's read and its
 *    claim - the claim refuses, nothing is superseded, and the retry asks for
 *    the released credit alone;
 *  - #4652: a release attempt whose claim goes stale mid-mint and is reclaimed
 *    (the stale reaper's fenced write, then the real runner): once the
 *    reclaiming runner closed the row without the stale attempt's intent, that
 *    intent is cancelled at Stripe, once, with no transaction open; while the
 *    row may yet record it, or a row names it, it is left.
 *
 * Envelope: identical to `concurrency-lock-races.realdb.test.ts`, which imports
 * this file; the describe runs ONLY when `RUN_CONCURRENCY_RACE_TESTS=1`,
 * against a loopback database on port 55442+ named with
 * `concurrency_race_1881`. It owns and cleans its own `race-4491-` fixtures.
 *
 *   RUN_CONCURRENCY_RACE_TESTS=1 \
 *   CONCURRENCY_RACE_DATABASE_URL=postgresql://user:pass@127.0.0.1:55442/concurrency_race_1881 \
 *   pnpm exec vitest run src/lib/__tests__/credit-release-merge-into-edit.realdb.test.ts
 */
import type { PrismaClient } from "@prisma/client";
import type Stripe from "stripe";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { SuiteEnvironmentRoleDeclaration } from "./helpers/environment-role";
import { releaseBookingJournalForTeardown } from "./support/booking-financial-history-teardown";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";
import { assertSafeRaceDbUrl } from "./support/race-db-url";
import { resetStripeRaceHooks, stripeRaceHooks } from "./support/stripe-race-double";

// The harness's one shared Stripe double: pass-through unless a case hooks it.
vi.mock("@/lib/stripe", async (importOriginal) =>
  (await import("./support/stripe-race-double")).stripeRaceDouble(await importOriginal()),
);

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const MEMBER_ID = "race-4491-member";
const LODGE_ID = "race-4491-lodge";
const BOOKING_ID = "race-4491-booking";
const GUEST_ID = "race-4491-guest";
const PAYMENT_ID = "race-4491-payment";
const PRIMARY_INTENT = "pi_race_4491_primary";
const INVOICE_ID = "race-4491-invoice";
const NOTE_ID = "race-4491-note";
const LOT_ID = "race-4491-lot";
const OUTSIDE_INVOICE_ID = "race-4491-outside-invoice";
const MOD_E = "race-4491-mod-e";
const NIGHTS = [new Date("2027-08-01T00:00:00.000Z"), new Date("2027-08-02T00:00:00.000Z")];
const CHECK_IN = NIGHTS[0]!;
const CHECK_OUT = new Date("2027-08-03T00:00:00.000Z");

const PRICE_CENTS = 20_000;
/** The account credit applied to the booking, whose note was spent in Xero elsewhere. */
const CREDIT_CENTS = 4_000;
/** The edit's own price increase. */
const E_CENTS = 3_000;

type FakeIntent = {
  id: string;
  object: "payment_intent";
  amount: number;
  currency: string;
  status: Stripe.PaymentIntent.Status;
  client_secret: string;
  payment_method: string | null;
  metadata: Record<string, string>;
  latest_charge: string | null;
  last_payment_error: { message: string } | null;
};

/** Stripe, in memory: intents keep their status, and a cancel or capture moves it. */
const stripe = { intents: new Map<string, FakeIntent>(), created: [] as string[] };
let webhookEventSequence = 0;

/**
 * Xero, in memory: the credit note (spent on another invoice, so the app's
 * allocation is refused and the worker converges), the booking's invoice with
 * its amount due, and the payments the app records, by idempotency key.
 */
const fakeXero = vi.hoisted(() => {
  const state = {
    on: false,
    noteTotalCents: 0,
    noteAllocations: [] as Array<{ allocationID: string; invoiceID: string; amountCents: number }>,
    invoiceDueCents: new Map<string, number>(),
    payments: new Map<string, { paymentID: string; invoiceID: string; amountCents: number }>(),
  };
  const remaining = () => state.noteTotalCents - state.noteAllocations.reduce((sum, row) => sum + row.amountCents, 0);
  const noteBody = (creditNoteID: string) => ({
    creditNotes: [
      {
        creditNoteID,
        status: remaining() > 0 ? "AUTHORISED" : "PAID",
        total: state.noteTotalCents / 100,
        remainingCredit: remaining() / 100,
        payments: [],
        allocations: state.noteAllocations.map((row) => ({
          allocationID: row.allocationID,
          invoice: { invoiceID: row.invoiceID },
          amount: row.amountCents / 100,
          isDeleted: false,
        })),
      },
    ],
  });
  const accountingApi = {
    async createCreditNoteAllocation(_tenant: string, _noteId: string, body: { allocations: Array<{ amount: number }> }) {
      if (body.allocations.some((row) => Math.round(row.amount * 100) > remaining())) {
        throw new Error("Credit Note cannot be allocated as the allocation amount is greater than the amount remaining on the Credit Note");
      }
      throw new Error("fake Xero: this suite's note is always spent");
    },
    async getCreditNote(_tenant: string, creditNoteID: string) {
      return { body: noteBody(creditNoteID) };
    },
    async deleteCreditNoteAllocations() {
      return { body: {} };
    },
    async getInvoice(_tenant: string, invoiceID: string) {
      const due = state.invoiceDueCents.get(invoiceID);
      if (due === undefined) return { body: { invoices: [] } };
      return { body: { invoices: [{ invoiceID, invoiceNumber: "INV-4491", status: due > 0 ? "AUTHORISED" : "PAID", amountDue: due / 100 }] } };
    },
    async createPayments(
      _tenant: string,
      body: { payments: Array<{ invoice: { invoiceID: string }; amount: number }> },
      _summarize: unknown,
      idempotencyKey: string,
    ) {
      const existing = state.payments.get(idempotencyKey);
      if (existing) return { body: { payments: [{ paymentID: existing.paymentID }] } };
      const [payment] = body.payments;
      const amountCents = Math.round(payment!.amount * 100);
      const invoiceID = payment!.invoice.invoiceID;
      state.invoiceDueCents.set(invoiceID, (state.invoiceDueCents.get(invoiceID) ?? 0) - amountCents);
      const paymentID = `pay_race_4491_${state.payments.size + 1}`;
      state.payments.set(idempotencyKey, { paymentID, invoiceID, amountCents });
      return { body: { payments: [{ paymentID }] } };
    },
  };
  return { state, client: { accountingApi } };
});

let prisma: PrismaClient;
let harnessRole: SuiteEnvironmentRoleDeclaration | undefined;
let installedSpies: Array<{ mockRestore: () => void }> = [];
let previousDatabaseUrl: string | undefined;

(RUN ? describe : describe.skip)(
  "#4491: a credit release merges into an unpaid edit request, one card payment recorded against both invoices - real PostgreSQL",
  { timeout: 60_000 },
  () => {
    async function deleteFixtures() {
      const rows = await prisma.paymentTransaction.findMany({ where: { paymentId: PAYMENT_ID }, select: { id: true } });
      const rowIds = rows.map((row) => row.id);
      const localIds = [BOOKING_ID, PAYMENT_ID, MOD_E, ...rowIds];
      await prisma.xeroSyncOperation.deleteMany({ where: { localId: { in: localIds } } });
      await prisma.xeroSyncOperation.deleteMany({ where: { requestPayload: { path: ["bookingId"], equals: BOOKING_ID } } });
      await prisma.xeroSyncOperation.deleteMany({ where: { requestPayload: { path: ["appliedCreditContext", "bookingId"], equals: BOOKING_ID } } });
      await prisma.xeroObjectLink.deleteMany({ where: { localId: { in: localIds } } });
      await prisma.xeroObjectLink.deleteMany({ where: { xeroObjectId: { startsWith: "pay_race_4491_" } } });
      await prisma.processedWebhookEvent.deleteMany({ where: { eventId: { startsWith: "evt_race_4491_" } } });
      await prisma.webhookLog.deleteMany({ where: { eventId: { startsWith: "evt_race_4491_" } } });
      await prisma.alertCooldown.deleteMany({ where: { OR: [BOOKING_ID, ...rowIds].map((id) => ({ key: { contains: id } })) } });
      await prisma.emailLog.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.auditLog.deleteMany({ where: { OR: [{ targetId: BOOKING_ID }, { subjectMemberId: MEMBER_ID }, { memberId: MEMBER_ID }] } });
      await prisma.memberCreditNoteAllocation.deleteMany({ where: { OR: [{ appliedToBookingId: BOOKING_ID }, { memberCredit: { memberId: MEMBER_ID } }] } });
      // #4627: the doors post journal batches bridged to these lines; release them first.
      await releaseBookingJournalForTeardown(prisma, [BOOKING_ID]);
      await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.bookingEvent.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.memberCredit.deleteMany({ where: { memberId: MEMBER_ID } });
      await prisma.paymentRecoveryOperation.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.manualRefundTask.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.paymentRefund.deleteMany({ where: { paymentId: PAYMENT_ID } });
      const payment = await prisma.payment.findUnique({ where: { id: PAYMENT_ID }, select: { id: true } });
      if (payment) await prisma.payment.update({ where: { id: PAYMENT_ID }, data: { settledByTransactionId: null } });
      await prisma.paymentTransaction.deleteMany({ where: { paymentId: PAYMENT_ID } });
      await prisma.payment.deleteMany({ where: { id: PAYMENT_ID } });
      await prisma.bookingModification.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.bookingGuestNight.deleteMany({ where: { bookingGuest: { bookingId: BOOKING_ID } } });
      await prisma.bookingGuest.deleteMany({ where: { bookingId: BOOKING_ID } });
      await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
    }

    /**
     * A booking paid by card for its price less $40.00 of account credit, its
     * invoice in Xero. The credit's note is then spent on another invoice in
     * Xero, outside the app, so the booking's invoice still owes the $40.00.
     */
    async function seedCreditPaidBooking() {
      await prisma.member.create({
        data: { id: MEMBER_ID, email: `${MEMBER_ID}@example.invalid`, passwordHash: "not-a-real-password", firstName: "Merge", lastName: "Both", ageTier: "ADULT" },
      });
      await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4491 Lodge", slug: "race-4491" } });
      await prisma.memberCredit.create({
        data: { id: LOT_ID, memberId: MEMBER_ID, amountCents: CREDIT_CENTS, type: "CANCELLATION_REFUND", description: "race 4491 lot", xeroCreditNoteId: NOTE_ID, createdAt: new Date("2026-05-01T00:00:00.000Z") },
      });
      await prisma.booking.create({
        data: { id: BOOKING_ID, memberId: MEMBER_ID, lodgeId: LODGE_ID, checkIn: CHECK_IN, checkOut: CHECK_OUT, status: "PAID", totalPriceCents: PRICE_CENTS, finalPriceCents: PRICE_CENTS },
      });
      await prisma.bookingGuest.create({
        data: { id: GUEST_ID, bookingId: BOOKING_ID, firstName: "Merge", lastName: "Guest", ageTier: "ADULT", stayStart: CHECK_IN, stayEnd: CHECK_OUT, priceCents: PRICE_CENTS },
      });
      await prisma.bookingGuestNight.createMany({
        data: NIGHTS.map((stayDate) => ({ bookingGuestId: GUEST_ID, stayDate, priceCents: PRICE_CENTS / 2, priceSource: "SOLD" as const })),
      });
      for (const [index, night] of NIGHTS.entries()) {
        await prisma.bookingLedgerLine.create({ data: {
          bookingId: BOOKING_ID, side: "CHARGE", kind: "GUEST_NIGHT", sign: 1, quantity: 1, unitCents: PRICE_CENTS / 2, amountCents: PRICE_CENTS / 2,
          bookingGuestId: GUEST_ID, nightStart: night, nightEndExclusive: NIGHTS[index + 1] ?? CHECK_OUT, ageTier: "ADULT",
          guestNames: ["Merge Guest"], anchorKind: "CONFIRMATION", anchorId: BOOKING_ID, narration: "race 4491 confirmation",
          lodgeId: LODGE_ID, postingKey: `race-4491-confirm-${index}`,
        } });
      }
      await prisma.payment.create({
        data: {
          id: PAYMENT_ID,
          bookingId: BOOKING_ID,
          amountCents: PRICE_CENTS - CREDIT_CENTS,
          creditAppliedCents: CREDIT_CENTS,
          source: "STRIPE",
          status: "SUCCEEDED",
          xeroInvoiceId: INVOICE_ID,
          stripePaymentIntentId: PRIMARY_INTENT,
          stripeCustomerId: "cus_race_4491",
          transactions: {
            create: { kind: "PRIMARY", source: "STRIPE", stripePaymentIntentId: PRIMARY_INTENT, amountCents: PRICE_CENTS - CREDIT_CENTS, status: "SUCCEEDED" },
          },
        },
      });
      const credit = await import("@/lib/member-credit");
      await prisma.$transaction((tx) => credit.applyCreditToBooking(MEMBER_ID, CREDIT_CENTS, BOOKING_ID, tx, CLUB_FORMAT_TEST));
      fakeXero.state.noteTotalCents = CREDIT_CENTS;
      fakeXero.state.noteAllocations = [{ allocationID: "race-4491-outside", invoiceID: OUTSIDE_INVOICE_ID, amountCents: CREDIT_CENTS }];
      fakeXero.state.invoiceDueCents = new Map([[INVOICE_ID, CREDIT_CENTS]]);
      fakeXero.state.payments = new Map();
    }

    /** The edit: its history row, the card ask its door mints, and (unless told not to) its Xero leg. */
    async function priceIncrease(options: { xeroLeg?: boolean; racedPrimaryInvoice?: boolean } = {}): Promise<string> {
      const [{ createModificationAdditionalPaymentIntent }, { sizeAdditionalAsk }] = await Promise.all([
        import("@/lib/booking-modification-settlement"),
        import("@/lib/additional-payment-ask"),
      ]);
      await prisma.bookingModification.create({
        data: {
          id: MOD_E,
          bookingId: BOOKING_ID,
          memberId: MEMBER_ID,
          modificationType: "GUEST_ADD",
          previousData: {},
          // An edit that raced the booking invoice's create settles against that invoice (#3980's marker).
          newData: options.racedPrimaryInvoice ? { primaryInvoiceSettlement: { settledAgainstPrimaryInvoice: true } } : {},
          priceDiffCents: E_CENTS,
        },
      });
      await prisma.booking.update({ where: { id: BOOKING_ID }, data: { finalPriceCents: { increment: E_CENTS }, totalPriceCents: { increment: E_CENTS } } });
      const mirror = await prisma.payment.findUniqueOrThrow({
        where: { id: PAYMENT_ID },
        select: { additionalAmountCents: true, additionalPaymentStatus: true },
      });
      const minted = await createModificationAdditionalPaymentIntent({
        format: CLUB_FORMAT_TEST,
        bookingId: BOOKING_ID,
        door: "guestAdd",
        failureMessage: "race-4491: the mint failed",
        result: {
          pendingRefundAmountCents: 0,
          organiserChildRefund: null,
          paymentId: PAYMENT_ID,
          additionalAsk: sizeAdditionalAsk({ priceDiffCents: E_CENTS, changeFeeCents: 0, payment: mirror }),
          retiredAdditionalAsks: [],
          hasSucceededPayment: true,
          hasIssuedXeroInvoice: !options.racedPrimaryInvoice,
          paymentCustomerId: "cus_race_4491",
          memberEmail: `${MEMBER_ID}@example.invalid`,
          memberName: "Merge Both",
          memberFirstName: "Merge",
          memberId: MEMBER_ID,
          bookingModificationId: MOD_E,
          priceLines: null,
        },
      });
      const intentId = minted.additionalPaymentIntentId;
      if (!intentId) throw new Error("race-4491: the edit's ask was not minted");
      if (options.xeroLeg !== false && !options.racedPrimaryInvoice) await editXeroLeg(intentId);
      return intentId;
    }

    async function editXeroLeg(intentId: string) {
      const { queueXeroBookingEditSettlement } = await import("@/lib/xero-booking-edit-settlement");
      await queueXeroBookingEditSettlement({
        bookingId: BOOKING_ID,
        bookingModificationId: MOD_E,
        hasIssuedXeroInvoice: true,
        originalPaymentStatus: "SUCCEEDED",
        priceDiffCents: E_CENTS,
        changeFeeCents: 0,
        requiresAdditionalStripePayment: true,
        additionalPaymentIntentId: intentId,
      });
    }

    /**
     * #3980: the booking invoice's create saved its link having billed the booking as it was before
     * the racing edit, so the gap check queues the edit's money on a gap invoice anchored on it. The
     * create's row and the figures it stored are a seeded fact (as the primary invoice is); the gap
     * check is the real writer.
     */
    async function gapInvoiceBillsTheEdit() {
      const [{ buildXeroBookingInvoiceCorrelationKey }, { PRIMARY_INVOICE_FEE_AT_LINK_KEY }, { queuePrimaryInvoiceWorthGap }] = await Promise.all([
        import("@/lib/xero-booking-invoice-key"),
        import("@/lib/xero-primary-invoice-fee-at-link"),
        import("@/lib/xero-primary-invoice-fee-gap"),
      ]);
      const figures = {
        xeroInvoiceId: INVOICE_ID,
        billedChangeFeeCents: 0,
        billedTotalCents: PRICE_CENTS,
        recordedChangeFeeCentsAtLink: 0,
        primaryInvoiceCashCents: PRICE_CENTS - CREDIT_CENTS,
        worth: { atBuildCents: PRICE_CENTS, builtTotalCents: PRICE_CENTS, atLinkCents: PRICE_CENTS + E_CENTS, markedModificationIdsAtBuild: [] },
        paymentIntentIdsRecordedAtLink: [PRIMARY_INTENT],
      };
      const key = buildXeroBookingInvoiceCorrelationKey(BOOKING_ID);
      const create = await prisma.xeroSyncOperation.create({
        data: {
          direction: "OUTBOUND", entityType: "INVOICE", operationType: "CREATE", localModel: "Payment", localId: PAYMENT_ID,
          status: "SUCCEEDED", correlationKey: key, idempotencyKey: key, xeroObjectId: INVOICE_ID,
          requestPayload: { [PRIMARY_INVOICE_FEE_AT_LINK_KEY]: figures },
        },
      });
      const result = await queuePrimaryInvoiceWorthGap({ bookingId: BOOKING_ID, atLink: figures, figuresOperationId: create.id });
      expect(result).toMatchObject({ gapCents: E_CENTS });
      const gap = await prisma.xeroSyncOperation.findMany({
        where: { localModel: "BookingModification", localId: MOD_E, queueType: "SUPPLEMENTARY_INVOICE" },
        select: { requestPayload: true },
      });
      expect(gap).toHaveLength(1);
      expect(gap[0]!.requestPayload).toMatchObject({ primaryInvoiceGap: true });
    }

    /** The allocation worker meets the spent note and converges: the booking's applied credit is released. */
    async function convergeSpentCredit() {
      const { allocateAppliedCreditForBooking } = await import("@/lib/xero-applied-credit-allocation");
      await allocateAppliedCreditForBooking(BOOKING_ID);
      const release = await prisma.memberCredit.findFirstOrThrow({
        where: { memberId: MEMBER_ID, type: "BOOKING_APPLIED", appliedToBookingId: BOOKING_ID, outsideSpendConvergedAt: { not: null }, amountCents: { gt: 0 } },
      });
      expect(release.amountCents).toBe(CREDIT_CENTS);
      expect((await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID } })).creditAppliedCents).toBe(0);
    }

    /** The sweep's enqueue, past its settle window, then the runner on the release's row. */
    async function enqueueRelease() {
      const { enqueueCreditReleaseAsks } = await import("@/lib/credit-release-ask-sweep");
      return enqueueCreditReleaseAsks({ now: new Date(Date.now() + 10 * 60 * 1000) });
    }

    async function releaseOperation() {
      return prisma.paymentRecoveryOperation.findFirstOrThrow({
        where: { bookingId: BOOKING_ID, idempotencyKey: { startsWith: "credit_release_ask_" } },
      });
    }

    async function runRelease() {
      const { runPaymentRecoveryOperationNow } = await import("@/lib/payment-recovery");
      const row = await releaseOperation();
      if (row.status !== "SUCCEEDED") {
        await prisma.paymentRecoveryOperation.update({ where: { id: row.id }, data: { nextRetryAt: new Date(0) } });
      }
      return runPaymentRecoveryOperationNow(row.id, CLUB_FORMAT_TEST);
    }

    async function deliver(type: "payment_intent.succeeded", intentId: string) {
      const webhook = await import("@/lib/stripe-webhook-service");
      webhookEventSequence += 1;
      const event = {
        id: `evt_race_4491_${webhookEventSequence}`,
        object: "event",
        type,
        request: null,
        data: { object: { ...stripe.intents.get(intentId)! } },
      } as unknown as Stripe.Event;
      return webhook.processStripeWebhookEvent(event);
    }

    async function payWithCard(intentId: string) {
      const intent = stripe.intents.get(intentId)!;
      if (intent.status === "canceled" || intent.status === "succeeded") throw new Error(`fake Stripe: cannot capture a ${intent.status} intent`);
      intent.status = "succeeded";
      intent.payment_method = "pm_race_4491";
      intent.latest_charge = `ch_${intentId}`;
      await deliver("payment_intent.succeeded", intentId);
    }

    /** A price reduction that takes the edit back: the unpaid ask retired and the mirror rebuilt, in one transaction. */
    async function reductionWithdrawsTheEdit() {
      const [{ readUnpaidPriceAsk, retireUnpaidAskChain }, { reconcilePaymentAggregates }] = await Promise.all([
        import("@/lib/additional-ask-reduction"),
        import("@/lib/payment-transactions"),
      ]);
      await prisma.$transaction(async (tx) => {
        const booking = await tx.booking.findUniqueOrThrow({
          where: { id: BOOKING_ID },
          select: {
            id: true,
            status: true,
            payment: { select: { id: true, additionalAmountCents: true, additionalPaymentStatus: true, additionalPaymentIntentId: true } },
          },
        });
        const ask = await readUnpaidPriceAsk(tx, booking);
        expect(ask.askCents).toBe(E_CENTS);
        await retireUnpaidAskChain(tx, { bookingId: BOOKING_ID, paymentId: PAYMENT_ID, ask });
        await tx.booking.update({ where: { id: BOOKING_ID }, data: { finalPriceCents: { decrement: E_CENTS }, totalPriceCents: { decrement: E_CENTS } } });
        await reconcilePaymentAggregates({ paymentId: PAYMENT_ID, store: tx });
      });
    }

    async function editInvoice() {
      const rows = await prisma.xeroSyncOperation.findMany({
        where: { localModel: "BookingModification", localId: MOD_E, queueType: "SUPPLEMENTARY_INVOICE" },
        select: { status: true, requestPayload: true },
      });
      expect(rows, "one supplementary invoice for the edit").toHaveLength(1);
      const payload = rows[0]!.requestPayload as Record<string, unknown>;
      return {
        status: rows[0]!.status,
        waitsOn: payload.paymentIntentId,
        parkedFrom: payload.parkedFromPaymentIntentId,
        cents: (payload.priceDiffCents as number) + (payload.changeFeeCents as number),
        recordsPayment: payload.recordPayment !== false,
      };
    }

    async function additionalRows() {
      const { LEDGER_ROWS_OLDEST_FIRST } = await import("@/lib/payment-ledger-order");
      return prisma.paymentTransaction.findMany({
        where: { paymentId: PAYMENT_ID, kind: "ADDITIONAL" },
        orderBy: [...LEDGER_ROWS_OLDEST_FIRST],
        select: { status: true, reason: true, amountCents: true, carriedAskCents: true, stripePaymentIntentId: true, withdrawnAt: true },
      });
    }

    async function receiptsFor(intentId: string) {
      return prisma.xeroSyncOperation.count({
        where: { queueType: "ADDITIONAL_CAPTURE_RECEIPT", status: { not: "CANCELLED" }, requestPayload: { path: ["paymentIntentId"], equals: intentId } },
      });
    }

    async function recordReleasePayments() {
      const { recordCreditReleasePayments } = await import("@/lib/credit-release-xero-payment");
      return recordCreditReleasePayments({ deps: { captureDate: async () => null } });
    }

    /** What the app says is still owed: the ledger's unasked residual and the live ask. */
    async function appOwes() {
      const [{ bookingLedgerResidualCents, outstandingAdditionalAskCents }] = await Promise.all([import("@/lib/additional-payment-ask")]);
      const payment = await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID }, include: { booking: true } });
      return {
        unasked: bookingLedgerResidualCents({ ...payment, finalPriceCents: payment.booking!.finalPriceCents }),
        asked: outstandingAdditionalAskCents(payment),
      };
    }

    async function leftToOfficers() {
      return prisma.auditLog.findMany({
        where: { action: "payment.credit_release_ask.left_to_officers", targetId: BOOKING_ID },
        select: { metadata: true, summary: true },
      });
    }

    async function expectWaiting(reason: string, attemptsSpentBefore = 0) {
      const row = await releaseOperation();
      expect(row.status).not.toBe("SUCCEEDED");
      expect(row.attempts, "a wait hands its attempt back").toBe(attemptsSpentBefore);
      expect(row.lastError).toMatch(/cannot follow a combined request; the released-credit request waits until it is paid or withdrawn/);
      const notes = await leftToOfficers();
      expect(notes).toHaveLength(1);
      expect(notes[0]!.metadata).toMatchObject({ notMergedBecause: reason });
      const { CREDIT_RELEASE_MERGE_WAIT_WORDS } = await import("@/lib/credit-release-merge");
      expect(notes[0]!.summary).toContain(`Why: ${CREDIT_RELEASE_MERGE_WAIT_WORDS[reason as keyof typeof CREDIT_RELEASE_MERGE_WAIT_WORDS]}.`);
      const rows = await additionalRows();
      expect(rows.some((row) => row.reason === "credit_released_outside_app")).toBe(false);
    }

    /** The release asked for alone: its own row, nothing carried, paid once and recorded once on the booking's invoice. */
    async function expectReleaseAskedAlone() {
      expect((await releaseOperation()).status).toBe("SUCCEEDED");
      const release = (await additionalRows()).at(-1)!;
      expect(release).toMatchObject({ reason: "credit_released_outside_app", amountCents: CREDIT_CENTS, carriedAskCents: 0, status: "PENDING" });
      await payWithCard(release.stripePaymentIntentId!);
      expect(await recordReleasePayments()).toMatchObject({ recorded: 1, held: 0, failed: 0 });
      expect([...fakeXero.state.payments.values()]).toEqual([expect.objectContaining({ invoiceID: INVOICE_ID, amountCents: CREDIT_CENTS })]);
      expect(fakeXero.state.invoiceDueCents.get(INVOICE_ID)).toBe(0);
      expect(await appOwes()).toEqual({ unasked: 0, asked: 0 });
    }

    function installStripe() {
      stripeRaceHooks.customer = async () => ({ id: "cus_race_4491", object: "customer", metadata: {} });
      stripeRaceHooks.create = async (args) => {
        const id = `pi_race_4491_${stripe.created.length + 1}`;
        stripe.intents.set(id, {
          id,
          object: "payment_intent",
          amount: args.amountCents,
          currency: "nzd",
          status: "requires_payment_method",
          client_secret: `${id}_secret`,
          payment_method: null,
          metadata: args.metadata ?? {},
          latest_charge: null,
          last_payment_error: null,
        });
        stripe.created.push(id);
        return { ...stripe.intents.get(id)! };
      };
      stripeRaceHooks.get = async (id) => {
        const intent = stripe.intents.get(id);
        if (!intent) throw new Error(`fake Stripe: no such intent ${id}`);
        return { ...intent };
      };
      stripeRaceHooks.cancel = async (id) => {
        const intent = stripe.intents.get(id);
        if (!intent) throw new Error(`fake Stripe: no such intent ${id}`);
        if (intent.status === "succeeded" || intent.status === "canceled") return { paymentIntent: { ...intent }, canceled: false };
        intent.status = "canceled";
        return { paymentIntent: { ...intent }, canceled: true };
      };
    }

    /** The release's mint, with something landing first - after the release's read, before its claim. */
    function beforeTheReleaseMint(landFirst: () => Promise<void>) {
      const create = stripeRaceHooks.create!;
      stripeRaceHooks.create = async (args) => {
        if (args.metadata?.reason === "credit_released_outside_app") {
          stripeRaceHooks.create = create;
          await landFirst();
        }
        return create(args);
      };
    }

    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL, "#4491 credit-release merge");
      previousDatabaseUrl = process.env.DATABASE_URL;
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = (await import("@/lib/prisma")) as unknown as { prisma: PrismaClient });
      const { declareEnvironmentRoleForSuite } = await import("./helpers/environment-role");
      harnessRole = declareEnvironmentRoleForSuite("non-production");
      const xeroApi = await import("@/lib/xero-api-client");
      const realGetClient = xeroApi.getAuthenticatedXeroClient;
      const realCall = xeroApi.callXeroApi;
      installedSpies = [
        vi.spyOn(xeroApi, "getAuthenticatedXeroClient").mockImplementation(((...args: Parameters<typeof realGetClient>) =>
          fakeXero.state.on
            ? Promise.resolve({ xero: fakeXero.client, tenantId: "race-4491-tenant" })
            : realGetClient(...args)) as typeof realGetClient),
        vi.spyOn(xeroApi, "callXeroApi").mockImplementation(((fn: () => Promise<unknown>, options: Parameters<typeof realCall>[1]) =>
          fakeXero.state.on ? fn() : realCall(fn, options)) as typeof realCall),
      ];
    });

    beforeEach(async () => {
      await deleteFixtures();
      stripe.intents.clear();
      stripe.created = [];
      installStripe();
      fakeXero.state.on = true;
    });

    afterEach(() => {
      fakeXero.state.on = false;
      resetStripeRaceHooks();
    });

    afterAll(async () => {
      fakeXero.state.on = false;
      resetStripeRaceHooks();
      for (const spy of installedSpies) spy.mockRestore();
      installedSpies = [];
      try {
        if (prisma) await deleteFixtures();
      } finally {
        harnessRole?.restore();
        if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
        else process.env.DATABASE_URL = previousDatabaseUrl;
      }
    });

    /**
     * #4652 (`INV-PAY-120`): the release's first attempt mints, then stalls past the stale
     * reaper's threshold before its claim hold. Inside its mint the reaper's own fenced write
     * hands the row back (`resetStaleProcessingOperations`), and `reclaim` runs whatever comes
     * next - usually the real runner's second attempt. The first attempt's hold then finds its
     * claim gone. Stripe here honours idempotency keys, as the real one does within a day.
     */
    async function releaseLosesClaimToStaleReclaim(reclaim: (operationId: string) => Promise<void>) {
      await seedCreditPaidBooking();
      await convergeSpentCredit();
      expect(await enqueueRelease()).toBe(1);
      const operation = await releaseOperation();
      await prisma.paymentRecoveryOperation.update({ where: { id: operation.id }, data: { nextRetryAt: new Date(0) } });
      const cancelled: Array<{ id: string; openTransactions: number }> = [];
      const cancel = stripeRaceHooks.cancel!;
      stripeRaceHooks.cancel = async (id) => {
        cancelled.push({ id, openTransactions: await openTransactionsElsewhere() });
        return cancel(id);
      };
      const byKey = new Map<string, string>();
      const create = stripeRaceHooks.create!;
      const mint = async (args: Parameters<NonNullable<typeof stripeRaceHooks.create>>[0]) => {
        const known = args.idempotencyKey ? byKey.get(args.idempotencyKey) : undefined;
        if (known) return { ...stripe.intents.get(known)! };
        const intent = (await create(args)) as FakeIntent;
        if (args.idempotencyKey) byKey.set(args.idempotencyKey, intent.id);
        return intent;
      };
      const frozenNow = new Date();
      let stale: string | null = null;
      stripeRaceHooks.create = async (args) => {
        const intent = await mint(args);
        if (stale === null && args.metadata?.reason === "credit_released_outside_app") {
          stale = intent.id;
          stripeRaceHooks.create = mint;
          vi.setSystemTime(new Date(frozenNow.getTime() + 31 * 60_000));
          const held = await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { id: operation.id } });
          // The stale reaper's write (`markPaymentRecoveryOperationFailed`), fenced on the attempt it read.
          const reaped = await prisma.paymentRecoveryOperation.updateMany({
            where: { id: operation.id, status: "PROCESSING", attempts: held.attempts, processingStartedAt: held.processingStartedAt },
            data: { status: "FAILED", lastError: "Payment recovery worker timed out before completion.", processingStartedAt: null, nextRetryAt: new Date() },
          });
          expect(reaped.count).toBe(1);
          await reclaim(operation.id);
        }
        return intent;
      };
      const { runPaymentRecoveryOperationNow } = await import("@/lib/payment-recovery");
      try {
        expect(await runPaymentRecoveryOperationNow(operation.id, CLUB_FORMAT_TEST)).toBe("succeeded");
      } finally {
        vi.setSystemTime(frozenNow);
      }
      expect(stale).not.toBeNull();
      return { operationId: operation.id, stale: stale as unknown as string, cancelled };
    }

    async function reclaimingRunner(operationId: string) {
      const { runPaymentRecoveryOperationNow } = await import("@/lib/payment-recovery");
      expect(await runPaymentRecoveryOperationNow(operationId, CLUB_FORMAT_TEST)).toBe("succeeded");
    }

    /** Transactions open on any other connection to this database - a Stripe call made inside one shows here. */
    async function openTransactionsElsewhere(): Promise<number> {
      const rows = await prisma.$queryRaw<Array<{ count: number }>>`
        SELECT COUNT(*)::int AS "count" FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid() AND xact_start IS NOT NULL
      `;
      return rows[0]?.count ?? 0;
    }

    it("#4652: a stale attempt whose reclaiming runner asked for less under an amount-suffixed key has its own intent cancelled at Stripe, outside every transaction", async () => {
      const { operationId, stale, cancelled } = await releaseLosesClaimToStaleReclaim(async (id) => {
        // $10.00 of the released credit was paid in Xero meanwhile: the reclaiming runner asks for $30.00.
        fakeXero.state.invoiceDueCents.set(INVOICE_ID, CREDIT_CENTS - 1_000);
        await reclaimingRunner(id);
      });

      const rows = await additionalRows();
      expect(rows).toHaveLength(1);
      const live = rows[0]!.stripePaymentIntentId!;
      expect(live).not.toBe(stale);
      expect(rows[0]).toMatchObject({ reason: "credit_released_outside_app", amountCents: CREDIT_CENTS - 1_000, status: "PENDING" });
      expect(await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { id: operationId }, select: { status: true, paymentIntentId: true } }))
        .toEqual({ status: "SUCCEEDED", paymentIntentId: live });
      // The stale attempt's intent: nobody's, cancelled once, with no transaction open; the live ask untouched.
      expect(cancelled).toEqual([{ id: stale, openTransactions: 0 }]);
      expect(stripe.intents.get(stale)?.status).toBe("canceled");
      expect(stripe.intents.get(live)?.status).toBe("requires_payment_method");
      expect(await prisma.paymentTransaction.findUnique({ where: { stripePaymentIntentId: stale } })).toBeNull();
      expect(await prisma.paymentRecoveryOperation.count({ where: { paymentIntentId: stale } })).toBe(0);
    });

    it("#4652: a stale attempt whose reclaiming runner found nothing left to ask has its own intent cancelled at Stripe", async () => {
      const { operationId, stale, cancelled } = await releaseLosesClaimToStaleReclaim(async (id) => {
        // The booking no longer owes the released credit: its price came down by as much.
        await prisma.booking.update({ where: { id: BOOKING_ID }, data: { finalPriceCents: { decrement: CREDIT_CENTS } } });
        await reclaimingRunner(id);
      });

      expect(await additionalRows()).toEqual([]);
      expect(await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { id: operationId }, select: { status: true, paymentIntentId: true } }))
        .toEqual({ status: "SUCCEEDED", paymentIntentId: expect.stringMatching(/^credit_release_ask_pi_/) });
      expect(cancelled).toEqual([{ id: stale, openTransactions: 0 }]);
      expect(stripe.intents.get(stale)?.status).toBe("canceled");
    });

    it("#4652: a stale attempt whose reclaiming runner minted under the same key wrote THAT intent - it is the ask, never cancelled", async () => {
      const { operationId, stale, cancelled } = await releaseLosesClaimToStaleReclaim(reclaimingRunner);

      expect(stripe.created).toEqual([stale]);
      expect(await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { id: operationId }, select: { status: true, paymentIntentId: true } }))
        .toEqual({ status: "SUCCEEDED", paymentIntentId: stale });
      expect(cancelled).toEqual([]);
      expect(stripe.intents.get(stale)?.status).toBe("requires_payment_method");
      await expectReleaseAskedAlone();
    });

    it("#4652: a stale attempt whose row the reaper only handed back is left - the retry records that very intent under the same key", async () => {
      const { operationId, stale, cancelled } = await releaseLosesClaimToStaleReclaim(async () => {});

      expect(cancelled).toEqual([]);
      expect(stripe.intents.get(stale)?.status).toBe("requires_payment_method");
      expect((await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { id: operationId } })).status).toBe("FAILED");
      // Why it must be left: the retry's mint is answered with it, and records it as the ask.
      await runRelease();
      expect(stripe.created).toEqual([stale]);
      expect(await prisma.paymentRecoveryOperation.findUniqueOrThrow({ where: { id: operationId }, select: { status: true, paymentIntentId: true } }))
        .toEqual({ status: "SUCCEEDED", paymentIntentId: stale });
      await expectReleaseAskedAlone();
    });

    it("#4652: a stale attempt's intent a payment row names is left to that row, though its recovery closed without it", async () => {
      const { stale, cancelled } = await releaseLosesClaimToStaleReclaim(async (id) => {
        fakeXero.state.invoiceDueCents.set(INVOICE_ID, CREDIT_CENTS - 1_000);
        await reclaimingRunner(id);
        // A writer recorded the intent before the stale attempt's proof re-read it.
        await prisma.paymentTransaction.create({
          data: { id: "race-4652-named", paymentId: PAYMENT_ID, kind: "ADDITIONAL", source: "STRIPE", status: "FAILED", amountCents: CREDIT_CENTS, stripePaymentIntentId: stripe.created[0]! },
        });
      });

      expect(cancelled.map(({ id }) => id)).not.toContain(stale);
      expect(stripe.intents.get(stale)?.status).toBe("requires_payment_method");
      expect(await prisma.paymentTransaction.findUniqueOrThrow({ where: { stripePaymentIntentId: stale }, select: { id: true } })).toEqual({ id: "race-4652-named" });
    });

    it("merges: one request for both, the edit's invoice follows it, and the one card payment is recorded against both invoices, once", async () => {
      await seedCreditPaidBooking();
      const edit = await priceIncrease();
      expect(await editInvoice()).toMatchObject({ status: "WAITING_PAYMENT", waitsOn: edit, cents: E_CENTS });
      await convergeSpentCredit();
      expect(await enqueueRelease()).toBe(1);

      await runRelease();

      // ONE request for the combined amount, and no separate release request.
      const operation = await releaseOperation();
      expect(operation.status).toBe("SUCCEEDED");
      const rows = await additionalRows();
      expect(rows.map((row) => [row.status, row.reason === "credit_released_outside_app", row.amountCents, row.carriedAskCents])).toEqual([
        ["FAILED", false, E_CENTS, 0],
        ["PENDING", true, E_CENTS + CREDIT_CENTS, E_CENTS],
      ]);
      const merged = rows[1]!.stripePaymentIntentId!;
      expect(operation.paymentIntentId).toBe(merged);
      expect(stripe.intents.get(edit)?.status).toBe("canceled");
      expect([...stripe.intents.values()].filter((intent) => intent.status === "requires_payment_method").map((intent) => intent.id)).toEqual([merged]);
      const mirror = await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID } });
      expect([mirror.additionalAmountCents, mirror.additionalPaymentIntentId]).toEqual([E_CENTS + CREDIT_CENTS, merged]);
      // The edit's invoice now waits on the merged request; the officers were told nothing.
      expect(await editInvoice()).toMatchObject({ status: "WAITING_PAYMENT", waitsOn: merged, parkedFrom: edit, cents: E_CENTS });
      expect(await leftToOfficers()).toHaveLength(0);
      const { additionalAskCause } = await import("@/lib/additional-ask-cause");
      expect(additionalAskCause([...rows].reverse())).toBe("mixed");

      // Replaying the sweep and the runner raises nothing more.
      expect(await enqueueRelease()).toBe(0);
      await runRelease();
      expect(stripe.created).toHaveLength(2);
      expect(await additionalRows()).toHaveLength(2);

      // The member pays: the edit's invoice goes out for the edit, paid; no receipt; the released credit on the booking's invoice.
      await payWithCard(merged);
      expect(await editInvoice()).toMatchObject({ status: "PENDING", waitsOn: merged, cents: E_CENTS, recordsPayment: true });
      expect(await receiptsFor(merged)).toBe(0);
      expect(await recordReleasePayments()).toMatchObject({ recorded: 1, held: 0, failed: 0 });
      expect([...fakeXero.state.payments.values()]).toEqual([expect.objectContaining({ invoiceID: INVOICE_ID, amountCents: CREDIT_CENTS })]);
      // Each share once, summing to the capture.
      const capture = await prisma.paymentTransaction.findUniqueOrThrow({ where: { stripePaymentIntentId: merged } });
      expect(capture.status).toBe("SUCCEEDED");
      expect(E_CENTS + CREDIT_CENTS).toBe(capture.amountCents);

      // Replays: a redelivered success event and a second sweep record nothing more.
      await deliver("payment_intent.succeeded", merged);
      expect(await recordReleasePayments()).toMatchObject({ recorded: 0 });
      expect(fakeXero.state.payments.size).toBe(1);
      expect(await receiptsFor(merged)).toBe(0);
      expect(await prisma.xeroSyncOperation.count({ where: { localModel: "BookingModification", localId: MOD_E, queueType: "SUPPLEMENTARY_INVOICE" } })).toBe(1);

      // Xero's amount due on the booking's invoice and the app's owed agree: nothing.
      expect(fakeXero.state.invoiceDueCents.get(INVOICE_ID)).toBe(0);
      expect(await appOwes()).toEqual({ unasked: 0, asked: 0 });
    });

    it("waits where the edit's invoice cannot follow yet, and asks for the release alone once the edit is paid", async () => {
      await seedCreditPaidBooking();
      // The edit's Xero leg has not run: superseding it now would leave its invoice behind.
      const edit = await priceIncrease({ xeroLeg: false });
      await convergeSpentCredit();
      await enqueueRelease();

      await runRelease();
      await expectWaiting("edit-invoice-not-waiting");
      expect(stripe.created).toEqual([edit]);

      await editXeroLeg(edit);
      await payWithCard(edit);
      expect(await editInvoice()).toMatchObject({ status: "PENDING", waitsOn: edit, cents: E_CENTS, recordsPayment: true });

      await runRelease();
      await expectReleaseAskedAlone();
      expect(await receiptsFor(edit)).toBe(0);
    });

    it("waits where the edit's invoice cannot follow yet, and asks for the release alone once the edit is withdrawn", async () => {
      await seedCreditPaidBooking();
      await priceIncrease({ xeroLeg: false });
      await convergeSpentCredit();
      await enqueueRelease();

      await runRelease();
      await expectWaiting("edit-invoice-not-waiting");

      await reductionWithdrawsTheEdit();
      await runRelease();
      await expectReleaseAskedAlone();
    });

    it("the edit paid between the release's read and its claim: the claim refuses, nothing is superseded, and the retry asks for the release alone", async () => {
      await seedCreditPaidBooking();
      const edit = await priceIncrease();
      await convergeSpentCredit();
      await enqueueRelease();
      beforeTheReleaseMint(() => payWithCard(edit));

      await runRelease();

      const refused = stripe.created.at(-1)!;
      expect(stripe.intents.get(refused)?.amount, "sized while the edit was unpaid").toBe(E_CENTS + CREDIT_CENTS);
      expect(await prisma.paymentTransaction.findUnique({ where: { stripePaymentIntentId: refused } })).toBeNull();
      expect(await prisma.paymentRecoveryOperation.count({ where: { paymentIntentId: edit, type: "CANCEL_PAYMENT_INTENT" } })).toBe(0);
      // The edit's own capture released its own invoice; the release row retries.
      expect(await editInvoice()).toMatchObject({ status: "PENDING", waitsOn: edit, cents: E_CENTS, recordsPayment: true });
      const operation = await releaseOperation();
      expect(operation.status).not.toBe("SUCCEEDED");
      // The sizing fence refused it (the mirror moved), before the merge's own re-check.
      expect(operation.lastError).toMatch(/^The booking's payment changed while/);

      await runRelease();
      await expectReleaseAskedAlone();
    });

    it("the edit withdrawn between the release's read and its claim: the claim refuses, and the retry asks for the release alone", async () => {
      await seedCreditPaidBooking();
      const edit = await priceIncrease();
      await convergeSpentCredit();
      await enqueueRelease();
      beforeTheReleaseMint(() => reductionWithdrawsTheEdit());

      await runRelease();

      const refused = stripe.created.at(-1)!;
      expect(refused).not.toBe(edit);
      expect(await prisma.paymentTransaction.findUnique({ where: { stripePaymentIntentId: refused } })).toBeNull();
      expect((await releaseOperation()).lastError).toMatch(/^The booking's payment changed while/);

      await runRelease();
      await expectReleaseAskedAlone();
    });

    it("an edit that raced the booking's invoice and is billed on its #3980 gap invoice: the release waits, never putting the edit on the booking's invoice", async () => {
      await seedCreditPaidBooking();
      const edit = await priceIncrease({ racedPrimaryInvoice: true });
      await gapInvoiceBillsTheEdit();
      await convergeSpentCredit();
      await enqueueRelease();

      await runRelease();
      await expectWaiting("edit-billed-on-its-own-invoice");
      expect(stripe.created).toEqual([edit]);

      await payWithCard(edit);
      await runRelease();
      await expectReleaseAskedAlone();
    });

    it("the gap invoice queued between the release's read and its claim, the mirror unchanged: the merge's re-check under the lock refuses, and the retry waits", async () => {
      await seedCreditPaidBooking();
      const edit = await priceIncrease({ racedPrimaryInvoice: true });
      await convergeSpentCredit();
      await enqueueRelease();
      const mirrorBefore = await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID } });
      beforeTheReleaseMint(() => gapInvoiceBillsTheEdit());

      await runRelease();

      const refused = stripe.created.at(-1)!;
      expect(stripe.intents.get(refused)?.amount, "read as a merge before the gap was queued").toBe(E_CENTS + CREDIT_CENTS);
      const mirrorAfter = await prisma.payment.findUniqueOrThrow({ where: { id: PAYMENT_ID } });
      expect([mirrorAfter.additionalAmountCents, mirrorAfter.additionalPaymentIntentId, mirrorAfter.additionalPaymentStatus]).toEqual([
        mirrorBefore.additionalAmountCents, mirrorBefore.additionalPaymentIntentId, mirrorBefore.additionalPaymentStatus,
      ]);
      // Not the sizing fence: the merge decided again under the lock.
      expect((await releaseOperation()).lastError).toMatch(/^The unpaid edit request on the booking changed while/);
      expect(await prisma.paymentTransaction.findUnique({ where: { stripePaymentIntentId: refused } })).toBeNull();
      expect(await prisma.paymentRecoveryOperation.count({ where: { paymentIntentId: edit, type: "CANCEL_PAYMENT_INTENT" } })).toBe(0);
      expect(stripe.intents.get(edit)?.status).toBe("requires_payment_method");

      await runRelease();
      // The refused attempt was spent; the wait hands its own back.
      await expectWaiting("edit-billed-on-its-own-invoice", 1);
    });
  },
);
