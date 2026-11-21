/**
 * The `XeroObjectLink.role`s a credit note's allocation to an invoice is linked
 * with (`xeroObjectType` "ALLOCATION"). A leaf, so the Xero operation funnel
 * (`completeXeroSyncOperation`, #5289 B) can tell a note's own allocation apart
 * without loading the clearing-note readers; `xero-clearing-allocations.ts`
 * re-exports both (`INV-SSOT`).
 */

/** The role a note's own allocation links carry: the builder's, its PARTIAL retry's and the inbound mirror's. */
export const NOTE_ALLOCATION_ROLE = "MODIFICATION_CREDIT_NOTE_ALLOCATION";

/**
 * #4767: the role `allocateCreditNoteToInvoice` gives a link when its caller
 * names none. Before #4757 the repair tool could offer a note's own failed
 * allocation row its generic ALLOCATE retry, which links with this role.
 */
export const ROLELESS_ALLOCATION_ROLE = "CREDIT_NOTE_ALLOCATION";
