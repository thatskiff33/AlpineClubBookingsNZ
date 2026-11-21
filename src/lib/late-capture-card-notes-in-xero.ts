/**
 * A LATE CAPTURE'S CARD REFUND NOTES, AND WHERE EACH STANDS IN XERO. The rows
 * and links the unnoted-refund reader (`readUnnotedLateCaptureCardRefunds`)
 * sorts, read on any client so a writer's transaction can read them too.
 *
 * #4383 review: also the card notes raised before #4383 above what a capped
 * receipt recorded (`readLateCapturePreCapOverNoteCents`).
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { lateCaptureIntentOfCardRefundOperation } from "@/lib/late-capture-paid-another-way";
import { paymentRecoveryOperationIdOfPaidAnotherWay } from "@/lib/manual-refund-task-settlement-rules";
import { readLiveCardRefundReversalCentsByClose } from "@/lib/xero-resolved-in-xero-fences";
import {
  findLateCapturePaymentIntents,
  lateCaptureNotableRefundCents,
  readLateCaptureXeroReceipt,
} from "@/lib/late-capture-xero-receipt";
import {
  parsePaymentCreditNoteRetryInput,
  refundCreditNoteCreateAttempted,
} from "@/lib/xero-payment-credit-note-payload";
import { XERO_OUTBOX_REFUND_CREDIT_NOTE_TYPE } from "@/lib/xero-operation-outbox-payload";
import { xeroRefusedOperation } from "@/lib/xero-error-shape";

type CardNoteStore = Pick<Prisma.TransactionClient, "xeroSyncOperation" | "xeroObjectLink">;
type PreCapOverNoteStore = Pick<
  Prisma.TransactionClient,
  "manualRefundTask" | "paymentRecoveryOperation" | "paymentTransaction" | "xeroObjectLink" | "xeroSyncOperation"
>;

/**
 * #4383 review (money M1, `INV-PAY-128`): THE CARD NOTES RAISED BEFORE #4383
 * ABOVE WHAT A CAPPED RECEIPT RECORDED. Before #4383 a late capture's refund
 * note answered the whole refund, even where its receipt recorded only part of
 * the capture (`INV-PAY-139`). Since #4383 the eligible cash no longer counts
 * that part (`resolveRefundNoteEligibleCash`), so such a note would read as
 * coverage above cash: refunds that failed later, which a "Paid another way"
 * close reverses and the inbound recount takes off. It is not: it is an
 * over-note the officer corrects in Xero (`docs/MAINTENANCE.md`).
 *
 * Per late capture whose receipt the app recorded: its card notes in Xero
 * (`readLateCaptureCardNotesInXero`) less what a note may answer of them
 * (`lateCaptureNotableRefundCents`, the one spelling of the cap). Zero for an
 * uncapped receipt, and for every note sized since #4383, which never asks
 * above the cap. A capture with no recorded receipt is left out: its notes
 * were coverage above cash before #4383 too.
 *
 * #4383 delta review (money): coverage is net of live Stripe reversals, so an
 * over-note a reversal already undid is not taken off again. Only the part of
 * the live reversals answering this capture's refunds
 * (`readLateCaptureReversalCentsByIntent`) above its capped share undoes the
 * over-note. A close made before #4383 reversed the failed refund's whole
 * note, the part above the cap with it; one made since reverses only what the
 * receipt recorded (`failedLaterCardNoteCoverCents`), so the over-note still
 * stands for the officer to reverse by hand. Netting the whole reversal would
 * hide a later failed refund's cover after an older close, or read a newer
 * close's over-note as cover and have Xero corrected twice.
 */
export async function readLateCapturePreCapOverNoteCents(paymentId: string, db: PreCapOverNoteStore = prisma): Promise<number> {
  const intents = await readCardNotedPaymentIntentIds(paymentId, db);
  if (intents.length === 0) return 0;
  let overNoteCents = 0;
  let reversedByIntent: Map<string, number> | null = null;
  for (const intent of await findLateCapturePaymentIntents(intents, db)) {
    const receipt = await readLateCaptureXeroReceipt(intent, db);
    if (receipt.kind !== "recorded") continue;
    const { inXeroCents } = await readLateCaptureCardNotesInXero(paymentId, intent, db);
    const grossOverNoteCents = inXeroCents - lateCaptureNotableRefundCents(receipt, inXeroCents);
    if (grossOverNoteCents <= 0) continue;
    reversedByIntent ??= await readLateCaptureReversalCentsByIntent(paymentId, db);
    const cappedShareCents = inXeroCents - grossOverNoteCents;
    const undoneCents = Math.max(0, (reversedByIntent.get(intent) ?? 0) - cappedShareCents);
    overNoteCents += grossOverNoteCents - Math.min(grossOverNoteCents, undoneCents);
  }
  return overNoteCents;
}

/**
 * #4383 delta review (money): the payment's live Stripe reversals by the late
 * capture whose refund each answered. A reversal's close names the card refund
 * row it closed (`paymentRecoveryOperationIdOfPaidAnotherWay`), and that row
 * its late capture as a close's Xero plan reads it
 * (`lateCaptureIntentOfCardRefundOperation`). A reversal answering no late
 * capture's refund is left out.
 */
async function readLateCaptureReversalCentsByIntent(paymentId: string, db: PreCapOverNoteStore): Promise<Map<string, number>> {
  const byIntent = new Map<string, number>();
  for (const [closeTaskId, cents] of await readLiveCardRefundReversalCentsByClose(paymentId, db)) {
    const close = await db.manualRefundTask.findUnique({ where: { id: closeTaskId }, select: { kind: true, occurrenceKey: true } });
    const operationId = close ? paymentRecoveryOperationIdOfPaidAnotherWay(close) : null;
    if (!operationId) continue;
    const closed = await db.paymentRecoveryOperation.findUnique({
      where: { id: operationId },
      select: { idempotencyKey: true, paymentIntentId: true },
    });
    const intent = closed ? await lateCaptureIntentOfCardRefundOperation(closed, db) : null;
    if (intent !== null) byIntent.set(intent, (byIntent.get(intent) ?? 0) + cents);
  }
  return byIntent;
}

/** The capture intents the payment's card refund notes name, by link or by row. */
async function readCardNotedPaymentIntentIds(paymentId: string, db: CardNoteStore): Promise<string[]> {
  const links = await db.xeroObjectLink.findMany({
    where: { localModel: "Payment", localId: paymentId, xeroObjectType: "CREDIT_NOTE", role: "REFUND_CREDIT_NOTE", active: true },
    select: { metadata: true },
  });
  const rows = await db.xeroSyncOperation.findMany({
    where: lateCaptureCardNoteRowsWhere(paymentId, true),
    select: { requestPayload: true },
  });
  const intents = new Set<string>();
  const add = (value: unknown) => {
    const intent = (value as { paymentIntentId?: unknown } | null)?.paymentIntentId;
    if (typeof intent === "string" && intent.length > 0) intents.add(intent);
  };
  for (const link of links ?? []) add(link.metadata);
  for (const row of rows ?? []) add(row.requestPayload);
  return [...intents];
}

function lateCaptureCardNoteRowsWhere(paymentId: string, withRetries: boolean): Prisma.XeroSyncOperationWhereInput {
  return {
    direction: "OUTBOUND",
    entityType: "CREDIT_NOTE",
    operationType: "CREATE",
    localModel: "Payment",
    localId: paymentId,
    ...(withRetries
      ? { OR: [{ queueType: XERO_OUTBOX_REFUND_CREDIT_NOTE_TYPE }, { queueType: null }] }
      : { queueType: XERO_OUTBOX_REFUND_CREDIT_NOTE_TYPE }),
    status: { not: "CANCELLED" },
  };
}

/**
 * Rounds 14 and 15: the capture's card notes in Xero (`inXeroCents`) - once
 * per credit note id, its link's amount first, plus any row resolved by hand
 * in Xero that names no credit note - and those sent with the outcome
 * unknown (`sentCents`).
 */
export async function readLateCaptureCardNotesInXero(paymentId: string, paymentIntentId: string, db: CardNoteStore = prisma) {
  const inXeroByNote = await readLateCaptureCardNoteLinkCents(paymentId, paymentIntentId, db);
  let resolvedByHandCents = 0;
  let sentCents = 0;
  for (const note of await readLateCaptureCardNotes(paymentId, paymentIntentId, { withRetries: true }, db)) {
    const standing = classifyLateCaptureCardNote(note);
    const cents = parsePaymentCreditNoteRetryInput(note)?.amountCents ?? 0;
    if (standing === "sent-outcome-unknown") sentCents += cents;
    else if (standing !== "in-xero") continue;
    else if (!note.xeroObjectId) resolvedByHandCents += cents;
    else if (!inXeroByNote.has(note.xeroObjectId)) inXeroByNote.set(note.xeroObjectId, cents);
  }
  return { inXeroCents: [...inXeroByNote.values()].reduce((sum, cents) => sum + cents, resolvedByHandCents), sentCents };
}

/** Round 14: where one card note of a late capture stands in Xero (see above). */
export function classifyLateCaptureCardNote(note: {
  status: string;
  lastErrorCode: string | null;
  xeroObjectId: string | null;
  manuallyResolvedAt: Date | null;
  requestPayload: unknown;
}): "in-xero" | "sent-outcome-unknown" | "never-sent" {
  if (note.xeroObjectId || note.manuallyResolvedAt) return "in-xero";
  if (!refundCreditNoteCreateAttempted(note.requestPayload)) return "never-sent";
  // Round 15: a call Xero refused (a 4xx) created no credit note.
  return xeroRefusedOperation(note) ? "never-sent" : "sent-outcome-unknown";
}

/**
 * The refund-note rows naming ONE late capture, in any state but withdrawn:
 * the queued ones, and (round 15, `withRetries`) the rows an officer's retry
 * wrote with no queue type - never a paid-another-way close's
 * (`paidAnotherWayTaskId`).
 */
export async function readLateCaptureCardNotes(
  paymentId: string,
  paymentIntentId: string,
  { withRetries = false }: { withRetries?: boolean } = {},
  db: CardNoteStore = prisma,
) {
  const notes = await db.xeroSyncOperation.findMany({
    where: {
      ...lateCaptureCardNoteRowsWhere(paymentId, withRetries),
      requestPayload: { path: ["paymentIntentId"], equals: paymentIntentId },
    },
    select: { status: true, lastErrorCode: true, xeroObjectId: true, requestPayload: true, manuallyResolvedAt: true, correlationKey: true },
  });
  return (notes ?? []).filter((note) => !parsePaymentCreditNoteRetryInput(note)?.paidAnotherWayTaskId);
}

/**
 * Round 15: the capture's card notes in Xero by their active
 * `REFUND_CREDIT_NOTE` links naming its `paymentIntentId`, each credit note's
 * amount as its link records it (`amountCents`).
 */
async function readLateCaptureCardNoteLinkCents(paymentId: string, paymentIntentId: string, db: CardNoteStore) {
  const links = await db.xeroObjectLink.findMany({
    where: {
      localModel: "Payment",
      localId: paymentId,
      xeroObjectType: "CREDIT_NOTE",
      role: "REFUND_CREDIT_NOTE",
      active: true,
      metadata: { path: ["paymentIntentId"], equals: paymentIntentId },
    },
    select: { xeroObjectId: true, metadata: true },
  });
  const cents = new Map<string, number>();
  for (const link of links ?? []) {
    const amount = (link.metadata as { amountCents?: unknown } | null)?.amountCents;
    if (typeof amount === "number" && Number.isFinite(amount)) cents.set(link.xeroObjectId, Math.max(0, amount));
  }
  return cents;
}
