/**
 * The deliberately non-deliverable address a copy puts on a Xero contact
 * (ENV-SAFETY 3, #3036; epic #2986; INV-CONFIG-005).
 *
 * WHY A SEPARATE ADDRESS AT ALL, when #3035 already stops this application
 * emailing members. Because Xero emails an invoice from ITS OWN SERVERS to the
 * address stored on the contact, and it does so for outstanding `AUTHORISED`
 * invoices with no API call from here whatsoever. Suppressing our own sends and
 * suppressing `emailInvoice` cover every message we choose to send; they cover
 * nothing Xero decides to send on its own account. The only thing that reaches
 * Xero's own reminder is the address Xero holds, so on a copy that address has
 * to stop being a member's.
 *
 * WHY IT MUST NOT BE ONE OF THE THREE EXISTING `.invalid` DOMAINS, and this is
 * the sharpest rule in the file. `no-email.invalid`, `deleted.invalid` and
 * `inheritance-lost.invalid` all mean something about the MEMBER: they are what
 * `isPlaceholderContactEmail()` accepts, and that predicate has references
 * across the mailer, the reminder crons, email inheritance, non-member contacts,
 * deleted accounts and three Xero modules. Every one of them reads "this person
 * cannot be reached". A contained member CAN be reached — on the live site, by
 * the club, tomorrow — and a copy that reported them unreachable would change
 * booking flows, reminder crons and admin surfaces, so the copy would stop
 * behaving like production. That would destroy the property this whole issue
 * exists to preserve: invoices stay `AUTHORISED`, so realistic settlement
 * behaviour stays testable. So the domain here is its own, it is NEVER added to
 * `PLACEHOLDER_CONTACT_EMAIL_DOMAINS`, and the two predicates are disjoint by
 * construction — asserted both ways in `xero-sandbox-contact-email.test.ts`.
 *
 * WHY IT IS A HASH AND NOT THE ADDRESS. Containment has to be DETERMINISTIC —
 * the same real address always maps to the same contained address, or a restored
 * copy could not tell whether a contact it is looking at is already contained,
 * and nothing could be reconciled afterwards. Determinism could equally have
 * been had by mangling the address in place (`member+contained@example.com`,
 * `contained.member@example.com.invalid`), and both were rejected for the same
 * reason: the contained address is then a member's real address, sitting in
 * plain sight in the club's accounting system and on any operator screen that
 * reports containment. A SHA-256 keeps the determinism and carries no address.
 *
 * NOT SALTED, deliberately, and the reason is worth stating because "unsalted
 * hash of low-entropy input" is normally a finding. A salt would have to be
 * either per-installation — which breaks determinism across the restore this
 * feature exists for, since the copy and its source would derive different
 * addresses — or a shared constant, which is not a salt. And there is nothing to
 * protect: the audience for a contained address is whoever can read the copy's
 * Xero organisation, and they can also read the copy's database, which holds
 * every member's real address in plain text. The hash is here so an address does
 * not travel somewhere it has no business being, not to withstand an attacker
 * who already has the plaintext.
 *
 * A DEPENDENCY-FREE LEAF (crypto plus the placeholder leaf, which is itself
 * crypto-only). No Prisma, no environment read, no role: this file knows how to
 * spell a contained address and nothing about WHEN to use one. That decision is
 * `xero-contact-containment.ts`, which is the only module that reads the
 * environment role, and the split is what lets every address rule here be tested
 * without a database.
 */

import { createHash } from "crypto";

import { isPlaceholderContactEmail } from "@/lib/placeholder-contact-email";

/**
 * The reserved domain contained addresses live on.
 *
 * `.invalid` is reserved by RFC 2606 and guaranteed never to resolve, so a
 * contained address cannot collide with a real deliverable one and cannot be
 * delivered even by a provider that tries. Distinct from all three
 * placeholder domains — see the module docblock for why that separation is
 * load-bearing rather than cosmetic.
 */
export const XERO_SANDBOX_CONTACT_EMAIL_DOMAIN = "xero-sandbox.invalid";

/**
 * The local-part prefix. Present so a human reading the club's Xero contacts can
 * see at a glance what happened to them, and so the address is greppable in a
 * provider export.
 */
const XERO_SANDBOX_LOCAL_PART_PREFIX = "contained-";

/**
 * How much of the digest the address carries.
 *
 * 32 hex characters is 128 bits. The population is one address per Xero contact
 * — thousands, not billions — so this is far past the point where a collision is
 * a consideration; it is short enough to keep the whole address inside every
 * provider field limit (63 characters in total, against Xero's 255).
 */
const XERO_SANDBOX_DIGEST_LENGTH = 32;

/** Case- and whitespace-insensitive comparison, spelled once. */
function normalizeAddress(email: string | null | undefined): string {
  return (email ?? "").trim().toLowerCase();
}

/**
 * True when this address is already one of ours.
 *
 * Used by {@link toXeroSandboxContactEmail} to stay idempotent and by the
 * containment gate to recognise a contact it has already dealt with. It accepts
 * ONLY the sandbox domain: a placeholder is not a contained address and a
 * contained address is not a placeholder.
 */
export function isXeroSandboxContactEmail(
  email: string | null | undefined,
): boolean {
  const normalized = normalizeAddress(email);
  if (!normalized) return false;
  return normalized.endsWith(`@${XERO_SANDBOX_CONTACT_EMAIL_DOMAIN}`);
}

/**
 * The address this application would push to Xero for a member holding `email`.
 *
 * It exists because the two contact payload builders in `xero-contacts.ts`
 * already normalise a club-internal placeholder to the empty string before it
 * reaches Xero (#1935), and the containment fingerprint has to agree with them
 * exactly or the fast path misses on every walk-in owner and re-reads their
 * contact from the provider on every single invoice. One spelling of that rule,
 * consumed by both sides.
 */
export function xeroPushableContactEmail(
  email: string | null | undefined,
): string {
  const trimmed = (email ?? "").trim();
  if (!trimmed) return "";
  return isPlaceholderContactEmail(trimmed) ? "" : trimmed;
}

/**
 * The contained form of an address.
 *
 * Four properties, each of them tested:
 *
 * - **Deterministic.** The same address always maps to the same contained
 *   address, on this installation and on any other, for ever.
 * - **Idempotent.** Given a contained address it returns it unchanged, so
 *   nothing can double-wrap. That matters because the address travels back out
 *   of Xero and into a payload again on the next contact update; a wrapper that
 *   wrapped its own output would mint a fresh address on every sync and make
 *   containment undetectable.
 * - **Blank stays blank, and a placeholder is returned UNTRANSFORMED.** Both are
 *   already non-deliverable, and wrapping a placeholder would silently move a
 *   member out of `isPlaceholderContactEmail()`'s answer — see the module
 *   docblock for what that breaks. In practice the payload builders normalise a
 *   placeholder to `""` before this function sees it; the passthrough is the
 *   belt to that braces.
 * - **Non-deliverable.** RFC 2606 reserves `.invalid`.
 */
export function toXeroSandboxContactEmail(
  email: string | null | undefined,
): string {
  const trimmed = (email ?? "").trim();
  if (!trimmed) return "";
  if (isXeroSandboxContactEmail(trimmed)) return trimmed;
  if (isPlaceholderContactEmail(trimmed)) return trimmed;
  const digest = createHash("sha256")
    .update(normalizeAddress(trimmed))
    .digest("hex")
    .slice(0, XERO_SANDBOX_DIGEST_LENGTH);
  return `${XERO_SANDBOX_LOCAL_PART_PREFIX}${digest}@${XERO_SANDBOX_CONTACT_EMAIL_DOMAIN}`;
}

/**
 * The contained address a member's CURRENT stored address maps to — the value
 * the containment record carries and compares against.
 *
 * Composed rather than written out so the fingerprint cannot drift from what the
 * payload builders send: pushable-normalise first (placeholder and blank both
 * become `""`), then contain.
 */
export function xeroSandboxContainmentTarget(
  email: string | null | undefined,
): string {
  return toXeroSandboxContactEmail(xeroPushableContactEmail(email));
}

/**
 * True when the address Xero is holding cannot reach anybody, whatever the
 * reason.
 *
 * This is the CONTACT-side question, and it is deliberately wider than
 * {@link isXeroSandboxContactEmail}: a contact with no address at all, or one
 * carrying a club-internal placeholder, is already unable to reach a member, so
 * rewriting it would spend a provider call and change nothing. Narrow this and
 * every walk-in owner's contact gets a pointless write; widen it to accept a
 * real address and containment becomes a no-op that claims to have happened.
 */
export function isXeroContactEmailUnreachable(
  email: string | null | undefined,
): boolean {
  const trimmed = (email ?? "").trim();
  if (!trimmed) return true;
  return (
    isXeroSandboxContactEmail(trimmed) || isPlaceholderContactEmail(trimmed)
  );
}
