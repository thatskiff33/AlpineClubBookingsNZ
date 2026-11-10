import type { MemberMoneyOrigin, Prisma } from "@prisma/client";
import logger from "../../logger";
import { lockMemberMoneyPayment, readMemberMoneyApplicationState } from "./application-read";
import { memberMoneyApplicationTotals } from "./application-state";
import { keptCaptureIdentity } from "./booking-charges";
import { eventPosted, readBookingLiveChargeCents } from "./booking-journal-read";
import { bookingReceiptEventKey, lineDebtor, ownedBy } from "./booking-receipts";
import { isBookingJournalInactive, type BookingJournalContext } from "./journal-activity";
import { memberMoneyApplicationKeys, memberMoneyEventKeys, walkMemberMoneyChain, type MemberMoneyEventKey } from "./keys";
import type { MemberMoneyApplicationPlan, MemberMoneyDebtor } from "./plan";
import { reverseMemberMoneyJournal } from "./post";
import {
  cardReceiptLine,
  fundRefundFromReceipt,
  refundFamilyOpenCents,
  refundFamilyTip,
  refundObligationChain,
  writeWithLiveCharge,
} from "./refund-family";
import { postRefundObligation, refundDebtor } from "./refund-obligations";

/**
 * BANK AND CASH HAND-BACKS, AND A KEPT LATE CAPTURE (#4516, Ledger M4d). The officer resolutions M4c left open.
 *
 * A hand-back the club pays by bank transfer or in cash is a refund debt (R05, scope `hand-back`) raised with the
 * task, then paid (R14, `hand-back-paid:<task>`) when the treasurer marks it paid back. The payment is funded only
 * from the receipts the completion's allocation consumed. A task raised before this milestone has no R05, so its
 * payment posts unapplied (Dr AR, Cr BANK or CASH). Cash is never refused for a cap: the applied part trims to what
 * the debt still has open. Nothing here catches a refusal: it rolls the door back.
 *
 * A late capture the treasurer keeps records that the club holds it (`kept-capture:<intent>`): collected against the
 * booking where an invoice already bills it, otherwise a retained component. Approving that keep later reverses the
 * keep before the capture-return debt posts. Only a booking whose R01 is in the journal posts; an inactive journal
 * posts nothing.
 */

type Db = Prisma.TransactionClient;
type Account = "BANK" | "CASH";
export type HandBackPaymentAccount = Account;

const HAND_BACK_OWED = "Refund owed, to be paid by bank or in cash";

/** R05 for one hand-back task. Returns the obligation's key, or null when nothing posts. */
export async function postHandBackObligation(tx: Db, context: BookingJournalContext, input: {
  bookingId: string;
  taskId: string;
  amountCents: number;
  origin: MemberMoneyOrigin;
  actorMemberId?: string | null;
  debtorRead: "booking-row" | "plain";
}): Promise<MemberMoneyEventKey | null> {
  return postRefundObligation(tx, context, {
    bookingId: input.bookingId, scope: "hand-back", id: input.taskId, amountCents: input.amountCents,
    origin: input.origin, actorMemberId: input.actorMemberId, debtorRead: input.debtorRead, reason: HAND_BACK_OWED,
  });
}

/** The live hand-back debt for this task, or the review debt a by-hand review posted in the same completion. */
async function liveHandBackDebt(tx: Db, taskId: string): Promise<MemberMoneyEventKey | null> {
  return (await refundObligationChain(tx, "hand-back", taskId)).live
    ?? (await refundObligationChain(tx, "review", taskId)).live;
}

/** The receipt credit of one allocated transaction: its card capture, else the bank or cash receipt anchored on it. */
async function receiptOfTransaction(tx: Db, transactionId: string) {
  const row = await tx.paymentTransaction.findUnique({
    where: { id: transactionId },
    select: { id: true, stripePaymentIntentId: true, settlementLineId: true },
  });
  if (!row) return null;
  if (row.stripePaymentIntentId) {
    const line = await cardReceiptLine(tx, row.stripePaymentIntentId);
    if (line) return { transactionId, line };
  }
  if (!row.settlementLineId) return null;
  const settlement = await tx.bookingLedgerLine.findUnique({ where: { id: row.settlementLineId }, select: { id: true, kind: true } });
  if (!settlement) return null;
  const event = await tx.memberMoneyEvent.findUnique({
    where: { eventKey: bookingReceiptEventKey(row, settlement) },
    select: { journal: { select: { reversedBy: { select: { id: true } }, lines: {
      where: { account: "MEMBER_RECEIVABLE", side: "CREDIT" },
      select: { id: true, debtorKind: true, memberId: true, organisationId: true },
    } } } },
  });
  if (!event?.journal || event.journal.reversedBy) return null;
  const line = event.journal.lines[0];
  return line ? { transactionId, line } : null;
}

/**
 * R14 when the treasurer marks a hand-back paid. `fundingTransactionIds` are the receipts the completion's
 * allocation consumed, and no others. Returns the batches posted.
 */
export async function postHandBackPayment(tx: Db, context: BookingJournalContext, input: {
  bookingId: string;
  taskId: string;
  cents: number;
  account: Account;
  fundingTransactionIds: readonly string[];
  actorMemberId: string | null;
  debtorRead: "booking-row" | "plain";
}): Promise<number> {
  if (isBookingJournalInactive(context) || input.cents <= 0) return 0;
  if (!(await eventPosted(tx, memberMoneyEventKeys.bookingCharge(input.bookingId)))) return 0;
  await lockMemberMoneyPayment(tx, input.bookingId);
  const base = memberMoneyEventKeys.handBackPaid(input.taskId);
  const eventKey = await walkMemberMoneyChain(base, async (key) => tx.memberMoneyEvent.findUnique({
    where: { eventKey: key }, select: { reversedBy: { select: { id: true } } },
  }));
  if (await eventPosted(tx, eventKey)) return 0;

  const { lodgeId } = await tx.booking.findUniqueOrThrow({ where: { id: input.bookingId }, select: { lodgeId: true } });
  const booking = { bookingId: input.bookingId, lodgeId };
  const owner = await refundDebtor(tx, input.bookingId, input.debtorRead);
  const live = await liveHandBackDebt(tx, input.taskId);
  const evidence = { taskId: input.taskId, account: input.account };
  const source = { kind: "OFFICER_FACT" as const, id: input.taskId, version: eventKey };
  const liveCharge = await readBookingLiveChargeCents(tx, input.bookingId);

  if (!live) {
    logger.warn({ bookingId: input.bookingId, taskId: input.taskId },
      "A hand-back payment's refund debt is not in the journal; its cash posts unapplied (#4516)");
    const leg = { type: "amount" as const, amountCents: input.cents, booking, evidence };
    await writeWithLiveCharge(tx, context, { kind: "REFUND", eventKey, origin: "OFFICER", actorMemberId: input.actorMemberId, source,
      reason: "Hand-back paid, not yet answered to a debt",
      legs: [{ ...leg, account: "MEMBER_RECEIVABLE", side: "DEBIT", debtor: owner }, { ...leg, account: input.account, side: "CREDIT" }],
    }, { liveChargeCents: liveCharge });
    return 1;
  }

  const tip = await refundFamilyTip(tx, context, booking, live, owner);
  if (!tip) return 0;
  const state = await readMemberMoneyApplicationState(tx, input.bookingId);
  const applied = Math.min(input.cents, Math.max(0, refundFamilyOpenCents(state, live)));
  const receipts = (await Promise.all(input.fundingTransactionIds.map(async (id) => {
    const found = await receiptOfTransaction(tx, id);
    return found && ownedBy(tip, lineDebtor(found.line)) ? [found] : [];
  }))).flat();
  let needed = applied;
  let posted = 0;
  for (const { transactionId, line } of receipts) {
    if (needed <= 0) break;
    const fundingKey = memberMoneyEventKeys.refundFunding(`${eventKey}:${transactionId}`);
    const funded = await fundRefundFromReceipt(tx, context, { bookingId: input.bookingId, receiptLineId: line.id, obligationKey: tip.key,
      amountCents: needed, fundingKey, trim: true, source: { ...source, version: fundingKey },
      reason: "Fund a hand-back from the receipt its payment was recorded on" });
    needed -= funded?.fundedCents ?? 0;
    if (funded) posted++;
  }

  const cash = { type: "amount" as const, booking, evidence };
  const legs = applied > 0
    ? [
        { ...cash, account: "REFUND_PAYABLE" as const, side: "DEBIT" as const, amountCents: applied, debtor: lineDebtor(tip), obligationKey: tip.key },
        ...(input.cents > applied ? [{ ...cash, account: "MEMBER_RECEIVABLE" as const, side: "DEBIT" as const, amountCents: input.cents - applied, debtor: owner }] : []),
        { ...cash, account: input.account, side: "CREDIT" as const, amountCents: input.cents },
      ]
    : [
        { ...cash, account: "MEMBER_RECEIVABLE" as const, side: "DEBIT" as const, amountCents: input.cents, debtor: owner },
        { ...cash, account: input.account, side: "CREDIT" as const, amountCents: input.cents },
      ];
  const applications: MemberMoneyApplicationPlan[] = applied > 0
    ? [{ key: memberMoneyApplicationKeys.application(eventKey, input.taskId, tip.key), source: { leg: 0 }, obligationKey: tip.key, amountCents: applied }]
    : [];
  await writeWithLiveCharge(tx, context, { kind: "REFUND", eventKey, origin: "OFFICER", actorMemberId: input.actorMemberId, source,
    reason: input.account === "CASH" ? "Hand-back paid in cash" : "Hand-back paid by bank transfer", legs, applications,
  }, { liveChargeCents: liveCharge });
  return posted + 1;
}

/** The kept capture's chain tip, so a reversed keep can be posted again when the treasurer keeps it a second time. */
async function keptCaptureKey(tx: Db, paymentIntentId: string): Promise<MemberMoneyEventKey> {
  const base = memberMoneyEventKeys.keptCapture(paymentIntentId);
  return walkMemberMoneyChain(base, async (key) => tx.memberMoneyEvent.findUnique({
    where: { eventKey: key }, select: { reversedBy: { select: { id: true } } },
  }));
}

/**
 * Record a late capture the treasurer keeps. `billedByExistingInvoice`: an invoice already bills the capture, so
 * the receipt collects the booking's charge and no new component is posted. Otherwise the capture is a retained
 * component of the booking. Returns whether a batch posted.
 */
export async function postKeptCapture(tx: Db, context: BookingJournalContext, input: {
  bookingId: string;
  paymentIntentId: string;
  amountCents: number;
  actorMemberId: string | null;
  debtorRead: "booking-row" | "plain";
  billedByExistingInvoice: boolean;
}): Promise<boolean> {
  if (isBookingJournalInactive(context) || input.amountCents <= 0) return false;
  if (!(await eventPosted(tx, memberMoneyEventKeys.bookingCharge(input.bookingId)))) return false;
  await lockMemberMoneyPayment(tx, input.bookingId);
  const eventKey = await keptCaptureKey(tx, input.paymentIntentId);
  if (await eventPosted(tx, eventKey)) return false;
  const { lodgeId } = await tx.booking.findUniqueOrThrow({ where: { id: input.bookingId }, select: { lodgeId: true } });
  const booking = { bookingId: input.bookingId, lodgeId };
  const owner = await refundDebtor(tx, input.bookingId, input.debtorRead);
  const receipt = await cardReceiptLine(tx, input.paymentIntentId);
  const receiptOwned = receipt && ownedBy(receipt, owner) ? receipt : null;
  if (receipt && !receiptOwned) {
    logger.warn({ bookingId: input.bookingId, paymentIntentId: input.paymentIntentId },
      "A kept capture's receipt names another debtor, so the keep does not collect it (#4516)");
  }
  const state = await readMemberMoneyApplicationState(tx, input.bookingId);
  const totals = memberMoneyApplicationTotals(state);
  const room = receiptOwned ? Math.max(0, receiptOwned.amountCents - (totals.sources.get(receiptOwned.id) ?? 0)) : 0;
  const liveBefore = await readBookingLiveChargeCents(tx, input.bookingId);
  const evidence = { paymentIntentId: input.paymentIntentId };
  const source = { kind: "OFFICER_FACT" as const, id: input.paymentIntentId, version: eventKey };

  if (input.billedByExistingInvoice) {
    const obligationKey = chargeKey(state, owner);
    const collect = obligationKey === null ? 0 : Math.max(0, Math.min(input.amountCents, room, Math.max(0, liveBefore - totals.collected)));
    const applications: MemberMoneyApplicationPlan[] = collect > 0 && receiptOwned && obligationKey
      ? [{ key: memberMoneyApplicationKeys.application(eventKey, receiptOwned.id, obligationKey),
        source: { lineId: receiptOwned.id }, obligationKey, amountCents: collect }]
      : [];
    await writeWithLiveCharge(tx, context, { kind: "ZERO", eventKey, origin: "OFFICER", actorMemberId: input.actorMemberId, source,
      reason: "Late capture kept: an invoice already bills it", applications }, { liveChargeCents: liveBefore });
    return true;
  }

  const identity = keptCaptureIdentity(input.bookingId, input.paymentIntentId);
  const liveAfter = liveBefore + input.amountCents;
  const collect = Math.max(0, Math.min(input.amountCents, room, liveAfter - totals.collected));
  const obligationKey = chargeKey(state, owner);
  const applications: MemberMoneyApplicationPlan[] = collect > 0 && receiptOwned && obligationKey
    ? [{ key: memberMoneyApplicationKeys.application(eventKey, receiptOwned.id, obligationKey), source: { lineId: receiptOwned.id },
      obligationKey, amountCents: collect }]
    : [];
  await writeWithLiveCharge(tx, context, { kind: "ADJUSTMENT", eventKey, origin: "OFFICER", actorMemberId: input.actorMemberId, source,
    reason: "Late capture kept by the treasurer",
    legs: [
      { type: "amount", account: "MEMBER_RECEIVABLE", side: "DEBIT", amountCents: input.amountCents, booking, debtor: owner, evidence },
      { type: "revenue", account: "BOOKING_REVENUE", side: "CREDIT", grossCents: input.amountCents, booking, chargeIdentity: identity, evidence },
    ],
    applications }, { liveChargeCents: liveAfter });
  return true;
}

function chargeKey(state: Awaited<ReturnType<typeof readMemberMoneyApplicationState>>, debtor: MemberMoneyDebtor): string | null {
  const charge = state.obligations.find((o) => o.kind === "CHARGE" && ownedBy(o, debtor) && !state.obligations.some((c) => memberMoneyApplicationKeys.succeeds(c.key, o.key)));
  return charge?.key ?? null;
}

/** Reverse the keep, exactly, before an approved reopening posts the capture's return. Nothing when no keep is live. */
export async function reverseKeptCapture(tx: Db, context: BookingJournalContext, input: {
  bookingId: string;
  paymentIntentId: string;
  actorMemberId: string | null;
}): Promise<boolean> {
  if (isBookingJournalInactive(context)) return false;
  if (!(await eventPosted(tx, memberMoneyEventKeys.bookingCharge(input.bookingId)))) return false;
  const eventKey = await keptCaptureKey(tx, input.paymentIntentId);
  const kept = await tx.memberMoneyEvent.findUnique({ where: { eventKey }, select: { journal: { select: { id: true } } } });
  if (!kept?.journal) return false;
  await reverseMemberMoneyJournal(tx, context, { reversesJournalId: kept.journal.id, origin: "OFFICER", actorMemberId: input.actorMemberId,
    source: { kind: "BOOKING", id: input.bookingId, version: memberMoneyEventKeys.reversal(kept.journal.id) },
    reason: "Kept late capture approved for refund: the keep is reversed" });
  return true;
}
