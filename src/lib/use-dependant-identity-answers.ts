"use client";

/**
 * THE BOOKER'S ANSWERS to "this guest has the same name as a recorded
 * dependant" (#2721, `INV-GUEST-019`), held in one place for every surface that
 * asks the question.
 *
 * ## Why this is a shared hook rather than per-screen state
 *
 * Two create surfaces ask it: the member's own booking wizard, and the admin
 * booking screen where an officer books on a member's behalf (owner decision on
 * #2721, 15 Sep 2026 — the guard runs on the on-behalf path too). The RULE
 * already had one home in `booking-dependant-identity.ts`, which the client and
 * the server both run. What did not was the answer STATE: which declarations are
 * held, which of them still describe a live collision, and what therefore
 * travels on the next submit.
 *
 * Spelling that a second time on the admin screen would have been eighty lines
 * agreeing with the wizard by hand, and it carries exactly the two hazards this
 * issue has already had to fix once each:
 *
 * - **A stale declaration must stop travelling by itself.** Edit a colliding
 *   name and the answer about it is no longer sent; fix the typo back and it
 *   applies again. A surface that pruned the state instead would re-ask a
 *   question the booker had already answered; one that pruned nothing would POST
 *   a declaration the server refuses the whole party over.
 * - **Identity is a normalised NAME, never a party position.** The party is a
 *   mutable array a booker reorders, deletes from and adds to while the question
 *   is on screen, so an index captured at render answers for whoever ends up in
 *   that slot. Every function here takes and returns names and member ids.
 *
 * Nothing here is a guarantee. The server re-derives all of it from
 * authenticated data and refuses a party this hook would have let through; what
 * this buys is that the two screens ask the same question the same way, and that
 * the question is asked BEFORE the guest split rather than refused after it.
 */

import { useCallback, useState } from "react";
import type { AgeTier } from "@prisma/client";
import {
  declarationMatchesACollision,
  DIFFERENT_PERSON_SAME_NAME,
  findOwnDependantNameCollisions,
  unresolvedOwnDependantCollisions,
  type BookerDependant,
  type DependantIdentityDeclaration,
  type DependantIdentityPartyMember,
  type OwnDependantCollision,
} from "@/lib/booking-dependant-identity";
import { normalizePersonFullName } from "@/lib/person-name-normalization";

/**
 * The least a party row has to be for a collision to be resolved ON it: a name,
 * an age tier, and the two fields that put it on the member path.
 *
 * Deliberately structural rather than `GuestData`, so this does not depend on a
 * component module — and so a surface with its own row type gets the same relink
 * without converting its party first.
 */
export type RelinkablePartyRow = DependantIdentityPartyMember & {
  ageTier: AgeTier;
  isMember: boolean;
};

/**
 * "This IS the dependant" — move the colliding free-text row onto the member
 * path, keeping every other field (chosen nights, stay range) the row already
 * carried.
 *
 * MATCHED BY NORMALISED NAME, NEVER BY INDEX, and that is the whole reason this
 * is a function rather than three lines at each call site. The button was drawn
 * from a render of an older party; by the time it is pressed a row above it may
 * have been removed, and converting "the row that was at position 2" would put
 * this dependant's member link on somebody else's row — a defect this repository
 * has already shipped once on a neighbouring surface.
 *
 * Returns `null` when nothing changed, which is a real outcome rather than an
 * error: the colliding row may have been deleted or renamed since the render,
 * and then the right answer is to do nothing at all.
 */
export function relinkCollidingGuestToMember<G extends RelinkablePartyRow>(
  guests: ReadonlyArray<G>,
  normalizedName: string,
  member: {
    id: string;
    firstName: string;
    lastName: string;
    ageTier: AgeTier;
  },
): G[] | null {
  if (guests.some((guest) => guest.memberId === member.id)) return null;
  let converted = false;
  const next = guests.map((guest) => {
    if (converted || guest.memberId) return guest;
    if (
      normalizePersonFullName(guest.firstName, guest.lastName) !== normalizedName
    ) {
      return guest;
    }
    converted = true;
    return {
      ...guest,
      firstName: member.firstName,
      lastName: member.lastName,
      ageTier: member.ageTier,
      isMember: true,
      memberId: member.id,
    };
  });
  return converted ? next : null;
}

export type DependantIdentityAnswers = {
  /** Every live collision on this party, answered or not. */
  collisions: OwnDependantCollision[];
  /**
   * The declarations that still describe a collision this party actually has —
   * the ONLY ones a submit may carry, and `undefined` when there are none, so a
   * caller can put it straight into a request body.
   */
  declarationsPayload: DependantIdentityDeclaration[] | undefined;
  /** Dependant ids already called a different person, for rendering. */
  declaredDependantMemberIds: string[];
  /**
   * Collisions with at least one dependant nobody has answered for — the gate a
   * surface refuses to leave the guests step on, answered by the same module
   * function the server's refusal uses.
   */
  unresolvedCollisions: OwnDependantCollision[];
  /** Record "different person with the same name" about one named dependant. */
  declareDifferentPerson: (
    collision: OwnDependantCollision,
    dependantMemberId: string,
  ) => void;
  /** Take that answer back, putting the question back on screen. */
  withdrawDeclaration: (
    collision: OwnDependantCollision,
    dependantMemberId: string,
  ) => void;
  /**
   * Forget every answer. Used when the server refuses a declaration: it refuses
   * the whole party if ANY declaration fails and does not say which, so keeping
   * them rebuilds the identical payload and is refused again — clearing re-asks
   * the question, which is the only answer that terminates.
   */
  clearDeclarations: () => void;
  /**
   * Every answer held, live or not. A refusal handler needs this rather than the
   * live set: it re-derives the collisions from a freshly loaded dependant list,
   * against which a declaration the stale list made look dead may be live.
   */
  heldDeclarations: DependantIdentityDeclaration[];
};

/**
 * Derive the answer state for one party against one dependant list.
 *
 * `ownDependants` empty means "not asked yet" as well as "nothing to ask", and
 * empty is the safe direction on the client: the surface simply does not draw
 * the question, and the server — which never trusts this list — still refuses
 * the create.
 */
export function useDependantIdentityAnswers(params: {
  party: ReadonlyArray<DependantIdentityPartyMember>;
  ownDependants: ReadonlyArray<BookerDependant>;
}): DependantIdentityAnswers {
  const [heldDeclarations, setHeldDeclarations] = useState<
    DependantIdentityDeclaration[]
  >([]);

  const collisions = findOwnDependantNameCollisions(
    params.party,
    params.ownDependants,
  );
  const liveDeclarations = heldDeclarations.filter((declaration) =>
    declarationMatchesACollision(declaration, collisions),
  );

  const declareDifferentPerson = useCallback(
    (collision: OwnDependantCollision, dependantMemberId: string) => {
      setHeldDeclarations((current) =>
        current.some(
          (declaration) =>
            declaration.dependantMemberId === dependantMemberId &&
            declaration.normalizedName === collision.normalizedName,
        )
          ? current
          : [
              ...current,
              {
                kind: DIFFERENT_PERSON_SAME_NAME,
                dependantMemberId,
                normalizedName: collision.normalizedName,
              },
            ],
      );
    },
    [],
  );

  const withdrawDeclaration = useCallback(
    (collision: OwnDependantCollision, dependantMemberId: string) => {
      setHeldDeclarations((current) =>
        current.filter(
          (declaration) =>
            !(
              declaration.dependantMemberId === dependantMemberId &&
              declaration.normalizedName === collision.normalizedName
            ),
        ),
      );
    },
    [],
  );

  const clearDeclarations = useCallback(() => setHeldDeclarations([]), []);

  return {
    collisions,
    declarationsPayload:
      liveDeclarations.length > 0 ? liveDeclarations : undefined,
    declaredDependantMemberIds: liveDeclarations.map(
      (declaration) => declaration.dependantMemberId,
    ),
    unresolvedCollisions: unresolvedOwnDependantCollisions(
      collisions,
      liveDeclarations,
    ),
    declareDifferentPerson,
    withdrawDeclaration,
    clearDeclarations,
    heldDeclarations,
  };
}
