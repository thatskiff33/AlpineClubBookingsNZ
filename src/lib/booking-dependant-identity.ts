/**
 * OWN-DEPENDANT IDENTITY ON A BOOKING PARTY (#2721). `INV-GUEST-019`.
 *
 * ## The defect this exists to stop
 *
 * A booking party holds two kinds of person, and which one somebody lands on is
 * decided by whether the row carries a `memberId`. A member-linked row books a
 * bed at member rates immediately. A free-text row is a NON-MEMBER guest: under
 * the club's non-member hold policy it can be provisional — no bed reserved
 * until the booking is confirmed and paid nearer the stay — it is bumpable when
 * the lodge fills, and it is invoiced as the deferred guest portion rather than
 * as a member night.
 *
 * A parent typing their own recorded dependant's name into the guest form used
 * to get the second one, silently. The person is a member of this club, has a
 * bed by right, and was instead put on the queue behind the members.
 *
 * ## The rule (owner decision on #2721)
 *
 * A booker's own recorded dependant belongs on the family/member path. A
 * free-text name is NOT identity proof, so the app never guesses: it detects the
 * collision and makes the booker say which person they mean.
 *
 * - **"This is my dependant"** — the wizard relinks the row to the member. No
 *   declaration is submitted and nothing here is involved.
 * - **"This is a different person with the same name"** — the guest path
 *   continues, but only behind a declaration naming the exact dependant the
 *   collision was with.
 *
 * A generic `override: true` is prohibited and is structurally impossible here:
 * {@link dependantIdentityDeclarationSchema} accepts only the one literal kind
 * plus the identity of the collision it resolves, so nothing a caller can send
 * waives a collision they never saw.
 *
 * ## The privacy boundary, which is half the rule
 *
 * The candidate set is EXACTLY the booker's own recorded dependants —
 * {@link loadBookerDependants} matches a parent link pointing at the booker and
 * nothing else. Not their family group, not their lodge, not the membership
 * database. Free-text guest entry must never become a way to ask the club
 * whether some name is a member, so widening this query is the thing to refuse
 * in review, whatever the convenience.
 *
 * Matching is EXACT on the normalised form
 * (`@/lib/person-name-normalization`): trim, lowercase, collapse whitespace.
 * Nothing fuzzy, phonetic or partial — those produce false collisions, and a
 * false collision is a question about a name the booker never asked about.
 *
 * ## Identity here is never a list position
 *
 * A collision is keyed by the NORMALISED NAME, never by an index into the party.
 * The wizard's party is a mutable array a member reorders, deletes from and adds
 * to while the resolution is on screen, and identity resolved positionally
 * against that array has already put one person's member link on another
 * person's row in a neighbouring surface. Every function in this module takes
 * and returns names and member ids; no caller may reintroduce an index.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";
import { normalizePersonFullName } from "@/lib/person-name-normalization";

/**
 * The minimum a caller needs from Prisma to answer "who are this member's
 * recorded dependants?".
 *
 * Spelled exactly as `BookingGuestLookupDb` in `booking-guests.ts` is, so a
 * transaction client is equally acceptable. Both arms are TYPE-ONLY imports and
 * are erased at build time, which is what keeps this module importable from the
 * booking wizard's client components for the pure half below.
 */
export type BookerDependantLookupDb =
  | Pick<PrismaClient, "member">
  | Pick<Prisma.TransactionClient, "member">;

/** One member recorded as a dependant of the booker. */
export type BookerDependant = {
  id: string;
  firstName: string;
  lastName: string;
};

/**
 * One free-text guest name on the proposed party that is exactly one of the
 * booker's own dependants.
 *
 * `dependants` holds EVERY own dependant with this normalised name, because a
 * family can hold two people whose names normalise the same way (a junior named
 * for a sibling who has since left, two step-siblings both recorded). Resolving
 * such a collision means answering for each of them, not for "the match".
 */
export type OwnDependantCollision = {
  /** The identity of the collision: `normalizePersonFullName` of the typed name. */
  normalizedName: string;
  /** The name as the booker typed it, for wording only — never for matching. */
  typedFirstName: string;
  typedLastName: string;
  /** Every own dependant whose name normalises to `normalizedName`. */
  dependants: BookerDependant[];
};

/**
 * The one declaration kind. A booker may say "different person, same name" about
 * a named dependant, and there is nothing else they may say.
 */
export const DIFFERENT_PERSON_SAME_NAME =
  "different_person_same_name" as const;

export const dependantIdentityDeclarationSchema = z.object({
  kind: z.literal(DIFFERENT_PERSON_SAME_NAME),
  /** The dependant this declaration is about — the collision's identity. */
  dependantMemberId: z.string().min(1),
  /** The normalised name the collision was about, as the client saw it. */
  normalizedName: z.string().min(1).max(300),
});

export type DependantIdentityDeclaration = z.infer<
  typeof dependantIdentityDeclarationSchema
>;

/**
 * The party shape this guard reads. Deliberately just the three fields, so it
 * can be handed the wizard's guest rows and the route's NORMALISED guest inputs
 * without either side converting.
 */
export type DependantIdentityPartyMember = {
  firstName: string;
  lastName: string;
  memberId?: string | null;
};

export const DEPENDANT_IDENTITY_UNRESOLVED_CODE =
  "DEPENDANT_IDENTITY_UNRESOLVED";
export const DEPENDANT_IDENTITY_DECLARATION_INVALID_CODE =
  "DEPENDANT_IDENTITY_DECLARATION_INVALID";

export type DependantIdentityRefusal = {
  code:
    | typeof DEPENDANT_IDENTITY_UNRESOLVED_CODE
    | typeof DEPENDANT_IDENTITY_DECLARATION_INVALID_CODE;
  status: 409 | 400;
  error: string;
  /**
   * The collisions still unanswered, for the wizard to draw the choice against.
   * Only ever the booker's OWN dependants, so it discloses nothing they did not
   * supply or already possess. Empty on a tampering refusal.
   */
  collisions: OwnDependantCollision[];
};

/**
 * The booker's recorded dependants: every ACTIVE member whose primary or
 * secondary parent link points at them.
 *
 * The parent columns are the authoritative record of "my dependant". Family
 * group co-membership deliberately is NOT: a family group can hold a partner, a
 * flatmate's child or an adult sibling, and treating everyone in it as a
 * dependant would both over-refuse and start answering questions about people
 * whose relationship to the booker the club never recorded.
 *
 * Inactive members are excluded: they cannot be booked on the member path
 * either, so a collision with one would be a dead end — the booker would be told
 * to use a path that refuses them.
 */
export async function loadBookerDependants(
  db: BookerDependantLookupDb,
  bookerMemberId: string,
): Promise<BookerDependant[]> {
  const id = bookerMemberId.trim();
  if (!id) return [];
  return db.member.findMany({
    where: {
      active: true,
      // NOT the family group, NOT the club. See the privacy note in the file
      // header before widening this by one clause.
      OR: [{ parentMemberId: id }, { secondaryParentId: id }],
    },
    select: { id: true, firstName: true, lastName: true },
    orderBy: { id: "asc" },
  });
}

/**
 * Every exact own-dependant collision on a proposed party.
 *
 * A row with a `memberId` is already on the member path and is skipped — that is
 * the outcome this guard exists to produce, so a booker who has resolved one
 * collision is not asked about it again. On the server the party has been
 * through `normalizeBookingGuestInputs` first, which strips a `memberId` that
 * did not resolve to a bookable member; so a forged `isMember: true`, or an id
 * that names nobody, arrives here as the free-text row it really is.
 *
 * A row missing either name part mints no key (see `normalizePersonFullName`)
 * and therefore collides with nothing.
 */
export function findOwnDependantNameCollisions(
  party: ReadonlyArray<DependantIdentityPartyMember>,
  dependants: ReadonlyArray<BookerDependant>,
): OwnDependantCollision[] {
  if (dependants.length === 0) return [];

  const dependantsByName = new Map<string, BookerDependant[]>();
  for (const dependant of dependants) {
    const key = normalizePersonFullName(dependant.firstName, dependant.lastName);
    if (!key) continue;
    const existing = dependantsByName.get(key);
    if (existing) existing.push(dependant);
    else dependantsByName.set(key, [dependant]);
  }
  if (dependantsByName.size === 0) return [];

  const collisions = new Map<string, OwnDependantCollision>();
  for (const guest of party) {
    if (guest.memberId?.trim()) continue;
    const key = normalizePersonFullName(guest.firstName, guest.lastName);
    if (!key) continue;
    const matched = dependantsByName.get(key);
    if (!matched) continue;
    // One collision per NAME however many rows carry it: the question the
    // booker is being asked ("is this my dependant, or someone else?") is about
    // the name, and asking it twice for two identically-named rows would be two
    // ways to answer the same question differently.
    if (collisions.has(key)) continue;
    collisions.set(key, {
      normalizedName: key,
      typedFirstName: guest.firstName,
      typedLastName: guest.lastName,
      dependants: [...matched],
    });
  }
  return [...collisions.values()];
}

/**
 * Is this declaration one the party and the booker's own records still support?
 *
 * Answered against the collisions computed from CURRENT data, which is what
 * makes every tampering case one check: a fabricated or unrelated
 * `dependantMemberId` is not in any collision because it is not in the booker's
 * dependant set; a declaration whose name no longer matches any typed guest is
 * not in any collision because that collision no longer exists; and a
 * declaration made before the dependant was renamed is not in any collision
 * because the dependant's normalised name moved.
 */
function declarationMatchesACollision(
  declaration: DependantIdentityDeclaration,
  collisions: ReadonlyArray<OwnDependantCollision>,
): boolean {
  const collision = collisions.find(
    (candidate) => candidate.normalizedName === declaration.normalizedName,
  );
  if (!collision) return false;
  return collision.dependants.some(
    (dependant) => dependant.id === declaration.dependantMemberId,
  );
}

/**
 * The one sentence a member is told when a collision is unanswered. EXPORTED so
 * the wizard's own stop and the server's refusal read identically: the wizard
 * asks the question first, and a member who reached the refusal anyway (a stale
 * tab, a second device) must not be told something different about the same
 * state.
 */
export const DEPENDANT_IDENTITY_UNRESOLVED_MESSAGE =
  "One of the guests you have typed has the same name as somebody recorded as your dependant. Say whether that is your dependant or a different person with the same name before continuing.";

const INVALID_DECLARATION_ERROR =
  "The confirmation about a guest sharing a dependant's name no longer matches this booking. Go back to the guest list and answer the question again.";

/**
 * The whole guard: given a proposed party, the booker's own dependants and
 * whatever declarations the caller sent, either accept or refuse with something
 * the member can act on.
 *
 * Returns `null` when the party may proceed. Order matters and is deliberate:
 * a TAMPERED declaration is refused even when the party would otherwise be
 * clean, so a caller cannot park a forged declaration in a payload and have it
 * ignored until the day it silently covers a real collision.
 */
export function checkOwnDependantIdentity(params: {
  party: ReadonlyArray<DependantIdentityPartyMember>;
  dependants: ReadonlyArray<BookerDependant>;
  declarations?: ReadonlyArray<DependantIdentityDeclaration>;
}): DependantIdentityRefusal | null {
  const declarations = params.declarations ?? [];
  const collisions = findOwnDependantNameCollisions(
    params.party,
    params.dependants,
  );

  for (const declaration of declarations) {
    if (!declarationMatchesACollision(declaration, collisions)) {
      return {
        code: DEPENDANT_IDENTITY_DECLARATION_INVALID_CODE,
        status: 400,
        error: INVALID_DECLARATION_ERROR,
        collisions: [],
      };
    }
  }

  const declaredDependantIds = new Set(
    declarations.map((declaration) => declaration.dependantMemberId),
  );
  // EVERY dependant behind a collision must be answered for, not just one of
  // them: two dependants whose names normalise alike are two different people,
  // and "this is not Sam" says nothing about the other Sam.
  const unresolved = collisions.filter((collision) =>
    collision.dependants.some(
      (dependant) => !declaredDependantIds.has(dependant.id),
    ),
  );
  if (unresolved.length > 0) {
    return {
      code: DEPENDANT_IDENTITY_UNRESOLVED_CODE,
      status: 409,
      error: DEPENDANT_IDENTITY_UNRESOLVED_MESSAGE,
      collisions: unresolved,
    };
  }

  return null;
}
