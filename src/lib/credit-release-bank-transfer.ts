import { loadPublicBookingMessages, buildBookingMessageGlobalData } from "@/lib/booking-message-settings";
import { renderBookingMessageTemplate } from "@/lib/booking-message-definitions";
import { escapeHtml } from "@/lib/email-templates/escape";

/**
 * THE BANK-TRANSFER OFFER ON A REQUEST FOR CREDIT USED ELSEWHERE (#4253 release 2, owner
 * decision D6: card OR bank transfer, `INV-ADDPAY-048`).
 *
 * The club's account details are not stored by the app: they are the text the club writes in
 * the `paymentRequest.bankTransfer.instructions` booking message. The reference a transfer
 * must quote is the booking's Xero invoice number, because Xero matches the bank line to that
 * invoice and the closer (`credit-release-ask-close.ts`) closes the request when Xero shows it
 * paid. With no details written, or no invoice number to quote, there is NO offer and the email
 * stays card-only: an offer the member cannot act on, or that Xero could not match, is worse
 * than none.
 */
export type BankTransferOffer = { instructions: string; reference: string };

export async function loadBankTransferOffer(invoiceNumber: string | null | undefined): Promise<BankTransferOffer | null> {
  const reference = invoiceNumber?.trim();
  if (!reference) return null;
  const [bookingMessages, club] = await Promise.all([loadPublicBookingMessages(), buildBookingMessageGlobalData()]);
  const body = renderBookingMessageTemplate(bookingMessages["paymentRequest.bankTransfer.instructions"] ?? "", {
    ...club,
    paymentReference: reference,
    xeroInvoiceNumber: reference,
  }).trim();
  return body ? { instructions: body, reference } : null;
}

/**
 * THE ONE SPELLING of the offer's lead sentence, either side of the reference. The editable
 * body's `{{bankTransferNote}}`, the built-in email's paragraph and the editor's preview sample
 * all build from it, so the three cannot drift apart.
 */
const BANK_TRANSFER_LEAD = "You can also pay by bank transfer. Use the payment reference ";
const BANK_TRANSFER_LEAD_END = ".";

/** The whole offer as one plain-text paragraph for the editable email body, with its trailing break. */
export function bankTransferNoteText(offer: BankTransferOffer | null): string {
  if (!offer) return "";
  return `${BANK_TRANSFER_LEAD}${offer.reference}${BANK_TRANSFER_LEAD_END}\n${offer.instructions}\n\n`;
}

/** The same offer as the built-in email's paragraph content: escaped, reference in bold, line breaks kept. */
export function bankTransferNoteHtml(offer: BankTransferOffer): string {
  const lines = offer.instructions.split("\n").map((line) => escapeHtml(line)).join("<br>");
  return `${BANK_TRANSFER_LEAD}<strong>${escapeHtml(offer.reference)}</strong>${BANK_TRANSFER_LEAD_END}<br>${lines}`;
}

/** What the template editor previews `{{bankTransferNote}}` with: a club that has written its details. */
export const SAMPLE_BANK_TRANSFER_OFFER: BankTransferOffer = {
  reference: "INV-1234",
  instructions: "Account name: Sample Club\nAccount number: 00-0000-0000000-00",
};
