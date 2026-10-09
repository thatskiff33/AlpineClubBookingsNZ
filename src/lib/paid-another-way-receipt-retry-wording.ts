/**
 * #3924 round 9 (`INV-PAY-122`): WHAT THE TREASURER IS TOLD TO DO when a late
 * card charge's Xero receipt reaches Xero only through an officer's retry -
 * the receipt row failed after it may already have reached Xero, which a close
 * never runs again (`keptReceiptHeldForOfficer`), or a change's invoice for the
 * charge failed (`invoiceFailed`). The close's refund note follows that retry.
 *
 * Pure and client-safe: the one home of the instruction, read by the
 * stuck-states dialog's promise, the toast after the close, and the close's
 * audit summary (`INV-SSOT`).
 */
export type PaidAnotherWayReceiptRetry = "held-for-officer" | "failed";

export function paidAnotherWayReceiptRetryInstruction(kind: PaidAnotherWayReceiptRetry): string {
  return kind === "held-for-officer"
    ? "This late card charge's Xero record failed and may already be in Xero: check Xero, then retry it from the Xero operations list"
    : "This late card charge's invoice failed to reach Xero: retry it from the Xero operations list";
}
