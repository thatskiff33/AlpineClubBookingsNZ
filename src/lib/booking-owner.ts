/**
 * WHO OWNS THIS BOOKING — the one home for the question (#3368, stage 3 of
 * programme #2912). `INV-SSOT-005`.
 *
 * ## What this is for, in one paragraph
 *
 * A booking's owner is the party the club invoices, emails, refunds, credits
 * and records audit rows against. Until this stage that party was read straight
 * off the row — `booking.memberId` and `booking.member` — in several hundred
 * places, every one of which assumed the answer is a person and that there
 * always is one. Stage 4 (#3369) makes the member link optional so a school
 * booking can be owned by its `Organisation`, and both assumptions stop being
 * true. This module is where that change gets to happen ONCE.
 *
 * ## TODAY THIS ACCESSOR IS THE IDENTITY, AND THAT IS THE POINT
 *
 * `Booking.memberId` is still `NOT NULL` and no booking is owned by anything
 * but a member, so every answer below is the answer the direct read already
 * gave — the same strings, the same object reference for the loaded row. That
 * is what makes a sweep of this size safe: there is no behaviour to preserve by
 * argument, because the value returned is the value that was there.
 *
 * The view is a FRESH object holding the row's own values, not the row itself.
 * Nothing downstream can reach past the ownership question into the rest of the
 * booking, so when stage 4 changes the body it changes everything the callers
 * can see — and the reviewer's question there is about this function, not about
 * five hundred call sites.
 *
 * ## The shape it hands back, and what stage 4 does with each part
 *
 * `memberId` — the owning MEMBER's id. Stage 4 widens it to `string | null`,
 * and every use of it then declares itself. The uses where a null is a
 * correctness bug rather than a display bug are named below.
 *
 * `member` — the owning member's record, exactly the columns the caller
 * selected, by reference. Stage 4 turns this into the person-shaped projection
 * of whichever party owns the booking. Today a school's owner is an invented
 * member whose `firstName` is the school's name and whose `lastName` is empty,
 * so an organisation that presents itself the same way produces the SAME
 * rendered bytes — which is why this stage deliberately does not reshape the
 * name, email or greeting at any call site. Reshaping them would have hidden
 * the one property stage 4 has to prove.
 *
 * ## DECISION — ownership comparisons (`INV-SSOT-005`)
 *
 * A large family of comparisons asks "is this booking the actor's own?", almost
 * all of them `bookingOwner(booking).memberId !== session.user.id`. The #2912
 * census measured ten; that was a floor taken on an older tree, and the real
 * figure is published by the census test rather than carried forward by hand —
 * a number restated in prose is a number that drifts.
 *
 * Every one of them is **unconditionally true** once the member id can be
 * `null`, so an organisation-owned booking falls through to the admin-only
 * branch. The decision, taken here rather than left to whatever a null does:
 *
 * - **A comparison against a session user stays a comparison against a member
 *   and keeps failing closed.** A signed-in person is a `Member`; an
 *   organisation is not, and never signs in. So "is this my booking?" is
 *   correctly "no" for an organisation-owned one, and nothing about that is
 *   accidental.
 * - **What must NOT stay accidental is the refusal a school liaison then
 *   meets.** Entitling a named person to act on their school's booking is a
 *   product change — it needs a rule about which `OrganisationContact` roles may
 *   do what — and it is deliberately NOT in this programme. Stage 4 carries the
 *   call-site list from the census below, so the refusal is a decision somebody
 *   took rather than a null falling through.
 * - **Until then the comparison keeps its present meaning and a school booking
 *   is officer-only**, which is what it is today: the invented school member has
 *   `canLogin: false` and has never been able to sign in, so no human has ever
 *   passed one of these comparisons on a school booking.
 *
 * ## DECISION — the credit-ledger and Xero keys that take a member id
 *
 * `lockMemberCreditLedger`, `getMemberCreditBalance` and
 * `findOrCreateXeroContact` are all keyed on a member. Handed an empty key they
 * either throw inside the helper or degenerate to a shared key, and a shared
 * advisory key is an `INV-LOCK` correctness hazard that shows up only under
 * concurrency rather than on a screen. The decision:
 *
 * - **The credit ledger stays a MEMBER ledger.** Credit belongs to a person's
 *   account; no organisation has one, and inventing an organisation ledger is a
 *   money change this programme does not make. So in stage 4 a booking with no
 *   member has no credit ledger to lock and no balance to read, and the callers
 *   skip both rather than passing an empty key. Every one of those call sites
 *   reads the owner through this module and is listed by the census test, so
 *   stage 4's change is a branch in a caller the compiler is already pointing at.
 * - **The Xero contact is already decided and already built.** Stage 2 (#3367)
 *   made the `Organisation` the invoiced and contacted party, and
 *   `findOrCreateXeroContactForInvoicedParty` is that decision's home. The
 *   member-keyed provider paths stage 2 left behind — a credit note, a
 *   modification credit note, a supplementary invoice on a returning school's
 *   EARLIER booking — are routed onto it by this stage, which is the obligation
 *   #3368 inherited in writing on 13 September 2026.
 *
 * ## DECISION — the audit subject: `INV-PRIV-018`
 *
 * Recorded in `docs/invariants/analytics-and-privacy.md`, not restated here.
 * In one line: an audit row's subject stays a PERSON, an organisation-owned
 * booking writes no subject member, and the booking itself carries the identity
 * through `entityType`/`entityId`. `INV-OPS-012` is untouched — no row already
 * written changes meaning, and no member's view of their own history moves.
 *
 * ## The guard
 *
 * `src/lib/__tests__/booking-owner-census.test.ts` fails when a new direct read
 * of a booking's member appears anywhere under `src/` or `scripts/`. It reads
 * the tree from disk and therefore has no import edge to what it scans, so
 * `npm run test:related` cannot select it: like the other censuses in that
 * directory it is CI-caught by design, and `npm run test:named` is how to run
 * it locally.
 */

/**
 * The narrowest thing that can be asked who owns it.
 *
 * A booking row, or any selection of one that loaded the member link, the
 * member id, or both — including the hand-written projections of a booking that
 * already declare the id nullable or optional. Both fields are optional HERE
 * and the guarantee is enforced on the way out instead: {@link BookingOwnerView}
 * exposes only the keys the caller's own type carries, so a value that has
 * neither produces a view with nothing readable on it. That is the safety
 * property worth having — you cannot read a field Prisma never fetched — and it
 * is the one an optional property cannot express on the way in, because an
 * optional `memberId` and an absent one are the same type.
 *
 * Nothing here widens a caller's answer: the view reports the id exactly as
 * that caller's own type declares it, `undefined` and `null` included.
 */
export type BookingOwnerSource = {
  readonly memberId?: string | null;
  readonly member?: unknown;
};

/**
 * What {@link bookingOwner} hands back for a given source shape: exactly the
 * parts the caller loaded, and nothing else.
 *
 * The conditional halves are what keep a caller that selected only `memberId`
 * from reading a `member` it never fetched — an `undefined.firstName` at
 * runtime, which is the class of failure this module exists to make unreachable
 * by accident.
 */
export type BookingOwnerView<B> = ("memberId" extends keyof B
  ? { readonly memberId: B["memberId"] }
  : unknown) &
  ("member" extends keyof B ? { readonly member: B["member"] } : unknown);

/**
 * THE ACCESSOR. Who owns this booking?
 *
 * Today: its member, unchanged and by reference. Stage 4 (#3369): its
 * organisation where it has one, and its member where it does not.
 *
 * Keys absent from the source stay absent from the view — `"member" in
 * bookingOwner(booking)` is false when the relation was not selected — so a
 * caller cannot read a field Prisma never fetched.
 */
export function bookingOwner<B extends BookingOwnerSource>(
  booking: B,
): BookingOwnerView<B> {
  const view: { memberId?: unknown; member?: unknown } = {};
  if ("memberId" in booking) view.memberId = booking.memberId;
  if ("member" in booking) view.member = booking.member;
  // The conditional return type cannot be proved from a runtime `in` test, so
  // the cast is the honest expression of what the two lines above just did.
  return view as BookingOwnerView<B>;
}
