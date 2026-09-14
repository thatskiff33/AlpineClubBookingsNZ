/**
 * WHO OWNS THIS BOOKING — the one home for the question (#3368, stage 3 of
 * programme #2912; widened by #3369, stage 4). `INV-SSOT-005`.
 *
 * ## What this is for, in one paragraph
 *
 * A booking's owner is the party the club invoices, emails, refunds, credits
 * and records audit rows against. Until stage 3 that party was read straight
 * off the row — `booking.memberId` and `booking.member` — in several hundred
 * places, every one of which assumed the answer is a person and that there
 * always is one. Stage 4 (#3369) makes the member link optional so a school
 * booking is owned by its `Organisation`, and both assumptions stop being true.
 * This module is where that change happened ONCE.
 *
 * ## WHAT STAGE 4 CHANGED, AND WHAT IT DELIBERATELY DID NOT
 *
 * `Booking.memberId` is now nullable and a booking is owned by **exactly one
 * of** a member or an organisation — enforced by the `Booking_owner_exactly_one`
 * CHECK constraint, not by convention. So the accessor is no longer the
 * identity it was at stage 3, and the two halves of its answer went different
 * ways on purpose:
 *
 * - **`member` stays non-null and stays person-shaped.** Where a booking has no
 *   member, the view is built from the organisation: its name in `firstName`,
 *   an empty `lastName`, its recorded address in `email`. That is exactly what
 *   the invented school member carried before this stage — school name in
 *   `firstName`, `lastName` empty, the request's contact address — so the three
 *   hundred call sites that render a booking's owner render the same bytes they
 *   rendered yesterday and were not touched. Stage 3 promised this in writing
 *   and it is why that stage refused to reshape any name, email or greeting.
 * - **`memberId` becomes `string | null`, and every use of it declares itself.**
 *   An organisation is not a member and has no member id; handing one out under
 *   that name is precisely the school-as-person model this programme exists to
 *   end.
 *
 * ## THE PROJECTION'S CONTRACT — three fields an organisation can answer
 *
 * `firstName`, `lastName` and `email` are the fields a party presents itself
 * by, and an organisation answers all three. **Every other member column the
 * caller selected widens to include `undefined`**, because an organisation has
 * no answer to it: there is no member id, no age tier, no `canLogin`, no
 * hut-leader eligibility. `undefined` rather than `null` because the value is
 * genuinely ABSENT — the projection does not carry the key at all — and a type
 * that said `null` would be describing a value nothing ever writes.
 *
 * Two consequences worth stating because they are easy to misread:
 *
 * - A member-owned booking still hands back the member row BY REFERENCE, with
 *   every selected column present. The widening is what the TYPE promises, not
 *   what the value contains. A caller that needs a member id therefore gets one
 *   whenever there is one, and is made to say what it does when there is not.
 * - A school's name is no longer truncated at a hundred characters. The
 *   invented member carried it in `firstName`, which is `VarChar(100)`;
 *   `Organisation.name` holds two hundred. A school with a very long name is
 *   rendered correctly now and was rendered cut off before. That is a
 *   correction, and it is the only rendered byte this stage changes.
 *
 * ## `email`, and why an empty string is the honest answer
 *
 * `Organisation.email` is nullable — a school may only ever be reachable
 * through a named teacher, and inventing an address to fill a column is the
 * class of thing this programme exists to stop. The projection therefore falls
 * back to `""`, which is the same third answer `organisationContactEmail()`
 * gives the Xero contact builder (stage 2, #3367): no recorded address, said
 * plainly, rather than a fabricated one.
 *
 * No school reaching this from history loses an address: the classification
 * backfill carries the invented member's own `email` onto the organisation
 * where the organisation has none, so a row that had an address keeps it.
 * `bookingOwnerEmail()` below is what a caller that must actually SEND
 * somewhere uses, because "" is not a destination.
 *
 * ## DECISION — ownership comparisons (`INV-SSOT-005`)
 *
 * A large family of comparisons asks "is this booking the actor's own?", almost
 * all of them `bookingOwner(booking).memberId !== session.user.id`. The list is
 * published by the census test rather than carried forward by hand — a number
 * restated in prose is a number that drifts.
 *
 * Every one of them is **unconditionally true** now that the member id can be
 * `null`, so an organisation-owned booking falls through to the admin-only
 * branch. The decision, taken at stage 3 and unchanged here:
 *
 * - **A comparison against a session user stays a comparison against a member
 *   and keeps failing closed.** A signed-in person is a `Member`; an
 *   organisation is not, and never signs in. So "is this my booking?" is
 *   correctly "no" for an organisation-owned one, and nothing about that is
 *   accidental.
 * - **What must NOT stay accidental is the refusal a school liaison then
 *   meets.** Entitling a named person to act on their school's booking is a
 *   product change — it needs a rule about which `OrganisationContact` roles may
 *   do what — and it is deliberately NOT in this programme. The refusal is a
 *   decision somebody took, recorded here, rather than a null falling through.
 * - **A school booking is officer-only**, which is what it is today: the
 *   invented school member had `canLogin: false` and never signed in, so no
 *   human has ever passed one of these comparisons on a school booking. Nothing
 *   a person could do yesterday becomes impossible today.
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
 *   money change this programme does not make. So a booking with no member has
 *   no credit ledger to lock and no balance to read, and the callers skip both
 *   rather than passing an empty key. Every one of those call sites is listed by
 *   the census test, and stage 4 branched at each of them — the compiler made
 *   them unmissable, because `memberId` stopped being a `string`.
 * - **The Xero contact is already decided and already built.** Stage 2 (#3367)
 *   made the `Organisation` the invoiced and contacted party, and
 *   `findOrCreateXeroContactForInvoicedParty` is that decision's home; the
 *   member-keyed provider paths route onto it.
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
 * it locally. The accessor's own behaviour is unit-tested in
 * `src/lib/__tests__/booking-owner.test.ts`.
 */

/**
 * The parts of an organisation the owner projection is built from.
 *
 * Written out rather than taken as `unknown` on purpose: a caller that selects
 * the organisation but not these two columns gets a type error at the accessor
 * instead of a projection with `undefined` in it. `name` is what a party is
 * called; `email` is where the club reaches it, nullable because a school may
 * have no address of its own.
 */
export type BookingOwnerOrganisation = {
  readonly name: string;
  readonly email?: string | null;
};

/**
 * The narrowest thing that can be asked who owns it.
 *
 * A booking row, or any selection of one that loaded the member link, the
 * member id, the organisation, or any combination — including the hand-written
 * projections of a booking that already declare the id nullable or optional.
 * Every field is optional HERE and the guarantee is enforced on the way out
 * instead: {@link BookingOwnerView} exposes only the keys the caller's own type
 * carries, so a value that has none produces a view with nothing readable on
 * it. That is the safety property worth having — you cannot read a field Prisma
 * never fetched — and it is the one an optional property cannot express on the
 * way in, because an optional `memberId` and an absent one are the same type.
 *
 * Nothing here widens a caller's answer beyond what stage 4 genuinely made
 * uncertain: the view reports the member id exactly as that caller's own type
 * declares it, `undefined` and `null` included.
 */
export type BookingOwnerSource = {
  readonly memberId?: string | null;
  readonly member?: unknown;
  readonly organisationId?: string | null;
  readonly organisation?: BookingOwnerOrganisation | null;
};

/**
 * The three fields the projection answers for either kind of owner.
 *
 * Everything else a caller selected is a fact about a MEMBER, and an
 * organisation-owned booking has no member to have it.
 */
type OwnerPersonKey = "firstName" | "lastName" | "email";

/**
 * A selected member shape, seen as the owner presents itself.
 *
 * The three person keys keep the caller's own types. Every other key gains
 * `undefined`, which is exactly what the projection contains for an
 * organisation-owned booking: the key is not there.
 */
export type BookingOwnerPerson<M> = {
  readonly [K in keyof M]: K extends OwnerPersonKey ? M[K] : M[K] | undefined;
};

/**
 * What {@link bookingOwner} hands back for a given source shape: exactly the
 * parts the caller loaded, and nothing else.
 *
 * The conditional halves are what keep a caller that selected only `memberId`
 * from reading a `member` it never fetched — an `undefined.firstName` at
 * runtime, which is the class of failure this module exists to make unreachable
 * by accident.
 *
 * `member` is non-null **only when the caller also selected the organisation**,
 * because that is the only case in which the projection can be built. A caller
 * that selected the member alone keeps the member's own nullability and says
 * for itself what a school booking means to it — which for a member-only query
 * (`where: { memberId: { not: null } }`, a member's own booking list) is
 * usually nothing at all.
 */
export type BookingOwnerView<B> = ("memberId" extends keyof B
  ? { readonly memberId: B["memberId"] }
  : unknown) &
  ("member" extends keyof B
    ? "organisation" extends keyof B
      ? { readonly member: BookingOwnerPerson<NonNullable<B["member"]>> }
      : { readonly member: B["member"] }
    : unknown);

/**
 * A booking that is owned by neither a member nor an organisation.
 *
 * Unreachable while `Booking_owner_exactly_one` holds, which is why this throws
 * rather than returning an empty owner: a booking nobody owns cannot be
 * invoiced, emailed or refunded, and rendering a blank name would hide that
 * from the person who could still fix it. Failing closed is the rule the whole
 * of stage 4 is built on.
 */
export class BookingOwnerMissingError extends Error {
  constructor() {
    super(
      "This booking has neither a member nor an organisation, which the " +
        "Booking_owner_exactly_one constraint forbids (#3369). Nothing can " +
        "read its owner until that row is repaired.",
    );
    this.name = "BookingOwnerMissingError";
  }
}

/**
 * THE ACCESSOR. Who owns this booking?
 *
 * Its member where it has one, by reference and unchanged. Its organisation
 * where it has not, projected into the same person shape the invented school
 * member used to present.
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
  if ("member" in booking) {
    if (booking.member != null || !("organisation" in booking)) {
      // Either there is a member — hand back the row itself, byte for byte, as
      // every stage before this one did — or the caller did not load the
      // organisation and keeps its own nullability.
      view.member = booking.member;
    } else {
      if (booking.organisation == null) throw new BookingOwnerMissingError();
      view.member = {
        firstName: booking.organisation.name,
        lastName: "",
        email: booking.organisation.email ?? "",
      };
    }
  }
  // The conditional return type cannot be proved from a runtime `in` test, so
  // the cast is the honest expression of what the lines above just did.
  return view as BookingOwnerView<B>;
}

/**
 * The owner, as PROVIDER METADATA: exactly one key, naming what the owner is.
 *
 * Stripe metadata is a flat map of strings, and every booking-scoped intent the
 * club creates carries its owner in one. Before #3369 that was always
 * `memberId`, because a school WAS an invented member. Writing a school's
 * organisation id under the name `memberId` would carry the school-as-person
 * model straight into the provider, where nothing can correct it later and
 * where a reconciliation reading it back would look up a member that does not
 * exist.
 *
 * So a school's intent carries `organisationId` instead, and a person's carries
 * `memberId` exactly as before. Spread it into the metadata literal. Every
 * reader that matters keys on `bookingId`, which is unchanged.
 */
export function bookingOwnerProviderMetadata(
  booking: BookingOwnerSource & { organisationId?: string | null },
): { memberId: string } | { organisationId: string } {
  const memberId = bookingOwner(booking).memberId;
  if (memberId) return { memberId };
  if (booking.organisationId) return { organisationId: booking.organisationId };
  throw new BookingOwnerMissingError();
}

/**
 * Where the club can actually SEND to for this booking, or `null`.
 *
 * The projection's `email` is `""` for an organisation with no recorded
 * address, because "no address" is the truth and an invented one is not. `""`
 * is not a destination, though, so anything that addresses a message asks this
 * instead of reading the field: it turns the honest blank into an explicit
 * `null` the caller has to handle, rather than a send that silently goes
 * nowhere.
 */
export function bookingOwnerEmail(
  booking: BookingOwnerSource & { member?: { email?: string | null } | null },
): string | null {
  const owner = bookingOwner(booking);
  const email = "member" in owner ? owner.member?.email : null;
  const trimmed = typeof email === "string" ? email.trim() : "";
  return trimmed === "" ? null : trimmed;
}
