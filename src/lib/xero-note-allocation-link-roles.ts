/**
 * The `XeroObjectLink.role`s a credit note's allocation to an invoice is linked
 * with (`xeroObjectType` "ALLOCATION"). A leaf, so the Xero operation funnel
 * (`completeXeroSyncOperation`, #5289 B) can tell a note's own allocation apart
 * without loading the clearing-note readers; `xero-clearing-allocations.ts`
 * re-exports the roles and the readers' filter (`INV-SSOT`).
 */

/** The role a note's own allocation links carry: the builder's, its PARTIAL retry's and the inbound mirror's. */
export const NOTE_ALLOCATION_ROLE = "MODIFICATION_CREDIT_NOTE_ALLOCATION";

/**
 * #4767: the role `allocateCreditNoteToInvoice` gives a link when its caller
 * names none. Before #4757 the repair tool could offer a note's own failed
 * allocation row its generic ALLOCATE retry, which links with this role.
 */
export const ROLELESS_ALLOCATION_ROLE = "CREDIT_NOTE_ALLOCATION";

/**
 * Pure (#4786): the money readers' role-and-anchor filter for allocation
 * links found by their invoice: the note's own role, or the role-less one on
 * the note's own anchor. A payment's role-less links mirror its refund and
 * account notes, which its direct refund total counts, so they are never read
 * as a clearing or edit note's allocation.
 */
export const CLEARING_ALLOCATION_LINK_WHERE = {
  OR: [{ role: NOTE_ALLOCATION_ROLE }, { role: ROLELESS_ALLOCATION_ROLE, localModel: { not: "Payment" } }],
};

/** The same rule for one link in hand, so a writer names exactly the links those readers count (#5289 B). */
export function isClearingAllocationLinkRoleAndAnchor(link: { role: string; localModel: string }): boolean {
  return link.role === NOTE_ALLOCATION_ROLE || (link.role === ROLELESS_ALLOCATION_ROLE && link.localModel !== "Payment");
}
