import type { ManualRefundTaskKind, Prisma } from "@prisma/client";
import { z } from "zod";

import {
  BANK_REFUND_VOID_ANSWER_NOT_ASKED_MESSAGE,
  BANK_REFUND_VOID_ANSWER_REQUIRED_MESSAGE,
  bankRefundVoidCompletionMessage,
  HAND_MADE_CREDIT_NOTE_NUMBER_MAX,
  readBankRefundVoidFollowUpContext,
  type BankRefundVoidAnswer,
} from "@/lib/bank-refund-void-follow-up-copy";
import { bookingOwner } from "@/lib/booking-owner";
import { formatCents } from "@/lib/utils";
import type { ClubFormat } from "@/lib/club-format";
import { isBankRefundVoidFollowUpTask } from "@/lib/bank-refund-void-follow-up-key";
import { providerAmountToCents } from "@/lib/money-provider-amount";
import { ManualBookingPaymentError } from "@/lib/payment-reconciliation";
import { prisma } from "@/lib/prisma";
import { callXeroApi, getAuthenticatedXeroClient, XeroDailyLimitError } from "@/lib/xero-api-client";
import { getXeroErrorStatusCode } from "@/lib/xero-error-shape";
import { notifyXeroSyncError } from "@/lib/xero-error-alert";
import { reconcileXeroCreditNote } from "@/lib/xero-inbound/credit-note";
import { isRefundCreditNoteLinkCancelledInXero } from "@/lib/xero-refund-note-status";
import { upsertXeroObjectLink } from "@/lib/xero-sync";
import { enqueueXeroRefundCreditNoteOperation } from "@/lib/xero-operation-outbox";
import logger from "@/lib/logger";

/**
 * #4162 (owner decision 17 Oct 2026, `INV-ADDPAY-042`): THE "YES, I ALREADY
 * RECORDED IT IN XERO MYSELF" ANSWER to a bank refund to re-confirm.
 *
 * The treasurer types the number of the credit note they made in Xero by hand.
 * Before anything is written, the app reads that note from Xero - OUTSIDE any
 * transaction, so no lock is held across the provider call - and checks it is
 * a sales credit note, AUTHORISED or PAID, for exactly the follow-up's amount,
 * for the payment's contact and allocated to no other invoice, and that no
 * other record here tracks it. A mismatch is refused with a plain-English
 * reason and nothing moves. After the commit it is read once more
 * (`reconcileHandMadeNoteAfterCompletion`), so a void in between is caught.
 *
 * On success the completion (`resolveManualRefundTask`, under its locks) puts
 * the money back on the payment as an ordinary hand-back completion does and
 * records the note as a tracked refund-note link for the follow-up
 * (`recordHandMadeRefundNoteLink`), stamped per refund so it stands beside the
 * payment's other notes, and naming the follow-up (`handBackTaskId`). A later
 * void of it in Xero is then caught like any other: the inbound sync marks the
 * link voided and the nightly follow-up undoes it again.
 */

/** A hand-made note as Xero reported it, checked. Carried into the completion's transaction. */
export interface VerifiedHandMadeRefundNote {
  creditNoteId: string;
  creditNoteNumber: string;
  amountCents: number;
  status: string;
  total: number;
}

/**
 * The answer as the completion route receives it: raise a fresh credit note,
 * or the number of the note the treasurer already made in Xero (checked
 * against Xero before anything is written, `prepareBankRefundVoidAnswer`).
 */
export const bankRefundVoidAnswerBodySchema = z.discriminatedUnion("answer", [
  z.object({ answer: z.literal("fresh-note") }).strict(),
  z.object({ answer: z.literal("recorded-in-xero"), creditNoteNumber: z.string().trim().min(1).max(HAND_MADE_CREDIT_NOTE_NUMBER_MAX) }).strict(),
]);

/** What the treasurer is told once the completion took the answer. */
export function bankRefundVoidAnswerMessage(answer: ResolvedBankRefundVoidAnswer): string {
  return bankRefundVoidCompletionMessage(answer.answer, answer.answer === "recorded-in-xero" ? answer.note.creditNoteNumber : null);
}

/** The completion's answer to a follow-up, once a hand-made note has been checked. */
export type ResolvedBankRefundVoidAnswer =
  | { answer: Extract<BankRefundVoidAnswer, "fresh-note"> }
  | { answer: Extract<BankRefundVoidAnswer, "recorded-in-xero">; note: VerifiedHandMadeRefundNote };

/** A credit-note number this answer will search Xero for: no quotes or backslashes in Xero's filter. */
function normaliseCreditNoteNumber(raw: string): string {
  const number = raw.trim();
  if (number.length === 0 || number.length > HAND_MADE_CREDIT_NOTE_NUMBER_MAX || /["\\]/.test(number)) {
    throw new ManualBookingPaymentError("Type the credit note's number as Xero shows it, for example CN-0123.", 400);
  }
  return number;
}

/** The refusal when Xero's daily call limit is spent: nothing to retry until it resets (final review, security low 1). */
export const XERO_DAILY_LIMIT_MESSAGE = "Xero's daily limit has been reached; try again tomorrow.";

/** The refusal when Xero is rate-limiting this minute. */
export const XERO_BUSY_MESSAGE = "Xero is busy, try again in a minute.";

/** What the treasurer is told when Xero could not be read: its daily limit, its per-minute limit, or unreachable. */
function xeroReadFailureMessage(error: unknown): string {
  if (error instanceof XeroDailyLimitError) return XERO_DAILY_LIMIT_MESSAGE;
  if (getXeroErrorStatusCode(error) === 429) return XERO_BUSY_MESSAGE;
  return "The app could not reach Xero to check that credit note. Check Xero is connected, then try again.";
}

/** The two short-retry Xero reads behind the answer: a person waits on them (review, security 4). */
const HAND_MADE_NOTE_READ = { maxRetries: 1, maxWaitSec: 5, armTransientBreaker: false } as const;

/** What the "already in Xero" check needs of the follow-up's payment: the invoice it credits, or the owner's contact. */
export interface HandMadeNoteExpectation {
  expectedAmountCents: number;
  /** The payment's Xero invoice: the note must belong to its contact and be allocated to no other invoice. */
  xeroInvoiceId: string | null;
  /** The booking owner's Xero contact, used when the payment has no invoice. */
  ownerXeroContactId: string | null;
}

/**
 * Read the hand-made note from Xero and check it. No transaction is open; the
 * caller passes the result into the completion. The note must be AUTHORISED
 * or PAID, a sales credit note for exactly the amount, for the payment's
 * contact (its Xero invoice's, else the booking owner's), and allocated to no
 * other invoice (review, money 3). Refuses with a 400/409 whose message the
 * treasurer reads.
 */
export async function verifyHandMadeRefundNote(
  input: { creditNoteNumber: string; format: ClubFormat } & HandMadeNoteExpectation,
): Promise<VerifiedHandMadeRefundNote> {
  const number = normaliseCreditNoteNumber(input.creditNoteNumber);
  let creditNotes: Array<{
    creditNoteID?: string;
    creditNoteNumber?: string;
    status?: unknown;
    type?: unknown;
    total?: number;
    contact?: { contactID?: string };
    allocations?: Array<{ invoice?: { invoiceID?: string } }>;
  }>;
  let expectedContactId = input.ownerXeroContactId;
  try {
    const { xero, tenantId } = await getAuthenticatedXeroClient();
    const response = await callXeroApi(
      () => xero.accountingApi.getCreditNotes(tenantId, undefined, `CreditNoteNumber=="${number}"`),
      { operation: "getCreditNotes", resourceType: "CREDIT_NOTE", workflow: "verifyHandMadeRefundNote", context: `verifyHandMadeRefundNote(${number})`, ...HAND_MADE_NOTE_READ },
    );
    creditNotes = (response.body.creditNotes ?? []) as typeof creditNotes;
    if (input.xeroInvoiceId) {
      const invoice = await callXeroApi(
        () => xero.accountingApi.getInvoice(tenantId, input.xeroInvoiceId!),
        { operation: "getInvoice", resourceType: "INVOICE", workflow: "verifyHandMadeRefundNote", context: `verifyHandMadeRefundNote(${number}) invoice`, ...HAND_MADE_NOTE_READ },
      );
      expectedContactId = invoice.body.invoices?.[0]?.contact?.contactID ?? null;
    }
  } catch (error) {
    logger.error({ err: error, creditNoteNumber: number }, "Could not read a hand-made refund credit note from Xero (#4162)");
    throw new ManualBookingPaymentError(xeroReadFailureMessage(error), 409);
  }
  const matches = creditNotes.filter((note) => note.creditNoteID && note.creditNoteNumber?.trim() === number);
  if (matches.length === 0) {
    throw new ManualBookingPaymentError(`Xero has no credit note numbered ${number}. Check the number and try again.`, 409);
  }
  if (matches.length > 1) {
    throw new ManualBookingPaymentError(`Xero has more than one credit note numbered ${number}, so the app cannot tell which you mean.`, 409);
  }
  const note = matches[0]!;
  const status = String(note.status ?? "").trim().toUpperCase();
  if (!HAND_MADE_NOTE_LIVE_STATUSES.includes(status)) {
    throw new ManualBookingPaymentError(`Credit note ${number} is ${status.toLowerCase() || "not approved"} in Xero, not approved or paid, so it does not record this refund.`, 409);
  }
  if (String(note.type ?? "") !== "ACCRECCREDIT") {
    throw new ManualBookingPaymentError(`Credit note ${number} is not a sales credit note in Xero, so it does not record a refund to a member.`, 409);
  }
  if (!expectedContactId) {
    // Final review, security low 2: say why nothing could be compared.
    throw new ManualBookingPaymentError(
      input.xeroInvoiceId
        ? `Credit note ${number} cannot be checked: this booking's Xero invoice has no contact to check it against.`
        : `Credit note ${number} cannot be checked: this payment has no Xero invoice and the booking's owner has no Xero contact, so there is no Xero contact to check it against.`,
      409,
    );
  }
  if (note.contact?.contactID !== expectedContactId) {
    throw new ManualBookingPaymentError(`Credit note ${number} is for a different contact in Xero than this booking's invoice, so it does not record this refund.`, 409);
  }
  if ((note.allocations ?? []).some((allocation) => allocation.invoice?.invoiceID && allocation.invoice.invoiceID !== input.xeroInvoiceId)) {
    throw new ManualBookingPaymentError(`Credit note ${number} is allocated to another invoice in Xero, so it does not record this refund.`, 409);
  }
  const amountCents = providerAmountToCents(note.total);
  if (amountCents !== input.expectedAmountCents) {
    throw new ManualBookingPaymentError(
      `Credit note ${number} is for ${amountCents === null ? "an amount the app cannot read" : formatCents(amountCents, input.format)} in Xero, not ${formatCents(input.expectedAmountCents, input.format)}, so it does not record this refund.`,
      409,
    );
  }
  return { creditNoteId: note.creditNoteID!, creditNoteNumber: number, amountCents, status, total: note.total! };
}

/** The booking owner's own Xero contact, read through the one owner accessor (`INV-SSOT-005`). */
function bookingOwnerXeroContactId(booking: {
  member: { xeroContactId: string | null } | null;
  organisation: { name: string; xeroContactId: string | null } | null;
}): string | null {
  if (booking.organisation) return booking.organisation.xeroContactId;
  const member = bookingOwner(booking).member as { xeroContactId?: string | null } | null;
  return member?.xeroContactId ?? null;
}

/** The statuses a hand-made note may carry: approved or paid (review, money 3). */
const HAND_MADE_NOTE_LIVE_STATUSES: readonly string[] = ["AUTHORISED", "PAID"];

/** The refusal of a fresh note on a payment with no Xero invoice to credit (review, money 5). */
export const FRESH_NOTE_NO_INVOICE_MESSAGE =
  "This payment has no Xero invoice for a credit note to credit, so the app cannot raise one. If you made the credit note in Xero yourself, answer \"Yes, I already recorded it in Xero myself\" with its number.";

/**
 * The route's half of the answer, before the completion's transaction: an
 * unlocked read of the task (that it is a follow-up, its amount, its
 * payment's invoice and owner contact). A fresh note is refused on a payment
 * with no Xero invoice; "already in Xero" is checked against Xero here. The
 * completion re-checks under its locks.
 */
export async function prepareBankRefundVoidAnswer(input: {
  taskId: string;
  answer: z.infer<typeof bankRefundVoidAnswerBodySchema>;
  format: ClubFormat;
}): Promise<ResolvedBankRefundVoidAnswer> {
  const task = await prisma.manualRefundTask.findUnique({
    where: { id: input.taskId },
    select: {
      kind: true,
      occurrenceKey: true,
      amountCents: true,
      reviewContext: true,
      payment: { select: { xeroInvoiceId: true } },
      booking: { select: { member: { select: { xeroContactId: true } }, organisation: { select: { name: true, xeroContactId: true } } } },
    },
  });
  if (!task || !isBankRefundVoidFollowUpTask(task) || !readBankRefundVoidFollowUpContext(task.reviewContext) || task.amountCents === null) {
    throw new ManualBookingPaymentError(BANK_REFUND_VOID_ANSWER_NOT_ASKED_MESSAGE, 400);
  }
  const xeroInvoiceId = task.payment?.xeroInvoiceId ?? null;
  if (input.answer.answer === "fresh-note") {
    if (!xeroInvoiceId) throw new ManualBookingPaymentError(FRESH_NOTE_NO_INVOICE_MESSAGE, 409);
    return { answer: "fresh-note" };
  }
  const note = await verifyHandMadeRefundNote({
    creditNoteNumber: input.answer.creditNoteNumber,
    expectedAmountCents: task.amountCents,
    xeroInvoiceId,
    // An organisation's booking has its own contact; a member's, the member's.
    ownerXeroContactId: bookingOwnerXeroContactId(task.booking),
    format: input.format,
  });
  return { answer: "recorded-in-xero", note };
}

/**
 * Inside the completion's transaction, after its allocation: record the
 * checked note as the follow-up's tracked refund note. Refused (rolling the
 * completion back) when another record here already tracks that Xero note.
 * The one exception (review, money 6): the note is tracked only by this
 * payment's own inactive, non-voided refund-note link - a duplicate the
 * single-note rule turned off - which is reactivated for the follow-up.
 */
export async function recordHandMadeRefundNoteLink(
  tx: Prisma.TransactionClient,
  input: { paymentId: string; taskId: string; amountCents: number; note: VerifiedHandMadeRefundNote },
): Promise<void> {
  if (input.note.amountCents !== input.amountCents) {
    throw new ManualBookingPaymentError("This refund's amount changed while you were answering - refresh and try again.", 409);
  }
  const tracked = await tx.xeroObjectLink.findMany({
    where: { xeroObjectType: "CREDIT_NOTE", xeroObjectId: input.note.creditNoteId },
    select: { localModel: true, localId: true, role: true, active: true, metadata: true },
  });
  const ownInactive = (link: (typeof tracked)[number]) =>
    link.localModel === "Payment" &&
    link.localId === input.paymentId &&
    link.role === "REFUND_CREDIT_NOTE" &&
    !link.active &&
    !isRefundCreditNoteLinkCancelledInXero(link.metadata);
  if (!tracked.every(ownInactive)) {
    throw new ManualBookingPaymentError(
      `Credit note ${input.note.creditNoteNumber} is already recorded against another refund or booking here, so it cannot also record this one.`,
      409,
    );
  }
  await upsertXeroObjectLink(
    {
      localModel: "Payment",
      localId: input.paymentId,
      xeroObjectType: "CREDIT_NOTE",
      xeroObjectId: input.note.creditNoteId,
      xeroObjectNumber: input.note.creditNoteNumber,
      role: "REFUND_CREDIT_NOTE",
      active: true,
      metadata: {
        status: input.note.status,
        total: input.note.total,
        amountCents: input.note.amountCents,
        // A note per refund: it stands beside the payment's other notes and
        // is never its one canonical note (`isPerDeltaRefundNoteLink`).
        perDelta: true,
        handBackTaskId: input.taskId,
        recordedByHand: true,
      },
      mergeMetadata: true,
    },
    { store: tx },
  );
}

/**
 * #4162 review (concurrency 1): after the completion commits, outside any
 * transaction, the hand-made note is read from Xero once more through the
 * inbound reconcile, so a void that landed between the check and the link
 * write marks the new link voided at once - and the nightly follow-up undoes it
 * again. A failure is logged and alerted, never the completion's failure.
 */
export async function reconcileHandMadeNoteAfterCompletion(answer: ResolvedBankRefundVoidAnswer | null): Promise<void> {
  if (answer?.answer !== "recorded-in-xero") return;
  try {
    await reconcileXeroCreditNote(answer.note.creditNoteId);
  } catch (error) {
    logger.error({ err: error, creditNoteId: answer.note.creditNoteId }, "Could not re-read a hand-made refund credit note after recording it (#4162)");
    await notifyXeroSyncError({
      errorType: "refund-ledger-divergence",
      operation: `bank-refund-void-hand-made-note:${answer.note.creditNoteId}`,
      errorMessage: `The hand-made Xero credit note ${answer.note.creditNoteNumber} was recorded for a re-confirmed bank refund, but the app could not read it from Xero again afterwards. If it was voided in the meantime, the inbound sync or the nightly follow-up will catch it; check it in Xero.`,
    }).catch(() => undefined);
  }
}

/**
 * The completion's half of a follow-up's answer, inside its transaction after
 * the allocation and the hand-back line - so the money goes back on the
 * payment exactly as an ordinary hand-back completion records it, and the
 * answer commits or rolls back with it. Called for every completion: a
 * follow-up with no answer, or an answer on any other task, is refused here
 * and the whole completion rolls back. The completion also writes no
 * `REFUNDED` booking event for a follow-up: the money moved once (Q3).
 *
 * - "fresh-note": ONE refund note queued on the outbox, keyed and sized on the
 *   follow-up itself (`paidAnotherWayTaskId`, as a card refund shortfall's
 *   is), dated today; nothing is copied from the voided note. Refused where the
 *   payment has no invoice to credit, or no note could be queued, so the
 *   treasurer is never told one was. The outbox's 15-minute run sends it;
 * - "recorded-in-xero": the checked hand-made note becomes the follow-up's
 *   tracked refund-note link; nothing is queued.
 */
export async function recordBankRefundVoidAnswerInTransaction(input: {
  task: { id: string; kind: ManualRefundTaskKind | null; occurrenceKey: string | null; booking: { payment: { xeroInvoiceId: string | null } | null } };
  route: { kind: string; paymentId?: string | null; refundCents?: number } | null;
  answer: ResolvedBankRefundVoidAnswer | null;
  actingMemberId: string;
  store: Prisma.TransactionClient;
}): Promise<void> {
  const followUp = isBankRefundVoidFollowUpTask(input.task);
  if (followUp && !input.answer) throw new ManualBookingPaymentError(BANK_REFUND_VOID_ANSWER_REQUIRED_MESSAGE, 400);
  if (!followUp && input.answer) throw new ManualBookingPaymentError(BANK_REFUND_VOID_ANSWER_NOT_ASKED_MESSAGE, 400);
  const { answer, route } = input;
  if (!answer || route?.kind !== "local-allocation" || !route.paymentId || !route.refundCents || route.refundCents <= 0) return;
  if (answer.answer === "recorded-in-xero") {
    await recordHandMadeRefundNoteLink(input.store, { paymentId: route.paymentId, taskId: input.task.id, amountCents: route.refundCents, note: answer.note });
    return;
  }
  // The answer must be true when the treasurer reads it (review, money 5 and
  // security 1): no invoice, or no note queued, refuses the whole completion.
  if (!input.task.booking.payment?.xeroInvoiceId) throw new ManualBookingPaymentError(FRESH_NOTE_NO_INVOICE_MESSAGE, 409);
  const queued = await enqueueXeroRefundCreditNoteOperation(route.paymentId, route.refundCents, {
    createdByMemberId: input.actingMemberId,
    refundMethod: "internet-banking",
    paidAnotherWayTaskId: input.task.id,
    store: input.store,
  });
  if (!queued.queueOperationId) {
    logger.warn({ taskId: input.task.id, paymentId: route.paymentId, message: queued.message }, "A re-confirmed bank refund queued no fresh credit note (#4162)");
    throw new ManualBookingPaymentError(`No fresh credit note could be queued, so nothing was recorded: ${queued.message}`, 409);
  }
}
