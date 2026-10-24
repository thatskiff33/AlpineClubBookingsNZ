// The token store, not the `@/lib/xero` facade: this module sits in the
// payment-recovery cron's import graph, and the facade drags the whole Xero SDK
// into every route that imports that cron.
import { isXeroConnected } from "@/lib/xero-token-store";
import {
  enqueueXeroRefundCreditNoteOperation,
  kickQueuedXeroOutboxOperationsIfConnected,
} from "@/lib/xero-operation-outbox";
import { hasXeroReceiptForLateCapture, readLateCaptureXeroReceipt } from "@/lib/late-capture-xero-receipt";
import { logAudit } from "@/lib/audit";
import logger from "@/lib/logger";
import { ADDITIONAL_ASK_INTENT_TYPE } from "@/lib/ordinary-ask-request";
import { lateCaptureRefundPaymentIntentId } from "@/lib/payment-recovery-keys";
import { prisma } from "@/lib/prisma";
import { isRecordedRefundStatus } from "@/lib/payment-transaction-status";
import {
  parsePaymentCreditNoteRetryInput,
  refundCreditNoteCreateAttempted,
} from "@/lib/xero-payment-credit-note-payload";
import { XERO_OUTBOX_REFUND_CREDIT_NOTE_TYPE } from "@/lib/xero-operation-outbox-payload";
import { xeroRefusedOperation } from "@/lib/xero-error-shape";
import { xeroDocumentDateFromInstant } from "@/lib/xero-provider-dates";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";
import type { Prisma } from "@prisma/client";
import type { ClubTimeZone } from "@/lib/club-time";
import { findLateCaptureRefundPaidAnotherWay } from "@/lib/late-capture-paid-another-way";
import { paidAnotherWayCloseXeroNote } from "@/lib/manual-refund-task-settlement-rules";
import { paidAnotherWayCloseNoteRowsWhere } from "@/lib/card-refund-paid-another-way-cash";
import { cardRefundIdOfNoteRow, cardRefundNoteCutoverSeconds, madeSinceCardRefundNoteCutover, planLateCaptureCardNotes } from "@/lib/card-refund-own-note-share";

/**
 * #1350 / #3639 / #3635: the Xero correction that follows a refund of a late
 * capture on a cancelled booking, whoever issued the refund - the webhook
 * automatically, the treasurer's approval, the recovery cron replaying that
 * approval, a dashboard refund's `charge.refunded`, or the kept invoice's
 * credit-back once its receipt is in Xero.
 *
 * ONE SIZING, PER CAPTURE (round-3 R4): the capture's own succeeded refunds
 * (`PaymentRefund.stripePaymentIntentId`) less the refund notes already raised
 * for THIS capture (`sumLateCaptureNotedCents`, read from the `paymentIntentId`
 * each such note records). So a replay, a re-keep or a PARTIAL retry of the
 * receipt asks for nothing already noted, whatever else on the payment is
 * uncovered. The enqueue then caps it against the payment as a whole.
 *
 * Only when there is something to correct: THIS capture has a Xero receipt the
 * app recorded (`hasXeroReceiptForLateCapture`, review F2) - its kept-capture
 * invoice, or its change's released supplementary invoice. Never read from
 * `payment.xeroInvoiceId`: for a late capture that is the pre-cancel invoice the
 * cancel already cleared. Dated the day the latest refund left Stripe (R3), so
 * a refund credited back later lands in the period the payout does.
 *
 * NEVER THROWS. The money has already gone back to the member when this runs,
 * and a Xero outage must not undo or replay that. It says what it did (#3635
 * N4) so a caller reporting to an operator claims no note it did not queue:
 * `queued`, `nothing-owed` (no receipt, or every refunded cent already noted),
 * or `failed` (logged; the note must be raised by hand).
 *
 * #4312 (`INV-ADDPAY-047`): ON A BANK-TRANSFER PAYMENT the same ask is split
 * (`planLateCaptureCardNotes`): each refund made since the cutover gets its
 * own note, keyed on it (`cardRefundId`) and naming the capture, so the
 * single-note branch never folds it; older refunds keep the one note for the
 * capture they always had.
 */
export type LateCaptureNoteResult = "queued" | "nothing-owed" | "failed";

export async function noteLateCaptureRefunds(params: {
  paymentId: string;
  paymentIntentId: string;
}): Promise<LateCaptureNoteResult> {
  const { paymentId, paymentIntentId } = params;
  try {
    if (!(await hasXeroReceiptForLateCapture(paymentIntentId))) return "nothing-owed";
    const counted = await readLateCaptureCardRefunds(paymentId, paymentIntentId);
    const refundedCents = counted.reduce((sum, refund) => sum + Math.max(0, refund.amountCents), 0);
    const askCents = refundedCents - (await sumLateCaptureNotedCents(paymentId, paymentIntentId));
    if (askCents <= 0) return "nothing-owed";
    const clubZone = await readClubTimeZoneOutsideRequest();
    const dayOf = (refunds: typeof counted) =>
      xeroDocumentDateFromInstant(refunds.map((refund) => refund.stripeCreatedAt ?? refund.createdAt).reduce((max, at) => (at > max ? at : max)), clubZone);
    const plan = await planLateCaptureAsk(paymentId, paymentIntentId, counted);
    const asks = [
      ...plan.own.map((ask) => ({ cents: ask.askCents, refunds: counted.filter((refund) => refund.stripeRefundId === ask.stripeRefundId), cardRefundId: ask.stripeRefundId })),
      ...(plan.legacyAskCents > 0 ? [{ cents: plan.legacyAskCents, refunds: plan.legacy, cardRefundId: undefined }] : []),
    ];
    let queuedAny = false;
    let refused = false;
    for (const ask of asks) {
      const queued = await enqueueXeroRefundCreditNoteOperation(paymentId, ask.cents, {
        refundMethod: "card",
        paymentIntentId,
        documentDate: dayOf(ask.refunds),
        ...(ask.cardRefundId ? { cardRefundId: ask.cardRefundId } : {}),
      });
      if (queued.queueOperationId) queuedAny = true;
      // A refusal over an unreadable hand-resolved note is logged by the
      // enqueue and wants the note raised by hand; anything else is covered.
      else if ("resolvedInXeroOperationId" in queued && queued.resolvedInXeroOperationId) refused = true;
    }
    if (!queuedAny) return refused ? "failed" : "nothing-owed";
    if (await isXeroConnected()) {
      await kickQueuedXeroOutboxOperationsIfConnected({ limit: 1 });
    }
    return "queued";
  } catch (err) {
    logger.error(
      { err, paymentId, paymentIntentId },
      "Failed to queue the corrective Xero refund credit note for a late capture on a cancelled booking",
    );
    return "failed";
  }
}

/** The capture's own succeeded refunds (`PaymentRefund.stripePaymentIntentId`), the one sizing above. */
async function readLateCaptureCardRefunds(paymentId: string, paymentIntentId: string) {
  const refunds = await prisma.paymentRefund.findMany({
    where: { paymentId, stripePaymentIntentId: paymentIntentId },
    select: { stripeRefundId: true, amountCents: true, status: true, stripeCreatedAt: true, createdAt: true },
    orderBy: [{ createdAt: "asc" }, { stripeRefundId: "asc" }],
  });
  return refunds.filter((refund) => isRecordedRefundStatus(refund.status));
}

/**
 * #4312: the capture's ask split on a bank transfer (`planLateCaptureCardNotes`):
 * the refunds made since the cutover, each with what the notes naming it
 * already ask, and the older ones. On any other payment, or before the
 * cutover, everything is older - one note for the capture, as before.
 */
async function planLateCaptureAsk(paymentId: string, paymentIntentId: string, counted: Awaited<ReturnType<typeof readLateCaptureCardRefunds>>) {
  const payment = await prisma.payment.findUnique({ where: { id: paymentId }, select: { source: true } });
  const cutoverSeconds = payment?.source === "INTERNET_BANKING" ? await cardRefundNoteCutoverSeconds(prisma) : Number.POSITIVE_INFINITY;
  const own = counted.filter((refund) => madeSinceCardRefundNoteCutover(refund, cutoverSeconds));
  const legacy = counted.filter((refund) => !own.includes(refund));
  const askedByRefund = new Map<string, number>();
  let legacyNotedCents = 0;
  for (const note of await readLateCaptureCardNotes(paymentId, paymentIntentId)) {
    if (note.status === "SUCCEEDED" && classifyLateCaptureCardNote(note) !== "in-xero") continue;
    const recorded = parsePaymentCreditNoteRetryInput(note);
    const cents = recorded?.amountCents ?? 0;
    const refundId = cardRefundIdOfNoteRow(note);
    if (refundId && own.some((refund) => refund.stripeRefundId === refundId)) askedByRefund.set(refundId, (askedByRefund.get(refundId) ?? 0) + cents);
    else legacyNotedCents += cents;
  }
  const plan = planLateCaptureCardNotes({
    own: own.map((refund) => ({ stripeRefundId: refund.stripeRefundId, amountCents: refund.amountCents, ownNotedCents: askedByRefund.get(refund.stripeRefundId) ?? 0 })),
    legacyRefundedCents: legacy.reduce((sum, refund) => sum + Math.max(0, refund.amountCents), 0),
    legacyNotedCents,
  });
  return { ...plan, legacy };
}

/**
 * #3924 round 12 (`INV-PAY-122`): THE CAPTURE'S CARD REFUNDS NO NOTE ANSWERS -
 * its own refunds less the refund notes naming it. Never
 * `PaymentTransaction.refundedAmountCents`, which also carries a close's bank
 * cash and any other hand-back allocated to the capture's row. A close's own
 * note names no `paymentIntentId`, so it is never taken off here. What an
 * officer records by hand in Xero once the app raises no card note for the
 * capture: the linked change invoice's 409 and the repair tool's
 * record-by-hand findings.
 *
 * Round 14: each note row stands one of three ways
 * (`classifyLateCaptureCardNote`). IN XERO - its credit note's id recorded, or
 * resolved by hand in Xero - is taken off. NEVER SENT - its payload still the
 * queued shape, or refused by Xero (round 15, `xeroRefusedOperation`) - is
 * not in Xero, so its cents are recorded by hand. SENT, OUTCOME UNKNOWN - the
 * executed payload (`refundCreditNoteCreateAttempted`), no id, and no refusal
 * - may be in Xero: never in `byHandCents`, but named apart
 * (`mayBeInXeroCents`) for the officer to check Xero for that credit note
 * before recording it.
 *
 * Round 15: an officer's retry of a FAILED note runs the note again on a NEW
 * row with no queue type (the retry's `createXeroCreditNote`), which still
 * carries the capture's `paymentIntentId`. So a note is in Xero by its active
 * `REFUND_CREDIT_NOTE` link naming that `paymentIntentId` (the link the note
 * writer records the moment Xero returns it), and the rows sorted are the
 * queued ones and those retries (never a close's, `paidAnotherWayTaskId`):
 * a retry that landed counts once, by its credit note's id, and the row it
 * retried, never sent, adds nothing.
 *
 * While the card verdict (`readLateCaptureXeroReceipt`) still names an
 * invoice in Xero, or (round 15) another receipt row is on its way to Xero, a
 * queued or failed note can still land against it (`notesCanStillLand`):
 * nothing is recorded by hand or named as maybe in Xero, and what the note
 * writer has not asked for yet (`notedLaterCents`, sized as it sizes its own
 * ask, `sumLateCaptureNotedCents`) is asked for the next time it notes this
 * capture.
 */
export interface UnnotedLateCaptureCardRefunds {
  byHandCents: number;
  mayBeInXeroCents: number;
  notesCanStillLand: boolean;
  notedLaterCents: number;
}

export async function readUnnotedLateCaptureCardRefunds(
  paymentId: string,
  paymentIntentId: string,
): Promise<UnnotedLateCaptureCardRefunds> {
  const refunds = await readLateCaptureCardRefunds(paymentId, paymentIntentId);
  const refundedCents = refunds.reduce((sum, refund) => sum + Math.max(0, refund.amountCents), 0);
  const receipt = await readLateCaptureXeroReceipt(paymentIntentId);
  const notesCanStillLand = receipt.kind === "recorded" && (receipt.invoiceId !== null || !receipt.invoiceFailed);
  const none = { byHandCents: 0, mayBeInXeroCents: 0, notesCanStillLand, notedLaterCents: 0 };
  if (refundedCents === 0) return none;
  if (notesCanStillLand) {
    const askedCents = await sumLateCaptureNotedCents(paymentId, paymentIntentId);
    return { ...none, notedLaterCents: Math.max(0, refundedCents - askedCents) };
  }
  // In Xero: once per credit note id, its link's amount first; plus any row
  // resolved by hand in Xero that names no credit note.
  const inXeroByNote = await readLateCaptureCardNoteLinkCents(paymentId, paymentIntentId);
  let resolvedByHandCents = 0;
  let sentCents = 0;
  for (const note of await readLateCaptureCardNotes(paymentId, paymentIntentId, { withRetries: true })) {
    const standing = classifyLateCaptureCardNote(note);
    const cents = parsePaymentCreditNoteRetryInput(note)?.amountCents ?? 0;
    if (standing === "sent-outcome-unknown") sentCents += cents;
    else if (standing !== "in-xero") continue;
    else if (!note.xeroObjectId) resolvedByHandCents += cents;
    else if (!inXeroByNote.has(note.xeroObjectId)) inXeroByNote.set(note.xeroObjectId, cents);
  }
  const inXeroCents = [...inXeroByNote.values()].reduce((sum, cents) => sum + cents, resolvedByHandCents);
  const unnotedCents = Math.max(0, refundedCents - inXeroCents);
  const mayBeInXeroCents = Math.min(unnotedCents, sentCents);
  return { ...none, byHandCents: unnotedCents - mayBeInXeroCents, mayBeInXeroCents };
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
 * The refund cents already noted for ONE late capture (round-3 R4), as the
 * note writer sizes its own ask: every refund-note create on the payment that
 * records this `paymentIntentId`, at the amount it recorded
 * (`parsePaymentCreditNoteRetryInput`, both payload shapes), in any state but
 * withdrawn: a queued or failed one is not asked for again, and one resolved
 * by hand in Xero covers its amount. A row that completed without raising a
 * note (nothing uncovered, or skipped) covers nothing.
 */
export async function sumLateCaptureNotedCents(paymentId: string, paymentIntentId: string): Promise<number> {
  let notedCents = 0;
  for (const note of await readLateCaptureCardNotes(paymentId, paymentIntentId)) {
    if (note.status === "SUCCEEDED" && classifyLateCaptureCardNote(note) !== "in-xero") continue;
    notedCents += parsePaymentCreditNoteRetryInput(note)?.amountCents ?? 0;
  }
  return notedCents;
}

/**
 * The refund-note rows naming ONE late capture, in any state but withdrawn:
 * the queued ones, and (round 15, `withRetries`) the rows an officer's retry
 * wrote with no queue type - never a paid-another-way close's
 * (`paidAnotherWayTaskId`).
 */
async function readLateCaptureCardNotes(
  paymentId: string,
  paymentIntentId: string,
  { withRetries = false }: { withRetries?: boolean } = {},
) {
  const notes = await prisma.xeroSyncOperation.findMany({
    where: {
      direction: "OUTBOUND",
      entityType: "CREDIT_NOTE",
      operationType: "CREATE",
      localModel: "Payment",
      localId: paymentId,
      ...(withRetries
        ? { OR: [{ queueType: XERO_OUTBOX_REFUND_CREDIT_NOTE_TYPE }, { queueType: null }] }
        : { queueType: XERO_OUTBOX_REFUND_CREDIT_NOTE_TYPE }),
      status: { not: "CANCELLED" },
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
async function readLateCaptureCardNoteLinkCents(paymentId: string, paymentIntentId: string) {
  const links = await prisma.xeroObjectLink.findMany({
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

/** The approval's and the webhook's name for the one sizing above. */
export async function queueLateCaptureRefundCreditNote(params: {
  paymentId: string;
  paymentIntentId: string;
}): Promise<void> {
  await noteLateCaptureRefunds(params);
}

/**
 * The `kind` a `booking.payment.refunded_after_cancellation` entry names:
 * every writer of that entry reads it here (#4149), so the rows are told apart
 * by the row itself, whichever door refunded.
 */
export function lateCaptureAuditKind(captureKind: "primary" | "modification" | null): string | null {
  if (captureKind === null) return null;
  return captureKind === "primary" ? "primary" : ADDITIONAL_ASK_INTENT_TYPE;
}

/**
 * #3639: the record and the Xero correction of a treasurer-approved late-capture
 * refund, written wherever that refund actually went out - inline after the
 * approval, or by the recovery cron replaying it (review F4). The audit entry is
 * the one the automatic refund writes, naming who approved it.
 */
export async function finishApprovedLateCaptureRefund(refund: {
  bookingId: string;
  paymentId: string;
  paymentIntentId: string;
  amountCents: number;
  refundId: string | null;
  captureKind: "primary" | "modification" | null;
  approvedByMemberId: string | null;
  manualRefundTaskId: string | null;
}): Promise<void> {
  logAudit({
    action: "booking.payment.refunded_after_cancellation",
    category: "payment",
    memberId: refund.approvedByMemberId ?? undefined,
    entityType: "Booking",
    entityId: refund.bookingId,
    targetId: refund.bookingId,
    details: JSON.stringify({
      paymentIntentId: refund.paymentIntentId,
      refundId: refund.refundId,
      amountCents: refund.amountCents,
      kind: lateCaptureAuditKind(refund.captureKind),
      approvedByMemberId: refund.approvedByMemberId,
      manualRefundTaskId: refund.manualRefundTaskId,
    }),
  });
  await queueLateCaptureRefundCreditNote({
    paymentId: refund.paymentId,
    paymentIntentId: refund.paymentIntentId,
  });
}

/**
 * #3635 (orchestrator decision 29 Sep 2026): a kept capture's refunds, whenever
 * they were taken, are answered by the ordinary refund credit note against its
 * receipt. Called once the receipt exists - by the kept-capture invoice's
 * worker after it sends, and by the keep of a change payment after its invoice
 * is released - so a dashboard refund taken before the keep (which found no
 * receipt then, `stripeRefundNeedsXeroNoteNow`) or an approval that landed
 * while the invoice was sending is credited back. Sized per capture and dated
 * the refund's day (`noteLateCaptureRefunds`), so a refund already noted is
 * never noted twice. Never throws.
 */
export async function creditBackLateCaptureRefunds(paymentIntentId: string): Promise<void> {
  try {
    const capture = await prisma.paymentTransaction.findFirst({
      where: { source: "STRIPE", stripePaymentIntentId: paymentIntentId },
      select: { paymentId: true },
    });
    if (!capture) return;
    await noteLateCaptureRefunds({ paymentId: capture.paymentId, paymentIntentId });
  } catch (err) {
    logger.error(
      { err, paymentIntentId },
      "Failed to queue the Xero refund credit note for a kept late capture's refunds",
    );
  }
}

/**
 * The recovery cron's replay of a treasurer-approved refund the inline attempt
 * did not finish. The operation's own `paymentIntentId` is the payment's
 * representative intent, so the late capture's is read back off its prefix, and
 * the approving officer off the task that owns it. The refund is the one the
 * replay read back for the plan's first slice (#4126), as the inline path names
 * its own.
 */
export async function finishApprovedLateCaptureRefundAfterReplay(operation: {
  bookingId: string;
  paymentId: string;
  stripeKeyPrefix: string | null;
  amountCents: number;
  refundId: string | null;
}): Promise<void> {
  const paymentIntentId = lateCaptureRefundPaymentIntentId(
    operation.stripeKeyPrefix ?? "",
    operation.bookingId,
  );
  const task = await prisma.manualRefundTask.findUnique({
    where: { lateCaptureApprovalIntentId: paymentIntentId },
    select: { id: true, completedByMemberId: true },
  });
  await finishApprovedLateCaptureRefund({
    bookingId: operation.bookingId,
    paymentId: operation.paymentId,
    paymentIntentId,
    amountCents: operation.amountCents,
    refundId: operation.refundId,
    captureKind: null,
    approvedByMemberId: task?.completedByMemberId ?? null,
    manualRefundTaskId: task?.id ?? null,
  });
}

/**
 * #3924 round 6 (owner, 8 Oct 2026: "Record receipt, then credit";
 * `INV-PAY-122`): THE SECOND STEP for a late capture whose approved refund
 * Stripe gave up on and the treasurer closed as paid another way. The close
 * queued the capture's receipt; this queues the close's bank-transfer refund
 * note against it (`INV-PAY-101`), for exactly the amount paid back, keyed on
 * the close's record (`paidAnotherWayTaskId`), dated the day it closed, and
 * naming the receipt's invoice (`creditsInvoiceId`, round 7, money M5) - never
 * its `paymentIntentId`, which would count it as the capture's card note.
 *
 * Run ONLY once the receipt is in Xero, under the approval task's row lock
 * (`queueWaitingPaidAnotherWayNote`): by the receipt's worker once its link is
 * written, or (round 8) by a change's supplementary invoice for the capture
 * once it is sent. Until then the close's bank cash is outside what any refund
 * note may answer (`readPaidAnotherWayCash`), so the note cannot be sized
 * earlier by anyone.
 *
 * Only a close whose key says its note waits for the receipt
 * (`after-receipt`): one that queued its note itself, or raises none, is left
 * alone. AT MOST ONCE (round 7, C9): the worker runs this on every run of the
 * receipt's row, so a note row already asked for this record - in any state
 * but withdrawn; a failed one is retried as its own row - is returned, never a
 * second. Returns the queued row's id, or null when none is. Throws: the
 * worker then fails its row with the link standing, and the row's retry runs
 * this again.
 */
export async function notePaidAnotherWayCloseOnReceipt(params: {
  paymentIntentId: string;
  /** The receipt's Xero invoice, which the note credits. */
  receiptInvoiceId: string;
  clubZone: ClubTimeZone;
  store: Prisma.TransactionClient;
}): Promise<string | null> {
  const close = await findLateCaptureRefundPaidAnotherWay(params.paymentIntentId, params.store);
  if (!close || paidAnotherWayCloseXeroNote(close) !== "after-receipt" || close.paymentId === null) return null;
  const amountCents = Math.max(0, close.amountCents ?? 0);
  if (amountCents === 0) return null;
  // Round 8 (`INV-SSOT`): the close's rows, found the one way they are.
  const asked = await params.store.xeroSyncOperation.findFirst({
    where: { ...paidAnotherWayCloseNoteRowsWhere(close.paymentId, close.id), status: { not: "CANCELLED" } },
    select: { id: true },
  });
  if (asked) return asked.id;
  const queued = await enqueueXeroRefundCreditNoteOperation(close.paymentId, amountCents, {
    refundMethod: "internet-banking",
    paidAnotherWayTaskId: close.id,
    creditsInvoiceId: params.receiptInvoiceId,
    ...(close.completedAt
      ? { documentDate: xeroDocumentDateFromInstant(close.completedAt, params.clubZone) }
      : {}),
    ...(close.completedByMemberId ? { createdByMemberId: close.completedByMemberId } : {}),
    store: params.store,
  });
  return queued.queueOperationId;
}
