/**
 * Club-internal placeholder email for walk-in booking owners (issue #1935, E9).
 *
 * `Member.email` is non-nullable, but a phone/walk-in non-member booking owner
 * often has no email address. Instead of a schema change we store a recognisable
 * placeholder on the `.invalid` reserved TLD (RFC 2606 — never deliverable) so
 * that:
 *   - no outbound email is ever sent to that owner (see the guard in
 *     `sendEmail`, src/lib/email/core.ts),
 *   - the placeholder is never used for Xero contact email-matching and is never
 *     pushed to Xero as a real address (see the guards in xero-contacts.ts /
 *     xero-contact-sync.ts).
 *
 * This module is a dependency-free leaf (crypto only) so it can be imported from
 * the email core, the Xero contact layer, and the non-member-contact service
 * without introducing an import cycle.
 */
import { randomUUID } from "crypto";
import { DELETED_CONTACT_EMAIL_DOMAIN } from "./deleted-account-email";

export { DELETED_CONTACT_EMAIL_DOMAIN } from "./deleted-account-email";

/**
 * Reserved club-internal domain for walk-in placeholder addresses. `.invalid`
 * is guaranteed non-resolvable (RFC 2606), so a placeholder can never collide
 * with a real deliverable address.
 */
export const PLACEHOLDER_CONTACT_EMAIL_DOMAIN = "no-email.invalid";

/**
 * The other club-internal `.invalid` address this codebase mints: the
 * anonymised address written over a member's real one when a self-service
 * deletion request is approved (`deleted-xxxxxxxx@deleted.invalid`, see
 * `POST /api/admin/deletion-requests/[id]`).
 *
 * It was never recognised as undeliverable, which mattered once email
 * inheritance could resolve to an ancestor several generations up (#2255): a
 * grandchild could keep resolving to an anonymised grandparent and hard-bounce
 * on every send. It is deliverability-equivalent to a walk-in placeholder — a
 * reserved-TLD address nobody reads — so it is treated as one.
 */
/**
 * The third club-internal `.invalid` address, and the one with a story (#2716).
 *
 * `Member.email` on a dependant is a DENORMALISED COPY of whoever they inherit
 * from — kept so a reader can resolve an address without a join. When the source
 * departs (archived, cancelled, anonymised, hard-deleted) the pointer and the
 * choice are cleared, and that copy is all that is left. It is somebody else's
 * real, deliverable address sitting on a member who was never given it.
 *
 * The consequence found in review is the reason this domain exists. Nothing
 * clears the copy, so `resolveEffectiveEmail` falls through to it and every
 * booking confirmation, payment notice and renewal for the dependant keeps
 * arriving in the departed member's mailbox — while the dependant looks
 * perfectly reachable and therefore never appears on the unreachable surface.
 * For an ANONYMISED source that is the sharpest form of it: erasure rewrites the
 * member's own row and leaves their old address copied across their dependants'.
 *
 * Writing this over the stale copy resolves both halves at once. The address
 * becomes undeliverable, so the misrouting stops; and because the domain is in
 * {@link PLACEHOLDER_CONTACT_EMAIL_DOMAINS} the dependant is picked up by the
 * existing unreachable predicate with no new column to migrate. The domain is
 * distinct from the walk-in placeholder so the admin surface can say WHY —
 * "lost the address they used to inherit" reads very differently from "never had
 * one", and only the first tells an admin somebody's arrangement broke.
 *
 * The owner's decision (13 Aug 2026) is that visible unreachability beats silent
 * delivery to an adult nobody chose, and this is that decision applied to the
 * one place the pointer columns cannot reach.
 */
export const INHERITANCE_LOST_CONTACT_EMAIL_DOMAIN = "inheritance-lost.invalid";

/**
 * Every domain {@link isPlaceholderContactEmail} rejects. Exported so a SQL
 * filter that has to mirror that predicate (the admin "inherit email from"
 * candidate search) cannot list a subset and drift out of step with it.
 */
export const PLACEHOLDER_CONTACT_EMAIL_DOMAINS = [
  PLACEHOLDER_CONTACT_EMAIL_DOMAIN,
  DELETED_CONTACT_EMAIL_DOMAIN,
  INHERITANCE_LOST_CONTACT_EMAIL_DOMAIN,
] as const;

/**
 * Mint the address that replaces a stale inherited copy (#2716).
 *
 * Unique per member for the same reason walk-in placeholders are: the partial
 * `Member_email_login_unique` index does not apply to non-login rows, but two
 * members sharing a byte-identical stored string is a trap for any later code
 * that groups or matches on address.
 */
export function buildInheritanceLostEmail(): string {
  return `inheritance-lost-${randomUUID()}@${INHERITANCE_LOST_CONTACT_EMAIL_DOMAIN}`;
}

/**
 * Mint a fresh, unique placeholder address for a walk-in contact. Uniqueness
 * keeps distinct walk-ins on distinct stored strings even though the partial
 * `Member_email_login_unique` index (canLogin = true only) never applies to
 * these non-login contacts.
 */
export function buildPlaceholderContactEmail(): string {
  return `walk-in-${randomUUID()}@${PLACEHOLDER_CONTACT_EMAIL_DOMAIN}`;
}

/**
 * True when the address is a club-internal placeholder rather than a real one —
 * a walk-in contact who gave no address, or a member anonymised by an approved
 * deletion request. Case/whitespace-insensitive; matches on the reserved
 * domains.
 *
 * Callers use this to decide whether an address can RECEIVE mail, and both
 * domains answer "no", so both belong here rather than only the walk-in one.
 */
export function isPlaceholderContactEmail(
  email: string | null | undefined
): boolean {
  if (!email) return false;
  const normalized = email.trim().toLowerCase();
  return PLACEHOLDER_CONTACT_EMAIL_DOMAINS.some((domain) =>
    normalized.endsWith(`@${domain}`)
  );
}

/**
 * Specifically the "lost what they inherited" placeholder (#2716).
 *
 * A strict subset of {@link isPlaceholderContactEmail}: every address this
 * accepts, that one accepts too. It exists so the admin surface can report the
 * more specific reason, and it must be tested BEFORE the general predicate
 * anywhere the two compete, or the general one swallows it.
 */
export function isInheritanceLostEmail(
  email: string | null | undefined
): boolean {
  if (!email) return false;
  return email
    .trim()
    .toLowerCase()
    .endsWith(`@${INHERITANCE_LOST_CONTACT_EMAIL_DOMAIN}`);
}
