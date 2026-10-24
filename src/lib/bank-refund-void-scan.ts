/**
 * #4162 (owner decision 17 Oct 2026, `INV-ADDPAY-042`): WHAT A VOIDED
 * BANK-TRANSFER REFUND NOTE CALLS FOR. A read-only classifier, shared by the
 * nightly writer (`bank-refund-void-follow-up.ts`, under its locks, on its
 * transaction), the report-only run, the Stuck States list of notes a person
 * must answer, and the owner's count script (`scripts/bank-refund-void-count.ts`).
 * One answer for all four, so the count the owner reads is the work the job
 * then does.
 *
 * THE POPULATION: refund-note links (`REFUND_CREDIT_NOTE`, never an edit's,
 * an account-credit's or a refund request's note) on `INTERNET_BANKING`
 * payments whose recorded Xero status is VOIDED or DELETED.
 *
 * THE ANSWERS, in the order they are asked:
 * - `awaiting-heal`: the mirror is still ACTIVE. #4161's nightly heal turns it
 *   off first; the job runs after it.
 * - `handled`: its nightly follow-up exists (the occurrence key is the
 *   claim); a marker on the link records it was a spare, answered by a person,
 *   or picked in full; or a person's picks already add up to its amount (one
 *   pick, when its amount cannot be read).
 * - `deferred`: a refund-note create on the payment could still mint
 *   (`findBlockingRefundCreditNoteOperationId`, ignoring a row whose note Xero
 *   voided), so coverage may yet move. Listed for a person after 7 days.
 * - `unmatched`: the note's amount cannot be read, the payment's ledger holds
 *   no single live hand-back line for it, its detail no longer holds it, or it
 *   recorded a card refund's record (a "Paid another way" close or shortfall,
 *   whose note the card refund pipeline re-raises), or it recorded a card
 *   refund itself (#4312: a note keyed on its `PaymentRefund`, `cardRefundId`),
 *   or a person has picked part of it. Nothing moves by itself: a person picks the bank refunds it recorded
 *   on Stuck States, one at a time until the picks add up to its amount, and
 *   the same undo runs for each (owner decision 18 Oct 2026, `resolvePickedUndo`).
 * - `spare`: the payment's live refund notes, plus notes resolved by hand in
 *   Xero (`INV-INT-025`, never one whose own note Xero voided), still cover all
 *   of its bank hand-backs and its eligible card refund cash
 *   (`resolveRefundNoteEligibleCash`), so the voided note was a duplicate and
 *   nothing moves.
 * - `undo`: the note recorded one hand-back's refund, which nothing else in
 *   Xero now records. The writer takes it back out of the allocation, reverses
 *   the line, recomputes the total and raises the follow-up.
 *
 * WHICH HAND-BACK A NOTE RECORDED: the task it names - a hand-made note's link
 * (`handBackTaskId`), else its raising row's payload (`handBackTaskId` on a
 * cancellation's note since #4162, `reviewTaskId` on a review's,
 * `paidAnotherWayTaskId` on a follow-up's fresh note) - and that task's live
 * `BANK_REFUND` line for exactly the note's amount. A note naming no task (one
 * raised before #4162) takes the one live hand-back line of its amount on the
 * payment, and only when no other live `BANK_REFUND` line on the booking has
 * that amount; otherwise it is ambiguous.
 *
 * No lock, no write, no provider call.
 */
import type { PaymentSource, Prisma } from "@prisma/client";
import { Prisma as PrismaRuntime } from "@prisma/client";
import { z } from "zod";

import { liveLines } from "@/lib/booking-ledger-modification-posting";
import { findPostedSettlementLines } from "@/lib/booking-ledger-read";
import type { PostedSettlementLine } from "@/lib/booking-ledger-settlement-posting";
import {
  isCancelCardShortfallTask,
  isCardRefundPaidAnotherWayTask,
  isEditRefundHandBackTask,
  isRefundRequestHandBackTask,
} from "@/lib/manual-refund-task-settlement-rules";
import {
  BANK_REFUND_VOID_FOLLOW_UP_KEY_PREFIX,
  BANK_REFUND_VOID_FOLLOW_UP_TASK_WHERE,
  bankRefundVoidFollowUpOccurrenceKey,
  bankRefundVoidPickKeyPrefix,
} from "@/lib/bank-refund-void-follow-up-key";
import { readPaidAnotherWayCash } from "@/lib/card-refund-paid-another-way-cash";
import { cardRefundIdOfNoteRow } from "@/lib/card-refund-own-note-share";
import { unwindableHandBackCents } from "@/lib/refund-allocation-unwind";
import { resolveRefundNoteEligibleCash } from "@/lib/refund-note-eligible-cash";
import { decodeRawRows } from "@/lib/raw-sql-rows";
import { exactPrefix } from "@/lib/prisma-exact-prefix";
import { asRecord, readString } from "@/lib/xero-json";
import { findBlockingRefundCreditNoteOperationId } from "@/lib/xero-refund-note-link-repair";
import {
  CANCELLED_CREDIT_NOTE_STATUSES,
  isCoveredByExistingNoteRow,
  isRefundCreditNoteLinkCancelledInXero,
  readRefundNoteRaisingRow,
  recordedRefundNoteAmountCents,
  refundNoteIdSets,
} from "@/lib/xero-refund-note-status";
import {
  readResolvedRefundCreditNoteCoverage,
  sumRefundCreditNoteCoverageCents,
  sumRefundCreditNoteCoverageOfRowsCents,
} from "@/lib/xero-resolved-in-xero-fences";
import { sumCoveredRefundCreditNoteCents } from "@/lib/xero-sync";

type Reader = Prisma.TransactionClient;

/** The link metadata key a handled-without-a-follow-up marker lives under. */
export const BANK_REFUND_VOID_MARKER_KEY = "bankRefundVoid";

/**
 * Why a voided note was handled with no nightly follow-up: a spare, answered by
 * a person on Stuck States, or picked in full by a person (each pick raised its
 * own follow-up; the marker says no more picks are owed).
 */
export type BankRefundVoidMarkerOutcome = "spare" | "answered" | "picked";

export interface BankRefundVoidMarker {
  outcome: BankRefundVoidMarkerOutcome;
  at: string;
  memberId?: string | null;
  note?: string | null;
}

/** The marker a link carries, or null. */
export function readBankRefundVoidMarker(metadata: unknown): BankRefundVoidMarker | null {
  const marker = asRecord(asRecord(metadata)?.[BANK_REFUND_VOID_MARKER_KEY]);
  const outcome = readString(marker?.outcome);
  const at = readString(marker?.at);
  if ((outcome !== "spare" && outcome !== "answered" && outcome !== "picked") || !at) return null;
  return {
    outcome,
    at,
    memberId: readString(marker?.memberId),
    note: readString(marker?.note),
  };
}

const CANDIDATE_ROW = z.object({ id: z.string() });

/**
 * The ids of the refund-note links on bank-transfer payments whose recorded
 * status is VOIDED or DELETED, read the way `readRefundCreditNoteLinkStatus`
 * reads it (trimmed, any case), oldest write first. One statement, so neither
 * a status stored in another case nor the card payments' many retired notes
 * are read row by row; each row is re-checked in code (`classify…`).
 *
 * Handled notes - a follow-up raised under the note's key, or a marker on the
 * link - are left out in SQL unless `includeHandled` (the count reports them),
 * so the nightly run does not re-read every note it ever handled.
 */
export async function readVoidedBankRefundNoteLinkIds(
  db: Pick<Reader, "$queryRaw">,
  options?: { includeHandled?: boolean },
): Promise<string[]> {
  const includeHandled = options?.includeHandled === true;
  const rows = await db.$queryRaw`
    SELECT l."id"
    FROM "XeroObjectLink" l
    JOIN "Payment" p ON p."id" = l."localId"
    WHERE l."localModel" = 'Payment'
      AND l."xeroObjectType" = 'CREDIT_NOTE'
      AND l."role" = 'REFUND_CREDIT_NOTE'
      AND upper(btrim(l."metadata"->>'status')) IN (${PrismaRuntime.join([...CANCELLED_CREDIT_NOTE_STATUSES])})
      AND p."source" = 'INTERNET_BANKING'
      AND (${includeHandled}::boolean OR (
        (l."metadata" -> ${BANK_REFUND_VOID_MARKER_KEY}::text) IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM "ManualRefundTask" t
          WHERE t."occurrenceKey" = ${BANK_REFUND_VOID_FOLLOW_UP_KEY_PREFIX}::text || p."id" || ':' || l."xeroObjectId"
        )
      ))
    ORDER BY l."updatedAt" ASC, l."id" ASC
  `;
  return decodeRawRows(rows, CANDIDATE_ROW, "voided bank-transfer refund notes").map((row) => row.id);
}

/** The voided note link's fields every reader here needs. */
export const VOIDED_LINK_SELECT = {
  id: true,
  localModel: true,
  localId: true,
  xeroObjectType: true,
  xeroObjectId: true,
  xeroObjectNumber: true,
  role: true,
  active: true,
  metadata: true,
  updatedAt: true,
} as const satisfies Prisma.XeroObjectLinkSelect;

export type VoidedLink = Prisma.XeroObjectLinkGetPayload<{ select: typeof VOIDED_LINK_SELECT }>;

/**
 * Why a voided note goes to a person. `paid-another-way`: it recorded a card
 * refund the club paid back another way (or a card refund shortfall), whose
 * record and note stay with the card refund pipeline - never undone here.
 * `card-refund` (#4312, `INV-ADDPAY-047`): it recorded a card refund made
 * through Stripe, keyed on its refund - no bank refund to take back.
 * `coverage-unknown`: a note resolved by hand in Xero has no readable amount.
 * `partly-picked`: a person has picked some of the refunds it recorded, and
 * the rest of its amount is still to pick.
 */
export type BankRefundVoidUnmatchedReason =
  | "amount-unknown"
  | "no-line"
  | "ambiguous"
  | "detail-short"
  | "paid-another-way"
  | "card-refund"
  | "coverage-unknown"
  | "partly-picked";

/** What the payment looks like beside the void, for the count and the job's log. */
export interface BankRefundVoidPaymentFigures {
  /** `Payment.refundedAmountCents`. */
  refundedCents: number;
  /** What its transactions record as refunded: the detail. */
  detailCents: number;
}

/** What an undo takes back: the refund, the hand-back it was recorded on, and that hand-back's live line. */
export interface BankRefundVoidUndo {
  amountCents: number;
  taskId: string;
  line: PostedSettlementLine;
}

export type BankRefundVoidClassification =
  | { kind: "not-in-scope" }
  | { kind: "awaiting-heal" }
  | { kind: "handled"; by: "follow-up" | BankRefundVoidMarkerOutcome; followUpTaskId: string | null }
  | { kind: "deferred"; blockingOperationId: string }
  | {
      kind: "unmatched";
      reason: BankRefundVoidUnmatchedReason;
      amountCents: number | null;
      /** What is left to pick: the amount less the refunds already picked; null when the amount cannot be read. */
      remainingCents: number | null;
    }
  | { kind: "spare"; amountCents: number; coverageCents: number; requiredCents: number }
  | ({ kind: "undo" } & BankRefundVoidUndo);

export interface ClassifiedVoidedNote {
  link: VoidedLink;
  paymentId: string;
  bookingId: string | null;
  lodgeId: string | null;
  figures: BankRefundVoidPaymentFigures | null;
  classification: BankRefundVoidClassification;
}

/**
 * The completed tasks on the payment whose refunds a REFUND_CREDIT_NOTE
 * records, each marked when it is a card refund's record (a "Paid another
 * way" close or a card refund shortfall): those count as covered refunds in
 * the spare check, but are never undone or picked here.
 */
async function refundNoteHandBackTasks(db: Reader, paymentId: string): Promise<Map<string, { cardRecord: boolean }>> {
  const tasks =
    (await db.manualRefundTask.findMany({
      // Every completed task on the payment, sorted by kind below: a hand-back's
      // that is no edit's or refund request's (their notes are another role),
      // and a review's whose refund a refund note recorded.
      where: { paymentId, status: "COMPLETED" },
      select: { id: true, kind: true, occurrenceKey: true },
    })) ?? [];
  const reviewIds = tasks.filter((task) => task.kind === "EDIT_FINANCIAL_REVIEW").map((task) => task.id);
  // A review's hand-back is recorded by a refund note only on a cancelled
  // booking (#3880); its note row names the review, which is the evidence.
  const notedReviewIds = new Set<string>();
  if (reviewIds.length > 0) {
    const rows =
      (await db.xeroSyncOperation.findMany({
        where: {
          entityType: "CREDIT_NOTE",
          operationType: "CREATE",
          localModel: "Payment",
          localId: paymentId,
          OR: reviewIds.map((id) => ({ requestPayload: { path: ["reviewTaskId"], equals: id } })),
        },
        select: { requestPayload: true },
      })) ?? [];
    for (const row of rows) {
      const id = readString(asRecord(row.requestPayload)?.reviewTaskId);
      if (id) notedReviewIds.add(id);
    }
  }
  const out = new Map<string, { cardRecord: boolean }>();
  for (const task of tasks) {
    const counts =
      task.kind === "EDIT_FINANCIAL_REVIEW"
        ? notedReviewIds.has(task.id)
        : task.kind === "CANCELLED_BOOKING_HAND_BACK" && !isEditRefundHandBackTask(task) && !isRefundRequestHandBackTask(task);
    if (counts) out.set(task.id, { cardRecord: isCardRefundPaidAnotherWayTask(task) || isCancelCardShortfallTask(task) });
  }
  return out;
}

/** #4312: the reasons a voided note has no bank refund for a person to pick - it recorded card money. */
export function isCardMoneyVoidReason(reason: BankRefundVoidUnmatchedReason | "deferred"): boolean {
  return reason === "paid-another-way" || reason === "card-refund";
}

/** #4312: whether the note's raising row recorded a card refund of its own (`cardRefundIdOfNoteRow`). */
async function noteRecordsCardRefund(db: Reader, paymentId: string, link: VoidedLink): Promise<boolean> {
  const row = await readRefundNoteRaisingRow(paymentId, link.xeroObjectId, db);
  return row !== null && cardRefundIdOfNoteRow(row) !== null;
}

/** The task a note names as the hand-back it records, or null (a note from before #4162). */
async function noteHandBackTaskId(db: Reader, paymentId: string, link: VoidedLink): Promise<string | null> {
  const onLink = readString(asRecord(link.metadata)?.handBackTaskId);
  if (onLink) return onLink;
  const payload = asRecord((await readRefundNoteRaisingRow(paymentId, link.xeroObjectId, db))?.requestPayload);
  return (
    readString(payload?.handBackTaskId) ??
    readString(payload?.reviewTaskId) ??
    readString(payload?.paidAnotherWayTaskId)
  );
}

/**
 * The card refund cash the payment's refund notes must also cover: the
 * canonical eligible cash (`resolveRefundNoteEligibleCash`, which leaves out
 * late-capture refunds Xero never received, `INV-PAY-110`) less the
 * paid-another-way cash it counts, which the hand-back lines already count.
 * Only on the provider ledger: with no refund rows the evidence is the
 * mirror, which on a bank transfer is the hand-backs themselves.
 */
async function cardRefundCashCents(db: Reader, payment: { id: string; bookingId: string; refundedAmountCents: number }): Promise<number> {
  const eligible = await resolveRefundNoteEligibleCash(payment, db);
  if (eligible.evidence.source !== "provider-ledger") return 0;
  const paidAnotherWay = await readPaidAnotherWayCash(db, payment.id);
  return Math.max(0, eligible.eligibleCashCents - paidAnotherWay.notedCents);
}

/** A live hand-back line a person may pick as the one a voided note recorded, with what the treasurer sees of it. */
export interface PickableHandBackLine {
  lineId: string;
  taskId: string;
  amountCents: number;
  /** Its refund is exactly what is left of the note's amount to pick: the likeliest one. */
  matchesNote: boolean;
}

interface PaymentHandBacks {
  /** Every live `BANK_REFUND` line on the booking. */
  bankRefundLines: PostedSettlementLine[];
  /** Those on the payment's refund-note hand-backs. */
  handBackLines: PostedSettlementLine[];
  /** Those an undo may take back: not a card refund's record. */
  undoableLines: PostedSettlementLine[];
}

async function readPaymentHandBacks(db: Reader, paymentId: string, bookingId: string): Promise<PaymentHandBacks> {
  const tasks = await refundNoteHandBackTasks(db, paymentId);
  const bankRefundLines = liveLines(await findPostedSettlementLines(db, bookingId, { kind: "BANK_REFUND" }));
  const handBackLines = bankRefundLines.filter((line) => line.anchorKind === "REVIEW_TASK" && tasks.has(line.anchorId));
  const undoableLines = handBackLines.filter((line) => tasks.get(line.anchorId)?.cardRecord === false);
  return { bankRefundLines, handBackLines, undoableLines };
}

/** A line's refund, positive cents (a hand-back line is a credit to the member). */
function lineCents(line: PostedSettlementLine): number {
  return -line.sign * line.unitCents * line.quantity;
}

/**
 * Classify one voided note link. Reads with `db`: the writer passes its
 * transaction after `lock(1)` and the Payment row; every other caller the
 * pooled client, as advice.
 */
export async function classifyVoidedBankRefundNote(db: Reader, linkId: string): Promise<ClassifiedVoidedNote | null> {
  const link = await db.xeroObjectLink.findUnique({ where: { id: linkId }, select: VOIDED_LINK_SELECT });
  if (!link || link.localModel !== "Payment") return null;
  const paymentId = link.localId;
  const result = (classification: BankRefundVoidClassification, extra?: Partial<ClassifiedVoidedNote>): ClassifiedVoidedNote => ({
    link,
    paymentId,
    bookingId: null,
    lodgeId: null,
    figures: null,
    classification,
    ...extra,
  });
  const payment = await db.payment.findUnique({
    where: { id: paymentId },
    select: { id: true, source: true, refundedAmountCents: true, bookingId: true, booking: { select: { lodgeId: true } } },
  });
  if (
    !payment ||
    payment.source !== ("INTERNET_BANKING" satisfies PaymentSource) ||
    link.xeroObjectType !== "CREDIT_NOTE" ||
    link.role !== "REFUND_CREDIT_NOTE" ||
    !isRefundCreditNoteLinkCancelledInXero(link.metadata)
  ) {
    return result({ kind: "not-in-scope" });
  }
  const detail = await db.paymentTransaction.aggregate({ where: { paymentId }, _sum: { refundedAmountCents: true } });
  const base: Partial<ClassifiedVoidedNote> = {
    bookingId: payment.bookingId,
    lodgeId: payment.booking.lodgeId,
    figures: { refundedCents: payment.refundedAmountCents, detailCents: Math.max(0, detail._sum.refundedAmountCents ?? 0) },
  };
  if (link.active) return result({ kind: "awaiting-heal" }, base);

  const followUp = await findFollowUpOfNote(db, paymentId, link.xeroObjectId);
  if (followUp) return result({ kind: "handled", by: "follow-up", followUpTaskId: followUp.id }, base);
  const marker = readBankRefundVoidMarker(link.metadata);
  if (marker) return result({ kind: "handled", by: marker.outcome, followUpTaskId: null }, base);
  const picks = await readPicksOfNote(db, paymentId, link.xeroObjectId);

  // A create row whose note Xero voided can never mint again (#4091's asserts
  // refuse it), so it never holds a void back (#4162 review, money 4).
  const cancelledNoteIds = [...(await refundNoteIdSets(paymentId, db)).cancelled];
  const blockingOperationId = await findBlockingRefundCreditNoteOperationId(paymentId, db, { ignoreXeroObjectIds: cancelledNoteIds });
  if (blockingOperationId) return result({ kind: "deferred", blockingOperationId }, base);

  const recorded = await recordedRefundNoteAmountCents(paymentId, link, db);
  const amountCents = recorded !== null && Number.isSafeInteger(recorded) && recorded > 0 ? recorded : null;
  // An unreadable amount allows one pick only: nothing says how much is left (review, money A).
  if (amountCents === null) {
    if (picks.count > 0) return result({ kind: "handled", by: "picked", followUpTaskId: null }, base);
    return result({ kind: "unmatched", reason: "amount-unknown", amountCents: null, remainingCents: null }, base);
  }
  if (picks.cents >= amountCents) return result({ kind: "handled", by: "picked", followUpTaskId: null }, base);
  const remainingCents = amountCents - picks.cents;
  const unmatched = (reason: BankRefundVoidUnmatchedReason) => result({ kind: "unmatched", reason, amountCents, remainingCents }, base);

  const { bankRefundLines, handBackLines, undoableLines } = await readPaymentHandBacks(db, paymentId, payment.bookingId);
  const handBackCents = handBackLines.reduce((sum, line) => sum + lineCents(line), 0);

  // The spare check: Xero still records every bank hand-back and card refund.
  // A note resolved by hand whose own note Xero voided covers nothing (review, money 1; the helper's rule, #4250).
  const resolved = await readResolvedRefundCreditNoteCoverage(paymentId, db);
  if (resolved.unreadableOperationIds.length > 0) return unmatched("coverage-unknown");
  const coverageCents = await sumRefundCreditNoteCoverageCents(paymentId, resolved, db);
  const requiredCents = handBackCents + (await cardRefundCashCents(db, payment));
  if (handBackCents > 0 && coverageCents >= requiredCents) {
    return result({ kind: "spare", amountCents, coverageCents, requiredCents }, base);
  }

  // #4312: a card refund's own note recorded no bank refund, so it is never matched to one by amount.
  if (await noteRecordsCardRefund(db, paymentId, link)) return unmatched("card-refund");
  const taskId = await noteHandBackTaskId(db, paymentId, link);
  // A card refund's record (a "Paid another way" close, a shortfall) is the
  // card refund pipeline's: its note is re-raised there, never undone here.
  const cardRecordLineIds = new Set(handBackLines.filter((line) => !undoableLines.includes(line)).map((line) => line.id));
  if (taskId !== null && handBackLines.some((line) => line.anchorId === taskId && cardRecordLineIds.has(line.id))) {
    return unmatched("paid-another-way");
  }
  // Part of it picked: the rest is a person's to pick, never matched by amount (review, money A).
  if (picks.count > 0) return unmatched("partly-picked");
  const sameAmount = (line: PostedSettlementLine) => lineCents(line) === amountCents;
  const candidates: PostedSettlementLine[] = [];
  for (const line of undoableLines) {
    // A line live notes still cover was not this note's to take back (money B).
    if (sameAmount(line) && (taskId === null || line.anchorId === taskId) && !(await isLineStillCovered(db, paymentId, line))) candidates.push(line);
  }
  // A named task's own line; an unnamed note's only when no other live
  // `BANK_REFUND` line on the booking has its amount.
  const unique = candidates.length === 1 && (taskId !== null || bankRefundLines.filter(sameAmount).length === 1);
  if (!unique) {
    return unmatched(candidates.length === 0 ? "no-line" : "ambiguous");
  }
  const line = candidates[0]!;
  if ((await unwindableHandBackCents(db, paymentId)) < amountCents) {
    return unmatched("detail-short");
  }
  return result({ kind: "undo", amountCents, taskId: line.anchorId, line }, base);
}

/**
 * The refunds people have picked for one voided note (review, money A): how
 * many picks, and the refund each raised, summed. A pick's follow-up is raised
 * for the picked line's refund (`raisedAmountCents`, never edited later).
 */
async function readPicksOfNote(db: Reader, paymentId: string, creditNoteId: string): Promise<{ count: number; cents: number }> {
  const tasks =
    (await db.manualRefundTask.findMany({
      where: { ...BANK_REFUND_VOID_FOLLOW_UP_TASK_WHERE, occurrenceKey: exactPrefix(bankRefundVoidPickKeyPrefix(paymentId, creditNoteId)) },
      select: { amountCents: true, raisedAmountCents: true },
    })) ?? [];
  return { count: tasks.length, cents: tasks.reduce((sum, task) => sum + (task.raisedAmountCents ?? task.amountCents ?? 0), 0) };
}

/** The nightly follow-up raised for a voided note, if any. */
async function findFollowUpOfNote(db: Reader, paymentId: string, creditNoteId: string) {
  return db.manualRefundTask.findUnique({
    where: { occurrenceKey: bankRefundVoidFollowUpOccurrenceKey(paymentId, creditNoteId) },
    select: { id: true },
  });
}

/** The payload keys a refund note's create row names the hand-back it records under. */
const NOTE_TASK_KEYS = ["handBackTaskId", "reviewTaskId", "paidAnotherWayTaskId"] as const;

/**
 * #4162 final review (money B): what Xero's LIVE notes still record of one
 * hand-back's refund - the notes whose create rows name its task, counted as
 * the payment's coverage counts them (`sumRefundCreditNoteCoverageOfRowsCents`,
 * never a row resolved by hand whose own note Xero voided, nor a row closed as
 * covered by another hand-back's note, `isCoveredByExistingNoteRow`), plus a note made by
 * hand and linked to it (`handBackTaskId` on an active link whose create row,
 * if any, does not already name it). A line those notes still cover was not
 * the voided note's, so it is never picked.
 */
async function taskNoteCoverageCents(db: Reader, paymentId: string, taskId: string): Promise<number> {
  const namesTask: Prisma.XeroSyncOperationWhereInput = { OR: NOTE_TASK_KEYS.map((key) => ({ requestPayload: { path: [key], equals: taskId } })) };
  // A row closed as covered by another hand-back's note minted nothing: that note is not this task's.
  const namingRows = (await db.xeroSyncOperation.findMany({ where: { localModel: "Payment", localId: paymentId, ...namesTask }, select: { id: true, responsePayload: true } })) ?? [];
  const coveredByOtherIds = namingRows.filter(isCoveredByExistingNoteRow).map((row) => row.id);
  const rowsWhere: Prisma.XeroSyncOperationWhereInput = {
    ...namesTask,
    ...(coveredByOtherIds.length > 0 ? { AND: [{ id: { notIn: coveredByOtherIds } }] } : {}),
  };
  const fromRows = await sumRefundCreditNoteCoverageOfRowsCents(paymentId, rowsWhere, db);
  const handMade =
    (await db.xeroObjectLink.findMany({
      where: {
        localModel: "Payment",
        localId: paymentId,
        xeroObjectType: "CREDIT_NOTE",
        role: "REFUND_CREDIT_NOTE",
        active: true,
        metadata: { path: ["handBackTaskId"], equals: taskId },
      },
      select: { xeroObjectId: true },
    })) ?? [];
  const onlyOnLink: string[] = [];
  for (const link of handMade) {
    const payload = asRecord((await readRefundNoteRaisingRow(paymentId, link.xeroObjectId, db))?.requestPayload);
    if (!NOTE_TASK_KEYS.some((key) => readString(payload?.[key]) === taskId)) onlyOnLink.push(link.xeroObjectId);
  }
  return fromRows + (await sumCoveredRefundCreditNoteCents(paymentId, db, onlyOnLink));
}

/** How much of this hand-back line's refund its own task's live notes still record, at most the line's refund (money B). */
async function lineOwnLiveCoverageCents(db: Reader, paymentId: string, line: PostedSettlementLine): Promise<number> {
  return Math.min(lineCents(line), await taskNoteCoverageCents(db, paymentId, line.anchorId));
}

/**
 * Whether live notes still record ANY of this line's refund (money B, final
 * re-check). Even in part, it is never offered, picked or matched: an undo
 * takes back the whole line, so it would take back what Xero still records,
 * and leave too little of the voided note to pick the refunds it did record.
 * Such a line goes to the answer path, its live share shown to the person.
 */
async function isLineStillCovered(db: Reader, paymentId: string, line: PostedSettlementLine): Promise<boolean> {
  return (await lineOwnLiveCoverageCents(db, paymentId, line)) > 0;
}

/** A live bank hand-back line its own live notes record in part: not offered, shown with its live share. */
export interface PartlyCoveredHandBackLine {
  lineId: string;
  taskId: string;
  amountCents: number;
  /** What its own live notes in Xero still record of it: more than 0, less than `amountCents`. */
  coveredCents: number;
}

/** The payment's live bank hand-backs (never a card refund's record) whose own live notes record part of them. */
export async function readPartlyCoveredHandBackLines(db: Reader, paymentId: string, bookingId: string): Promise<PartlyCoveredHandBackLine[]> {
  const { undoableLines } = await readPaymentHandBacks(db, paymentId, bookingId);
  const out: PartlyCoveredHandBackLine[] = [];
  for (const line of undoableLines) {
    const amountCents = lineCents(line);
    const coveredCents = await lineOwnLiveCoverageCents(db, paymentId, line);
    if (coveredCents > 0 && coveredCents < amountCents) out.push({ lineId: line.id, taskId: line.anchorId, amountCents, coveredCents });
  }
  return out;
}

/**
 * The live bank hand-backs a person may pick for an unmatched note on this
 * payment: never a card refund's record, never one live notes still record
 * even in part (money B), and none larger than what is left of the note's amount to pick
 * (`remainingCents`; any size when the amount cannot be read). Each says
 * whether its refund is exactly what is left.
 */
export async function readPickableHandBackLines(
  db: Reader,
  paymentId: string,
  bookingId: string,
  remainingCents: number | null,
): Promise<PickableHandBackLine[]> {
  const { undoableLines } = await readPaymentHandBacks(db, paymentId, bookingId);
  const out: PickableHandBackLine[] = [];
  for (const line of undoableLines) {
    const amountCents = lineCents(line);
    if (remainingCents !== null && amountCents > remainingCents) continue;
    if (await isLineStillCovered(db, paymentId, line)) continue;
    out.push({ lineId: line.id, taskId: line.anchorId, amountCents, matchesNote: amountCents === remainingCents });
  }
  return out;
}

/** Why a person's pick is refused, in the words the panel shows. */
export type PickRefusal = "not-unmatched" | "line-not-pickable" | "still-covered" | "too-large" | "detail-short";

/**
 * #4162 (owner decision 18 Oct 2026, comment 6247741127): the undo a person's
 * pick asks for, re-read under the caller's locks - the note still unmatched,
 * the line a live hand-back line of THIS payment that an undo may take back,
 * that no live note of its own still records even in part (money B), no larger than what is left of the
 * note's amount to pick (money A), and the payment's detail still holding its
 * refund. The undo takes back the picked line's refund.
 */
export async function resolvePickedUndo(
  db: Reader,
  note: ClassifiedVoidedNote,
  lineId: string,
): Promise<{ undo: BankRefundVoidUndo; remainingCents: number | null } | { refusal: PickRefusal }> {
  const c = note.classification;
  if (c.kind !== "unmatched" || isCardMoneyVoidReason(c.reason) || !note.bookingId) {
    return { refusal: "not-unmatched" };
  }
  const { undoableLines } = await readPaymentHandBacks(db, note.paymentId, note.bookingId);
  const line = undoableLines.find((candidate) => candidate.id === lineId);
  if (!line) return { refusal: "line-not-pickable" };
  const amountCents = lineCents(line);
  if (await isLineStillCovered(db, note.paymentId, line)) return { refusal: "still-covered" };
  if (c.remainingCents !== null && amountCents > c.remainingCents) return { refusal: "too-large" };
  if ((await unwindableHandBackCents(db, note.paymentId)) < amountCents) return { refusal: "detail-short" };
  return { undo: { amountCents, taskId: line.anchorId, line }, remainingCents: c.remainingCents };
}

/**
 * #4162 review (security 12): whether the payment holds a voided refund note
 * the follow-up has not handled yet - the inbound floor then logs its
 * divergence at info instead of alerting, because the follow-up resolves it.
 */
export async function hasVoidAwaitingFollowUp(db: Reader, paymentId: string): Promise<boolean> {
  const links =
    (await db.xeroObjectLink.findMany({
      where: { localModel: "Payment", localId: paymentId, xeroObjectType: "CREDIT_NOTE", role: "REFUND_CREDIT_NOTE" },
      select: { xeroObjectId: true, metadata: true },
    })) ?? [];
  for (const link of links) {
    if (!isRefundCreditNoteLinkCancelledInXero(link.metadata) || readBankRefundVoidMarker(link.metadata)) continue;
    if (!(await findFollowUpOfNote(db, paymentId, link.xeroObjectId))) return true;
  }
  return false;
}

/** A void deferred this long is listed for a person, so a stuck create never hides it (review, money 4). */
export const BANK_REFUND_VOID_DEFERRAL_ALERT_DAYS = 7;

/** One voided note a person answers on Stuck States. */
export interface BankRefundVoidForAPerson {
  linkId: string;
  paymentId: string;
  bookingId: string;
  creditNoteNumber: string | null;
  creditNoteId: string;
  /** The voided note's recorded amount, or null when it cannot be read. */
  amountCents: number | null;
  /** What is left of it to pick (money A): null when the amount cannot be read, or the note is deferred. */
  remainingCents: number | null;
  /** When the app found the note voided (the link's last write), as an ISO instant - not Xero's own void time. */
  foundVoidedAt: string;
  /** Why it is here: unmatched (a person picks), or deferred too long (shown, nothing to pick yet). */
  reason: BankRefundVoidUnmatchedReason | "deferred";
  /** For an unmatched note, the payment's live bank refunds it may have recorded. Empty otherwise. */
  pickableLines: PickableHandBackLine[];
  /** For an unmatched note, the bank refunds not offered because their own live notes still record part of them. */
  partlyCoveredLines: PartlyCoveredHandBackLine[];
}

/**
 * Every voided bank-transfer refund note a person must look at, oldest first:
 * the `unmatched` ones (with the refunds a person may pick), and those
 * deferred for more than `BANK_REFUND_VOID_DEFERRAL_ALERT_DAYS`. Read with the
 * pooled client, as advice: a pick re-classifies under the writer's locks.
 */
export async function listBankRefundVoidsForAPerson(db: Reader, now: Date = new Date()): Promise<BankRefundVoidForAPerson[]> {
  const items: BankRefundVoidForAPerson[] = [];
  const deferredBefore = now.getTime() - BANK_REFUND_VOID_DEFERRAL_ALERT_DAYS * 24 * 60 * 60 * 1000;
  for (const linkId of await readVoidedBankRefundNoteLinkIds(db)) {
    const note = await classifyVoidedBankRefundNote(db, linkId);
    if (!note?.bookingId) continue;
    const c = note.classification;
    const unmatched = c.kind === "unmatched";
    if (!unmatched && !(c.kind === "deferred" && note.link.updatedAt.getTime() < deferredBefore)) continue;
    items.push({
      linkId,
      paymentId: note.paymentId,
      bookingId: note.bookingId,
      creditNoteNumber: note.link.xeroObjectNumber ?? null,
      creditNoteId: note.link.xeroObjectId,
      amountCents: c.kind === "unmatched" ? c.amountCents : null,
      remainingCents: c.kind === "unmatched" ? c.remainingCents : null,
      foundVoidedAt: note.link.updatedAt.toISOString(),
      reason: c.kind === "unmatched" ? c.reason : "deferred",
      pickableLines:
        c.kind === "unmatched" && !isCardMoneyVoidReason(c.reason)
          ? await readPickableHandBackLines(db, note.paymentId, note.bookingId, c.remainingCents)
          : [],
      partlyCoveredLines:
        c.kind === "unmatched" && !isCardMoneyVoidReason(c.reason) ? await readPartlyCoveredHandBackLines(db, note.paymentId, note.bookingId) : [],
    });
  }
  return items;
}
