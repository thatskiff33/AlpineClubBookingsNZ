import type { Prisma } from "@prisma/client";
import logger from "../../logger";
import { isRecordedRefundStatus } from "../../payment-transaction-status";
import { lockMemberMoneyPayment, readMemberMoneyApplicationState } from "./application-read";
import { refundFamilyKey } from "./application-state";
import { eventPosted } from "./booking-journal-read";
import { lineDebtor, receiptFactContext } from "./booking-receipts";
import { isBookingJournalInactive, type BookingJournalContext } from "./journal-activity";
import { memberMoneyApplicationKeys, memberMoneyEventKeys } from "./keys";
import type { MemberMoneyPostingContext, MemberMoneySource } from "./plan";
import { postMemberMoneyEvent, releaseMemberMoneyRefundReservation, reverseMemberMoneyJournal } from "./post";
import { refundFamilyTip, type RefundBooking } from "./refund-family";
import { refundDebtor } from "./refund-obligations";

/**
 * R12 AND R13 IN THE ONE CASH WRITER (#4516, Ledger M4c; design R12/R13). `recordStripeRefundsAgainstTransaction`
 * calls this after its payment aggregate, under the Payment row it took first, in its own transaction, for every
 * card refund row of the payment, so a run that missed one (an old colour, an inactive journal) is caught up by the
 * next run on that payment.
 *
 * - **R12** posts once, when a refund counts (`isRecordedRefundStatus`), keyed by Stripe's refund id
 *   (`refund:<id>`), never by amount or time. It is APPLIED only through the open reservation its own attempt key
 *   names (the sender's key, or the `refundSliceKey` evidence Stripe returns with the refund): Dr RP on the
 *   family's live tip, Cr Stripe clearing, consuming that reservation. Otherwise it posts UNAPPLIED: Dr AR,
 *   Cr Stripe clearing. Never guessed onto a debt.
 * - **An answer** (`refund-answer:<id>`): a key that arrives after an unapplied R12 reclassifies its Dr AR to RP
 *   through that key's reservation, while the refund still counts. No cash moves again.
 * - **R13**: a refund that counted and then failed or was cancelled reverses, once, its answer, its R12 and the
 *   funding of the reservation it answered, in that order, so the debt is owed again and its receipt is free to
 *   fund the re-send. A refund refused before it ever counted releases its reservation (REFUSED) with its funding.
 */

type Db = Prisma.TransactionClient;
type RefundRow = { stripeRefundId: string; stripePaymentIntentId: string | null; amountCents: number; status: string; stripeCreatedAt: Date | null; createdAt: Date; updatedAt: Date };

async function journalOf(tx: Db, eventKey: string) {
  const event = await tx.memberMoneyEvent.findUnique({ where: { eventKey }, select: { journal: { select: { id: true, reversedBy: { select: { id: true } },
    applications: { select: { id: true } }, lines: { where: { account: "MEMBER_RECEIVABLE" }, select: { debtorKind: true, memberId: true, organisationId: true } } } } } });
  return event?.journal ?? null;
}

/** The open reservation an attempt key names, if it can answer this refund: same capture, same cents. */
async function answeringReservation(tx: Db, bookingId: string, row: RefundRow, attemptKey: string | undefined) {
  if (!attemptKey) return null;
  const state = await readMemberMoneyApplicationState(tx, bookingId);
  const reservation = state.reservations.find((r) => r.attemptKey === attemptKey);
  if (!reservation) return null;
  if (reservation.capture !== row.stripePaymentIntentId || reservation.amountCents !== row.amountCents) {
    logger.error({ bookingId, stripeRefundId: row.stripeRefundId, attemptKey }, "A card refund names a reservation it cannot answer (capture or cents differ); it posts unapplied (#4516)");
    return null;
  }
  return { ...reservation, rootKey: refundFamilyKey(state.obligations.find((o) => o.id === reservation.obligationId)!.key) };
}

async function reverse(tx: Db, context: MemberMoneyPostingContext, journalId: string, refundId: string, reason: string) {
  await reverseMemberMoneyJournal(tx, context, { reversesJournalId: journalId, origin: "STRIPE",
    source: { kind: "REFUND", id: refundId, version: memberMoneyEventKeys.reversal(journalId) }, reason });
}

/** Post every R12, answer and R13 the payment's card refund rows call for; returns the batches posted. */
export async function postCardRefundCash(tx: Db, context: BookingJournalContext, input: {
  paymentId: string;
  /** Stripe refund id to the attempt key it answers: the sender's own key, or the refund's `refundSliceKey`. */
  attemptKeys: ReadonlyMap<string, string>;
}): Promise<number> {
  if (isBookingJournalInactive(context)) return 0;
  const payment = await tx.payment.findUnique({ where: { id: input.paymentId }, select: { bookingId: true, booking: { select: { lodgeId: true } } } });
  if (!payment || !(await eventPosted(tx, memberMoneyEventKeys.bookingCharge(payment.bookingId)))) return 0;
  const booking: RefundBooking = { bookingId: payment.bookingId, lodgeId: payment.booking.lodgeId };
  await lockMemberMoneyPayment(tx, booking.bookingId);
  const rows: RefundRow[] = await tx.paymentRefund.findMany({ where: { paymentId: input.paymentId, paymentTransactionId: { not: null } },
    orderBy: { stripeRefundId: "asc" },
    select: { stripeRefundId: true, stripePaymentIntentId: true, amountCents: true, status: true, stripeCreatedAt: true, createdAt: true, updatedAt: true } });
  let posted = 0;
  for (const row of rows) {
    const attemptKey = input.attemptKeys.get(row.stripeRefundId);
    const r12Key = memberMoneyEventKeys.refund(row.stripeRefundId);
    const r12 = await journalOf(tx, r12Key);
    if (isRecordedRefundStatus(row.status)) {
      if (!r12) posted += await postRefundCash(tx, receiptFactContext(context, row.stripeCreatedAt ?? row.createdAt), booking, row, attemptKey);
      else if (!r12.reversedBy && r12.applications.length === 0 && attemptKey) posted += await postRefundAnswer(tx, context, booking, row, attemptKey, r12);
      continue;
    }
    const failed = receiptFactContext(context, row.updatedAt);
    if (r12 && !r12.reversedBy) {
      posted += await reverseFailedRefund(tx, failed, row.stripeRefundId, r12.id);
    } else if (!r12) {
      const reservation = await answeringReservation(tx, booking.bookingId, row, attemptKey);
      if (reservation) {
        await releaseMemberMoneyRefundReservation(tx, failed, { bookingId: booking.bookingId, reservationId: reservation.id, reason: "REFUSED",
          source: { kind: "REFUND", id: row.stripeRefundId, version: `refused:${reservation.attemptKey}` } });
        posted++;
      }
    }
  }
  return posted;
}

/** R12: applied through its reservation, or unapplied. */
async function postRefundCash(tx: Db, context: MemberMoneyPostingContext, booking: RefundBooking, row: RefundRow, attemptKey: string | undefined): Promise<number> {
  const eventKey = memberMoneyEventKeys.refund(row.stripeRefundId);
  const source: MemberMoneySource = { kind: "REFUND", id: row.stripeRefundId, version: eventKey };
  const evidence = { stripeRefundId: row.stripeRefundId, paymentIntentId: row.stripePaymentIntentId, attemptKey: attemptKey ?? null };
  const clearing = { type: "amount" as const, account: "STRIPE_CLEARING" as const, side: "CREDIT" as const, amountCents: row.amountCents, booking, evidence };
  const reservation = await answeringReservation(tx, booking.bookingId, row, attemptKey);
  const owner = await refundDebtor(tx, booking.bookingId, "plain");
  if (!reservation) {
    await postMemberMoneyEvent(tx, context, { kind: "REFUND", eventKey, origin: "STRIPE", source, reason: "Card refund, not yet answered to a debt",
      legs: [{ type: "amount", account: "MEMBER_RECEIVABLE", side: "DEBIT", amountCents: row.amountCents, debtor: owner, booking, evidence }, clearing] });
    return 1;
  }
  const tip = (await refundFamilyTip(tx, context, booking, reservation.rootKey, owner))!;
  await postMemberMoneyEvent(tx, context, { kind: "REFUND", eventKey, origin: "STRIPE", source, reason: "Card refund paying its reserved debt",
    legs: [{ type: "amount", account: "REFUND_PAYABLE", side: "DEBIT", amountCents: row.amountCents, debtor: lineDebtor(tip), booking, obligationKey: tip.key, evidence }, clearing],
    applications: [{ key: memberMoneyApplicationKeys.application(eventKey, row.stripeRefundId, tip.key), source: { leg: 0 }, obligationKey: tip.key,
      amountCents: row.amountCents, reservationAttemptKey: reservation.attemptKey }] });
  return 1;
}

/** An answer arriving after an unapplied R12: Dr RP, Cr AR, consuming the key's reservation. */
async function postRefundAnswer(tx: Db, context: MemberMoneyPostingContext, booking: RefundBooking, row: RefundRow, attemptKey: string,
  r12: NonNullable<Awaited<ReturnType<typeof journalOf>>>): Promise<number> {
  const eventKey = memberMoneyEventKeys.refundAnswer(row.stripeRefundId);
  if (await eventPosted(tx, eventKey)) return 0;
  const reservation = await answeringReservation(tx, booking.bookingId, row, attemptKey);
  if (!reservation) return 0;
  const tip = (await refundFamilyTip(tx, context, booking, reservation.rootKey, await refundDebtor(tx, booking.bookingId, "plain")))!;
  const evidence = { stripeRefundId: row.stripeRefundId, attemptKey };
  await postMemberMoneyEvent(tx, context, { kind: "TRANSFER", eventKey, origin: "APP", source: { kind: "REFUND", id: row.stripeRefundId, version: eventKey },
    reason: "Answer a card refund to the debt its key reserved",
    legs: [
      { type: "amount", account: "REFUND_PAYABLE", side: "DEBIT", amountCents: row.amountCents, debtor: lineDebtor(tip), booking, obligationKey: tip.key, evidence },
      { type: "amount", account: "MEMBER_RECEIVABLE", side: "CREDIT", amountCents: row.amountCents, debtor: lineDebtor(r12.lines[0]!), booking, evidence },
    ],
    applications: [{ key: memberMoneyApplicationKeys.application(eventKey, row.stripeRefundId, tip.key), source: { leg: 0 }, obligationKey: tip.key,
      amountCents: row.amountCents, reservationAttemptKey: reservation.attemptKey }] });
  return 1;
}

/** R13: the answer, the cash and the answered reservation's funding, each reversed once. */
async function reverseFailedRefund(tx: Db, context: MemberMoneyPostingContext, refundId: string, r12JournalId: string): Promise<number> {
  let posted = 0;
  const answer = await journalOf(tx, memberMoneyEventKeys.refundAnswer(refundId));
  if (answer && !answer.reversedBy) {
    await reverse(tx, context, answer.id, refundId, "Card refund failed later: its answer reversed");
    posted++;
  }
  await reverse(tx, context, r12JournalId, refundId, "Card refund failed later");
  posted++;
  const answered = await tx.memberMoneyRefundReservationRelease.findFirst({ where: { stripeRefundId: refundId, reason: "ANSWERED" },
    select: { reservation: { select: { fundingJournalId: true, fundingJournal: { select: { reversedBy: { select: { id: true } } } } } } } });
  if (answered && !answered.reservation.fundingJournal.reversedBy) {
    await reverse(tx, context, answered.reservation.fundingJournalId, refundId, "Card refund failed later: the receipt it drew on is free again");
    posted++;
  }
  return posted;
}
