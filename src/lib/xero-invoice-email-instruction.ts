/**
 * THE CREATION-TIME DELIVERY INSTRUCTION FOR A XERO INVOICE EMAIL (#2929, MAD
 * epic #2725).
 *
 * ## The rule, in one paragraph
 *
 * When an administrator creates a booking on somebody else's behalf the admin
 * booking page asks whether to email the member. Choosing **not** to email now
 * also withholds the invoice email XERO sends for THAT invoice creation. The
 * invoice is still raised and still AUTHORISED, exactly as before; the only
 * thing that changes is that nobody asks Xero to send it. Nothing persistent
 * moves: `Booking.noEmails` is untouched, the Xero contact keeps its address,
 * and every later booking email is decided by the ordinary rules.
 * `INV-LOCKOUT-041` is the standing rule; #2929 is the deciding issue.
 *
 * ## WHY THIS IS A PERSISTED INSTRUCTION AND NOT A FUNCTION PARAMETER
 *
 * The invoice is not raised by the request that created the booking. The create
 * enqueues an outbox operation and returns; a worker picks it up, and an
 * operator retry may pick it up again hours or days later. A parameter carried
 * in memory is gone by then, and "the flag is gone, so send it" is precisely the
 * failure this has to make impossible — the member would receive the email the
 * officer chose to withhold, from a retry nobody watched.
 *
 * So the instruction is written once, onto the operation row itself, and every
 * dispatcher reads it back from there. {@link readXeroInvoiceEmailInstruction}
 * is the only way to turn what is stored into something typed, so an unknown or
 * corrupt value can never be mistaken for a WITHHOLD: it parses to `null`,
 * which callers read as "no instruction was recorded", which is what every row
 * written before this feature existed honestly is.
 *
 * `null` is then treated exactly like `SEND`, and that is FAIL-OPEN on purpose.
 * The member owes this invoice and the email is how they learn it, so a typo in
 * a future enqueuer must not silently stop invoices reaching members. Do not
 * read across from the per-booking "No emails" switch, which fails CLOSED on an
 * unknown answer: there the unknown is "did an administrator promise this member
 * silence?", and breaking that promise is the direction you cannot take back.
 * The two adjacent withhold mechanisms genuinely have opposite failure modes.
 *
 * ## WHY A COLUMN RATHER THAN THE QUEUED PAYLOAD
 *
 * `XeroSyncOperation.requestPayload` is REWRITTEN WHOLESALE during execution —
 * `createXeroInvoiceForBooking` replaces it with the Xero invoice request before
 * the first provider call, and `retryXeroWriteWithContactRepair` replaces it
 * again on a contact repair. Both drop `queueType` and everything else the
 * enqueue put there; the schema comment on `queueType` says so in those words.
 * An instruction stored in the payload would therefore survive the happy path
 * and vanish exactly when it is needed: on the retry of a run that got as far as
 * the payload rewrite and then failed. The column is immutable after enqueue for
 * the same reason `queueType` is, and that is a property of where it lives
 * rather than a rule somebody has to remember.
 *
 * The column is `XeroSyncOperation.invoiceEmailDelivery` — it names how this
 * invoice email is to be DELIVERED, while the values below are the INSTRUCTION
 * that answers it. Nothing else may read that column directly; going through
 * {@link readXeroInvoiceEmailInstruction} is what makes an unrecognised value
 * safe.
 */

/** Send the invoice email, subject to every other gate. The default. */
export const XERO_INVOICE_EMAIL_SEND = "SEND";

/**
 * Do not ask Xero to email this invoice, because the administrator who created
 * the booking chose not to email the member. A business-rule withhold: nothing
 * failed, and it is not the per-booking "No emails" switch.
 */
export const XERO_INVOICE_EMAIL_WITHHELD_AT_CREATION = "WITHHELD_AT_CREATION";

export type XeroInvoiceEmailInstruction =
  | typeof XERO_INVOICE_EMAIL_SEND
  | typeof XERO_INVOICE_EMAIL_WITHHELD_AT_CREATION;

/**
 * Parse what is stored on the operation row.
 *
 * `null` for anything this module does not recognise, including `null` itself:
 * every operation enqueued before #2929, and every operation whose enqueuer has
 * no creation-time choice to express, carries nothing here and must behave
 * exactly as it did before.
 */
export function readXeroInvoiceEmailInstruction(
  value: unknown,
): XeroInvoiceEmailInstruction | null {
  return value === XERO_INVOICE_EMAIL_SEND ||
    value === XERO_INVOICE_EMAIL_WITHHELD_AT_CREATION
    ? value
    : null;
}

/**
 * The admin booking page's per-create email choice, as an instruction.
 *
 * Both answers are recorded rather than only the withhold, so an operator
 * reading the operation row can tell "the officer chose to send" apart from "no
 * choice was expressed here at all" — a member's own booking, a waitlist
 * confirmation, an officer repair. Only {@link XERO_INVOICE_EMAIL_WITHHELD_AT_CREATION}
 * changes any behaviour.
 */
export function xeroInvoiceEmailInstructionForNotifyChoice(
  notifyMember: boolean,
): XeroInvoiceEmailInstruction {
  return notifyMember
    ? XERO_INVOICE_EMAIL_SEND
    : XERO_INVOICE_EMAIL_WITHHELD_AT_CREATION;
}

/**
 * Whether a stored instruction withholds the invoice email.
 *
 * THE SUPPRESSION CONDITION, in one place, so the create path reads the rule
 * rather than restating it and a test can name it.
 */
export function xeroInvoiceEmailIsWithheldAtCreation(
  instruction: XeroInvoiceEmailInstruction | null,
): boolean {
  return instruction === XERO_INVOICE_EMAIL_WITHHELD_AT_CREATION;
}
