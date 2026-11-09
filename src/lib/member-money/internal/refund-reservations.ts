import type { Prisma } from "@prisma/client";
import { lockMemberMoneyPayment, readMemberMoneyApplicationState } from "./application-read";
import { refundFamilyKey } from "./application-state";
import { eventPosted } from "./booking-journal-read";
import { lineDebtor, ownedBy } from "./booking-receipts";
import { isBookingJournalInactive, type BookingJournalContext } from "./journal-activity";
import { memberMoneyEventKeys, type RefundObligationScope } from "./keys";
import { releaseMemberMoneyRefundReservation } from "./post";
import {
  asReservationRefusal,
  cardReceiptLine,
  fundRefundFromReceipt,
  isSenderStripeKey,
  refundFamilyTip,
  refundObligationChain,
  reservationGenerationKey,
  reservationGenerationsWhere,
  stripeKeyOfReservation,
} from "./refund-family";
import { postRefundObligation, refundDebtor } from "./refund-obligations";
import { MemberMoneyReservationRefused, reserveMemberMoneyRefund } from "./store";

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
 * 3. Every open reservation of the same family on the same capture under one of THIS sender's own keys (its key
 *    prefix's) that the plan being sent no longer carries is released, SUPERSEDED_KEY, and its funding reversed: a
 *    re-plan never strands one. Another sender's open reservation on the same debt is its attempt in flight, never
 *    released here (#4516 review F3): C3 and C4 decide whether there is room beside it.
 * 4. The key's own reservations, every generation (`reservationGenerationKey`): an open one is this slice's retry,
 *    replayed only if it reserved the same slice (capture, charge and cents; review L1), else refused; one that
 *    answered a refund means Stripe made it and will replay it, so nothing is reserved again; otherwise (none, or
 *    each released without a refund) the key's next generation is reserved, so the slice never leaves unreserved
 *    (review F4).
 * 5. The slice is funded from its receipt, taking back that receipt's own collection for any shortfall.
 * 6. C3 and C4 are checked and the reservation written. A broken cap throws `MemberMoneyReservationRefused`
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
  /** The sender's Stripe key prefix (`idempotencyKeyPrefix`, or a row's own key): the keys it may supersede. */
  senderKeyPrefix: string;
  paymentTransactionId: string;
  amountCents: number;
  /** Every key of the plan being sent, made slices included: a reservation under any other key is superseded. */
  planAttemptKeys: readonly string[];
}

export type CardRefundReservationOutcome =
  | { outcome: "reserved"; reservationId: string; attemptKey: string; replayed: boolean }
  | { outcome: "skipped"; reason: "inactive" | "outside-population" | "no-receipt" | "no-obligation" | "merged-debtor" | "key-already-decided" };

/** Steps 1-6 for one slice, inside the caller's short root-client transaction. */
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
    const stripeKey = stripeKeyOfReservation(reservation.attemptKey);
    if (!familyIds.has(reservation.obligationId) || reservation.capture !== capture || input.planAttemptKeys.includes(stripeKey)
      || !isSenderStripeKey(stripeKey, input.senderKeyPrefix)) continue;
    await releaseMemberMoneyRefundReservation(tx, context, { bookingId, reservationId: reservation.id, reason: "SUPERSEDED_KEY",
      source: { kind: "PAYMENT", id: input.paymentTransactionId, version: `superseded:${reservation.attemptKey}` } });
  }

  const generations = await tx.memberMoneyRefundReservation.findMany({ where: reservationGenerationsWhere(input.attemptKey),
    select: { id: true, attemptKey: true, obligationId: true, stripePaymentIntentId: true, paymentTransactionId: true, amountCents: true,
      release: { select: { reason: true } } } });
  const open = generations.find((generation) => !generation.release);
  if (open) {
    // Review L1: a retry replays its own claim only for the same slice. A key that reserved another (a row whose one
    // request carries no slice, sent again for a changed amount) would have Stripe replay the original refund, or
    // refuse the key, not make this one: refused before it is asked.
    if (!familyIds.has(open.obligationId) || open.stripePaymentIntentId !== capture || open.paymentTransactionId !== input.paymentTransactionId
      || open.amountCents !== input.amountCents) {
      throw new MemberMoneyReservationRefused([`key ${input.attemptKey} already reserves another slice or debt (${open.amountCents} from ${open.paymentTransactionId})`]);
    }
    return { outcome: "reserved", reservationId: open.id, attemptKey: open.attemptKey, replayed: true };
  }
  if (generations.some((generation) => generation.release?.reason === "ANSWERED")) return { outcome: "skipped", reason: "key-already-decided" };
  const attemptKey = reservationGenerationKey(input.attemptKey, generations.length + 1);
  const fundingKey = memberMoneyEventKeys.refundFunding(attemptKey);
  const funding = await fundRefundFromReceipt(tx, context, { bookingId, receiptLineId: receipt.id, obligationKey: tip.key, amountCents: input.amountCents,
    fundingKey, source: { kind: "PAYMENT", id: input.paymentTransactionId, version: fundingKey }, reason: "Fund a card refund slice from its capture" });
  try {
    const reserved = await reserveMemberMoneyRefund(tx, { bookingId, attemptKey, obligationKey: tip.key, stripePaymentIntentId: capture,
      paymentTransactionId: input.paymentTransactionId, amountCents: input.amountCents, fundingJournalId: funding!.journalId });
    return { outcome: "reserved", reservationId: reserved.id, attemptKey, replayed: reserved.replayed };
  } catch (error) {
    throw asReservationRefusal(error);
  }
}
