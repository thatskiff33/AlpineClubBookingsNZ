/**
 * WHAT A XERO CONTACT'S STATUS MEANS, asked in one place (`INV-SSOT`, #3058).
 *
 * `XeroContactCache.contactStatus` is a free-text copy of Xero's own
 * `ContactStatusEnum`, and before this module three separate readers each
 * decided for themselves which values counted as a live contact:
 *
 * - the missing-contact census (`INV-INT-022`) filtered its cache read to
 *   `contactStatus: "ACTIVE"` — an ALLOWLIST;
 * - the contact-group member import skipped anything whose status was not
 *   `ACTIVE` — a second ALLOWLIST, spelled differently;
 * - the erased-member contact review (`INV-INT-024`) treated `ARCHIVED` as
 *   archived and EVERYTHING ELSE as active — a DENYLIST, which is the opposite
 *   reading of the same column.
 *
 * Those three cannot all be right, and the provider's enum already has a value
 * that splits them. `Contact.ContactStatusEnum` is `ACTIVE`, `ARCHIVED` and
 * **`GDPRREQUEST`** — a contact somebody has asked Xero to erase. The two
 * allowlists correctly refuse it; the denylist reported it to a treasurer as
 * "Active in Xero", which is the single row on that screen most certainly
 * needing no further attention. Add Xero's fourth status tomorrow and one file
 * would have changed while two kept saying the opposite about the same contact
 * on the same admin page.
 *
 * So the question has one home. A reader asks {@link classifyXeroContactStatus}
 * when it needs to tell the cases apart, or {@link isActiveXeroContactStatus}
 * when all it needs is "may this contact still be used".
 *
 * Deliberately a LEAF: it imports nothing, not even `xero-node`, so a client
 * component may key its operator copy on {@link XeroContactLiveness} without
 * dragging the provider SDK onto the browser graph (`INV-OPS-013`).
 */

/**
 * What this application understands a contact's status to be.
 *
 * - `ACTIVE` — usable: invoice it, link it, import from it.
 * - `ARCHIVED` — retired in Xero by whoever administers it.
 * - `GDPR_ERASED` — Xero's `GDPRREQUEST`: somebody has asked for this contact
 *   to be erased IN XERO. Not active, and not something anybody here should be
 *   asked to look at again.
 * - `UNRECOGNISED` — a status string this application does not know. Treated as
 *   not-active everywhere, because a value we cannot read is not a value we may
 *   act on; surfaced distinctly so a new provider status shows up as itself
 *   rather than silently joining whichever bucket the last `else` happened to
 *   be.
 */
export type XeroContactLiveness =
  | "ACTIVE"
  | "ARCHIVED"
  | "GDPR_ERASED"
  | "UNRECOGNISED";

/**
 * Xero's own spellings, as they arrive in the cache column.
 *
 * `XERO_CONTACT_STATUS_ACTIVE` is also what a Prisma `where` filters on, since
 * a database filter cannot call {@link isActiveXeroContactStatus}. Same fact,
 * spelled the way SQL needs it, so the census and the classifier cannot drift.
 */
export const XERO_CONTACT_STATUS_ACTIVE = "ACTIVE";
export const XERO_CONTACT_STATUS_ARCHIVED = "ARCHIVED";
export const XERO_CONTACT_STATUS_GDPR_REQUEST = "GDPRREQUEST";

export function classifyXeroContactStatus(
  raw: string | null | undefined,
): XeroContactLiveness {
  const status = raw?.trim().toUpperCase();
  if (!status) return "UNRECOGNISED";
  switch (status) {
    case XERO_CONTACT_STATUS_ACTIVE:
      return "ACTIVE";
    case XERO_CONTACT_STATUS_ARCHIVED:
      return "ARCHIVED";
    case XERO_CONTACT_STATUS_GDPR_REQUEST:
      return "GDPR_ERASED";
    default:
      return "UNRECOGNISED";
  }
}

/**
 * May this contact still be used — invoiced, linked, imported from?
 *
 * Only `ACTIVE` answers true. This is the ALLOWLIST half, and it is the half a
 * reader wants whenever the question is "go or no-go" rather than "which kind
 * of no".
 */
export function isActiveXeroContactStatus(
  raw: string | null | undefined,
): boolean {
  return classifyXeroContactStatus(raw) === "ACTIVE";
}
