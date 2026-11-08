import type { Prisma } from "@prisma/client";
import { lockMemberMoneyPayment, readMemberMoneyApplicationState } from "./application-read";
import { refundFamilyKey } from "./application-state";
import { eventPosted } from "./booking-journal-read";
import { lineDebtor, ownedBy } from "./booking-receipts";
import { isBookingJournalInactive, type BookingJournalContext } from "./journal-activity";
import { memberMoneyEventKeys, type RefundObligationScope } from "./keys";
import { releaseMemberMoneyRefundReservation } from "./post";
import { asReservationRefusal, cardReceiptLine, fundRefundFromReceipt, refundFamilyTip, refundObligationChain } from "./refund-family";
import { postRefundObligation, refundDebtor } from "./refund-obligations";
import { reserveMemberMoneyRefund } from "./store";

/**
 * THE RESERVATION STEP (#4516, Ledger M4c; plan section 5). Before a card refund slice is sent, in a short
 * transaction of its own on the root client that takes only the booking's Payment row, the sender claims the
 * slice's refund debt: the debt's family is funded from the slice's own capture receipt, and the reservation is
 * written under Stripe's own idempotency key for that slice, verbatim (`refundSliceStripeIdempotencyKey`).
 *
 * 1. A capture with no R06 receipt, a booking outside the journal's population, a door whose R05 is not in the
 *    journal, or a receipt on a member a merge moved away from: no reservation. The slice is sent exactly as
 *    today and its refund later posts unapplied (census `RESERVATION_SKIPPED_NO_RECEIPT`, `UNAPPLIED_CARD_REFUND`).
 * 2. A door that defers its R05 to its sender (a superseded intent's refund, an automatic late capture's) gives
 *    its face; the R05 posts here.
 * 3. Every open reservation of the same family on the same capture whose key the plan being sent no longer
 *    carries is released, SUPERSEDED_KEY, and its funding reversed: a re-plan never strands one.
 * 4. The slice is funded from its receipt, taking back that receipt's own collection for any shortfall.
 * 5. C3 and C4 are checked and the reservation written. A broken cap throws `MemberMoneyReservationRefused`
 *    BEFORE Stripe is asked; nothing here commits, the door that committed earlier stands, and the caller reports
 *    the refusal without retrying it.
 */

type Db = Prisma.TransactionClient;

/** The refund debt a sender's slices pay, as the door that raised it named it. */
export interface CardRefundObligationRef {
  scope: RefundObligationScope;
  id: string;
  /** A door that defers its R05 to the sender (step 2) gives the debt's face here. */
  ensureFaceCents?: number;
}

export interface CardRefundSliceReservation {
  paymentId: string;
  obligation: CardRefundObligationRef;
  /** Stripe's idempotency key for the slice, verbatim. */
  attemptKey: string;
  paymentTransactionId: string;
  amountCents: number;
  /** Every key of the plan being sent, made slices included: a reservation under any other key is superseded. */
  planAttemptKeys: readonly string[];
}

export type CardRefundReservationOutcome =
  | { outcome: "reserved"; reservationId: string; replayed: boolean }
  | { outcome: "skipped"; reason: "inactive" | "outside-population" | "no-receipt" | "no-obligation" | "merged-debtor" | "key-already-decided" };

/** Steps 1-5 for one slice, inside the caller's short root-client transaction. */
export async function reserveCardRefundSlice(tx: Db, context: BookingJournalContext, input: CardRefundSliceReservation): Promise<CardRefundReservationOutcome> {
  if (isBookingJournalInactive(context)) return { outcome: "skipped", reason: "inactive" };
  const payment = await tx.payment.findUnique({ where: { id: input.paymentId }, select: { bookingId: true } });
  if (!payment || !(await eventPosted(tx, memberMoneyEventKeys.bookingCharge(payment.bookingId)))) return { outcome: "skipped", reason: "outside-population" };
  const bookingId = payment.bookingId;
  await lockMemberMoneyPayment(tx, bookingId);
  const transaction = await tx.paymentTransaction.findUnique({ where: { id: input.paymentTransactionId }, select: { paymentId: true, stripePaymentIntentId: true } });
  const capture = transaction?.paymentId === input.paymentId ? transaction.stripePaymentIntentId : null;
  const receipt = capture ? await cardReceiptLine(tx, capture) : null;
  if (!capture || !receipt) return { outcome: "skipped", reason: "no-receipt" };

  let { live } = await refundObligationChain(tx, input.obligation.scope, input.obligation.id);
  if (!live && input.obligation.ensureFaceCents !== undefined) {
    live = await postRefundObligation(tx, context, { bookingId, scope: input.obligation.scope, id: input.obligation.id,
      amountCents: input.obligation.ensureFaceCents, origin: "APP", debtorRead: "plain" });
  }
  if (!live) return { outcome: "skipped", reason: "no-obligation" };
  const { lodgeId } = await tx.booking.findUniqueOrThrow({ where: { id: bookingId }, select: { lodgeId: true } });
  const owner = await refundDebtor(tx, bookingId, "plain");
  const tip = await refundFamilyTip(tx, context, { bookingId, lodgeId }, live, owner);
  // A receipt whose debtor is not the tip's (a merge moved the owner after it posted) cannot fund the tip:
  // applications never cross debtors (`store.ts`). The slice is sent as today and its refund posts unapplied.
  if (!tip || !ownedBy(tip, lineDebtor(receipt))) {
    return { outcome: "skipped", reason: "merged-debtor" };
  }

  const state = await readMemberMoneyApplicationState(tx, bookingId);
  const familyIds = new Set(state.obligations.filter((o) => o.kind === "REFUND" && refundFamilyKey(o.key) === live).map((o) => o.id));
  for (const reservation of state.reservations) {
    if (!familyIds.has(reservation.obligationId) || reservation.capture !== capture || input.planAttemptKeys.includes(reservation.attemptKey)) continue;
    await releaseMemberMoneyRefundReservation(tx, context, { bookingId, reservationId: reservation.id, reason: "SUPERSEDED_KEY",
      source: { kind: "PAYMENT", id: input.paymentTransactionId, version: `superseded:${reservation.attemptKey}` } });
  }

  const prior = await tx.memberMoneyRefundReservation.findUnique({ where: { attemptKey: input.attemptKey }, select: { id: true, obligationId: true, release: { select: { id: true } } } });
  if (prior) {
    // The same key reserved before: an open one of this family is this slice's (a retry); any other was decided.
    return !prior.release && familyIds.has(prior.obligationId)
      ? { outcome: "reserved", reservationId: prior.id, replayed: true }
      : { outcome: "skipped", reason: "key-already-decided" };
  }
  const fundingKey = memberMoneyEventKeys.refundFunding(input.attemptKey);
  const funding = await fundRefundFromReceipt(tx, context, { bookingId, receiptLineId: receipt.id, obligationKey: tip.key, amountCents: input.amountCents,
    fundingKey, source: { kind: "PAYMENT", id: input.paymentTransactionId, version: fundingKey }, reason: "Fund a card refund slice from its capture" });
  try {
    const reserved = await reserveMemberMoneyRefund(tx, { bookingId, attemptKey: input.attemptKey, obligationKey: tip.key, stripePaymentIntentId: capture,
      paymentTransactionId: input.paymentTransactionId, amountCents: input.amountCents, fundingJournalId: funding!.journalId });
    return { outcome: "reserved", reservationId: reserved.id, replayed: reserved.replayed };
  } catch (error) {
    throw asReservationRefusal(error);
  }
}
