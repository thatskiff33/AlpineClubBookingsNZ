/**
 * #5061 follow-up (`INV-PAY-154`): what a disputed reduction hands to the
 * treasurer - the whole reduction on the credit tier, as a disputed paid
 * cancel's hand-back is (`cancelRefundDisposition`), whatever the member chose.
 *
 * Pure and client-safe, so the save (`resolveSelectedSettlementAmount`) and
 * the edit screen's notice read the one rule (`INV-SSOT`).
 */
export function heldForDisputeSettlementCents(options: { accountCreditAmountCents: number }): number {
  return options.accountCreditAmountCents;
}
