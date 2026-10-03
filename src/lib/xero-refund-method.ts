/**
 * How a booking's money went back to the member, as the ONE home for the words
 * a Xero refund or credit document carries (`INV-PAY-101`, #3529).
 *
 * A treasurer reconciling Xero needs to tell three things apart, because each
 * moves money differently: a card refund leaves the Stripe account, a bank
 * transfer leaves the club's ordinary bank account, and account credit moves
 * nothing at all. Until #3529 every refund note read "Refund for booking …",
 * every account-credit note "Account credit from booking …", and a hand-back
 * settled by bank transfer after a booking-edit review carried the CARD
 * wording, because the review leg mapped every non-credit route to `"card"`.
 *
 * The method is a property of the SETTLEMENT DECISION and travels from where
 * that decision is made — the cancel path, the edit-review route, the hand-back
 * completion — into the outbox payload and on to the builder. It is never
 * inferred from `Payment.source` where the caller knows better: an
 * internet-banking payment can be refunded as credit or by transfer, and a card
 * payment can be refunded as credit. `defaultRefundMethodForPaymentSource` is
 * the one fallback, for queued rows written before the field existed.
 *
 * Pure: no database, no provider, no clock. The three strings below are the
 * owner's exact wording (20 September 2026); with the unpaid-invoice clearing
 * wording (#3535) and the two booking-edit wordings (#3536) nothing else may
 * spell them — `xero-refund-method.test.ts`
 * holds a census over `src/lib`, where every Xero document is built.
 */

import { PaymentSource } from "@prisma/client";
import type { AccountMappingKey } from "@/lib/xero-account-mapping-keys";

export const REFUND_METHODS = ["card", "internet-banking", "account-credit"] as const;

export type RefundMethod = (typeof REFUND_METHODS)[number];

export const REFUND_METHOD_WORDING: Readonly<Record<RefundMethod, string>> = {
  card: "Refund against original credit card",
  "internet-banking": "Refund requested via internet banking",
  "account-credit": "Account Credit",
};

export function describeRefundMethod(method: RefundMethod): string {
  return REFUND_METHOD_WORDING[method];
}

/**
 * The words on the note that closes an invoice nobody paid (`INV-PAY-017`,
 * #3535): an internet-banking hold released unpaid, a booking cancelled before
 * any payment was captured, and the repair tool's re-queue of that note. Not a
 * fourth refund method: no money moved, so nothing settles the note and no
 * payment source ever implies it. A caller asks for it with
 * `clearsUnpaidInvoice: true`; `modificationNoteWording` maps that here.
 */
export const UNPAID_INVOICE_CLEARING_WORDING = "Invoice cleared - booking not paid";

/**
 * #3643 (`INV-PAY-107`): the same clearing note on a booking that WAS partly
 * paid — cancelled after the cancel path recorded the part payment Xero showed,
 * so the note clears only the unpaid rest. "Booking not paid" would be false on
 * it. A caller asks with `clearsUnpaidBalance: true` beside
 * `clearsUnpaidInvoice: true`; every clearing behaviour keys off the latter.
 */
export const UNPAID_BALANCE_CLEARING_WORDING = "Unpaid balance cleared - booking cancelled";

/**
 * #3536 (`INV-PAY-113`): the two wordings the owner added on 2 Oct 2026 for
 * booking-edit credit notes that were previously worded as bank transfers.
 * Neither is a refund method and neither changes a note's settlement: a
 * modification credit note is allocated against the original invoice, never
 * settled by a payment, so these are words only.
 *
 * - `"invoice-correction"`: a booking change that lowers an UNPAID pay-on-account
 *   invoice. The note corrects the invoice; nothing was paid, so nothing is
 *   refunded.
 * - `"cash"`: an edit-review refund the club handed back in cash. Refined by
 *   the owner on 3 Oct 2026: the OFFICER chooses it on the settle screen, and
 *   only for a refund paid back by hand (the `local-allocation` route). The app
 *   never infers cash from "marked paid by hand", which covers bank transfers
 *   recorded outside Xero too; with no answer the note keeps the bank-transfer
 *   wording.
 */
export const MODIFICATION_NOTE_SPECIAL_WORDINGS = ["invoice-correction", "cash"] as const;

export type ModificationNoteSpecialWording = (typeof MODIFICATION_NOTE_SPECIAL_WORDINGS)[number];

export const INVOICE_CORRECTION_WORDING = "Invoice correction — nothing refunded";

export const REFUNDED_IN_CASH_WORDING = "Refunded in cash";

/** What a credit document's wording is chosen from: how money went back, or that none was owed back. */
export type CreditDocumentWording =
  | RefundMethod
  | ModificationNoteSpecialWording
  | "unpaid-invoice-clearing"
  | "unpaid-balance-clearing";

/**
 * What the invoice-applied modification credit note is told to say, from its
 * enqueue through the stored payload to the builder: either how the reduction
 * went back, or that the invoice is being cleared because nobody paid it.
 * Never both — a clearing note has no refund method to name.
 */
export type ModificationNoteWording =
  | {
      refundMethod?: RefundMethod;
      /** #3536: one of the two owner-added wordings; it wins over `refundMethod` on the document. */
      noteWording?: ModificationNoteSpecialWording;
      clearsUnpaidInvoice?: undefined;
      clearsUnpaidBalance?: undefined;
    }
  | {
      clearsUnpaidInvoice: true;
      clearsUnpaidBalance?: true;
      refundMethod?: undefined;
      noteWording?: undefined;
    };

/**
 * The ONE reading of the fields, from a typed caller, a stored payload or a
 * repair action alike: `clearsUnpaidInvoice` counts only when it is literally
 * `true`, and then no refund method is carried — only whether the note clears
 * the unpaid balance of a partly paid booking (`clearsUnpaidBalance`, also
 * literally `true`, #3643); otherwise the refund method if it is one of the
 * three. Spread the result wherever the choice is passed on.
 */
export function readModificationNoteWording(
  raw:
    | {
        clearsUnpaidInvoice?: unknown;
        clearsUnpaidBalance?: unknown;
        refundMethod?: unknown;
        noteWording?: unknown;
      }
    | null
    | undefined,
): ModificationNoteWording {
  if (raw?.clearsUnpaidInvoice === true) {
    return raw.clearsUnpaidBalance === true
      ? { clearsUnpaidInvoice: true, clearsUnpaidBalance: true }
      : { clearsUnpaidInvoice: true };
  }
  const refundMethod = parseRefundMethod(raw?.refundMethod);
  const noteWording = parseModificationNoteSpecialWording(raw?.noteWording);
  return {
    ...(refundMethod ? { refundMethod } : {}),
    ...(noteWording ? { noteWording } : {}),
  };
}

/** A stored payload field, or null when absent or not one of the two (#3536). */
function parseModificationNoteSpecialWording(value: unknown): ModificationNoteSpecialWording | null {
  return typeof value === "string" &&
    (MODIFICATION_NOTE_SPECIAL_WORDINGS as readonly string[]).includes(value)
    ? (value as ModificationNoteSpecialWording)
    : null;
}

/**
 * The choice with its default applied — a card refund when told nothing, as
 * every pre-#3529 row was. What a built note records, so a replay says the same.
 */
export function settledModificationNoteWording(
  choice: ModificationNoteWording,
):
  | { clearsUnpaidInvoice: true; clearsUnpaidBalance?: true }
  | { noteWording: ModificationNoteSpecialWording; refundMethod?: RefundMethod }
  | { refundMethod: RefundMethod } {
  const read = readModificationNoteWording(choice);
  if (read.clearsUnpaidInvoice) return read;
  // #3536: no card default here - an invoice correction refunds nothing, so a
  // recorded `"card"` beside it would be a false statement.
  if (read.noteWording) {
    return read.refundMethod
      ? { noteWording: read.noteWording, refundMethod: read.refundMethod }
      : { noteWording: read.noteWording };
  }
  return { refundMethod: read.refundMethod ?? "card" };
}

/** The wording a modification note carries. */
export function modificationNoteWording(choice: ModificationNoteWording): CreditDocumentWording {
  const settled = settledModificationNoteWording(choice);
  if ("noteWording" in settled) return settled.noteWording;
  if (!("clearsUnpaidInvoice" in settled)) return settled.refundMethod;
  return settled.clearsUnpaidBalance ? "unpaid-balance-clearing" : "unpaid-invoice-clearing";
}

function describeCreditDocumentWording(wording: CreditDocumentWording): string {
  if (wording === "unpaid-invoice-clearing") return UNPAID_INVOICE_CLEARING_WORDING;
  if (wording === "unpaid-balance-clearing") return UNPAID_BALANCE_CLEARING_WORDING;
  if (wording === "invoice-correction") return INVOICE_CORRECTION_WORDING;
  if (wording === "cash") return REFUNDED_IN_CASH_WORDING;
  return describeRefundMethod(wording);
}

export function isRefundMethod(value: unknown): value is RefundMethod {
  return (
    typeof value === "string" &&
    (REFUND_METHODS as readonly string[]).includes(value)
  );
}

/** A stored payload field, or null when absent or not one of the three. */
export function parseRefundMethod(value: unknown): RefundMethod | null {
  return isRefundMethod(value) ? value : null;
}

/**
 * The fallback for a caller that carries no method — a queued row from before
 * the field existed, or a repair re-driving one. A Stripe payment's money can
 * only have left through Stripe; anything else that reaches the cash-refund
 * builder went back by bank transfer. Account credit never reaches this: the
 * unapplied-note builder is account credit by construction.
 */
export function defaultRefundMethodForPaymentSource(
  source: PaymentSource | null | undefined,
): CashRefundMethod {
  return source === PaymentSource.INTERNET_BANKING ? "internet-banking" : "card";
}

/**
 * `INV-PAY-101`: a cash refund note's method, and whether a caller SAID it —
 * the one derivation the builder and the repair leg both make. A note nobody
 * vouched for (`methodRecorded: false`) is raised unsettled rather than marked
 * paid from an account it never touched.
 */
export function resolveRefundNoteMethod(
  recorded: CashRefundMethod | undefined,
  source: PaymentSource | null | undefined,
): { refundMethod: CashRefundMethod; refundMethodRecorded: boolean } {
  return {
    refundMethod: recorded ?? defaultRefundMethodForPaymentSource(source),
    refundMethodRecorded: recorded !== undefined,
  };
}

/**
 * The booking-edit services' two-way `settlementMethod` ("card" | "credit") is
 * the MEMBER's choice between money back and credit kept; this is what it
 * means on the document. "Money back" is a card refund only where the payment
 * is a captured Stripe payment (`refundedThroughStripe`, the services' own
 * `hasSucceededPayment`); a booking paid another way and reduced "to card"
 * has its money returned by the club itself, so the note says a bank transfer
 * (review of #3537). Unknown reads as card, which every pre-#3529 row was. A
 * caller that knows the route outright passes the method instead.
 */
export function refundMethodForSettlementMethod(
  settlementMethod: "card" | "credit" | null | undefined,
  refundedThroughStripe?: boolean | null,
): RefundMethod {
  if (settlementMethod === "credit") return "account-credit";
  return refundedThroughStripe === false ? "internet-banking" : "card";
}

/** The two methods that settle a cash refund note: money actually left. */
export type CashRefundMethod = Exclude<RefundMethod, "account-credit">;

/**
 * Which bank account a cash refund note is SETTLED against — the credit-note
 * payment that records money leaving. Account credit records no payment, so
 * it is not in the domain. The internet-banking key has NO fallback: unset,
 * the note is raised without a settling payment (owner decision, #3529), and
 * `resolveRefundSettlement` in `xero-invoice-payments` is where that is
 * decided.
 */
export function refundSettlementMappingKey(
  method: CashRefundMethod,
): Extract<AccountMappingKey, "stripeBankAccount" | "bankTransferRefundAccount"> {
  return method === "card" ? "stripeBankAccount" : "bankTransferRefundAccount";
}

/** The short booking reference every Xero booking document already uses. */
function bookingRef(bookingId: string): string {
  return bookingId.slice(0, 8);
}

/**
 * The line-item description of a refund or credit document. `stay` is the
 * lodge-night range already formatted for the document (the builder owns the
 * date rendering, `INV-DATE-019`); `modificationId` marks a note raised by a
 * booking edit rather than a cancellation.
 */
export function buildRefundDocumentDescription(params: {
  method: CreditDocumentWording;
  bookingId: string;
  stay?: { checkIn: string; checkOut: string } | null;
  modificationId?: string | null;
}): string {
  const head = `${describeCreditDocumentWording(params.method)} - Booking ${bookingRef(params.bookingId)}`;
  if (params.modificationId) {
    return `${head} - booking change ${bookingRef(params.modificationId)}`;
  }
  if (params.stay) {
    return `${head} (${params.stay.checkIn} - ${params.stay.checkOut})`;
  }
  return head;
}

/** The document's `reference` field: the wording and the booking, nothing else. */
export function buildRefundDocumentReference(params: {
  method: CreditDocumentWording;
  bookingId: string;
}): string {
  return `${describeCreditDocumentWording(params.method)} - Booking ${bookingRef(params.bookingId)}`;
}

/**
 * The reference on the credit-note PAYMENT that settles a cash refund note —
 * the line the treasurer sees on the bank account. `clubName` is passed in so
 * this module stays free of configuration reads.
 */
export function buildRefundPaymentReference(params: {
  method: CashRefundMethod;
  clubName: string;
  paymentId: string;
}): string {
  return `${describeRefundMethod(params.method)} - ${params.clubName} payment ${params.paymentId.slice(0, 8)}`;
}
