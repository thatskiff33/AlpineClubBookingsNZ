import type { MemberMoneyOrigin, Prisma } from "@prisma/client";
import logger from "../../logger";
import { lockMemberMoneyPayment, readMemberMoneyApplicationState } from "./application-read";
import { memberMoneyApplicationTotals } from "./application-state";
import { bookingOwnerDebtor, eventPosted } from "./booking-journal-read";
import { lockedBookingDebtor } from "./booking-posting";
import { isBookingJournalInactive, type BookingJournalContext } from "./journal-activity";
import { memberMoneyApplicationKeys, memberMoneyEventKeys, type MemberMoneyEventKey, type RefundObligationScope } from "./keys";
import { MemberMoneyPlanError, type MemberMoneyDebtor, type MemberMoneyEvidence, type MemberMoneyLegPlan, type MemberMoneyPostingContext } from "./plan";
import { postMemberMoneyEvent, releaseMemberMoneyRefundReservation, reverseMemberMoneyJournal } from "./post";
import { isStripeKeyOfSenderPrefix } from "../../payment-recovery-keys";
import { memberMoneyChainTip, refundFamily, refundFamilyOpenCents, refundFamilyTip, refundObligationChain, stripeKeyOfReservation, type RefundBooking } from "./refund-family";
import { lineDebtor, moveMergedDebtorResidue } from "./booking-receipts";

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
  /**
   * The batch's reason. Card doors leave it unset ("Refund owed by card"); a hand-back or a review paid by hand
   * names how the money goes back, so the journal does not call a bank payment a card refund.
   */
  reason?: string;
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
    reason: door.reason ?? (door.concession ? "Refund owed: an approved appeal's concession and its card refund" : "Refund owed by card"),
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
 *
 * The caller already holds `lock(1)` and then the booking row (#5191): this takes the Payment row, and the owner read
 * under the booking row comes after it (`lockedRefundBooking`, or a part's `debtorRead: "booking-row"`), so a caller
 * that had not taken that row first would take it after the Payment row.
 */
export async function withdrawRefundObligation(tx: Db, context: BookingJournalContext, input: {
  bookingId: string; scope: RefundObligationScope; id: string; actorMemberId?: string | null; reason: string;
  /** The door's own Stripe key prefix: the only reservations it may release. */
  senderKeyPrefix: string;
  /**
   * #4516 (owner decision, 15 Nov 2026, comment 6893252570): withdraw only part of the debt (`amountCents`: a hand-back
   * reduced by card disputes lost for part of it), or what is open of it (`"open"`: a reduced hand-back dismissed).
   * Posted under `eventKey` as the mirror of the R05 for those cents, paying its live tip; a debt nothing has paid
   * is still withdrawn whole by the exact reversal. Without `part`, a debt anything has paid is refused, as before.
   */
  part?: { eventKey: MemberMoneyEventKey; amountCents: number | "open"; debtorRead: "booking-row" | "plain" };
}): Promise<boolean> {
  if (isBookingJournalInactive(context)) return false;
  if (!(await eventPosted(tx, memberMoneyEventKeys.bookingCharge(input.bookingId)))) return false;
  await lockMemberMoneyPayment(tx, input.bookingId);
  const { live } = await refundObligationChain(tx, input.scope, input.id);
  if (!live) return false;
  const state = await readMemberMoneyApplicationState(tx, input.bookingId);
  const family = refundFamily(state, live);
  const paid = memberMoneyApplicationTotals(state).families.get(live)?.paid ?? 0;
  if (paid > 0 && !input.part) {
    throw new MemberMoneyPlanError([`refund obligation ${live} is already paid in part, so its door cannot withdraw it`]);
  }
  const ids = new Set(family.members.map((o) => o.id));
  const held = state.reservations.filter((r) => ids.has(r.obligationId));
  const others = held.filter((r) => !isStripeKeyOfSenderPrefix(stripeKeyOfReservation(r.attemptKey), input.senderKeyPrefix));
  if (others.length > 0) {
    throw new MemberMoneyPlanError([`refund obligation ${live} is reserved by another sender (${others.map((r) => r.attemptKey).join(", ")}), so its door cannot withdraw it`]);
  }
  const part = input.part;
  if (part && (paid > 0 || part.amountCents !== "open")) {
    if (held.length > 0) throw new MemberMoneyPlanError([`refund obligation ${live} holds reservations, so only its whole withdrawal can release them`]);
    return withdrawRefundObligationPart(tx, context, { bookingId: input.bookingId, live, state, part, actorMemberId: input.actorMemberId ?? null, reason: input.reason });
  }
  for (const reservation of held) {
    // SUPERSEDED_KEY: the plan that keyed it was withdrawn with the door's approval; nothing was sent under it.
    await releaseMemberMoneyRefundReservation(tx, context, { bookingId: input.bookingId, reservationId: reservation.id, reason: "SUPERSEDED_KEY",
      source: { kind: "BOOKING", id: input.bookingId, version: `withdraw:${reservation.attemptKey}` } });
  }
  await reverseRefundObligation(tx, context, { booking: await lockedRefundBooking(tx, input.bookingId), live, actorMemberId: input.actorMemberId ?? null, reason: input.reason });
  return true;
}

/**
 * Part of a debt withdrawn: Dr RP, Cr AR for the cents (the mirror of its R05 for them), paying the family's live tip,
 * so what is open drops by exactly that and the receivable holds it again, as a whole withdrawal leaves the rest. The
 * tip is the owner's (D4 posts a merged owner's successor first). Capped at what is open; a replay posts nothing.
 */
async function withdrawRefundObligationPart(tx: Db, context: MemberMoneyPostingContext, input: {
  bookingId: string; live: MemberMoneyEventKey; state: Awaited<ReturnType<typeof readMemberMoneyApplicationState>>;
  part: NonNullable<Parameters<typeof withdrawRefundObligation>[2]["part"]>; actorMemberId: string | null; reason: string;
}): Promise<boolean> {
  const { part } = input;
  const open = Math.max(0, refundFamilyOpenCents(input.state, input.live));
  const cents = part.amountCents === "open" ? open : Math.min(part.amountCents, open);
  // #5197: a rest withdrawal a late win reversed (`restoreHandBackObligation`) is followed by its chain's next key,
  // so dismissing the reopened task again withdraws the restored rest again; a replay still finds its own tip.
  const eventKey = part.amountCents === "open" ? await memberMoneyChainTip(tx, part.eventKey) : part.eventKey;
  if (await eventPosted(tx, eventKey)) {
    if (part.amountCents === "open") return false;
    // A reduction's key names the lost disputes it counted; posted already, a new reduction under it means a
    // dispute's amount changed since. Refused, so the door rolls back rather than lowering the task alone.
    throw new MemberMoneyPlanError([`part withdrawal ${part.eventKey} is already posted, so a further part cannot use its name`]);
  }
  if (cents <= 0) return false;
  const { lodgeId } = await tx.booking.findUniqueOrThrow({ where: { id: input.bookingId }, select: { lodgeId: true } });
  const booking = { bookingId: input.bookingId, lodgeId };
  const tip = await refundFamilyTip(tx, context, booking, input.live, await refundDebtor(tx, input.bookingId, part.debtorRead));
  if (!tip) throw new MemberMoneyPlanError([`refund obligation ${input.live} has no live tip, so part of it cannot be withdrawn`]);
  const debtor = lineDebtor(tip);
  const evidence = { withdrawnFrom: input.live, cents };
  const leg = { type: "amount" as const, amountCents: cents, booking, evidence };
  await postMemberMoneyEvent(tx, context, { kind: "ADJUSTMENT", eventKey, origin: "OFFICER", actorMemberId: input.actorMemberId,
    source: { kind: "BOOKING", id: input.bookingId, version: eventKey }, reason: input.reason,
    legs: [{ ...leg, account: "REFUND_PAYABLE", side: "DEBIT", debtor, obligationKey: tip.key }, { ...leg, account: "MEMBER_RECEIVABLE", side: "CREDIT", debtor }],
    applications: [{ key: memberMoneyApplicationKeys.application(eventKey, input.bookingId, tip.key), source: { leg: 0 }, obligationKey: tip.key, amountCents: cents }] });
  return true;
}

/**
 * The booking's owner read under its row, and its lodge, for a whole reversal. Every caller already holds that row
 * after `lock(1)` (an appeal's `release_claim` takes it first, #5191; the keep and a hand-back's dismissal take it
 * at the completion's start), so taking it here again is a no-op, never a booking row after the Payment row. Under
 * it a member merge's owner move has committed or waits, so the owner read is the one the residue move follows to.
 */
async function lockedRefundBooking(tx: Db, bookingId: string): Promise<OwnedRefundBooking> {
  const owner = await refundDebtor(tx, bookingId, "booking-row");
  const { lodgeId } = await tx.booking.findUniqueOrThrow({ where: { id: bookingId }, select: { lodgeId: true } });
  return { bookingId, lodgeId, owner };
}

type OwnedRefundBooking = RefundBooking & { owner: MemberMoneyDebtor };

/**
 * The exact mirror of the R05, on the debtor it named. A debtor merged away since leaves that receivable stray, so
 * the R05's own receivable, when the merge snapshot missed it, and then the mirror's are carried along the committed
 * merge chain to the owner, as a reversed receipt's is (D4, #5191); a merge after this commits nets it in its own
 * snapshot instead, and with no merge nothing moves.
 */
async function reverseRefundObligation(tx: Db, context: MemberMoneyPostingContext, input: {
  booking: OwnedRefundBooking; live: MemberMoneyEventKey; actorMemberId: string | null; reason: string;
}): Promise<void> {
  const { bookingId, lodgeId, owner } = input.booking;
  // The debt itself first: a reservation reads its debtor unlocked (`refund-reservations.ts`), so an R05 can land on
  // a member after that member's merge snapshot. Its receivable is then carried too, or the mirror's move alone would
  // leave the debt behind; an R05 the snapshot counted is skipped, and a replay posts nothing.
  await moveMergedDebtorResidue(tx, context, { bookingId, lodgeId }, owner, input.live);
  const r05 = await tx.memberMoneyEvent.findUniqueOrThrow({ where: { eventKey: input.live }, select: { journal: { select: { id: true } } } });
  const reversal = memberMoneyEventKeys.reversal(r05.journal!.id);
  await reverseMemberMoneyJournal(tx, context, { reversesJournalId: r05.journal!.id, origin: "OFFICER", actorMemberId: input.actorMemberId,
    source: { kind: "BOOKING", id: bookingId, version: reversal }, reason: input.reason });
  await moveMergedDebtorResidue(tx, context, { bookingId, lodgeId }, owner, reversal);
}

/**
 * A LATE CAPTURE THE TREASURER KEEPS OWES NOTHING BACK (#4516 review M5). Its capture-return debt was posted when an
 * automatic refund of it reserved its slice (`ensureFaceCents`, the reservation step), and Stripe's refusal then
 * released only that reservation. The keep, in its own transaction under the Payment row, reverses that R05 while
 * nothing has paid it or holds a reservation on it. One that something paid or still reserves is left as it is
 * and said: that money is moving or moved, and the keep cannot undo it.
 *
 * The caller already holds `lock(1)` and then the booking row (#5191; the completion takes both before the Payment
 * row), because `lockedRefundBooking` reads the owner under the booking row after this has taken the Payment row.
 */
export async function closeKeptCaptureReturn(tx: Db, context: BookingJournalContext, input: {
  bookingId: string; paymentIntentId: string; actorMemberId: string | null;
}): Promise<boolean> {
  if (isBookingJournalInactive(context)) return false;
  if (!(await eventPosted(tx, memberMoneyEventKeys.bookingCharge(input.bookingId)))) return false;
  await lockMemberMoneyPayment(tx, input.bookingId);
  const { live } = await refundObligationChain(tx, "capture-return", input.paymentIntentId);
  if (!live) return false;
  const family = memberMoneyApplicationTotals(await readMemberMoneyApplicationState(tx, input.bookingId)).families.get(live);
  // An open reservation always holds its funding (the reservation step funds, then reserves), so funded covers it.
  if ((family?.paid ?? 0) !== 0 || (family?.funded ?? 0) !== 0) {
    logger.warn({ bookingId: input.bookingId, obligationKey: live, paidCents: family?.paid ?? 0, fundedCents: family?.funded ?? 0 },
      "A kept late capture's refund debt is paid or reserved, so the keep leaves it open (#4516)");
    return false;
  }
  await reverseRefundObligation(tx, context, { booking: await lockedRefundBooking(tx, input.bookingId), live, actorMemberId: input.actorMemberId,
    reason: "Late capture kept by the treasurer: nothing is owed back" });
  return true;
}
