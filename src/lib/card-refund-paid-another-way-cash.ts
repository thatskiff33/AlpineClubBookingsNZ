import type { Prisma } from "@prisma/client";

import { paidAnotherWayCloseReceiptRecorded } from "@/lib/late-capture-paid-another-way";
import {
  CARD_REFUND_PAID_ANOTHER_WAY_TASK_WHERE,
  COMPLETED_CANCEL_CARD_SHORTFALL_TASK_WHERE,
  isCancelCardShortfallTask,
  NOT_NON_CANCELLATION_HAND_BACK_WHERE,
  paidAnotherWayCloseXeroNote,
} from "@/lib/manual-refund-task-settlement-rules";
import { BANK_REFUND_VOID_FOLLOW_UP_TASK_WHERE, isBankRefundVoidFollowUpTask } from "@/lib/bank-refund-void-follow-up-key";
import { BANK_REFUND_VOID_FOLLOW_UP_CONTEXT_KEY } from "@/lib/bank-refund-void-follow-up-copy";
import { sumRefundCreditNoteCoverageOfRowsCents } from "@/lib/xero-resolved-in-xero-fences";
import { sumCoveredRefundCreditNoteCents } from "@/lib/xero-sync";
import { exactContains } from "@/lib/prisma-exact-prefix";

/**
 * #3924 round 4 (money review, M1 and M3; `INV-PAY-122`): THE BANK CASH A
 * "PAID ANOTHER WAY" CLOSE SENT BACK, AS THE XERO REFUND-NOTE PIPELINE READS IT.
 *
 * The close raises the payment's `refundedAmountCents` by the amount paid back
 * (`applyLocalRefundAllocation`) and writes no `PaymentRefund` row: no card
 * refund happened. Its persisted record is a COMPLETED
 * `ManualRefundTask` under `CARD_REFUND_PAID_ANOTHER_WAY_KEY_PREFIX`, written
 * in the same transaction (`isCardRefundPaidAnotherWayTask`) - never the
 * operation's `lastError` wording.
 *
 * WHICH CLOSE TOOK A REFUND NOTE (#3924 round 5; owner, 8 Oct 2026: "Raise a
 * refund note for all"): every kind of card refund takes one - a bank-transfer
 * refund note for exactly the amount paid back (`INV-PAY-101`) - wherever the
 * payment has an invoice to credit (`paidAnotherWayNoteInvoice`). The close
 * records which on its key (`paidAnotherWayCloseXeroNote`), and this reads that
 * record, never the invoice as it stands later.
 *
 * A NOTE THAT WAITS FOR ITS RECEIPT (#3924 round 6; owner, 8 Oct 2026: "Record
 * receipt, then credit"): a late card charge Xero holds no receipt for has
 * its receipt queued by the close, and its note raised by the receipt's worker
 * once the receipt is in Xero. Until then the close is counted nowhere - not as
 * noted, not as un-noted - and comes off the mirror like an un-noted one
 * (`awaitingReceiptCents`). So nothing can size a note for that money before
 * the receipt exists: not the close, not the nightly self-heal, not the
 * repair tool, not the note's own execution-time cap. That is the order.
 *
 * So the cash a refund note may answer on the payment
 * (`resolveStripeCashRefundEvidence`) counts a NOTED close and never an
 * UN-NOTED or WAITING one, on both of its paths:
 *
 * - provider ledger: the card refund rows plus the noted closes - the note the
 *   close queued is then answered by cash, and a card refund made later is not
 *   taken as covered by it;
 * - legacy mirror: `refundedAmountCents` already holds every close, so the
 *   un-noted and waiting ones come off it - or the nightly self-heal would
 *   raise a card note, settled from the Stripe account, for money that went
 *   back by bank with no invoice to credit.
 *
 * #4097 (`INV-PAY-129`): A CANCEL'S CARD REFUND SHORTFALL, PAID BACK, IS READ
 * THE SAME WAY. Its completion raises the refunded total by bank money with no
 * refund row, and queues its own bank-transfer note keyed on the task where
 * the payment has an invoice to credit. So a COMPLETED one is one of these
 * records (`BANK_CASH_RECORD_WHERE`): noted when a note row names it, in any
 * status, else un-noted - read off the rows its completion committed, never
 * off the invoice as it stands later. #4159 round 2 (F1): a capacity race's
 * part whose record keeps a card note's cover (`paidAnotherWayCardNoteCover`)
 * is noted too: that note answers its cash, and its own note the rest.
 *
 * #4287 (`INV-ADDPAY-043`): A CANCELLATION HAND-BACK NOTED ON ITS OWN RECORD IS
 * READ THE SAME WAY. A later hand-back on a bank-transfer payment, or one on a
 * payment with card refund rows, queues its own note keyed on the task
 * (`cancellationHandBackNotedOnItsOwnRecord`). Such a completed hand-back is
 * noted bank cash here once a note row names it, so a card note sized against
 * the payment's cash is never squeezed by that note's coverage. One whose note
 * is the payment's canonical one, or that has none, is not a record here at
 * all: the canonical note is sized from the mirror as before.
 *
 * #4287 review (F1): ONLY WHILE ITS REFUND STANDS. When Xero voids its note
 * and the #4162 undo reverses its `BANK_REFUND` line, the task stays COMPLETED
 * with its amount, but that refund is off the payment's records; the undo's
 * follow-up names it (`originalTaskId`). So the hand-back counts here, and its
 * own note is sized, at its amount less every follow-up's that names it
 * (`standingHandBackCents`). Counted forever, it would read as noted cash no
 * note answers and shrink every later card or canonical note by it.
 *
 * #4315 item 2 (folded into #4287): A RE-CONFIRMED FOLLOW-UP IS READ THE SAME
 * WAY. The treasurer's answer to a `bank-refund-void:` follow-up records its
 * refund again with its own note - a fresh one keyed on it, or a hand-made one
 * linked to it (`recordedByHand`). That note sits in the payment's coverage,
 * so the COMPLETED follow-up is noted bank cash beside it, at what of it still
 * stands: a second void of its note, undone, names it as `originalTaskId` too.
 * Each refund counts once - the original nets out what the undo took back, the
 * follow-up counts only its own - and a DISMISSED follow-up (the transfer
 * bounced) counts nothing.
 */

/**
 * #4104 delta review (A-F1, `INV-PAY-128`): HOW MUCH OF A `now` CLOSE A CARD
 * REFUND NOTE ALREADY IN XERO ANSWERS - the card note of a refund Stripe failed
 * later (`failedLaterCardNoteCoverCents`), capped at what the close paid back.
 * The close's own note is for the rest, so its record keeps this figure: the
 * close's share counts it as covered (`readPaidAnotherWayCloseShare`), or the
 * self-heal and the repair tool would read that much of the close as un-noted
 * forever and size later card notes short. Kept in the record's
 * `reviewContext` (`paidAnotherWayCardNoteCover`) beside a paid-twice
 * resolution, which keeps it when written; written once, at the close.
 */
export function paidAnotherWayCardNoteCoverContext(cardNoteCoversCents: number): { paidAnotherWayCardNoteCover: number } | null {
  return cardNoteCoversCents > 0 ? { paidAnotherWayCardNoteCover: cardNoteCoversCents } : null;
}

/** The card-note cover a close's record keeps (`paidAnotherWayCardNoteCoverContext`), or 0. */
export function readPaidAnotherWayCardNoteCoverCents(reviewContext: unknown): number {
  if (!reviewContext || typeof reviewContext !== "object" || Array.isArray(reviewContext)) return 0;
  const value = (reviewContext as Record<string, unknown>).paidAnotherWayCardNoteCover;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

/** #4287: a completed cancellation hand-back - noted bank cash only once a note row names it (see above). */
const COMPLETED_CANCELLATION_HAND_BACK_WHERE = {
  kind: "CANCELLED_BOOKING_HAND_BACK",
  status: "COMPLETED",
  ...NOT_NON_CANCELLATION_HAND_BACK_WHERE,
} satisfies Prisma.ManualRefundTaskWhereInput;

/** #4315 item 2: a re-confirmed bank refund (a COMPLETED `bank-refund-void:` follow-up) - noted once its own note names it. */
const COMPLETED_BANK_REFUND_VOID_FOLLOW_UP_WHERE = { ...BANK_REFUND_VOID_FOLLOW_UP_TASK_WHERE, status: "COMPLETED" } satisfies Prisma.ManualRefundTaskWhereInput;

/** The records whose bank cash this module reads: paid-another-way closes, (#4097) paid-back card refund shortfalls, (#4287) hand-backs noted on their own record and re-confirmed bank refunds. */
const BANK_CASH_RECORD_WHERE = {
  OR: [CARD_REFUND_PAID_ANOTHER_WAY_TASK_WHERE, COMPLETED_CANCEL_CARD_SHORTFALL_TASK_WHERE, COMPLETED_CANCELLATION_HAND_BACK_WHERE, COMPLETED_BANK_REFUND_VOID_FOLLOW_UP_WHERE],
};

export interface PaidAnotherWayCash {
  /** Paid back on closes that queued a refund note. */
  notedCents: number;
  /** Paid back on closes with no invoice to credit: on the refunded total, never a card refund, never noted. */
  unnotedCents: number;
  /** Paid back on closes whose note waits for the late capture's receipt, which Xero does not hold yet. */
  awaitingReceiptCents: number;
}

type CashStore = Pick<
  Prisma.TransactionClient,
  "manualRefundTask" | "paymentRecoveryOperation" | "xeroObjectLink" | "xeroSyncOperation"
>;

/** One close on the payment, and how its bank cash counts (see the module comment). */
interface PaidAnotherWayCloseCash {
  id: string;
  amountCents: number;
  counted: "noted" | "unnoted" | "awaiting-receipt";
}

/** #4287: a plain cancellation hand-back - not a close, a card refund shortfall or a void follow-up. */
function isPlainCancellationHandBack(task: { kind: string | null; occurrenceKey: string | null }): boolean {
  return (
    task.kind === "CANCELLED_BOOKING_HAND_BACK" &&
    !isCancelCardShortfallTask(task) &&
    paidAnotherWayCloseXeroNote(task) === null &&
    !isBankRefundVoidFollowUpTask(task)
  );
}

/** #4287: a bank hand-back whose refund note stands on its own record - a plain cancellation hand-back, or a re-confirmed follow-up. */
function isOwnRecordBankHandBack(task: { kind: string | null; occurrenceKey: string | null }): boolean {
  return isPlainCancellationHandBack(task) || isBankRefundVoidFollowUpTask(task);
}

/**
 * #4315 item 2: the notes a re-confirmed follow-up's treasurer made by hand in
 * Xero and recorded against it (`recordHandMadeRefundNoteLink`): the link
 * names the follow-up and no create row raised it. Plain hand-backs have none.
 */
async function handMadeNoteIdsOf(
  db: Pick<Prisma.TransactionClient, "xeroObjectLink">,
  paymentId: string,
  taskId: string,
): Promise<string[]> {
  const links = await db.xeroObjectLink.findMany({
    where: {
      localModel: "Payment",
      localId: paymentId,
      xeroObjectType: "CREDIT_NOTE",
      role: "REFUND_CREDIT_NOTE",
      AND: [{ metadata: { path: ["handBackTaskId"], equals: taskId } }, { metadata: { path: ["recordedByHand"], equals: true } }],
    },
    select: { xeroObjectId: true },
  });
  return (links ?? []).map((link) => link.xeroObjectId);
}

/** Whether a bank hand-back's own note exists: a create row naming it, or (a follow-up) a hand-made note linked to it. */
async function notedOnOwnRecord(db: CashStore, paymentId: string, task: { id: string; kind: string | null; occurrenceKey: string | null }): Promise<boolean> {
  if ((await db.xeroSyncOperation.count({ where: paidAnotherWayCloseNoteRowsWhere(paymentId, task.id) })) > 0) return true;
  return isBankRefundVoidFollowUpTask(task) && (await handMadeNoteIdsOf(db, paymentId, task.id)).length > 0;
}

/**
 * #4287 review (F1): what of a bank hand-back's refund still stands - its
 * amount less what every `bank-refund-void:` follow-up naming it took back
 * (the undo reverses the hand-back's whole `BANK_REFUND` line), never below
 * nothing. A follow-up counts in any status: dismissed or re-confirmed, the
 * original line stays reversed.
 */
async function standingHandBackCents(
  db: Pick<Prisma.TransactionClient, "manualRefundTask">,
  paymentId: string,
  task: { id: string; amountCents: number | null },
): Promise<number> {
  const undone = await db.manualRefundTask.findMany({
    where: {
      paymentId,
      ...BANK_REFUND_VOID_FOLLOW_UP_TASK_WHERE,
      reviewContext: { path: [BANK_REFUND_VOID_FOLLOW_UP_CONTEXT_KEY, "originalTaskId"], equals: task.id },
    },
    select: { amountCents: true },
  });
  const undoneCents = (undone ?? []).reduce((sum, followUp) => sum + Math.max(0, followUp.amountCents ?? 0), 0);
  return Math.max(0, Math.max(0, task.amountCents ?? 0) - undoneCents);
}

async function readPaidAnotherWayCloses(db: CashStore, paymentId: string): Promise<PaidAnotherWayCloseCash[]> {
  const tasks = await db.manualRefundTask.findMany({
    where: { paymentId, ...BANK_CASH_RECORD_WHERE },
    select: { id: true, kind: true, occurrenceKey: true, amountCents: true, reviewContext: true },
  });
  const closes: PaidAnotherWayCloseCash[] = [];
  for (const task of tasks ?? []) {
    const amountCents = Math.max(0, task.amountCents ?? 0);
    if (isCancelCardShortfallTask(task)) {
      // #4159 round 2 (F1): a capacity race's part a card note already answers is noted, with or without a row of its own.
      const noted = readPaidAnotherWayCardNoteCoverCents(task.reviewContext) > 0 || (await db.xeroSyncOperation.count({ where: paidAnotherWayCloseNoteRowsWhere(paymentId, task.id) })) > 0;
      closes.push({ id: task.id, amountCents, counted: noted ? "noted" : "unnoted" });
      continue;
    }
    const note = paidAnotherWayCloseXeroNote(task);
    if (note === null) {
      // #4287: a hand-back (or, #4315, a re-confirmed follow-up) is a record here only once its own note names it, and (F1) only for what still stands.
      if (isOwnRecordBankHandBack(task) && (await notedOnOwnRecord(db, paymentId, task))) {
        closes.push({ id: task.id, amountCents: await standingHandBackCents(db, paymentId, task), counted: "noted" });
      }
      continue;
    }
    const counted =
      note === "now"
        ? "noted"
        : note !== "after-receipt"
          ? "unnoted"
          : (await paidAnotherWayCloseReceiptRecorded(task, db))
            ? "noted"
            : "awaiting-receipt";
    closes.push({ id: task.id, amountCents, counted });
  }
  return closes;
}

/**
 * The bank cash every paid-another-way close on one payment sent back, split by
 * whether its close took a refund note. One read; almost no payment has any.
 */
export async function readPaidAnotherWayCash(db: CashStore, paymentId: string): Promise<PaidAnotherWayCash> {
  const cash: PaidAnotherWayCash = { notedCents: 0, unnotedCents: 0, awaitingReceiptCents: 0 };
  for (const close of await readPaidAnotherWayCloses(db, paymentId)) {
    if (close.counted === "noted") cash.notedCents += close.amountCents;
    else if (close.counted === "unnoted") cash.unnotedCents += close.amountCents;
    else cash.awaitingReceiptCents += close.amountCents;
  }
  return cash;
}

/**
 * #3924 round 8 (money review, `INV-SSOT`): THE ONE WAY TO FIND A CLOSE'S OWN
 * NOTE ROWS - the refund-note creates on its payment whose payload names its
 * record (`paidAnotherWayTaskId`), in any status. Every row the note pipeline
 * writes for the close carries it: the queued payload and the executed one. The
 * receipt's note step (`notePaidAnotherWayCloseOnReceipt`), the enqueue's
 * dedupe and the close's coverage all ask this, and nothing else.
 */
export function paidAnotherWayCloseNoteRowsWhere(paymentId: string, closeId: string) {
  return { ...ownRecordRefundNoteRowsBase(paymentId), requestPayload: { path: ["paidAnotherWayTaskId"], equals: closeId } } satisfies Prisma.XeroSyncOperationWhereInput;
}

/**
 * #4312 (`INV-ADDPAY-047`): THE SAME QUESTION OF A CARD REFUND'S OWN NOTE ROWS
 * on a bank transfer - every refund-note create naming the refund, in any
 * status: by its payload (`cardRefundId`), or by its key
 * (`:card-refund:<id>:`, `cardRefundNoteKey`), which a previous release's
 * worker keeps when it rewrites the payload without the field - matched
 * literally (`exactContains`, `INV-SSOT-006`): a refund id holds a `_`.
 */
export function cardRefundNoteRowsWhere(paymentId: string, stripeRefundId: string) {
  return {
    ...ownRecordRefundNoteRowsBase(paymentId),
    OR: [{ requestPayload: { path: ["cardRefundId"], equals: stripeRefundId } }, { correlationKey: exactContains(cardRefundNoteKeyTag(stripeRefundId)) }],
  } satisfies Prisma.XeroSyncOperationWhereInput;
}

/** The part of a card refund's own note key that names it (`cardRefundNoteKey`). */
export function cardRefundNoteKeyTag(stripeRefundId: string): string {
  return `:card-refund:${stripeRefundId}:`;
}

/** The refund-note creates on one payment: the base both own-record row questions above narrow. */
function ownRecordRefundNoteRowsBase(paymentId: string) {
  return { direction: "OUTBOUND", entityType: "CREDIT_NOTE", operationType: "CREATE", localModel: "Payment", localId: paymentId } satisfies Prisma.XeroSyncOperationWhereInput;
}

/**
 * #3924 round 8 (money review, `INV-PAY-122`): WHAT A CLOSE'S OWN NOTE STILL
 * HAS TO ANSWER. The close's record holds what it paid back
 * (`amountCents`); its own notes - and only those - answer it, counted as the
 * payment's coverage counts them (`sumRefundCreditNoteCoverageOfRowsCents`).
 * So a note the close raised whose refund payment failed (PARTIAL) covers its
 * amount here, as it does in the payment's coverage, and a row that raised no
 * note covers nothing. `uncoveredCents` sizes the close's note exactly: the
 * enqueue and the note's execution both ask it, never the payment-wide gap.
 * #4104: less what a card note already in Xero answers of it, as its record
 * keeps (`readPaidAnotherWayCardNoteCoverCents`). Null when the payment has no
 * such record.
 */
export async function readPaidAnotherWayCloseShare(
  db: Pick<Prisma.TransactionClient, "manualRefundTask" | "xeroObjectLink" | "xeroSyncOperation">,
  paymentId: string,
  closeId: string,
): Promise<{ amountCents: number; coveredCents: number; cardNoteCoversCents: number; uncoveredCents: number } | null> {
  const record = await db.manualRefundTask.findFirst({
    // #4162 (`INV-ADDPAY-042`): a completed bank refund to re-confirm raises its
    // fresh note the same way - keyed and sized on itself, never the payment's
    // gap - so its record is read here too (and only here: it is no card cash).
    // #4287: as is a completed cancellation hand-back's (`BANK_CASH_RECORD_WHERE`, which holds both).
    where: { id: closeId, paymentId, ...BANK_CASH_RECORD_WHERE },
    select: { id: true, kind: true, occurrenceKey: true, amountCents: true, reviewContext: true },
  });
  if (!record) return null;
  // #4287 review (F1), #4315: a bank hand-back answers only what of its refund still stands.
  const amountCents = isOwnRecordBankHandBack(record) ? await standingHandBackCents(db, paymentId, record) : Math.max(0, record.amountCents ?? 0);
  const coveredCents = await sumRefundCreditNoteCoverageOfRowsCents(
    paymentId,
    paidAnotherWayCloseNoteRowsWhere(paymentId, closeId),
    db,
  );
  // #4104 delta review (A-F1): what a card note already in Xero answered of the
  // close, kept on its record - covered too, though no note of its own says so.
  // `coveredCents` stays the close's own notes: it keys the close's note.
  const cardNoteCoversCents = readPaidAnotherWayCardNoteCoverCents(record.reviewContext);
  // #4315 item 2: a re-confirmed follow-up's hand-made note covers it too, though no create row raised it.
  const handMadeIds = isBankRefundVoidFollowUpTask(record) ? await handMadeNoteIdsOf(db, paymentId, closeId) : [];
  const handMadeNoteCoversCents = handMadeIds.length > 0 ? await sumCoveredRefundCreditNoteCents(paymentId, db, handMadeIds) : 0;
  return {
    amountCents,
    coveredCents,
    cardNoteCoversCents,
    uncoveredCents: Math.max(0, amountCents - coveredCents - cardNoteCoversCents - handMadeNoteCoversCents),
  };
}

/**
 * #3924 round 7 (money M1) and round 8 (`INV-PAY-122`): THE NOTED BANK CASH
 * THE CLOSES' OWN NOTES DO NOT YET COVER. A close counted as noted puts its
 * bank cash into what a refund note may answer, and only its own bank-transfer
 * note may answer it. The payment's gap (`readRefundCreditNoteGap`) is that
 * cash and the card cash, less all coverage; this is the closes' part of it,
 * by the same coverage (`readPaidAnotherWayCloseShare`), so a caller that sizes
 * a CARD note - the nightly self-heal, the repair tool - takes off exactly what
 * coverage does not already count for the closes, and never fills it with a
 * card note settled from the Stripe account. Each close's note is retried as
 * its own row.
 */
export async function readPaidAnotherWayUncoveredCents(db: CashStore, paymentId: string): Promise<number> {
  let uncoveredCents = 0;
  for (const close of await readPaidAnotherWayCloses(db, paymentId)) {
    if (close.counted !== "noted") continue;
    uncoveredCents += (await readPaidAnotherWayCloseShare(db, paymentId, close.id))?.uncoveredCents ?? 0;
  }
  return uncoveredCents;
}
