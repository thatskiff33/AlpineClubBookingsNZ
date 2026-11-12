/**
 * #4986: the plain-English refusals for invoicing while the `xeroIntegration`
 * module is off. Client safe (no imports): the Subscriptions panel shows the
 * same words the server refuses with. The guard that decides is
 * `xero-invoicing-guard.ts` (`INV-INT-038`).
 */

/**
 * Every subscription-invoice refusal and the approval warning use this one
 * message. Worded "any … owed" because an approval warns before knowing whether
 * the new member owes a subscription at all.
 */
export const SUBSCRIPTION_INVOICING_XERO_OFF_MESSAGE =
  "Subscription invoicing is off because Xero is not enabled. Bill any subscription owed outside the app.";

/**
 * The refusal a subscription writer throws while Xero is off; routes map it to
 * a 409 with its message. Lives here, not in the guard, so a test can replace
 * the guard without losing the class.
 */
export class XeroInvoicingOffError extends Error {
  readonly status = 409;

  constructor(message: string = SUBSCRIPTION_INVOICING_XERO_OFF_MESSAGE) {
    super(message);
    this.name = "XeroInvoicingOffError";
  }
}

/**
 * The joining-fee counterpart, raised on application approval. Conditional,
 * because the approval does not know whether a fee applies (an exempt
 * organisation, or no fee configured, owes none).
 */
export const JOINING_FEE_INVOICING_XERO_OFF_MESSAGE =
  "Joining-fee invoicing is off because Xero is not enabled. If a joining fee applies, invoice it outside the app.";

/**
 * The preview exception raised when the subscriptionIncome mapping is not set.
 * With Xero off it is not the reason nothing can be invoiced, so the panel
 * hides it behind the message above rather than pointing at a hidden screen.
 */
export const MISSING_XERO_ACCOUNT_MAPPING_CODE = "MISSING_XERO_ACCOUNT_MAPPING";
