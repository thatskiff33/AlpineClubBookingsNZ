/**
 * #3643 (`INV-PAY-107`): the reason stamped on the ledger row the cancel path
 * writes when it records a part payment Xero showed. A leaf, so the repair
 * classifier can recognise that population without importing the cancel-time
 * Xero reader.
 */
export const PART_PAYMENT_RECOGNISED_REASON = "xero_part_payment_recognised_at_cancel";
