/**
 * WHAT A XERO INVOICE-CREATE OPERATION'S COMPLETION PAYLOAD SAYS — the one home
 * for reading it (#3001, MAD epic #2725). `INV-SSOT`.
 *
 * ## Why this module exists
 *
 * `createXeroInvoiceForBooking` finishes a booking-invoice operation by writing
 * a fixed set of outcome keys onto `XeroSyncOperation.responsePayload`, and by
 * #3001 two quite different rules had to read them back:
 *
 *  - the money fence in `xero-operation-retry.ts`, which decides whether an
 *    operator's "Retry" may record a payment against that invoice;
 *  - the officer-facing warning on the booking itself, which has to say what
 *    actually happened.
 *
 * Both were about to spell the same six key names out for themselves. This
 * module is the one place that knows them, so a key renamed at the writer is a
 * compile-visible change in one file rather than a silent behaviour change in
 * two readers. The RULES stay where they are — this returns what the payload
 * SAYS, and each caller decides what to do about it.
 *
 * ## THE THREE REASONS AN INVOICE EMAIL DOES NOT GO OUT ARE NOT ONE REASON
 *
 * This is the whole reason the shape below has four separate email fields
 * rather than one "email did not go out" boolean, and flattening them is a
 * misdiagnosed support call:
 *
 *  - **the per-booking "No emails" switch** (#2258) — the club deliberately
 *    silenced this booking, persistently, and an officer owes the member the
 *    message by hand;
 *  - **the creation-time "do not email the member" choice** (#2929) — the club
 *    deliberately silenced THIS ONE invoice creation; the switch is off and
 *    every later email is decided by the ordinary rules;
 *  - **the environment-safety suppression** (#3035, `INV-CONFIG-004`) — not the
 *    club's decision at all. This installation is a copy, so nothing was
 *    transmitted. No withheld row is written and nothing failed;
 *  - **`invoiceEmailFailed`** — and only this one is a FAULT.
 *
 * The first three are complete, intended outcomes. Only the fourth is a
 * failure, and only the fourth may be reported to an operator as one.
 *
 * ## THE FAULT ITSELF HAS THREE CAUSES, AND THEY NEED DIFFERENT ACTIONS (#3001)
 *
 * `invoiceEmailFailed` fires for three unrelated events, and until #3001 the
 * surface printed one sentence for all three — while the reason text stays null
 * on every partial row, so the one kind that most needed its distinguishing
 * detail was the one kind that always withheld it:
 *
 *  - **`PROVIDER`** — asking Xero to email the invoice threw. Send the invoice
 *    from Xero by hand;
 *  - **`NO_EMAILS_UNREADABLE`** — the booking's "No emails" switch could not be
 *    READ, so nothing was sent and nobody decided that. The switch may well be
 *    ON, and "send it from Xero yourself" would then email a booking the club
 *    silenced — the conflation this file calls money-adjacent. Read the switch
 *    first;
 *  - **`ROLE_UNCONFIRMED`** — this installation's role is not confirmed
 *    (`INV-CONFIG-004`), so nothing was transmitted. Declaring the role is the
 *    remedy, and it is not a Xero problem at all.
 *
 * The cause is recorded as its OWN key by the writer rather than inferred from
 * the error VALUE, because the values are not redacted and are never read out of
 * this payload (see the last section). A row written before #3001 carries no
 * cause, which reads back as `null` — honestly unknown, never guessed at.
 *
 * A COMBINED "was it deliberately withheld?" predicate was drafted here and
 * deliberately removed: both readers below want the three reasons APART, not
 * together, and the money fence in particular must keep refusing on exactly the
 * two it refuses on today rather than on a set that quietly grew. A predicate
 * with no caller is a predicate whose behaviour nothing pins.
 *
 * ## THE WRITER
 *
 * `createXeroInvoiceForBooking` in `xero-booking-invoices.ts`, which composes
 * this payload once at `completeXeroSyncOperation`. The group-settlement and
 * subscription invoice workflows write an overlapping subset (they have no
 * payment leg and no creation-time choice), which reads here as the absent
 * fields being `false` — honest, because those workflows never made either
 * decision.
 *
 * `xero-booking-invoice-outcome-contract.test.ts` asserts from disk that the
 * writer and this reader still name the same keys.
 *
 * ## WHAT THIS DELIBERATELY DOES NOT RETURN
 *
 * The error VALUES. `paymentError` and `invoiceEmailError` are stored through
 * `sanitizeForJson`, which is a serialisation guard and not the operator-text
 * redactor that `failXeroSyncOperation` runs over `lastErrorMessage`. So this
 * module reports only whether each is PRESENT, and a surface that wants a
 * reason to show a person takes `lastErrorMessage` — the field that was
 * redacted on the way in (`INV-INT-005`).
 */

import { asRecord } from "@/lib/xero-json";

/**
 * What one invoice-create operation's completion payload asserts.
 *
 * Every field is a plain boolean, because every question here is "did this
 * happen?" and a `null` third state would only push the payload-absent case
 * into six places instead of one. Payload-absent is the RETURN being `null`.
 */
/**
 * Why the invoice email failed, when it failed. `null` on a row written before
 * #3001, or by a workflow with no email leg.
 */
export type XeroInvoiceEmailFailureCause =
  | "PROVIDER"
  | "NO_EMAILS_UNREADABLE"
  | "ROLE_UNCONFIRMED";

const EMAIL_FAILURE_CAUSES: readonly string[] = [
  "PROVIDER",
  "NO_EMAILS_UNREADABLE",
  "ROLE_UNCONFIRMED",
] as const;

export interface XeroInvoiceOperationOutcome {
  /** The Xero payment write for this invoice failed. */
  paymentFailed: boolean;
  /** No Xero payment was written, and that was the intended outcome. */
  paymentSkipped: boolean;
  /**
   * A FAULT stopped the invoice email. Never a deliberate withhold — those are
   * the three fields below.
   */
  invoiceEmailFailed: boolean;
  /**
   * WHICH fault, when the writer recorded one. The three causes want three
   * different actions from an officer, and one of them must not be told to
   * "send it from Xero" at all.
   */
  invoiceEmailFailureCause: XeroInvoiceEmailFailureCause | null;
  /** #2258: the per-booking "No emails" switch withheld it. The club's decision. */
  invoiceEmailWithheldByNoEmails: boolean;
  /**
   * #2929: the administrator who created the booking chose not to email the
   * member. The club's decision, spent on this one invoice creation.
   */
  invoiceEmailWithheldByCreationChoice: boolean;
  /**
   * #3035: this installation is a copy, so nothing was transmitted. Not the
   * club's decision and not a fault.
   */
  invoiceEmailWithheldForEnvironment: boolean;
}

/**
 * Read one operation's completion payload.
 *
 * `null` when the payload is not an object at all — no outcome was recorded,
 * which is a different answer from "recorded, and everything was fine". Callers
 * that treat the two alike would read a legacy or half-written row as a clean
 * run, and on the retry fence that is a payment recorded against an unpaid
 * invoice.
 */
export function readXeroInvoiceOperationOutcome(
  responsePayload: unknown,
): XeroInvoiceOperationOutcome | null {
  const payload = asRecord(responsePayload);
  if (!payload) return null;

  return {
    paymentFailed: payload.paymentError != null,
    paymentSkipped: payload.paymentSkipped === true,
    invoiceEmailFailed: payload.invoiceEmailError != null,
    invoiceEmailFailureCause:
      typeof payload.invoiceEmailFailureCause === "string" &&
      EMAIL_FAILURE_CAUSES.includes(payload.invoiceEmailFailureCause)
        ? (payload.invoiceEmailFailureCause as XeroInvoiceEmailFailureCause)
        : null,
    invoiceEmailWithheldByNoEmails:
      payload.invoiceEmailWithheldByNoEmails === true,
    invoiceEmailWithheldByCreationChoice:
      payload.invoiceEmailWithheldByCreationChoice === true,
    invoiceEmailWithheldForEnvironment:
      payload.invoiceEmailWithheldForEnvironment === true,
  };
}
