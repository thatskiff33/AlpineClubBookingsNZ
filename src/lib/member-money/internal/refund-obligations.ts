import type { MemberMoneyOrigin, Prisma } from "@prisma/client";
import logger from "../../logger";
import { lockMemberMoneyPayment, readMemberMoneyApplicationState } from "./application-read";
import { memberMoneyApplicationTotals } from "./application-state";
import { bookingOwnerDebtor, eventPosted } from "./booking-journal-read";
import { lockedBookingDebtor } from "./booking-posting";
import { isBookingJournalInactive, type BookingJournalContext } from "./journal-activity";
import { memberMoneyEventKeys, type MemberMoneyEventKey, type RefundObligationScope } from "./keys";
import { MemberMoneyPlanError, type MemberMoneyDebtor, type MemberMoneyEvidence, type MemberMoneyLegPlan, type MemberMoneyPostingContext } from "./plan";
import { postMemberMoneyEvent, releaseMemberMoneyRefundReservation, reverseMemberMoneyJournal } from "./post";
import { isSenderStripeKey, refundFamily, refundObligationChain, stripeKeyOfReservation } from "./refund-family";

/**
 * R05 AT THE CARD-REFUND DOORS (#4516, Ledger M4c). After the door's price or retention decision has posted
 * (R02, R04, R21, or the capture's own R06), the exact refund debt the door just recorded moves to its own
 * obligation: Dr AR, Cr RP, one obligation per legacy debt record, keyed by the door's scope
 * (`refund-obligation|<scope>|<id>`, the chain rule). No cash leg: Stripe is asked after the door commits, and a
 * reservation then claims the obligation before each slice is sent (`refund-reservations.ts`).
 *
 * Only a booking whose R01 is in the journal posts; an inactive journal posts nothing (decided before the
 * transaction, `INV-LOCK-004`); a debt already posted is a no-op. Nothing here catches a refusal: it rolls the
 * door back (`INV-MONEY-044`).
 */

type Db = Prisma.TransactionClient;

export interface RefundObligationDoor {
  bookingId: string;
  scope: RefundObligationScope;
  /** The legacy debt record's identity: the booking, modification, refund request, review task or capture intent. */
  id: string;
  /** The card refund the door recorded as owed (its frozen plan's total, or the amount it will send). */
  amountCents: number;
  origin: MemberMoneyOrigin;
  actorMemberId?: string | null;
  /**
   * How the door reads the debtor. A door holding `lock(1)` takes the booking row, as M3b's adapter does (a member
   * merge's owner move then commits first or waits); a Payment-row-only writer never takes a booking row
   * (`INV-LOCK-002`, design section 6) and reads the owner plainly.
   */
  debtorRead: "booking-row" | "plain";
  /**
   * An approved appeal: the give-back beyond the cancellation's policy posts first, against approved goodwill
   * (design R05; #4075 keeps the kept fee as charged), then the transfer. Both in the one batch.
   */
  concession?: boolean;
  evidence?: MemberMoneyEvidence;
}

/** The booking's owner as the caller's lock tier allows (`RefundObligationDoor.debtorRead`). */
export async function refundDebtor(tx: Db, bookingId: string, read: "booking-row" | "plain"): Promise<MemberMoneyDebtor> {
  if (read === "booking-row") return lockedBookingDebtor(tx, bookingId);
  const booking = await tx.booking.findUnique({ where: { id: bookingId }, select: { memberId: true, organisationId: true } });
  if (!booking) throw new MemberMoneyPlanError([`booking ${bookingId} does not exist`]);
  return bookingOwnerDebtor(booking);
}

/** R05 for one door's debt. Returns the obligation's key (the R05 event key), or null when nothing posts. */
export async function postRefundObligation(tx: Db, context: BookingJournalContext, door: RefundObligationDoor): Promise<MemberMoneyEventKey | null> {
  if (isBookingJournalInactive(context) || door.amountCents <= 0) return null;
  if (!(await eventPosted(tx, memberMoneyEventKeys.bookingCharge(door.bookingId)))) return null;
  await lockMemberMoneyPayment(tx, door.bookingId);
  const chain = await refundObligationChain(tx, door.scope, door.id);
  if (chain.live) {
    // Review M5: a door that names its debt again for another amount (a webhook's automatic late-capture refund
    // after a treasurer's approval, or the reverse) keeps the face first posted; said, never silently.
    const face = await tx.memberMoneyObligation.findUnique({ where: { obligationKey: chain.live }, select: { faceCents: true } });
    if (face && face.faceCents !== door.amountCents) {
      logger.warn({ bookingId: door.bookingId, obligationKey: chain.live, faceCents: face.faceCents, doorCents: door.amountCents },
        "A card refund door named its refund debt again for a different amount; the debt keeps its first face (#4516)");
    }
    return chain.live;
  }
  const debtor = await refundDebtor(tx, door.bookingId, door.debtorRead);
  const { lodgeId } = await tx.booking.findUniqueOrThrow({ where: { id: door.bookingId }, select: { lodgeId: true } });
  const booking = { bookingId: door.bookingId, lodgeId };
  const evidence: MemberMoneyEvidence = { scope: door.scope, id: door.id, ...door.evidence };
  const leg = { type: "amount" as const, amountCents: door.amountCents, booking, evidence };
  const legs: MemberMoneyLegPlan[] = [
    ...(door.concession ? [{ ...leg, account: "GOODWILL" as const, side: "DEBIT" as const },
      { ...leg, account: "MEMBER_RECEIVABLE" as const, side: "CREDIT" as const, debtor }] : []),
    { ...leg, account: "MEMBER_RECEIVABLE", side: "DEBIT", debtor },
    { ...leg, account: "REFUND_PAYABLE", side: "CREDIT", debtor, obligationKey: chain.next },
  ];
  await postMemberMoneyEvent(tx, context, { kind: "REFUND_OBLIGATION", eventKey: chain.next, origin: door.origin,
    actorMemberId: door.actorMemberId ?? null, source: { kind: "BOOKING", id: door.bookingId, version: chain.next },
    reason: door.concession ? "Refund owed: an approved appeal's concession and its card refund" : "Refund owed by card",
    obligations: [{ key: chain.next, kind: "REFUND", debtor, faceCents: door.amountCents, evidence }], legs });
  return chain.next;
}

/**
 * The door withdrew its debt before Stripe was asked (an appeal's `release_claim`, which puts the request back to
 * PENDING): the family's open reservations under the door's own sender keys are released with their funding, then
 * the R05 is reversed exactly, in the door's transaction. A family something has already paid, or another sender
 * holds a reservation on (#4516 review F3), cannot be withdrawn: that refusal rolls the release back, never
 * caught. A retry of the door posts a fresh R05 under the chain's next key, and its slices reserve their keys'
 * next generation (`reservationGenerationKey`, review F4).
 */
export async function withdrawRefundObligation(tx: Db, context: BookingJournalContext, input: {
  bookingId: string; scope: RefundObligationScope; id: string; actorMemberId?: string | null; reason: string;
  /** The door's own Stripe key prefix: the only reservations it may release. */
  senderKeyPrefix: string;
}): Promise<boolean> {
  if (isBookingJournalInactive(context)) return false;
  if (!(await eventPosted(tx, memberMoneyEventKeys.bookingCharge(input.bookingId)))) return false;
  await lockMemberMoneyPayment(tx, input.bookingId);
  const { live } = await refundObligationChain(tx, input.scope, input.id);
  if (!live) return false;
  const state = await readMemberMoneyApplicationState(tx, input.bookingId);
  const family = refundFamily(state, live);
  if ((memberMoneyApplicationTotals(state).families.get(live)?.paid ?? 0) > 0) {
    throw new MemberMoneyPlanError([`refund obligation ${live} is already paid in part, so its door cannot withdraw it`]);
  }
  const ids = new Set(family.members.map((o) => o.id));
  const held = state.reservations.filter((r) => ids.has(r.obligationId));
  const others = held.filter((r) => !isSenderStripeKey(stripeKeyOfReservation(r.attemptKey), input.senderKeyPrefix));
  if (others.length > 0) {
    throw new MemberMoneyPlanError([`refund obligation ${live} is reserved by another sender (${others.map((r) => r.attemptKey).join(", ")}), so its door cannot withdraw it`]);
  }
  for (const reservation of held) {
    // SUPERSEDED_KEY: the plan that keyed it was withdrawn with the door's approval; nothing was sent under it.
    await releaseMemberMoneyRefundReservation(tx, context, { bookingId: input.bookingId, reservationId: reservation.id, reason: "SUPERSEDED_KEY",
      source: { kind: "BOOKING", id: input.bookingId, version: `withdraw:${reservation.attemptKey}` } });
  }
  await reverseRefundObligation(tx, context, { bookingId: input.bookingId, live, actorMemberId: input.actorMemberId ?? null, reason: input.reason });
  return true;
}

async function reverseRefundObligation(tx: Db, context: MemberMoneyPostingContext, input: {
  bookingId: string; live: MemberMoneyEventKey; actorMemberId: string | null; reason: string;
}): Promise<void> {
  const r05 = await tx.memberMoneyEvent.findUniqueOrThrow({ where: { eventKey: input.live }, select: { journal: { select: { id: true } } } });
  await reverseMemberMoneyJournal(tx, context, { reversesJournalId: r05.journal!.id, origin: "OFFICER", actorMemberId: input.actorMemberId,
    source: { kind: "BOOKING", id: input.bookingId, version: memberMoneyEventKeys.reversal(r05.journal!.id) }, reason: input.reason });
}

/**
 * A LATE CAPTURE THE TREASURER KEEPS OWES NOTHING BACK (#4516 review M5). Its capture-return debt was posted when an
 * automatic refund of it reserved its slice (`ensureFaceCents`, the reservation step), and Stripe's refusal then
 * released only that reservation. The keep, in its own transaction under the Payment row, reverses that R05 while
 * nothing has paid it or holds a reservation on it. One that something paid or still reserves is left as it is
 * and said: that money is moving or moved, and the keep cannot undo it.
 */
export async function closeKeptCaptureReturn(tx: Db, context: BookingJournalContext, input: {
  bookingId: string; paymentIntentId: string; actorMemberId: string | null;
}): Promise<boolean> {
  if (isBookingJournalInactive(context)) return false;
  if (!(await eventPosted(tx, memberMoneyEventKeys.bookingCharge(input.bookingId)))) return false;
  await lockMemberMoneyPayment(tx, input.bookingId);
  const { live } = await refundObligationChain(tx, "capture-return", input.paymentIntentId);
  if (!live) return false;
  const state = await readMemberMoneyApplicationState(tx, input.bookingId);
  const ids = new Set(refundFamily(state, live).members.map((o) => o.id));
  const family = memberMoneyApplicationTotals(state).families.get(live);
  if ((family?.paid ?? 0) !== 0 || (family?.funded ?? 0) !== 0 || state.reservations.some((r) => ids.has(r.obligationId))) {
    logger.warn({ bookingId: input.bookingId, obligationKey: live, paidCents: family?.paid ?? 0, fundedCents: family?.funded ?? 0 },
      "A kept late capture's refund debt is paid or reserved, so the keep leaves it open (#4516)");
    return false;
  }
  await reverseRefundObligation(tx, context, { bookingId: input.bookingId, live, actorMemberId: input.actorMemberId,
    reason: "Late capture kept by the treasurer: nothing is owed back" });
  return true;
}
