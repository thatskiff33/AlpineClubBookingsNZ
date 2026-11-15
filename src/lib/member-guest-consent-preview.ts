/**
 * What the booking screens predict a "+ Add Member Guest" add will do, shown
 * beside the guest row before anything is saved (epic #2305, MG3 #2308, MG4
 * #2309): the club asks the person first (`PENDING`), tells them
 * (`NOTIFY_ONLY`), or placed them itself (`ADMIN_ASSIGNED`).
 *
 * The ONE definition of the set (`INV-SSOT`). The guest row type, the edit
 * panel's row type and the booking wizard's kept copy
 * (`src/lib/booking-wizard-work.ts`) all take it from here, so a fourth value
 * cannot be understood by the screen yet rejected by the copy that is kept for
 * a refresh. Display only: the server recomputes consent for itself.
 */
export const MEMBER_GUEST_CONSENT_PREVIEW_VALUES = [
  "PENDING",
  "NOTIFY_ONLY",
  "ADMIN_ASSIGNED",
] as const;

export type MemberGuestConsentPreview =
  (typeof MEMBER_GUEST_CONSENT_PREVIEW_VALUES)[number];
