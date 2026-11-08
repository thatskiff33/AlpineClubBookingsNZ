import type { Prisma } from "@prisma/client";
import logger from "../../logger";
import { lockMemberMoneyPayment, readMemberMoneyApplicationState } from "./application-read";
import { memberMoneyApplicationTotals } from "./application-state";
import { eventPosted, readBookingLiveChargeCents } from "./booking-journal-read";
import { lineDebtor, ownedBy, receiptFactContext } from "./booking-receipts";
import { isBookingJournalInactive, type BookingJournalContext } from "./journal-activity";
import { memberMoneyApplicationKeys, memberMoneyEventKeys } from "./keys";
import type { MemberMoneyApplicationPlan, MemberMoneySource } from "./plan";
import { releaseMemberMoneyRefundReservation } from "./post";
import {
  cardReceiptLine,
  fundRefundFromReceipt,
  refundFamily,
  refundFamilyOpenCents,
  refundFamilyTip,
  refundObligationChain,
  writeWithLiveCharge,
} from "./refund-family";
import { refundDebtor } from "./refund-obligations";
import type { CardRefundObligationRef } from "./refund-reservations";

/**
 * R14 FOR A "PAID ANOTHER WAY" CLOSE (#4516, Ledger M4c; owner decision of 2 Nov 2026, plan section 14a). In the
 * close's own transaction, after its record and its ledger line, under the `lock(1)` and Payment row it holds:
 *
 * 1. The closed row's reservations close without a refund (CLOSED_WITHOUT_REFUND), their funding reversed.
 * 2. Dr RP, Cr BANK for exactly what the treasurer paid back (`paid-another-way:<record>`), paying the family's
 *    live tip, funded from the receipts of the charges the allocation placed it on. Cash is never refused for a
 *    cap: the applications trim to what is open (design section 4).
 * 3. A part close says what happens to the rest, as the treasurer chose, never by default:
 *    - "club-keeps": the rest of the debt is cleared into a retained booking charge, taxed like the charge, once
 *      per debt (`refund-close-out|<R05 key>`), and the receipts that funded nothing collect it;
 *    - "still-owed": nothing more posts; the debt stays open for the rest, for a later refund or close.
 */

type Db = Prisma.TransactionClient;

export type PaidAnotherWayRest = "club-keeps" | "still-owed";

export interface PaidAnotherWayJournalClose {
  bookingId: string;
  /** The refund debt the closed row paid, or null where its key maps to none (nothing posts). */
  obligation: CardRefundObligationRef | null;
  /** The completed close record (`ManualRefundTask`). */
  recordId: string;
  /** What the treasurer paid back. */
  amountCents: number;
  /** What was owed and not paid back: zero for a full close. */
  restCents: number;
  /** A part close's choice; null for a full close. */
  rest: PaidAnotherWayRest | null;
  /** The closed row's attempt keys: its reservations close without a refund. */
  attemptKeys: readonly string[];
  /** The charges the allocation placed the money on, in its order: their receipts fund the close. */
  transactionIds: readonly string[];
  closedAt: Date;
  actorMemberId: string;
}

/** The R14 and, for a kept rest, the close-out. Returns the batches posted. */
export async function postPaidAnotherWayClose(tx: Db, context: BookingJournalContext, input: PaidAnotherWayJournalClose): Promise<number> {
  if (isBookingJournalInactive(context) || !input.obligation) return 0;
  if (!(await eventPosted(tx, memberMoneyEventKeys.bookingCharge(input.bookingId)))) return 0;
  await lockMemberMoneyPayment(tx, input.bookingId);
  const { live } = await refundObligationChain(tx, input.obligation.scope, input.obligation.id);
  if (!live) {
    logger.warn({ bookingId: input.bookingId, obligation: input.obligation }, "A paid-another-way close's refund debt is not in the journal; its bank cash is not posted (#4516)");
    return 0;
  }
  const at = receiptFactContext(context, input.closedAt);
  const { lodgeId } = await tx.booking.findUniqueOrThrow({ where: { id: input.bookingId }, select: { lodgeId: true } });
  const booking = { bookingId: input.bookingId, lodgeId };
  const owner = await refundDebtor(tx, input.bookingId, "plain");
  let posted = 0;

  const before = await readMemberMoneyApplicationState(tx, input.bookingId);
  const familyIds = new Set(refundFamily(before, live).members.map((o) => o.id));
  for (const reservation of before.reservations.filter((r) => familyIds.has(r.obligationId) && input.attemptKeys.includes(r.attemptKey))) {
    await releaseMemberMoneyRefundReservation(tx, at, { bookingId: input.bookingId, reservationId: reservation.id, reason: "CLOSED_WITHOUT_REFUND",
      source: { kind: "OFFICER_FACT", id: input.recordId, version: `closed:${reservation.attemptKey}` } });
    posted++;
  }
  const tip = await refundFamilyTip(tx, at, booking, live, owner);
  if (!tip) return posted;
  const receipts = (await Promise.all(input.transactionIds.map(async (id) => {
    const row = await tx.paymentTransaction.findUnique({ where: { id }, select: { stripePaymentIntentId: true } });
    const line = row?.stripePaymentIntentId ? await cardReceiptLine(tx, row.stripePaymentIntentId) : null;
    return line && ownedBy(tip, lineDebtor(line)) ? [{ transactionId: id, line }] : [];
  }))).flat();

  // 2. R14: fund what the family's live funding does not already cover, from the allocation's receipts in order.
  const eventKey = memberMoneyEventKeys.paidAnotherWay(input.recordId);
  if (!(await eventPosted(tx, eventKey))) {
    const state = await readMemberMoneyApplicationState(tx, input.bookingId);
    const family = memberMoneyApplicationTotals(state).families.get(live);
    const payCents = Math.min(input.amountCents, Math.max(0, refundFamilyOpenCents(state, live)));
    let needed = Math.max(0, payCents - Math.max(0, (family?.funded ?? 0) - (family?.paid ?? 0) - (family?.reserved ?? 0)));
    for (const { transactionId, line } of receipts) {
      if (needed <= 0) break;
      const fundingKey = memberMoneyEventKeys.refundFunding(`${eventKey}:${transactionId}`);
      const funded = await fundRefundFromReceipt(tx, at, { bookingId: input.bookingId, receiptLineId: line.id, obligationKey: tip.key, amountCents: needed,
        fundingKey, trim: true, source: { kind: "OFFICER_FACT", id: input.recordId, version: fundingKey }, reason: "Fund a refund paid another way from its receipt" });
      needed -= funded?.fundedCents ?? 0;
      if (funded) posted++;
    }
    const evidence = { recordId: input.recordId, rest: input.rest, restCents: input.restCents };
    const leg = { type: "amount" as const, amountCents: input.amountCents, booking, evidence };
    // No collection moves here, so C2 reads the charge as it stands.
    await writeWithLiveCharge(tx, at, { kind: "REFUND", eventKey, origin: "OFFICER", actorMemberId: input.actorMemberId,
      source: { kind: "OFFICER_FACT", id: input.recordId, version: eventKey }, reason: "Refund paid another way",
      legs: [{ ...leg, account: "REFUND_PAYABLE", side: "DEBIT", debtor: lineDebtor(tip), obligationKey: tip.key }, { ...leg, account: "BANK", side: "CREDIT" }],
      applications: payCents > 0 ? [{ key: memberMoneyApplicationKeys.application(eventKey, input.recordId, tip.key), source: { leg: 0 }, obligationKey: tip.key, amountCents: payCents }] : [],
    }, { liveChargeCents: await readBookingLiveChargeCents(tx, input.bookingId) });
    posted++;
  }

  // 3. The rest the club keeps: a retained charge, paid from the debt, and collected from what the receipts still hold.
  if (input.rest === "club-keeps" && input.restCents > 0) posted += await postCloseOut(tx, at, { booking, rootKey: live, tip, receipts, input });
  return posted;
}

async function postCloseOut(tx: Db, context: Parameters<typeof writeWithLiveCharge>[1], args: {
  booking: { bookingId: string; lodgeId: string }; rootKey: string; tip: NonNullable<Awaited<ReturnType<typeof refundFamilyTip>>>;
  receipts: ReadonlyArray<{ transactionId: string; line: { id: string } }>; input: PaidAnotherWayJournalClose;
}): Promise<number> {
  const { booking, tip, input } = args;
  const eventKey = memberMoneyEventKeys.refundCloseOut(args.rootKey as Parameters<typeof memberMoneyEventKeys.refundCloseOut>[0]);
  if (await eventPosted(tx, eventKey)) return 0;
  const state = await readMemberMoneyApplicationState(tx, booking.bookingId);
  const totals = memberMoneyApplicationTotals(state);
  const payCents = Math.min(input.restCents, Math.max(0, refundFamilyOpenCents(state, args.rootKey)));
  const liveBefore = await readBookingLiveChargeCents(tx, booking.bookingId);
  const liveAfter = liveBefore + input.restCents;
  const charge = state.obligations.find((o) => o.kind === "CHARGE" && ownedBy(o, lineDebtor(tip)) && !state.obligations.some((c) => memberMoneyApplicationKeys.succeeds(c.key, o.key)));
  const applications: MemberMoneyApplicationPlan[] = payCents > 0
    ? [{ key: memberMoneyApplicationKeys.application(eventKey, input.recordId, tip.key), source: { leg: 0 }, obligationKey: tip.key, amountCents: payCents }] : [];
  let collectable = charge ? Math.max(0, Math.min(input.restCents, liveAfter - totals.collected)) : 0;
  for (const { transactionId, line } of args.receipts) {
    if (collectable <= 0) break;
    const room = (state.sources.find((s) => s.id === line.id)?.amountCents ?? 0) - (totals.sources.get(line.id) ?? 0);
    const cents = Math.min(collectable, room);
    if (cents <= 0) continue;
    applications.push({ key: memberMoneyApplicationKeys.application(eventKey, transactionId, charge!.key), source: { lineId: line.id }, obligationKey: charge!.key, amountCents: cents });
    collectable -= cents;
  }
  const evidence = { recordId: input.recordId, restCents: input.restCents };
  const source: MemberMoneySource = { kind: "OFFICER_FACT", id: input.recordId, version: eventKey };
  await writeWithLiveCharge(tx, context, { kind: "ADJUSTMENT", eventKey, origin: "OFFICER", actorMemberId: input.actorMemberId, source,
    reason: "Part refund paid another way: the club keeps the rest",
    legs: [
      { type: "amount", account: "REFUND_PAYABLE", side: "DEBIT", amountCents: input.restCents, debtor: lineDebtor(tip), booking, obligationKey: tip.key, evidence },
      { type: "revenue", account: "BOOKING_REVENUE", side: "CREDIT", grossCents: input.restCents, booking,
        chargeIdentity: `booking:${booking.bookingId}:refund-close-out:${input.recordId}`, evidence },
    ],
    applications }, { liveChargeCents: liveAfter });
  return 1;
}
