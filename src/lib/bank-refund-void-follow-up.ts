import { Prisma } from "@prisma/client";

import { createAuditLog } from "@/lib/audit";
import {
  bankRefundVoidFollowUpReviewContext,
} from "@/lib/bank-refund-void-follow-up-copy";
import {
  BANK_REFUND_VOID_MARKER_KEY,
  BANK_REFUND_VOID_DEFERRAL_ALERT_DAYS,
  classifyVoidedBankRefundNote,
  listBankRefundVoidsForAPerson,
  readPickableHandBackLines,
  readVoidedBankRefundNoteLinkIds,
  isCardMoneyVoidReason,
  resolvePickedUndo,
  type BankRefundVoidClassification,
  type BankRefundVoidUndo,
  type PickRefusal,
  type BankRefundVoidMarker,
  type ClassifiedVoidedNote,
} from "@/lib/bank-refund-void-scan";
import { settlementLineReversal } from "@/lib/booking-ledger-settlement-posting";
import { buildBookingLedgerRows, writeBookingLedgerRows } from "@/lib/booking-ledger-write";
import { bookingOwner } from "@/lib/booking-owner";
import { formatBookingReference } from "@/lib/booking-reference";
import logger from "@/lib/logger";
import { MANUAL_REFUND_TASK_REASON_MAX } from "@/lib/manual-subscription-payment";
import { bankRefundVoidFollowUpOccurrenceKey, bankRefundVoidPickOccurrenceKey } from "@/lib/bank-refund-void-follow-up-key";
import {
  lockPaymentForRefundedTotal,
  reconcilePaymentAggregates,
} from "@/lib/payment-transactions";
import { unwindLocalRefundAllocation } from "@/lib/refund-allocation-unwind";
import { isPostgresLockNotAvailable } from "@/lib/prisma-errors";
import { prisma } from "@/lib/prisma";
import { asRecord } from "@/lib/xero-json";
import { isXeroBankRefundVoidWritesEnabled } from "@/lib/xero-feature-flags";

/**
 * #4162 (owner decision 17 Oct 2026, `INV-ADDPAY-042`): UNDO, THEN ASK ONCE.
 *
 * The treasurer's hand-back is the record that a bank refund was paid; its
 * Xero credit note mirrors it. When Xero voids that note, the refund is no
 * longer recorded, so each night - after #4161's heal has turned the voided
 * mirror off - this job carries the void through every app record and puts the
 * money back on the treasurer's refund list as owed, with one question. Each
 * voided bank-transfer refund note is handled EXACTLY ONCE
 * (`classifyVoidedBankRefundNote` says how):
 *
 * - a SPARE note (live notes, plus notes resolved by hand in Xero, still cover
 *   every bank hand-back) moves nothing; a marker on its link records that it
 *   was handled, so it is not examined forever;
 * - a note that recorded ONE hand-back's refund is undone in one transaction:
 *   the follow-up hand-back ("Refund to re-confirm", key
 *   `bank-refund-void:<paymentId>:<creditNoteId>`) is inserted first - the
 *   unique key is the claim, so a lost claim moves nothing - then the amount
 *   comes out of the allocation (`unwindLocalRefundAllocation`), the
 *   hand-back's `BANK_REFUND` line is reversed (`settlementLineReversal`) and
 *   the refunded total is recomputed from the detail
 *   (`reconcilePaymentAggregates`). No email, no booking event, no provider
 *   call: nothing is raised in Xero without a person;
 * - an unmatched or ambiguous note goes to a person on Stuck States, who picks
 *   the bank refund it recorded; the same undo then runs
 *   (`pickRefundForUnmatchedVoid`, owner decision 18 Oct 2026). A note that
 *   recorded several refunds takes one pick per refund, each claimed under its
 *   own key, until the picks add up to its amount (one pick when its amount
 *   cannot be read); the last pick marks the note "picked". A note with
 *   nothing to pick (a card refund's record) takes a recorded answer instead.
 *
 * REPORT-ONLY BY DEFAULT: until the operator sets
 * `XERO_ENABLE_BANK_REFUND_VOID_WRITES=true` the job classifies every note,
 * logs what it would do, and writes nothing - and a person's pick or answer
 * is refused, so nothing anywhere writes.
 *
 * LOCKS (`INV-LOCK-001`, `INV-LOCK-002`): the undo moves settlement money that
 * every edit, acceptance, paid cancel and refund appeal reads to size a
 * refund, so each note's transaction takes global `lock(1)` first, then the
 * Payment row (`lockPaymentForRefundedTotal`) BEFORE anything about the
 * payment is read, then re-classifies under both. The spare marker's link row
 * is taken last and `NOWAIT`: the inbound sync's link write and #4161's heal
 * take the link before the Payment row, so a busy link defers the note to the
 * next run rather than waiting with the Payment row held. One note per
 * transaction, so a slow note never holds another payment's locks.
 */

export type BankRefundVoidJobOutcome =
  | "undone"
  | "spare"
  | "handled"
  | "deferred"
  | "unmatched"
  | "awaiting-heal"
  | "not-in-scope"
  | "failed";

export interface BankRefundVoidJobItem {
  linkId: string;
  paymentId: string;
  creditNoteId: string;
  creditNoteNumber: string | null;
  outcome: BankRefundVoidJobOutcome;
  /** What the job would do (report-only) or did, in a line. */
  detail: string;
  amountCents: number | null;
  followUpTaskId?: string | null;
}

export interface BankRefundVoidJobResult {
  mode: "report-only" | "writes";
  scanned: number;
  counts: Record<BankRefundVoidJobOutcome, number>;
  /** Notes deferred for more than `BANK_REFUND_VOID_DEFERRAL_ALERT_DAYS`, also listed on Stuck States. */
  deferredOverdue: number;
  /** Every note that is not already handled, in scan order. */
  items: BankRefundVoidJobItem[];
}

const OUTCOMES: readonly BankRefundVoidJobOutcome[] = [
  "undone",
  "spare",
  "handled",
  "deferred",
  "unmatched",
  "awaiting-heal",
  "not-in-scope",
  "failed",
];

/** The outcome a classification leads to, before anything is written. */
function plannedOutcome(classification: BankRefundVoidClassification): BankRefundVoidJobOutcome {
  return classification.kind === "undo" ? "undone" : classification.kind;
}

function describe(classification: BankRefundVoidClassification, writes: boolean): string {
  switch (classification.kind) {
    case "undo":
      return `${writes ? "Undone" : "Would undo"}: the hand-back's refund taken out of the allocation, its ledger line reversed, the total recomputed, and one follow-up raised`;
    case "spare":
      return "Spare: live notes still cover every bank hand-back; nothing moves";
    case "deferred":
      return `Deferred: refund-note operation ${classification.blockingOperationId} could still mint`;
    case "unmatched":
      return `Unmatched (${classification.reason}): a person answers it on Stuck States`;
    case "awaiting-heal":
      return "Awaiting #4161's heal: the voided mirror is still active";
    case "handled":
      return `Already handled (${classification.by})`;
    default:
      return "Not a voided bank-transfer refund note";
  }
}

function itemOf(note: ClassifiedVoidedNote, outcome: BankRefundVoidJobOutcome, detail: string, extra?: Partial<BankRefundVoidJobItem>): BankRefundVoidJobItem {
  const c = note.classification;
  return {
    linkId: note.link.id,
    paymentId: note.paymentId,
    creditNoteId: note.link.xeroObjectId,
    creditNoteNumber: note.link.xeroObjectNumber ?? null,
    outcome,
    detail,
    amountCents: c.kind === "undo" || c.kind === "spare" ? c.amountCents : c.kind === "unmatched" ? c.amountCents : null,
    ...extra,
  };
}

/**
 * Write a handled marker onto a voided note's link, merged into its metadata.
 * The link row is taken `NOWAIT` after the caller's Payment row (see the
 * module comment), and re-read under it: a link that is no longer a voided
 * refund note, or already carries a marker, is left alone.
 */
export async function writeBankRefundVoidMarker(
  tx: Prisma.TransactionClient,
  linkId: string,
  marker: BankRefundVoidMarker,
): Promise<boolean> {
  await tx.$executeRaw`SELECT 1 FROM "XeroObjectLink" WHERE "id" = ${linkId} FOR UPDATE NOWAIT`;
  const link = await tx.xeroObjectLink.findUnique({ where: { id: linkId }, select: { metadata: true } });
  const metadata = asRecord(link?.metadata);
  if (!link || !metadata || metadata[BANK_REFUND_VOID_MARKER_KEY] !== undefined) return false;
  await tx.xeroObjectLink.update({
    where: { id: linkId },
    data: { metadata: { ...metadata, [BANK_REFUND_VOID_MARKER_KEY]: { ...marker } } as Prisma.InputJsonObject },
  });
  return true;
}

/** The follow-up's reason line, as the refund list and the old app version show it. */
function followUpReason(bookingId: string, creditNoteNumber: string | null): string {
  return `Refund to re-confirm: Xero credit note ${creditNoteNumber ?? "(no number)"} for booking ${formatBookingReference(bookingId)} was found voided, so this bank refund is back on the list. Check whether the money went to the member (#4162).`.slice(
    0,
    MANUAL_REFUND_TASK_REASON_MAX,
  );
}

/** A refusal of a person's action, with the status the route answers. Thrown inside the transaction, so nothing commits. */
export class BankRefundVoidAnswerRefusal extends Error {
  constructor(
    message: string,
    readonly status: 404 | 409,
  ) {
    super(message);
    this.name = "BankRefundVoidAnswerRefusal";
  }
}

/** The refusal of every person's action while the follow-up is report-only (review, security 5). */
export const BANK_REFUND_VOID_REPORT_ONLY_MESSAGE =
  "This list is report-only until the club switches the voided-refund follow-up on (XERO_ENABLE_BANK_REFUND_VOID_WRITES). Nothing was changed.";

/**
 * THE UNDO, under the caller's `lock(1)` and Payment row, of one voided note's
 * refund - shared by the nightly follow-up (a matched note) and a person's
 * pick (an unmatched one), so both write exactly the same rows. The claim
 * first: the follow-up's unique key, before any money moves; a lost claim
 * moves nothing. Then the unwind, the reversal and the rebuild, and the audit
 * row naming who acted (none for the job).
 */
async function undoUnderLocks(
  tx: Prisma.TransactionClient,
  note: ClassifiedVoidedNote,
  undo: BankRefundVoidUndo,
  actingMemberId: string | null,
  /** The claim: the note's own key for the nightly undo, the note-and-line key for a person's pick. */
  occurrenceKey: string,
): Promise<{ claimed: false } | { claimed: true; followUpTaskId: string }> {
  const bookingId = note.bookingId!;
  const lodgeId = note.lodgeId!;
  const claimed = await tx.manualRefundTask.createMany({
    data: [
      {
        bookingId,
        paymentId: note.paymentId,
        amountCents: undo.amountCents,
        raisedAmountCents: undo.amountCents,
        kind: "CANCELLED_BOOKING_HAND_BACK",
        occurrenceKey,
        reason: followUpReason(bookingId, note.link.xeroObjectNumber ?? null),
        reviewContext: bankRefundVoidFollowUpReviewContext({
          voidedCreditNoteId: note.link.xeroObjectId,
          voidedCreditNoteNumber: note.link.xeroObjectNumber ?? null,
          voidedAt: note.link.updatedAt.toISOString(),
          originalTaskId: undo.taskId,
          reversedLineId: undo.line.id,
        }),
      },
    ],
    skipDuplicates: true,
  });
  if (claimed.count !== 1) return { claimed: false };
  await unwindLocalRefundAllocation({ paymentId: note.paymentId, amountCents: undo.amountCents, store: tx });
  const written = await writeBookingLedgerRows(tx, buildBookingLedgerRows([settlementLineReversal({ bookingId, lodgeId }, undo.line, actingMemberId)]));
  if (written !== 1) {
    // A replay would have lost the claim above; a reversal already there
    // means the ledger moved under us. Roll the whole undo back.
    throw new Error(`Bank refund void follow-up: the hand-back line ${undo.line.id} was already reversed`);
  }
  await reconcilePaymentAggregates({ paymentId: note.paymentId, store: tx });
  const task = await tx.manualRefundTask.findUniqueOrThrow({ where: { occurrenceKey }, select: { id: true } });
  const booking = await tx.booking.findUniqueOrThrow({ where: { id: bookingId }, select: { memberId: true } });
  await createAuditLog(
    {
      action: "booking-payment.bank-refund.void-undone",
      memberId: actingMemberId,
      actorMemberId: actingMemberId,
      subjectMemberId: bookingOwner(booking).memberId,
      targetId: bookingId,
      entityType: "ManualRefundTask",
      entityId: task.id,
      category: "payment",
      severity: "important",
      outcome: "success",
      summary: `Xero voided the refund credit note ${note.link.xeroObjectNumber ?? note.link.xeroObjectId} on booking ${formatBookingReference(bookingId)}; the bank refund was taken back out of the payment's records and put back on the refund list to re-confirm${actingMemberId ? " (the refund was picked by a person)" : ""}`,
      metadata: {
        paymentId: note.paymentId,
        voidedCreditNoteId: note.link.xeroObjectId,
        amountCents: undo.amountCents,
        originalTaskId: undo.taskId,
        reversedLineId: undo.line.id,
        pickedByPerson: actingMemberId !== null,
      },
    },
    tx,
  );
  return { claimed: true, followUpTaskId: task.id };
}

/** `lock(1)`, then the link's Payment row, then the note re-classified under both: the start of every writer here. */
async function lockAndClassify(tx: Prisma.TransactionClient, linkId: string): Promise<ClassifiedVoidedNote | null> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
  // The link's payment is immutable: read unlocked, only to know which row to lock.
  const head = await tx.xeroObjectLink.findUnique({ where: { id: linkId }, select: { localModel: true, localId: true } });
  if (!head || head.localModel !== "Payment") return null;
  await lockPaymentForRefundedTotal(tx, head.localId);
  return classifyVoidedBankRefundNote(tx, linkId);
}

/** What a busy link row (`NOWAIT`) turns into: the note waits for the next run. */
function deferredBusy(linkId: string): BankRefundVoidJobItem {
  logger.warn({ linkId }, "Deferred a voided bank-transfer refund note to the next run: its link row was busy (#4162)");
  return { linkId, paymentId: "", creditNoteId: "", creditNoteNumber: null, outcome: "deferred", detail: "Deferred: the link row was busy", amountCents: null };
}

/**
 * Handle ONE voided note under the locks, writing: a spare's marker, or a
 * matched note's undo. Exported for the realdb suite and the job below.
 */
export async function followUpVoidedBankRefundNote(linkId: string, now: Date = new Date()): Promise<BankRefundVoidJobItem | null> {
  try {
    return await prisma.$transaction(
      async (tx) => {
        const note = await lockAndClassify(tx, linkId);
        if (!note) return null;
        const c = note.classification;
        if (c.kind === "spare") {
          await writeBankRefundVoidMarker(tx, linkId, { outcome: "spare", at: now.toISOString() });
          return itemOf(note, "spare", describe(c, true));
        }
        if (c.kind !== "undo") return itemOf(note, plannedOutcome(c), describe(c, true));
        const done = await undoUnderLocks(tx, note, c, null, bankRefundVoidFollowUpOccurrenceKey(note.paymentId, note.link.xeroObjectId));
        if (!done.claimed) return itemOf(note, "handled", "Already handled (follow-up raised by another run)");
        return itemOf(note, "undone", describe(c, true), { followUpTaskId: done.followUpTaskId });
      },
      { timeout: 30_000 },
    );
  } catch (error) {
    if (isPostgresLockNotAvailable(error)) return deferredBusy(linkId);
    throw error;
  }
}

/** The words a refused pick shows (`resolvePickedUndo`). */
const PICK_REFUSALS: Record<PickRefusal, string> = {
  "not-unmatched": "This voided refund note no longer needs a refund picked here. The list has been refreshed.",
  "line-not-pickable": "That refund is not a live bank refund on this payment any more. The list has been refreshed: pick again.",
  "still-covered": "Another credit note in Xero still records some or all of that refund, so taking the whole refund back would undo what Xero still records. The list has been refreshed: pick again, or record the answer.",
  "too-large": "That refund is larger than what is left of the voided note's amount to pick, so the note did not record it. The list has been refreshed: pick again.",
  "detail-short": "The payment's records no longer hold that refund, so it cannot be taken back. The list has been refreshed.",
};

/**
 * #4162 (owner decision 18 Oct 2026, comment 6247741127): A PERSON PICKS THE
 * REFUND an unmatched voided note recorded, and the SAME undo runs - same
 * locks, same rows (`undoUnderLocks`), with the person as its actor. Under the
 * locks the note must still be unmatched and the line a live bank hand-back
 * line of THIS payment that no live note still covers, no larger than what is
 * left of the note's amount, and that the payment's detail still holds
 * (`resolvePickedUndo`). Each pick is claimed under the note-and-line key, so a
 * note that recorded several refunds takes one pick per refund (review, money
 * A); the pick that leaves nothing to pick - or the one pick a note of
 * unreadable amount allows - writes the "picked" marker on its link (`NOWAIT`,
 * last), which takes the note out of the nightly scan. Behind the writes
 * switch: report-only refuses it and writes nothing.
 */
export async function pickRefundForUnmatchedVoid(input: { linkId: string; lineId: string; actingMemberId: string }): Promise<{ followUpTaskId: string; paymentId: string; bookingId: string }> {
  if (!isXeroBankRefundVoidWritesEnabled()) throw new BankRefundVoidAnswerRefusal(BANK_REFUND_VOID_REPORT_ONLY_MESSAGE, 409);
  return prisma.$transaction(
    async (tx) => {
      const note = await lockAndClassify(tx, input.linkId);
      if (!note) throw new BankRefundVoidAnswerRefusal("Voided refund note not found.", 404);
      const picked = await resolvePickedUndo(tx, note, input.lineId);
      if ("refusal" in picked) throw new BankRefundVoidAnswerRefusal(PICK_REFUSALS[picked.refusal], 409);
      const key = bankRefundVoidPickOccurrenceKey(note.paymentId, note.link.xeroObjectId, picked.undo.line.id);
      const done = await undoUnderLocks(tx, note, picked.undo, input.actingMemberId, key);
      if (!done.claimed) throw new BankRefundVoidAnswerRefusal(PICK_REFUSALS["not-unmatched"], 409);
      if (picked.remainingCents === null || picked.remainingCents - picked.undo.amountCents <= 0) {
        await writeBankRefundVoidMarker(tx, input.linkId, { outcome: "picked", at: new Date().toISOString(), memberId: input.actingMemberId });
      }
      return { followUpTaskId: done.followUpTaskId, paymentId: note.paymentId, bookingId: note.bookingId! };
    },
    { timeout: 30_000 },
  );
}

/**
 * THE NIGHTLY JOB. Runs from the Xero cron runner after #4161's link cleanup.
 * `writes` defaults to the operator switch; report-only classifies with the
 * pooled client and writes nothing at all. Each note is classified unlocked
 * first (review, money 9): only a spare or an undo opens the locked
 * transaction, which classifies it again under the locks before writing.
 */
export async function runBankRefundVoidFollowUp(options?: { writes?: boolean; now?: Date }): Promise<BankRefundVoidJobResult> {
  const writes = options?.writes ?? isXeroBankRefundVoidWritesEnabled();
  const now = options?.now ?? new Date();
  const counts = Object.fromEntries(OUTCOMES.map((outcome) => [outcome, 0])) as Record<BankRefundVoidJobOutcome, number>;
  const items: BankRefundVoidJobItem[] = [];
  const deferredBefore = now.getTime() - BANK_REFUND_VOID_DEFERRAL_ALERT_DAYS * 24 * 60 * 60 * 1000;
  let deferredOverdue = 0;
  const reader = prisma as unknown as Prisma.TransactionClient;
  const linkIds = await readVoidedBankRefundNoteLinkIds(reader);
  for (const linkId of linkIds) {
    let item: BankRefundVoidJobItem | null;
    try {
      const note = await classifyVoidedBankRefundNote(reader, linkId);
      const kind = note?.classification.kind;
      if (writes && (kind === "spare" || kind === "undo")) {
        item = await followUpVoidedBankRefundNote(linkId, now);
      } else {
        item = note ? itemOf(note, plannedOutcome(note.classification), describe(note.classification, writes)) : null;
        if (note && kind === "deferred" && note.link.updatedAt.getTime() < deferredBefore) deferredOverdue += 1;
      }
    } catch (error) {
      logger.error({ err: error, linkId }, "Failed to follow up a voided bank-transfer refund note (#4162)");
      item = { linkId, paymentId: "", creditNoteId: "", creditNoteNumber: null, outcome: "failed", detail: error instanceof Error ? error.message : String(error), amountCents: null };
    }
    if (!item) continue;
    counts[item.outcome] += 1;
    if (item.outcome !== "handled" && item.outcome !== "not-in-scope") items.push(item);
  }
  const result: BankRefundVoidJobResult = { mode: writes ? "writes" : "report-only", scanned: linkIds.length, counts, deferredOverdue, items };
  logger.info({ mode: result.mode, scanned: result.scanned, counts, deferredOverdue }, "Voided bank-transfer refund notes followed up (#4162)");
  return result;
}

/** The cron task's failure line: any note that failed, else null. */
export function bankRefundVoidFollowUpFailureMessage(result: BankRefundVoidJobResult): string | null {
  return result.counts.failed > 0
    ? `${result.counts.failed} voided bank-transfer refund note(s) could not be followed up; see the logs (#4162)`
    : null;
}

/**
 * #4162: a person's answer to a voided note that has no bank refund to pick -
 * one that recorded card money (a card refund's record, whose note is re-raised
 * from the card refund pipeline, or #4312 a card refund itself,
 * `isCardMoneyVoidReason`), or a note with no live bank refund left on its
 * payment. It moves no money: under the same locks as the job, it
 * re-classifies the note, refuses unless that is still so, and writes the
 * "answered" marker - with who answered and their note - on its link (taken
 * `NOWAIT`). Behind the writes switch, as every writer here is.
 */
export async function markUnmatchedBankRefundVoidAnswered(input: {
  linkId: string;
  note: string;
  actingMemberId: string;
  now?: Date;
}): Promise<{ paymentId: string; bookingId: string }> {
  if (!isXeroBankRefundVoidWritesEnabled()) throw new BankRefundVoidAnswerRefusal(BANK_REFUND_VOID_REPORT_ONLY_MESSAGE, 409);
  const now = input.now ?? new Date();
  return prisma.$transaction(async (tx) => {
    const note = await lockAndClassify(tx, input.linkId);
    if (!note) throw new BankRefundVoidAnswerRefusal("Voided refund note not found.", 404);
    const c = note.classification;
    const nothingToPick =
      c.kind === "unmatched" &&
      note.bookingId !== null &&
      (isCardMoneyVoidReason(c.reason) || (await readPickableHandBackLines(tx, note.paymentId, note.bookingId, c.remainingCents)).length === 0);
    if (!nothingToPick || !note.bookingId || c.kind !== "unmatched") {
      throw new BankRefundVoidAnswerRefusal("This voided refund note no longer takes an answer here: pick the refund it recorded instead. The list has been refreshed.", 409);
    }
    const written = await writeBankRefundVoidMarker(tx, input.linkId, {
      outcome: "answered",
      at: now.toISOString(),
      memberId: input.actingMemberId,
      note: input.note,
    });
    if (!written) throw new BankRefundVoidAnswerRefusal("This voided refund note has already been answered.", 409);
    const booking = await tx.booking.findUniqueOrThrow({ where: { id: note.bookingId }, select: { memberId: true } });
    await createAuditLog(
      {
        action: "booking-payment.bank-refund.void-answered",
        memberId: input.actingMemberId,
        actorMemberId: input.actingMemberId,
        subjectMemberId: bookingOwner(booking).memberId,
        targetId: note.bookingId,
        entityType: "XeroObjectLink",
        entityId: input.linkId,
        category: "payment",
        severity: "important",
        outcome: "success",
        summary: `Voided refund credit note ${note.link.xeroObjectNumber ?? note.link.xeroObjectId} on booking ${formatBookingReference(note.bookingId)} answered by a person; nothing in the club's records moved`,
        details: input.note,
        metadata: { paymentId: note.paymentId, voidedCreditNoteId: note.link.xeroObjectId, reason: c.reason },
      },
      tx,
    );
    return { paymentId: note.paymentId, bookingId: note.bookingId };
  });
}

/** The Stuck States panel's rows, read with the pooled client, with each pickable refund's task date. */
export async function listBankRefundVoidsToAnswerRows() {
  const reader = prisma as unknown as Prisma.TransactionClient;
  const items = await listBankRefundVoidsForAPerson(reader);
  const taskIds = [...new Set(items.flatMap((item) => [...item.pickableLines, ...item.partlyCoveredLines].map((line) => line.taskId)))];
  const tasks = taskIds.length === 0 ? [] : await prisma.manualRefundTask.findMany({ where: { id: { in: taskIds } }, select: { id: true, completedAt: true } });
  const completedAt = new Map(tasks.map((task) => [task.id, task.completedAt?.toISOString() ?? null]));
  return items.map((item) => ({
    linkId: item.linkId,
    bookingId: item.bookingId,
    bookingReference: formatBookingReference(item.bookingId),
    creditNoteNumber: item.creditNoteNumber,
    amountCents: item.amountCents,
    remainingCents: item.remainingCents,
    foundVoidedAt: item.foundVoidedAt,
    reason: item.reason,
    pickableLines: item.pickableLines.map((line) => ({
      lineId: line.lineId,
      amountCents: line.amountCents,
      matchesNote: line.matchesNote,
      recordedAt: completedAt.get(line.taskId) ?? null,
    })),
    partlyCoveredLines: item.partlyCoveredLines.map((line) => ({
      lineId: line.lineId,
      amountCents: line.amountCents,
      coveredCents: line.coveredCents,
      recordedAt: completedAt.get(line.taskId) ?? null,
    })),
  }));
}

/** How many voided notes wait for a person: the Stuck States dashboard's count for a viewer without the list. */
export async function countBankRefundVoidsToAnswer(): Promise<number> {
  return (await listBankRefundVoidsForAPerson(prisma as unknown as Prisma.TransactionClient)).length;
}
