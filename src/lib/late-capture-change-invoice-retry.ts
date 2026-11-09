import type { ClubFormat } from "@/lib/club-format";
import { cardNoteMayBeInXeroSentence } from "@/lib/late-capture-card-note-wording";
import { findLateCaptureRefundPaidAnotherWayCloses } from "@/lib/late-capture-paid-another-way";
import { findActiveSupplementaryInvoiceLink } from "@/lib/late-capture-xero-receipt";
import { prisma } from "@/lib/prisma";
import { formatCents } from "@/lib/utils";

/**
 * #3924 round 10 (`INV-PAY-122`): THE TWO QUESTIONS an officer's retry of a
 * FAILED change invoice released for a late capture asks before it sends the
 * row back through the outbox (`retryXeroSyncOperation`).
 */

/**
 * Is the payload's intent a late capture an approval task owns
 * (`lateCaptureApprovalIntentId`) - the late charge whose refund a close can
 * wait on? An ordinary card edit's invoice names its `paymentIntentId` too, and
 * keeps the inline replay.
 */
export async function isLateCaptureApprovalChangeInvoice(payload: Record<string, unknown>): Promise<boolean> {
  const intent = payload.paymentIntentId;
  if (typeof intent !== "string" || intent === "") return false;
  const task = await prisma.manualRefundTask.findUnique({
    where: { lateCaptureApprovalIntentId: intent },
    select: { id: true },
  });
  return task !== null;
}

/**
 * Is that change invoice ALREADY IN XERO - its change carries the active
 * `SUPPLEMENTARY_INVOICE` link `createXeroSupplementaryInvoice` writes once
 * Xero returns the invoice, though the row failed after it? Then it is never
 * sent again, since a retry could raise a second invoice for one charge: the
 * refusal (a 409) tells the officer to mark the row resolved as fixed in Xero.
 * The link is the receipt reader's (`findActiveSupplementaryInvoiceLink`).
 * Null when it may be sent.
 *
 * Round 12 (`INV-PAY-122`): WHAT TO RECORD BY HAND, AND WHAT NOT. Once the row
 * is resolved the two receipt verdicts part. A refund closed as paid another
 * way reads the linked invoice as its receipt
 * (`readPaidAnotherWayLateCaptureXeroReceipt`), so the app raises the close's
 * note - through the nightly credit check or the repair tool, since marking
 * the row resolved runs no note step - and that share is never recorded by
 * hand. Every card-refund path reads the row resolved by hand
 * (`readLateCaptureXeroReceipt`), so the app raises no note for the capture's
 * card refunds, and the refusal names what of them no note answers
 * (`readUnnotedLateCaptureCardRefunds`) to record by hand.
 *
 * Round 14: the row is resolved FIRST, before anything is recorded by hand -
 * until then a card note waiting for the receipt may still be sent. A card
 * note that may be in Xero is named apart, to check in Xero before recording
 * it. And while the card verdict still names an invoice in Xero, or another
 * receipt row is on its way (`notesCanStillLand`), the app notes the
 * capture's card refunds against it: round 15, nothing of them is recorded by
 * hand, and what no note asks for yet is noted the next time the app notes
 * this charge (`notedLaterCents`).
 */
export async function linkedChangeInvoiceRetryRefusal(
  operation: { localModel: string | null; localId: string | null },
  payload: Record<string, unknown>,
  format: ClubFormat,
): Promise<string | null> {
  const linked = await findActiveSupplementaryInvoiceLink([operation]);
  if (!linked) return null;
  const paymentIntentId = String(payload.paymentIntentId);
  // #4516 (round-2 review A): every close of the capture's refund, a part close's still-owed rest's included.
  const closes = await findLateCaptureRefundPaidAnotherWayCloses(paymentIntentId);
  const close = closes[0] ?? null;
  const task = await prisma.manualRefundTask.findUnique({
    where: { lateCaptureApprovalIntentId: paymentIntentId },
    select: { paymentId: true },
  });
  const paymentId = close?.paymentId ?? task?.paymentId ?? null;
  // Imported here, not at the top: that module reaches the outbox.
  const { readUnnotedLateCaptureCardRefunds } = await import("@/lib/late-capture-refund-credit-note");
  const card = paymentId
    ? await readUnnotedLateCaptureCardRefunds(paymentId, paymentIntentId)
    : { byHandCents: 0, mayBeInXeroCents: 0, notesCanStillLand: false, notedLaterCents: 0 };
  return linkedChangeInvoiceRetryRefusalMessage(
    { closeCents: close ? closes.reduce((sum, each) => sum + Math.max(0, each.amountCents ?? 0), 0) : null, ...card },
    format,
  );
}

/**
 * The 409's words: resolve the row first; the close's share is never recorded
 * by hand; the card refunds no note answers are, and those a note that may be
 * in Xero may answer only once Xero is checked - unless the app's card notes
 * can still land, when none of them is.
 */
function linkedChangeInvoiceRetryRefusalMessage(
  figures: {
    closeCents: number | null;
    byHandCents: number;
    mayBeInXeroCents: number;
    notesCanStillLand: boolean;
    notedLaterCents: number;
  },
  format: ClubFormat,
): string {
  const { closeCents, byHandCents, mayBeInXeroCents, notesCanStillLand, notedLaterCents } = figures;
  const parts = [
    "This late card charge's change invoice is already in Xero, so retrying it could raise a second invoice. Mark this operation resolved as fixed in Xero instead, and do that first, before recording anything by hand in Xero.",
  ];
  if (closeCents !== null && closeCents > 0) {
    parts.push(
      `Do not record the ${formatCents(closeCents, format)} paid back another way by hand: the app raises that refund note against the invoice already there, through the nightly credit check or the Xero repair tool.`,
    );
  }
  if (notesCanStillLand) {
    // The app's card notes still land against this charge's receipt (round 15).
    if (notedLaterCents > 0) {
      parts.push(
        `Do not record the ${formatCents(notedLaterCents, format)} refunded to the card that no refund note answers yet by hand: the app notes it against this charge's receipt in Xero the next time it notes this charge, as it notes this charge's other card refunds.`,
      );
    }
    return parts.join(" ");
  }
  if (byHandCents > 0) {
    parts.push(
      `Record the ${formatCents(byHandCents, format)} refunded to the card by hand in Xero: once this operation is resolved the app raises no refund note for a card refund of this charge.`,
    );
  }
  if (mayBeInXeroCents > 0) {
    parts.push(cardNoteMayBeInXeroSentence(formatCents(mayBeInXeroCents, format)));
  }
  if (byHandCents === 0 && mayBeInXeroCents === 0 && !closeCents) {
    // No close, or a $0 one (round 13): a later card refund is still the officer's to record.
    parts.push(
      "If this charge is refunded to the card, record that refund by hand in Xero: once this operation is resolved the app raises no refund note for it.",
    );
  }
  return parts.join(" ");
}
