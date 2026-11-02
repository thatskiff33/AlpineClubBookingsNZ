/**
 * #4253 (`INV-ADDPAY-045`): THE CARD PAYMENT REQUEST FOR CREDIT RELEASED WHEN A
 * CREDIT NOTE WAS SPENT IN XERO OUTSIDE THE APP.
 *
 * After `convergeCreditNoteSpentOutsideApp` (#4251) the booking's applied credit
 * is smaller and its ledger says the member owes the difference - but nothing
 * asked for it. This module is the recovery runner's branch for that request,
 * reached from `processCreateAdditionalPaymentIntentOperation` through
 * `isCreditReleaseAskRecoveryKey` BEFORE the ordinary replay, because the
 * ordinary replay derives everything from a `BookingModification` and this
 * request has none:
 *
 * - its parser answers null for the key, so the "a newer ask settled it" check
 *   would complete the row with the debt unpaid;
 * - its mint would cancel a live edit's ask without carrying it.
 *
 * WHAT IT ASKS FOR is re-derived at every attempt from the ledger
 * (`sizeCreditReleaseAsk`): the smaller of the amount frozen on the row and what
 * the booking still owes unasked, plus any live ask it supersedes (carried, like
 * every other mint). A booking that was paid, cancelled or reduced meanwhile asks
 * for less or nothing; an older under-collection is never folded in.
 *
 * WHAT IT DOES NOT DO: raise a Xero invoice. The released amount already stands
 * on the booking's own invoice, so the money is recorded against THAT invoice
 * when the card captures it (`credit-release-xero-payment.ts`).
 */
import {
  BookingStatus,
  CreditType,
  PaymentStatus,
  PaymentTransactionKind,
  type PaymentRecoveryOperation,
  type Prisma,
} from "@prisma/client";

import { bookingLedgerResidualCents, outstandingAdditionalAskCents } from "@/lib/additional-payment-ask";
import { sizeCreditReleaseAsk } from "@/lib/credit-release-ask-size";
import { CREDIT_RELEASE_MERGE_WAIT_WORDS, readCreditReleaseMergeVerdict } from "@/lib/credit-release-merge";
import { createAuditLog } from "@/lib/audit";
import { signalCreditReleaseToOfficers } from "@/lib/release-ask-officer-signal";
import { bookingOwner } from "@/lib/booking-owner";
import type { ClubFormat } from "@/lib/club-format";
import logger from "@/lib/logger";
import { ADDITIONAL_ASK_INTENT_TYPE } from "@/lib/ordinary-ask-request";
import { refuseAdoptedIntentOnLedger } from "@/lib/ordinary-ask-mint";
import {
  stripeIdempotencyKeyForAskAmount,
} from "@/lib/payment-recovery-keys";
import {
  buildCreditReleaseAskStripeIdempotencyKey,
  CREDIT_RELEASE_ASK_REASON,
  creditReleaseIdForAskRecoveryKey,
} from "@/lib/credit-release-ask-keys";
import { isCapturedPaymentStatus } from "@/lib/booking-payment-state";
import type { PaymentRecoveryClaim } from "@/lib/payment-recovery-constants";
import { lockPaymentForRefundedTotal, upsertPaymentIntentTransaction } from "@/lib/payment-transactions";
import { prisma } from "@/lib/prisma";
import { mintedIntentCustomerId, resolveAskCustomerId } from "@/lib/reissued-ask-mint";
import { createPaymentIntent } from "@/lib/stripe";
import { formatCents } from "@/lib/utils";
import { isSettledInXero, openBalanceCents, readXeroInvoiceBalance, type XeroInvoiceBalanceReader } from "@/lib/xero-invoice-balance";
import { localChargeRefusal } from "@/lib/stripe-charge-currency";

/**
 * What the recovery runner hands in, because both are private to
 * `payment-recovery.ts` and importing that module here would be a cycle.
 */
export interface CreditReleaseAskRunnerDeps {
  /** Writes under the runner's claim, in one transaction (`holdAdditionalIntentRecoveryClaim`); returns the re-stamped claim. */
  holdClaim: <T>(
    operation: PaymentRecoveryClaim & Pick<PaymentRecoveryOperation, "paymentId">,
    write: (store: Prisma.TransactionClient) => Promise<T>,
  ) => Promise<{ value: T; claim: PaymentRecoveryClaim } | null>;
  /**
   * Closes the row only while this attempt still holds `claim` (`completePaymentRecoveryOperation`,
   * #4675), in `store`'s transaction when given. `true` only for the call that closed it.
   */
  complete: (claim: PaymentRecoveryClaim, store?: Prisma.TransactionClient) => Promise<boolean>;
  /**
   * Puts the row back to wait at the longest retry interval WITHOUT spending the attempt the
   * claim took (`waitPaymentRecoveryOperation`): for a release blocked only by something that
   * clears on its own, which must never run the row out of attempts and go terminal.
   */
  wait: (operation: PaymentRecoveryOperation, message: string) => Promise<unknown>;
}

/** What a release that cannot merge into an unpaid edit request records on its recovery row (#4491). */
export const CREDIT_RELEASE_WAITING_ON_EDIT_MESSAGE =
  "An unpaid edit request is open on this booking and its Xero invoice cannot follow a combined request; the released-credit request waits until it is paid or withdrawn";

/** Why a row was closed without asking for anything: the audit row's wording and its code. */
type NoAskReason =
  | "not-a-release"
  | "booking-not-owed"
  | "payment-not-captured"
  | "nothing-unasked"
  | "organiser-settled"
  | "invoice-settled-in-xero"
  | "below-card-minimum";

const NO_ASK_SUMMARY: Record<NoAskReason, string> = {
  "not-a-release": "The credit release this request was raised for could not be found, so nothing was asked for",
  "booking-not-owed": "The booking was cancelled or removed before the released credit was asked for",
  "payment-not-captured": "The booking's payment had not been taken, so the released credit was left to its own payment",
  "nothing-unasked": "The booking no longer owed the released credit, so no payment was requested",
  "organiser-settled": "The booking is settled by its group organiser, so no payment was requested from the member",
  "invoice-settled-in-xero": "Xero already shows the booking's invoice as paid, so no payment was requested",
  "below-card-minimum": "The released credit is too small to collect by card; an officer was told",
};

/**
 * Closes the row having asked for nothing, and records why - the audit row in the close's own
 * transaction, written only when this attempt's claim closed it (#4675). An attempt the stale
 * reaper gave up on closes nothing and records nothing: the row is another runner's, which may
 * find money owed and ask for it. Returns whether it closed.
 */
async function closeWithoutAsk(
  operation: PaymentRecoveryOperation,
  reason: NoAskReason,
  deps: CreditReleaseAskRunnerDeps,
  detail: Record<string, unknown> = {},
): Promise<boolean> {
  const closed = await prisma.$transaction(async (tx) => {
    if (!(await deps.complete(operation, tx))) return false;
    await createAuditLog(
      {
        action: "payment.credit_release_ask.not_raised",
        targetId: operation.bookingId,
        entityType: "Booking",
        entityId: operation.bookingId,
        category: "payment",
        severity: reason === "below-card-minimum" ? "important" : "info",
        outcome: "success",
        summary: NO_ASK_SUMMARY[reason],
        details: reason,
        metadata: { operationId: operation.id, releasedCents: operation.amountCents, ...detail },
      },
      tx,
    );
    return true;
  });
  if (closed) logger.info({ operationId: operation.id, bookingId: operation.bookingId, reason }, NO_ASK_SUMMARY[reason]);
  return closed;
}

/** Everything the request's size and the ask it supersedes were read from; compared again under the lock. */
function sizingBasis(payment: {
  status: unknown;
  amountCents: number;
  refundedAmountCents: number;
  changeFeeCents: number;
  creditAppliedCents: number;
  additionalAmountCents: number;
  additionalPaymentStatus: unknown;
  additionalPaymentIntentId: string | null;
  booking: { status: unknown; deletedAt: Date | null; finalPriceCents: number };
}): string {
  return JSON.stringify([
    payment.status,
    payment.amountCents,
    payment.refundedAmountCents,
    payment.changeFeeCents,
    payment.creditAppliedCents,
    payment.additionalAmountCents,
    payment.additionalPaymentStatus,
    payment.additionalPaymentIntentId,
    payment.booking.status,
    payment.booking.deletedAt,
    payment.booking.finalPriceCents,
  ]);
}

export async function processCreditReleaseAskOperation(
  operation: PaymentRecoveryOperation,
  format: ClubFormat,
  deps: CreditReleaseAskRunnerDeps,
  readInvoiceBalance: XeroInvoiceBalanceReader = readXeroInvoiceBalance,
): Promise<"waited" | void> {
  const releaseId = creditReleaseIdForAskRecoveryKey(operation.idempotencyKey);
  if (!releaseId) throw new Error(`Credit-release ask ${operation.id} has no release id in its key`);

  const release = await prisma.memberCredit.findUnique({
    where: { id: releaseId },
    select: { type: true, amountCents: true, appliedToBookingId: true, outsideSpendConvergedAt: true },
  });
  if (
    !release ||
    release.type !== CreditType.BOOKING_APPLIED ||
    release.outsideSpendConvergedAt === null ||
    release.appliedToBookingId !== operation.bookingId ||
    release.amountCents <= 0
  ) {
    await closeWithoutAsk(operation, "not-a-release", deps);
    return;
  }

  const payment = await prisma.payment.findUnique({
    where: { id: operation.paymentId },
    include: { booking: { include: { member: true, organisation: { select: { name: true, email: true } } } } },
  });
  if (!payment?.booking) throw new Error(`Payment ${operation.paymentId} not found for a credit-release ask`);
  const booking = payment.booking;
  // Cancelled and bumped bookings keep their ask columns by design (INV-ADDPAY-023) and
  // are owed nothing here: the cancel settles the credit. A deleted booking has no owner to ask.
  if (booking.deletedAt !== null || booking.status === BookingStatus.CANCELLED || booking.status === BookingStatus.BUMPED) {
    // A retry after a failed retirement finds the request it wrote still outstanding: retire it
    // as the cancel does before closing (#4316; throws to retry). Cycle: dynamic.
    const guard = await import("@/lib/ended-booking-ask-guard");
    await guard.retireOutstandingAskOnEndedBooking({ format, bookingId: operation.bookingId, paymentId: operation.paymentId });
    await closeWithoutAsk(operation, "booking-not-owed", deps, { bookingStatus: booking.status });
    return;
  }
  // A booking whose payment has taken nothing owes its whole price as the PRIMARY payment,
  // which the ordinary doors size from current credit; an ask here would double it.
  if (!isCapturedPaymentStatus(payment.status)) {
    await closeWithoutAsk(operation, "payment-not-captured", deps, { paymentStatus: payment.status });
    return;
  }

  // A group organiser's booking is settled on the organiser's payment, not the member's card.
  if (booking.organiserSettled) {
    await closeWithoutAsk(operation, "organiser-settled", deps);
    return;
  }

  // An unpaid EDIT request open on the booking is MERGED into this one (#4491, `INV-ADDPAY-052`):
  // the mint below carries its balance and supersedes it, and the supersede moves its waiting
  // supplementary invoice onto this request, so one card payment pays both invoices. Where that
  // move would not take every edit invoice, the release waits for the edit to be paid or withdrawn
  // - for as long as that takes. A throw here used to spend the row's attempts in about 17 hours
  // and leave it terminal, and the sweep never looks at a release twice, so the money was never
  // asked for. Now the row is put back at the longest retry interval with its attempt handed back,
  // and the officers are told once (`INV-ADDPAY-051`). Decided BEFORE the Xero read below: it needs
  // only the database, and a waiting row must never take the read's failure path (an unreachable
  // Xero would otherwise spend its attempts and make it terminal after all), nor read Xero every
  // 12 hours for nothing.
  const liveAsk =
    outstandingAdditionalAskCents(payment) > 0 && payment.additionalPaymentIntentId
      ? {
          id: payment.id,
          bookingId: operation.bookingId,
          xeroInvoiceId: payment.xeroInvoiceId,
          additionalAmountCents: payment.additionalAmountCents,
          additionalPaymentIntentId: payment.additionalPaymentIntentId,
        }
      : null;
  if (liveAsk) {
    const merge = await readCreditReleaseMergeVerdict(prisma, liveAsk);
    if (!merge.merge) {
      await signalCreditReleaseToOfficers({
        bookingId: operation.bookingId,
        reason: "waiting-on-edit-request",
        key: `waiting-on-edit-request:${operation.id}`,
        // Why it could not merge, in the officers' own note (#4491).
        detail: CREDIT_RELEASE_MERGE_WAIT_WORDS[merge.reason],
        metadata: {
          operationId: operation.id,
          releasedCents: operation.amountCents,
          editPaymentIntentId: liveAsk.additionalPaymentIntentId,
          notMergedBecause: merge.reason,
        },
      });
      logger.info({ operationId: operation.id, bookingId: operation.bookingId }, CREDIT_RELEASE_WAITING_ON_EDIT_MESSAGE);
      await deps.wait(operation, CREDIT_RELEASE_WAITING_ON_EDIT_MESSAGE);
      // Not a completion: the runner counts it as a retry, not a success.
      return "waited";
    }
  }

  // The released amount stands on the booking's own invoice (D1): that invoice is what the card
  // payment will be recorded against, so it must exist and still owe the money. A provider read,
  // outside every lock. An invoice not yet in Xero, or in a state that cannot take a payment, is a
  // thrown error: the row backs off and retries, and on exhaustion alerts the officers - never a
  // quiet close, because the member does owe the money.
  if (!payment.xeroInvoiceId) {
    throw new Error("The booking's invoice is not in Xero yet, so the released credit cannot be asked for yet");
  }
  const balance = await readInvoiceBalance(payment.xeroInvoiceId);
  if (isSettledInXero(balance)) {
    // Paid another way: nothing to ask, but the ledger must still show the money as paid.
    const { recordReleasePaidInXeroCash } = await import("@/lib/credit-release-ask-close");
    const cashCents = await recordReleasePaidInXeroCash({
      paymentId: operation.paymentId,
      releasedCents: Math.min(operation.amountCents, release.amountCents),
      balance,
    });
    await closeWithoutAsk(operation, "invoice-settled-in-xero", deps, { invoiceId: balance.invoiceId, cashCents });
    return;
  }
  const invoiceDueCents = openBalanceCents(balance);
  if (invoiceDueCents === null) {
    throw new Error(
      `Xero shows the booking's invoice as ${balance.status || "unreadable"}, so a card payment cannot be recorded against it; leaving the request to retry`,
    );
  }

  const unaskedCents = bookingLedgerResidualCents({
    finalPriceCents: booking.finalPriceCents,
    changeFeeCents: payment.changeFeeCents,
    amountCents: payment.amountCents,
    refundedAmountCents: payment.refundedAmountCents,
    creditAppliedCents: payment.creditAppliedCents,
    additionalAmountCents: payment.additionalAmountCents,
    additionalPaymentStatus: payment.additionalPaymentStatus,
  });
  const ask = sizeCreditReleaseAsk({
    releasedCents: Math.min(operation.amountCents, release.amountCents, invoiceDueCents),
    unaskedCents,
    payment,
  });
  if (ask.amountCents <= 0) {
    await closeWithoutAsk(operation, "nothing-unasked", deps, { unaskedCents });
    return;
  }
  const refusal = localChargeRefusal(format, ask.amountCents);
  if (refusal) {
    // #4675: the officers are told only by the attempt that closed the row.
    if (!(await closeWithoutAsk(operation, "below-card-minimum", deps, { askCents: ask.amountCents }))) return;
    const { alertPaymentRecoveryOfficers } = await import("@/lib/payment-recovery-alert");
    await alertPaymentRecoveryOfficers(
      {
        bookingId: operation.bookingId,
        operationId: operation.id,
        amountCents: ask.amountCents,
        paymentIntentId: "none",
        errorMessage: `The member owes ${formatCents(ask.amountCents, format)} for credit that was used in Xero, which is too small to ask for by card. Please collect it another way. ${refusal.message}`,
      },
      format,
    );
    return;
  }

  const customerId = await resolveAskCustomerId(payment);
  // The key names the amount once it moved off the frozen figure: Stripe refuses a key replayed
  // with other parameters, and a re-derived ask is a different request (`stripeIdempotencyKeyForAskAmount`).
  const baseKey = buildCreditReleaseAskStripeIdempotencyKey(releaseId);
  const idempotencyKey = ask.amountCents === operation.amountCents ? baseKey : stripeIdempotencyKeyForAskAmount(baseKey, ask.amountCents);
  const intent = await createPaymentIntent({
    format,
    amountCents: ask.amountCents,
    customerId,
    idempotencyKey,
    metadata: {
      bookingId: operation.bookingId,
      type: ADDITIONAL_ASK_INTENT_TYPE,
      reason: CREDIT_RELEASE_ASK_REASON,
      creditReleaseId: releaseId,
    },
  });

  // Dynamic import: booking-payment-cleanup imports the recovery runner.
  const { queueSupersededAdditionalIntentCancellationRows, cancelSupersededAdditionalIntentsNow } = await import(
    "@/lib/booking-payment-cleanup"
  );
  const held = await deps.holdClaim(operation, async (store) => {
    // Re-read under the Payment row lock: the figures that sized this request, and the ask it
    // supersedes, must be the ones now (a capture, a reduction, an edit or another release may
    // have moved them since the read above). A difference throws and the row retries, re-sized.
    await lockPaymentForRefundedTotal(store, operation.paymentId);
    const fresh = await store.payment.findUnique({ where: { id: operation.paymentId }, include: { booking: true } });
    if (!fresh?.booking || sizingBasis(fresh) !== sizingBasis(payment)) {
      throw new Error("The booking's payment changed while the released-credit request was being raised; retrying");
    }
    // The merge decided again under the lock (#4491): an edit invoice that can no longer follow
    // this request (sent, retired or resolved since) means the row retries and waits instead.
    if (liveAsk && !(await readCreditReleaseMergeVerdict(store, liveAsk)).merge) {
      throw new Error("The unpaid edit request on the booking changed while the released-credit request was being raised; retrying");
    }
    await refuseAdoptedIntentOnLedger(store, { intent, adopted: false });
    await upsertPaymentIntentTransaction({
      paymentId: operation.paymentId,
      kind: PaymentTransactionKind.ADDITIONAL,
      paymentIntentId: intent.id,
      amountCents: ask.amountCents,
      // The same value that sized the amount says what it absorbed (INV-PAY-098).
      carriedAskCents: ask.carriedCents,
      status: PaymentStatus.PENDING,
      reason: CREDIT_RELEASE_ASK_REASON,
      stripeCustomerId: mintedIntentCustomerId(intent, customerId),
      // No edit and no supplementary invoice: the money rides on the booking's own invoice.
      hadIssuedXeroInvoice: false,
      store,
    });
    await store.paymentRecoveryOperation.update({ where: { id: operation.id }, data: { paymentIntentId: intent.id } });
    await createAuditLog(
      {
        action: "payment.credit_release_ask.raised",
        subjectMemberId: bookingOwner(booking).memberId,
        targetId: operation.bookingId,
        entityType: "Booking",
        entityId: operation.bookingId,
        category: "payment",
        severity: "important",
        outcome: "success",
        summary: "A card payment was requested for credit that was used in Xero",
        metadata: {
          operationId: operation.id,
          creditReleaseId: releaseId,
          askCents: ask.amountCents,
          carriedCents: ask.carriedCents,
          paymentIntentId: intent.id,
        },
      },
      store,
    );
    return queueSupersededAdditionalIntentCancellationRows({
      bookingId: operation.bookingId,
      paymentId: operation.paymentId,
      newPaymentIntentId: intent.id,
      store,
    });
  });
  if (held === null) {
    // #4652 (`INV-PAY-120`): nothing written, and the hold's transaction has ended. The intent was
    // never offered; it is cancelled at Stripe, best-effort, once a reclaiming runner closed this
    // row without it and nothing names it (`settleLostRecoveryClaimHold`). Minted under this
    // release's own key, never adopted. Dynamic import: that module reaches the recovery runner.
    const { settleLostRecoveryClaimHold } = await import("@/lib/reissued-ask-abandoned-intent");
    await settleLostRecoveryClaimHold({ operationId: operation.id, bookingId: operation.bookingId, paymentIntentId: intent.id, adopted: false });
    return;
  }
  await cancelSupersededAdditionalIntentsNow({
    format,
    bookingId: operation.bookingId,
    paymentId: operation.paymentId,
    queued: held.value,
    newPaymentIntentId: intent.id,
  });
  // #4316: a cancel committed since the check above could not see this intent. It is retired as
  // the cancel retires one (a failure throws, to retry); the debt closes, nothing is owed.
  const guard = await import("@/lib/ended-booking-ask-guard");
  await guard.replayRetiresAskOnEndedBooking({
    format,
    bookingId: operation.bookingId,
    paymentId: operation.paymentId,
    paymentIntentId: intent.id,
  });
  // Under the claim the hold re-stamped (#4675).
  await deps.complete(held.claim);
}
