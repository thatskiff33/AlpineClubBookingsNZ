import type { MemberMoneyOrigin, Prisma } from "@prisma/client";
import logger from "../../logger";
import { lockMemberMoneyPayment, readMemberMoneyApplicationState } from "./application-read";
import { memberMoneyApplicationTotals } from "./application-state";
import { keptCaptureIdentity } from "./booking-charges";
import { eventPosted, readBookingLiveChargeCents, readBookingTaxAnchorDate } from "./booking-journal-read";
import { CAPTURE_KINDS } from "../../booking-ledger-capture-kinds";
import { bookingReceiptEventKey, bookingReceiptRow, chargeObligation, lineDebtor, moveMergedDebtorResidue, ownedBy } from "./booking-receipts";
import { isBookingJournalInactive, type BookingJournalContext } from "./journal-activity";
import { memberMoneyApplicationKeys, memberMoneyEventKeys, type MemberMoneyEventKey } from "./keys";
import { MemberMoneyPlanError, type MemberMoneyApplicationPlan } from "./plan";
import { reverseMemberMoneyJournal } from "./post";
import {
  cardReceiptLine,
  fundRefundFromReceipt,
  memberMoneyChainTip,
  receiptCreditLine,
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

const HAND_BACK_OWED = "Refund owed, to be paid by bank or in cash";
const APPEAL_HAND_BACK_OWED = "Refund owed: an approved appeal's concession, to be paid by bank or in cash";

/**
 * R05 for one hand-back task. Returns the obligation's key, or null when nothing posts. `concession` is an approved
 * appeal's bank part: its give-back posts against approved goodwill first, by the same rule as the appeal's card
 * part (`postRefundObligation`'s concession legs, design R05), so the member's receivable is left at zero once paid.
 */
export async function postHandBackObligation(tx: Db, context: BookingJournalContext, input: {
  bookingId: string;
  taskId: string;
  amountCents: number;
  origin: MemberMoneyOrigin;
  actorMemberId?: string | null;
  debtorRead: "booking-row" | "plain";
  concession?: boolean;
}): Promise<MemberMoneyEventKey | null> {
  return postRefundObligation(tx, context, {
    bookingId: input.bookingId, scope: "hand-back", id: input.taskId, amountCents: input.amountCents,
    origin: input.origin, actorMemberId: input.actorMemberId, debtorRead: input.debtorRead,
    concession: input.concession, reason: input.concession ? APPEAL_HAND_BACK_OWED : HAND_BACK_OWED,
  });
}

/**
 * #5197: a hand-back put back on the queue after its dismissal or rest withdrawal, posting its refund debt again so
 * the journal owes the member what the reopened task does. Its debt's trace decides how:
 * - the dismissal reversed its whole R05 (none live): an R05 for the task's amount at the chain's next key;
 * - a reduced hand-back's dismissal withdrew its open rest (`handBackRestWithdrawn`): that withdrawal reversed
 *   exactly, so the reductions stay and the rest is owed again;
 * - no trace (raised before the journal, or its R05 is live and nothing withdrew the rest): nothing posts.
 * Called with the reopen's status claim, so a replay finds the task open and never reaches here. Returns what posted.
 */
export async function restoreHandBackObligation(tx: Db, context: BookingJournalContext, input: {
  bookingId: string;
  taskId: string;
  amountCents: number;
  origin: MemberMoneyOrigin;
  actorMemberId: string | null;
  reason: string;
}): Promise<"reposted" | "rest-restored" | null> {
  if (isBookingJournalInactive(context)) return null;
  if (!(await eventPosted(tx, memberMoneyEventKeys.bookingCharge(input.bookingId)))) return null;
  await lockMemberMoneyPayment(tx, input.bookingId);
  const chain = await refundObligationChain(tx, "hand-back", input.taskId);
  if (!chain.live) {
    // The chain moved past its base only by reversing a posted R05: a debt that was never posted stays unposted.
    if (chain.next === memberMoneyEventKeys.refundObligation("hand-back", input.taskId)) return null;
    await postRefundObligation(tx, context, { bookingId: input.bookingId, scope: "hand-back", id: input.taskId, amountCents: input.amountCents,
      origin: input.origin, actorMemberId: input.actorMemberId, debtorRead: "booking-row", reason: input.reason });
    return "reposted";
  }
  const rest = await memberMoneyChainTip(tx, memberMoneyEventKeys.handBackRestWithdrawn(input.taskId));
  const withdrawal = await tx.memberMoneyEvent.findUnique({ where: { eventKey: rest }, select: { journal: { select: { id: true } } } });
  if (!withdrawal?.journal) return null;
  const reversal = memberMoneyEventKeys.reversal(withdrawal.journal.id);
  await reverseMemberMoneyJournal(tx, context, { reversesJournalId: withdrawal.journal.id, origin: input.origin, actorMemberId: input.actorMemberId,
    source: { kind: "BOOKING", id: input.bookingId, version: reversal }, reason: input.reason });
  // The mirror lands on the debtor the withdrawal named; one merged away since is carried to the owner, read under
  // the booking row the reopen holds, as a reversed refund debt's is (D4, #5191).
  const { lodgeId } = await tx.booking.findUniqueOrThrow({ where: { id: input.bookingId }, select: { lodgeId: true } });
  await moveMergedDebtorResidue(tx, context, { bookingId: input.bookingId, lodgeId }, await refundDebtor(tx, input.bookingId, "booking-row"), reversal);
  return "rest-restored";
}

/** The live hand-back debt for this task, or the review debt a by-hand review posted in the same completion. */
async function liveHandBackDebt(tx: Db, taskId: string): Promise<MemberMoneyEventKey | null> {
  return (await refundObligationChain(tx, "hand-back", taskId)).live
    ?? (await refundObligationChain(tx, "review", taskId)).live;
}

/**
 * The receipt credit of one allocated transaction: its card capture, else the bank or cash receipt anchored on it.
 * A receipt's settlement line names its charge by `anchorId`, the pairing `bookingReceiptRow` makes for every receipt.
 */
async function receiptOfTransaction(tx: Db, transactionId: string) {
  const row = await tx.paymentTransaction.findUnique({
    where: { id: transactionId },
    select: { id: true, stripePaymentIntentId: true, reason: true },
  });
  if (!row) return null;
  if (row.stripePaymentIntentId) {
    const line = await cardReceiptLine(tx, row.stripePaymentIntentId);
    if (line) return { transactionId, line };
  }
  const settlements = await tx.bookingLedgerLine.findMany({
    where: { anchorId: transactionId, side: "SETTLEMENT", kind: { in: [...CAPTURE_KINDS] } },
    select: { id: true, kind: true, anchorId: true, reversesLineId: true, amountCents: true },
    orderBy: [{ postedAt: "asc" }, { id: "asc" }],
  });
  for (const settlement of settlements) {
    if (!bookingReceiptRow(settlement, [row])) continue;
    const line = await receiptCreditLine(tx, bookingReceiptEventKey(row, settlement));
    if (line) return { transactionId, line };
  }
  return null;
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
  const eventKey = await memberMoneyChainTip(tx, memberMoneyEventKeys.handBackPaid(input.taskId));
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
  if (!tip) {
    throw new MemberMoneyPlanError([`hand-back ${input.taskId} names a refund debt with no live tip, so its payment cannot post`]);
  }
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
  return memberMoneyChainTip(tx, memberMoneyEventKeys.keptCapture(paymentIntentId));
}

/**
 * Record a late capture the treasurer keeps. `billedCents` is what an invoice already bills, so that part collects
 * the booking's charge and the rest is a retained component. Returns whether a batch posted.
 */
export async function postKeptCapture(tx: Db, context: BookingJournalContext, input: {
  bookingId: string;
  paymentIntentId: string;
  amountCents: number;
  actorMemberId: string | null;
  debtorRead: "booking-row" | "plain";
  billedCents: number;
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
  const billedCents = Math.max(0, Math.min(input.amountCents, Number.isSafeInteger(input.billedCents) ? input.billedCents : 0));
  const unbilledCents = input.amountCents - billedCents;
  const liveCharge = liveBefore + unbilledCents;
  const evidence = { paymentIntentId: input.paymentIntentId };
  const source = { kind: "OFFICER_FACT" as const, id: input.paymentIntentId, version: eventKey };
  const obligationKey = receiptOwned && room > 0
    ? (await chargeObligation(tx, context, booking, owner, liveCharge))?.key ?? null
    : null;
  const collect = obligationKey === null ? 0 : Math.max(0, Math.min(input.amountCents, room, Math.max(0, liveCharge - totals.collected)));
  const applications: MemberMoneyApplicationPlan[] = collect > 0 && receiptOwned && obligationKey
    ? [{ key: memberMoneyApplicationKeys.application(eventKey, receiptOwned.id, obligationKey),
      source: { lineId: receiptOwned.id }, obligationKey, amountCents: collect }]
    : [];

  if (unbilledCents === 0) {
    await writeWithLiveCharge(tx, context, { kind: "ZERO", eventKey, origin: "OFFICER", actorMemberId: input.actorMemberId, source,
      reason: "Late capture kept: an invoice already bills it", applications }, { liveChargeCents: liveBefore });
    return true;
  }

  const identity = keptCaptureIdentity(input.bookingId, input.paymentIntentId);
  await writeWithLiveCharge(tx, context, { kind: "ADJUSTMENT", eventKey, origin: "OFFICER", actorMemberId: input.actorMemberId, source,
    reason: "Late capture kept by the treasurer",
    legs: [
      { type: "amount", account: "MEMBER_RECEIVABLE", side: "DEBIT", amountCents: unbilledCents, booking, debtor: owner, evidence },
      // #4632: a booking's charge, so the treatment in force when the booking was made, as every other door posts it.
      { type: "revenue", account: "BOOKING_REVENUE", side: "CREDIT", grossCents: unbilledCents, booking,
        taxAnchorDate: await readBookingTaxAnchorDate(tx, input.bookingId, context.zone), chargeIdentity: identity, evidence },
    ],
    applications }, { liveChargeCents: liveCharge });
  return true;
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
