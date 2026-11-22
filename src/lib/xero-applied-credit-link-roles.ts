/**
 * The `XeroObjectLink.role` that records one applied-credit allocation slice in
 * Xero (`localModel` "MemberCreditNoteAllocation"). One definition, read by the
 * allocation engine, its deallocation worker, the legacy repair and the
 * credit-note convergence (`INV-SSOT`).
 */
export const APPLIED_CREDIT_ALLOCATION_ROLE = "APPLIED_CREDIT_ALLOCATION";

/**
 * The role of the credit note the allocation engine mints for an
 * admin-adjustment remainder that has no Xero note of its own (`localModel`
 * "Payment"). Read by the engine and by the booking page's credit-note list
 * (`booking-credit-notes.ts`, #5066).
 */
export const APPLIED_CREDIT_REMAINDER_NOTE_ROLE = "APPLIED_CREDIT_REMAINDER_NOTE";
