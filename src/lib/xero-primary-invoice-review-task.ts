/**
 * #3980 (owner decision, 21 Oct 2026: "refuse, and bill the gap"): the Xero
 * Operations task a treasurer gets when a booking's primary Xero invoice does
 * not bill what the booking was worth when its link was saved, and the gap
 * cannot be billed automatically.
 *
 *  - OVERBILLED: the invoice bills MORE than the booking is worth - an edit
 *    lowered the price after the create read the booking. No credit note is
 *    raised automatically (not taken by the owner); the treasurer decides.
 *  - UNDERBILLED: it bills LESS, and no edit that settled against the primary
 *    invoice is there to anchor a supplementary invoice on (or, #4324, the one
 *    there is billed by a kept late capture's own invoice), so nothing can be
 *    billed without a person.
 *
 * THE TASK IS A `XeroSyncOperation` ROW, written FAILED and not replayable, so
 * it shows in the Xero Operations panel as an active failure with its message,
 * Retry refuses it ("not marked replayable"), and the treasurer closes it with
 * "Resolve (fixed in Xero)" once they have acted (`INV-INT-025`). No provider call is
 * made and no migration is needed: `status` and the type columns are text.
 *
 * Its types are its own (`entityType` `REVIEW`) so no invoice, credit-note or
 * repair query mistakes it for a document's operation, and its correlation key
 * is its own, so it neither dedups against nor is counted with the create. It
 * is anchored on the booking (`localModel` `Booking`) so the booking shows it.
 * One per invoice and direction: a re-run of the check finds the first and
 * raises no second.
 */
import type { ClubFormat } from "@/lib/club-format";
import { getClubFormat } from "@/lib/club-format-settings";
import { prisma } from "@/lib/prisma";
import { redactSensitiveText } from "@/lib/redact-sensitive-json";
import { formatCents } from "@/lib/utils";
import { sanitizeForJson } from "@/lib/xero-sync";

export const PRIMARY_INVOICE_REVIEW_ENTITY_TYPE = "REVIEW";
export const PRIMARY_INVOICE_REVIEW_OPERATION_TYPE = "PRIMARY_INVOICE_WORTH_GAP";

export type PrimaryInvoiceReviewKind = "OVERBILLED" | "UNDERBILLED";

/** The task's own key: one per booking, invoice and direction. */
export function primaryInvoiceReviewCorrelationKey(input: {
  bookingId: string;
  xeroInvoiceId: string;
  kind: PrimaryInvoiceReviewKind;
}): string {
  return `primary-invoice-review:${input.kind.toLowerCase()}:${input.bookingId}:${input.xeroInvoiceId}`;
}

/** What the treasurer reads in the panel. Plain figures, no member details. */
export function primaryInvoiceReviewMessage(
  input: {
    kind: PrimaryInvoiceReviewKind;
    bookingId: string;
    gapCents: number;
    settledBy?: ReductionSettlement;
    /** #4324 (`INV-PAY-144`): the change that would carry a shortfall is billed by a kept late capture's own invoice. */
    keptInvoiceBillsChange?: boolean;
  },
  format: ClubFormat,
): string {
  const reference = `Booking ${input.bookingId.slice(0, 8)}`;
  const amount = formatCents(Math.abs(input.gapCents), format);
  if (input.kind === "UNDERBILLED" && input.keptInvoiceBillsChange) {
    return `The primary Xero invoice for ${reference} bills ${amount} less than the booking is worth: the booking was changed while the invoice was being raised, and the change that would carry the difference is already billed by the Xero invoice for a late card payment the club kept. Check both invoices and bill in Xero whatever part of ${amount} that invoice does not already bill, then choose Resolve (fixed in Xero).`;
  }
  return input.kind === "OVERBILLED"
    ? `The primary Xero invoice for ${reference} bills ${amount} more than the booking is worth: the booking was changed while the invoice was being raised. ${settledSentence(input.settledBy, format)}Check the invoice and raise a credit note for ${amount} in Xero if one is due, then choose Resolve (fixed in Xero).`
    : `The primary Xero invoice for ${reference} bills ${amount} less than the booking is worth: the booking was changed while the invoice was being raised, and no change could carry the difference. Check the invoice and bill ${amount} in Xero if it is due, then choose Resolve (fixed in Xero).`;
}

/** How the reductions behind an overcharge settled their own money (review M5). */
export type ReductionSettlement = {
  refundAmountCents: number;
  accountCreditAmountCents: number;
  appliedCreditGivenBackCents: number;
  unpaidAskOffsetCents: number;
};

function settledSentence(settledBy: ReductionSettlement | undefined, format: ClubFormat): string {
  if (!settledBy) return "";
  const parts = [
    settledBy.refundAmountCents > 0 ? `a refund of ${formatCents(settledBy.refundAmountCents, format)} paid out` : null,
    settledBy.accountCreditAmountCents > 0
      ? `${formatCents(settledBy.accountCreditAmountCents, format)} of account credit`
      : null,
    settledBy.appliedCreditGivenBackCents > 0
      ? `${formatCents(settledBy.appliedCreditGivenBackCents, format)} of applied credit given back`
      : null,
    settledBy.unpaidAskOffsetCents > 0
      ? `${formatCents(settledBy.unpaidAskOffsetCents, format)} taken off an unpaid payment request`
      : null,
  ].filter((part): part is string => part !== null);
  if (parts.length === 0) return "The change returned no money. ";
  return `The change was settled by ${parts.join(", ")}; account for that too. `;
}

/**
 * Raises the task, or finds the one an earlier run raised. Returns its id.
 *
 * ONE ATOMIC INSERT, written by hand rather than through the operation
 * helpers, because neither fits: `startXeroSyncOperation` cannot write the
 * error fields, and following it with `failXeroSyncOperation` is two writes -
 * a crash between them leaves a RUNNING row the stale-running reset would turn
 * into an ORPHANED_STALE_RUNNING failure with no message - and the second would
 * count this row towards the repeated-failure alert, which is for providers
 * that keep failing, not for a finding. The message is redacted as that
 * helper's would be (`redactSensitiveText`), and the row sets no `xeroObjectUrl`
 * (`xero-object-url-write-guard.test.ts`).
 * Two runs racing past the lookup could each write one; the panel groups rows
 * by correlation key and shows the latest, so a duplicate reads as one task.
 */
export async function raisePrimaryInvoiceReviewTask(input: {
  kind: PrimaryInvoiceReviewKind;
  bookingId: string;
  xeroInvoiceId: string;
  gapCents: number;
  figures: Record<string, unknown>;
  /** An overcharge's: how the reductions behind it settled (review M5). */
  settledBy?: ReductionSettlement;
  /** A shortfall's: its anchor is billed by a kept late capture's own invoice (#4324). */
  keptInvoiceBillsChange?: boolean;
  createdByMemberId?: string;
}): Promise<{ operationId: string; alreadyRaised: boolean }> {
  const correlationKey = primaryInvoiceReviewCorrelationKey(input);
  const existing = await prisma.xeroSyncOperation.findFirst({
    where: {
      correlationKey,
      entityType: PRIMARY_INVOICE_REVIEW_ENTITY_TYPE,
      operationType: PRIMARY_INVOICE_REVIEW_OPERATION_TYPE,
    },
    select: { id: true },
  });
  if (existing) return { operationId: existing.id, alreadyRaised: true };

  const now = new Date();
  const created = await prisma.xeroSyncOperation.create({
    data: {
      direction: "OUTBOUND",
      entityType: PRIMARY_INVOICE_REVIEW_ENTITY_TYPE,
      operationType: PRIMARY_INVOICE_REVIEW_OPERATION_TYPE,
      localModel: "Booking",
      localId: input.bookingId,
      status: "FAILED",
      correlationKey,
      replayable: false,
      lastErrorCode: `PRIMARY_INVOICE_${input.kind}`,
      lastErrorMessage: redactSensitiveText(primaryInvoiceReviewMessage(input, await getClubFormat())),
      requestPayload: sanitizeForJson({
        kind: input.kind,
        bookingId: input.bookingId,
        xeroInvoiceId: input.xeroInvoiceId,
        gapCents: input.gapCents,
        ...input.figures,
      }),
      createdByMemberId: input.createdByMemberId ?? null,
      startedAt: now,
      completedAt: now,
    },
    select: { id: true },
  });
  return { operationId: created.id, alreadyRaised: false };
}
