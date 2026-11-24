import type { Prisma } from "@prisma/client";
import { cardRefundPaidAnotherWayClosesWhere, paidAnotherWayUnpaidCents } from "../../manual-refund-task-settlement-rules";
import { parseRefundAllocationPlan } from "../../open-card-refund-owed";
import { refundSliceStripeIdempotencyKey } from "../../payment-recovery-keys";
import { cardRefundOperationStripeKeyPrefix } from "../../card-refund-stripe-key-prefix";
import { isRecordedRefundStatus } from "../../payment-transaction-status";
import { lockMemberMoneyPayment, readMemberMoneyApplicationState } from "./application-read";
import { isBookingJournalInactive, type BookingJournalContext } from "./journal-activity";
import { memberMoneyEventKeys } from "./keys";
import { MemberMoneyPlanError } from "./plan";
import { releaseMemberMoneyRefundReservation } from "./post";
import { postCardRefundCash } from "./refund-cash";
import { cardReceiptLine, reservationGenerationsWhere, stripeKeyOfReservation } from "./refund-family";
import { classifyHandBacks, readBookingHandBackJournal } from "./hand-back-census";
import { eventPosted } from "./booking-journal-read";

/**
 * THE REFUND CENSUS AND THE ROLLBACK RULES (#4516, Ledger M4c; plan section 8). Read-only classes for an owner's
 * dry run, the exact reconciliation of reservations a rollback stranded, and the OPERATOR release, the only way
 * a reservation nothing can answer is released.
 *
 * - `STRANDED_RESERVATION`: an open reservation no recorded refund answers. In flight while its sender runs;
 *   stranded once nothing will (a rollback across M4c, a sender that died). Listed, never released here.
 * - `ANSWERABLE_RESERVATION`: an open reservation a recovery row's plan marks made (`madeRefundId`) by a refund
 *   on record: `--reconcile` answers it (or releases it, REFUSED, when that refund failed) through the cash writer.
 * - `CARD_REFUND_WITHOUT_EVENT`: a card refund row with no R12; the next cash-writer run on the payment posts it.
 * - `RESERVATION_SKIPPED_NO_RECEIPT` / `UNAPPLIED_CARD_REFUND`: a live R12 answered to no debt, without or with
 *   an R06 receipt for its capture. A dashboard refund, a capture with no receipt, or a debtor a merge moved.
 * - `PAID_ANOTHER_WAY_WITHOUT_EVENT`: a "Paid another way" close of one of the payment's card refund rows with no
 *   R14 (#4516 review M3): one made before M4c (M9 back-posts history), or while the journal was inactive.
 * - `KEPT_REST_WITHOUT_CLOSE_OUT`: a part close whose record says the club kept the rest, whose R14 posted
 *   applied to its debt, and whose rest has no close-out (`refund-close-out:<record>`). An R14 posted unapplied
 *   (its debt was never in the journal) has no debt to close out, so it is not listed (round-2 review E).
 *
 * #5185 (M4d): and the booking's bank and cash hand-backs, the classes `HAND_BACK_CENSUS_CLASSES` names
 * (`hand-back-census.ts` reads and classifies them).
 */

type Db = Prisma.TransactionClient;

/**
 * THE HAND-BACK CLASSES (#4516, M4d; #5185), defined once: this command lists them, and the booking-ledger census
 * (`booking-ledger:census`, and the nightly money census that runs it) reports each as an integrity kind that holds
 * its gate (`BOOKING_LEDGER_INTEGRITY_KINDS`). What each means: `hand-back-census.ts`.
 */
export const HAND_BACK_CENSUS_CLASSES = [
  "HAND_BACK_WITHOUT_EVENT",
  "HAND_BACK_PAID_WITHOUT_EVENT",
  "UNAPPLIED_HAND_BACK",
  "HAND_BACK_OBLIGATION_DRIFT",
  "KEEP_WITHOUT_EVENT",
] as const;
export type HandBackCensusClass = (typeof HAND_BACK_CENSUS_CLASSES)[number];
export type RefundCensusClass = "STRANDED_RESERVATION" | "ANSWERABLE_RESERVATION" | "CARD_REFUND_WITHOUT_EVENT"
  | "RESERVATION_SKIPPED_NO_RECEIPT" | "UNAPPLIED_CARD_REFUND" | "PAID_ANOTHER_WAY_WITHOUT_EVENT" | "KEPT_REST_WITHOUT_CLOSE_OUT"
  | HandBackCensusClass;
export interface RefundCensusFinding { bookingId: string; identity: string; kind: RefundCensusClass; cents: number }

/** Each refund a payment's recovery rows mark made, by the exact attempt key of the slice it made. */
async function madeRefundKeys(tx: Db, paymentId: string): Promise<Map<string, string>> {
  const rows = await tx.paymentRecoveryOperation.findMany({ where: { paymentId, type: { in: ["REFUND_BOOKING_MODIFICATION", "REFUND_SUPERSEDED_PAYMENT"] } },
    select: { id: true, type: true, idempotencyKey: true, bookingId: true, stripeKeyPrefix: true, allocationPlan: true } });
  const keys = new Map<string, string>();
  for (const row of rows) {
    const prefix = cardRefundOperationStripeKeyPrefix(row);
    for (const slice of parseRefundAllocationPlan(row.allocationPlan) ?? []) {
      if (slice.madeRefundId) keys.set(refundSliceStripeIdempotencyKey(prefix, slice), slice.madeRefundId);
    }
  }
  return keys;
}

/** One population booking, in the caller's read-only repeatable-read snapshot. No provider read, lock or repair. */
export async function readBookingRefundCensus(tx: Db, paymentId: string): Promise<RefundCensusFinding[]> {
  const payment = await tx.payment.findUniqueOrThrow({ where: { id: paymentId }, select: { bookingId: true } });
  const findings: RefundCensusFinding[] = [];
  const add = (kind: RefundCensusClass, identity: string, cents: number) => findings.push({ bookingId: payment.bookingId, identity, kind, cents });
  const state = await readMemberMoneyApplicationState(tx, payment.bookingId);
  const made = await madeRefundKeys(tx, paymentId);
  const refunds = await tx.paymentRefund.findMany({ where: { paymentId, paymentTransactionId: { not: null } },
    select: { stripeRefundId: true, stripePaymentIntentId: true, status: true, amountCents: true } });
  for (const reservation of state.reservations) {
    const refund = refunds.find((r) => r.stripeRefundId === made.get(stripeKeyOfReservation(reservation.attemptKey)));
    add(refund ? "ANSWERABLE_RESERVATION" : "STRANDED_RESERVATION", reservation.attemptKey, reservation.amountCents);
  }
  for (const refund of refunds) {
    const event = await tx.memberMoneyEvent.findUnique({ where: { eventKey: memberMoneyEventKeys.refund(refund.stripeRefundId) },
      select: { journal: { select: { reversedBy: { select: { id: true } }, applications: { select: { id: true } } } } } });
    if (!event?.journal) {
      if (isRecordedRefundStatus(refund.status)) add("CARD_REFUND_WITHOUT_EVENT", refund.stripeRefundId, refund.amountCents);
      continue;
    }
    if (event.journal.reversedBy || event.journal.applications.length > 0) continue;
    const answered = await tx.memberMoneyEvent.findUnique({ where: { eventKey: memberMoneyEventKeys.refundAnswer(refund.stripeRefundId) }, select: { id: true } });
    if (answered) continue;
    const receipt = refund.stripePaymentIntentId ? await cardReceiptLine(tx, refund.stripePaymentIntentId) : null;
    add(receipt ? "UNAPPLIED_CARD_REFUND" : "RESERVATION_SKIPPED_NO_RECEIPT", refund.stripeRefundId, refund.amountCents);
  }
  const operationIds = (await tx.paymentRecoveryOperation.findMany({ where: { paymentId }, select: { id: true } })).map((row) => row.id);
  const closes = operationIds.length === 0 ? [] : await tx.manualRefundTask.findMany({ where: cardRefundPaidAnotherWayClosesWhere(operationIds),
    select: { id: true, amountCents: true, raisedAmountCents: true } });
  for (const close of closes) {
    const r14 = await tx.memberMoneyEvent.findUnique({ where: { eventKey: memberMoneyEventKeys.paidAnotherWay(close.id) },
      select: { journal: { select: { lines: { where: { account: "MEMBER_RECEIVABLE" }, select: { id: true } } } } } });
    if (!r14) {
      add("PAID_ANOTHER_WAY_WITHOUT_EVENT", close.id, close.amountCents ?? 0);
      continue;
    }
    // Round-2 review E: an R14 posted unapplied (its debt was not in the journal, Dr AR) has no debt to close out.
    if ((r14.journal?.lines.length ?? 0) > 0) continue;
    const keptCents = paidAnotherWayUnpaidCents(close);
    if (keptCents > 0 && !(await tx.memberMoneyEvent.findUnique({ where: { eventKey: memberMoneyEventKeys.refundCloseOut(close.id) }, select: { id: true } }))) {
      add("KEPT_REST_WITHOUT_CLOSE_OUT", close.id, keptCents);
    }
  }
  // #5185: only a booking whose R01 is in the journal posts a hand-back event.
  if (!(await eventPosted(tx, memberMoneyEventKeys.bookingCharge(payment.bookingId)))) return findings;
  const handBacks = (await readBookingHandBackJournal(tx, [payment.bookingId])).get(payment.bookingId)!;
  for (const finding of classifyHandBacks(payment.bookingId, handBacks)) add(finding.kind, finding.identity, finding.cents);
  return findings;
}

/**
 * Reconcile on redeploy (plan section 8): every reservation of the payment a recovery row's plan marks made by
 * an exact refund is answered or released through the one cash writer, as if the sender had recorded it. Nothing
 * is matched by amount or time; a reservation no mark names stays open for the OPERATOR release.
 */
export async function reconcileMadeRefundReservations(tx: Db, context: BookingJournalContext, paymentId: string): Promise<number> {
  if (isBookingJournalInactive(context)) return 0;
  const payment = await tx.payment.findUniqueOrThrow({ where: { id: paymentId }, select: { bookingId: true } });
  await lockMemberMoneyPayment(tx, payment.bookingId);
  const made = await madeRefundKeys(tx, paymentId);
  return postCardRefundCash(tx, context, { paymentId, attemptKeys: new Map([...made].map(([key, refundId]) => [refundId, key])) });
}

/** OPERATOR: release one open reservation with its funding, by an owner's explicit command. The caller audits it. */
export async function releaseReservationByOperator(tx: Db, context: BookingJournalContext, input: { reservationId: string }): Promise<{ bookingId: string; attemptKey: string; amountCents: number }> {
  if (isBookingJournalInactive(context)) throw new MemberMoneyPlanError(["the member-money journal is inactive"]);
  const reservation = await tx.memberMoneyRefundReservation.findUnique({ where: { id: input.reservationId },
    select: { attemptKey: true, amountCents: true, paymentTransactionId: true, release: { select: { reason: true } } } });
  if (!reservation) throw new MemberMoneyPlanError([`reservation ${input.reservationId} does not exist`]);
  const transaction = await tx.paymentTransaction.findUniqueOrThrow({ where: { id: reservation.paymentTransactionId }, select: { payment: { select: { bookingId: true } } } });
  const bookingId = transaction.payment.bookingId;
  await releaseMemberMoneyRefundReservation(tx, context, { bookingId, reservationId: input.reservationId, reason: "OPERATOR",
    source: { kind: "OFFICER_FACT", id: input.reservationId, version: `operator:${reservation.attemptKey}` } });
  return { bookingId, attemptKey: reservation.attemptKey, amountCents: reservation.amountCents };
}

/** Whether a Stripe key holds an open reservation, of any generation: a request made and never answered. */
export async function isRefundReservationOpen(db: Pick<Db, "memberMoneyRefundReservation">, stripeKey: string): Promise<boolean> {
  return (await db.memberMoneyRefundReservation.count({ where: { ...reservationGenerationsWhere(stripeKey), release: { is: null } } })) > 0;
}
