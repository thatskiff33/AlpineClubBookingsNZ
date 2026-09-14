"use client";

/**
 * OWN-DEPENDANT IDENTITY ON THE ADMIN BOOKING SCREEN (#2721, `INV-GUEST-019`).
 *
 * An officer booking on a member's behalf is asked exactly the question the
 * member is asked in their own wizard (owner decision on D1, 15 Sep 2026). The
 * guard used to skip the authorised on-behalf create entirely, on the reasoning
 * that the member-guest boundary check beside it skips too and reads the same
 * flag; the owner removed that because the two are not the same class. The
 * boundary check gates the OFFICER'S OWN AUTHORITY, which the officer can see in
 * front of them. This one protects A THIRD PARTY'S BED — a real child on a
 * provisional, bumpable, separately invoiced guest row at non-member prices —
 * and the parent is not at the screen to notice.
 *
 * ## Why this is a hook rather than lines in the page
 *
 * `admin/book/page.tsx` is already four times its size budget, and this is a
 * coherent unit with a seam: it reads the party and the member's dependants and
 * answers in state changes the page applies. Everything about the RULE is one
 * layer further down again — `booking-dependant-identity.ts` for the rule the
 * server re-runs, `use-dependant-identity-answers.ts` for the answer state the
 * member wizard shares — so what is left here is only what is specific to this
 * screen: the two invalidations a relink owes, and what a refusal does to a
 * wizard that has already moved past the guest step.
 */

import { useCallback } from "react";
import type { AgeTier } from "@prisma/client";
import type { GuestData } from "@/components/guest-form";
import {
  DEPENDANT_IDENTITY_DECLARATION_INVALID_CODE,
  DEPENDANT_IDENTITY_UNANSWERABLE_MESSAGE,
  DEPENDANT_IDENTITY_UNRESOLVED_CODE,
  DEPENDANT_IDENTITY_UNRESOLVED_ON_BEHALF_MESSAGE,
  declarationMatchesACollision,
  findOwnDependantNameCollisions,
  unresolvedOwnDependantCollisions,
  type BookerDependant,
  type OwnDependantCollision,
} from "@/lib/booking-dependant-identity";
import {
  relinkCollidingGuestToMember,
  useDependantIdentityAnswers,
  type DependantIdentityAnswers,
} from "@/lib/use-dependant-identity-answers";

export interface AdminDependantIdentity
  extends Pick<
    DependantIdentityAnswers,
    | "collisions"
    | "declaredDependantMemberIds"
    | "unresolvedCollisions"
    | "declarationsPayload"
    | "declareDifferentPerson"
    | "withdrawDeclaration"
  > {
  /** "This is the member's dependant" — move the colliding row to the member path. */
  relinkToMember: (
    normalizedName: string,
    member: {
      id: string;
      firstName: string;
      lastName: string;
      ageTier: AgeTier;
    },
  ) => void;
  /**
   * Did this create response refuse over own-dependant identity? Both submit
   * doors on the screen ask, so neither can forget to.
   */
  handledRefusal: (data: Record<string, unknown>) => boolean;
}

export function useAdminDependantIdentity(params: {
  /** The proposed party, live. */
  guests: GuestData[];
  /**
   * The SELECTED MEMBER's own recorded dependants — never the signed-in
   * officer's. Reading the wrong family would both miss every real collision on
   * this booking and put another family's names on the officer's screen, which
   * is the disclosure half of `INV-GUEST-019`.
   */
  ownDependants: BookerDependant[];
  setGuests: (guests: GuestData[]) => void;
  /** Drop the quote, promo and credit after a relink repriced the party. */
  onPartyRepriced: () => void;
  /** Re-read the on-behalf family picker; `null` when the read failed. */
  reloadFamily: () => Promise<{ ownDependants: BookerDependant[] } | null>;
  /** Put the officer back on the guest step, clearing panels from other checks. */
  sendBackToGuestStep: () => void;
  setError: (message: string) => void;
}): AdminDependantIdentity {
  const {
    guests,
    ownDependants,
    setGuests,
    onPartyRepriced,
    reloadFamily,
    sendBackToGuestStep,
    setError,
  } = params;

  const answers = useDependantIdentityAnswers({
    party: guests,
    ownDependants,
  });

  /**
   * The relink matches by NORMALISED NAME and never by index: the officer may
   * have deleted a row above this one since the panel rendered, and converting
   * "the row that was at position 2" would put this dependant's member link on
   * somebody else's row.
   */
  const relinkToMember: AdminDependantIdentity["relinkToMember"] = (
    normalizedName,
    member,
  ) => {
    const next = relinkCollidingGuestToMember(guests, normalizedName, member);
    if (!next) return;
    setGuests(next);
    onPartyRepriced();
  };

  /**
   * The create route refused this party over own-dependant identity.
   *
   * The screen asks the question on the guest step and will not leave it
   * unanswered, so reaching here means the picture went STALE — a tab left open
   * while the member's dependant was recorded or renamed, or a second officer on
   * the same member.
   *
   * IT REFETCHES, which is the point of the function. Sending the officer back
   * to the guest step only helps if that step can now draw the question, and the
   * step draws it from the picker's list; returning to it with the same stale
   * list renders no question and tells them to answer something that is not on
   * the screen — a loop Continue reproduces exactly.
   *
   * AN INVALID DECLARATION CLEARS EVERY HELD ANSWER. The server refuses the
   * whole party if any one of them fails and does not say which, so rebuilding
   * the same payload is refused identically; clearing re-asks the question,
   * which is the only answer that terminates.
   *
   * THE MESSAGE CAN CHANGE AFTERWARDS. The server's sentence shows at once,
   * because somebody is waiting. If the refreshed list still leaves nothing to
   * ask, it is replaced with copy naming something the officer can actually do.
   */
  const handleRefusal = useCallback(
    (declarationInvalid: boolean, serverMessage: string) => {
      sendBackToGuestStep();
      setError(serverMessage);
      const refusedParty = guests;
      const declarationsAfterRefusal = declarationInvalid
        ? []
        : answers.heldDeclarations;
      if (declarationInvalid) answers.clearDeclarations();
      void reloadFamily().then((fresh) => {
        if (!fresh) {
          setError(DEPENDANT_IDENTITY_UNANSWERABLE_MESSAGE);
          return;
        }
        const collisions: OwnDependantCollision[] =
          findOwnDependantNameCollisions(refusedParty, fresh.ownDependants);
        const live = declarationsAfterRefusal.filter((declaration) =>
          declarationMatchesACollision(declaration, collisions),
        );
        if (unresolvedOwnDependantCollisions(collisions, live).length === 0) {
          setError(DEPENDANT_IDENTITY_UNANSWERABLE_MESSAGE);
        }
      });
    },
    [answers, guests, reloadFamily, sendBackToGuestStep, setError],
  );

  const handledRefusal: AdminDependantIdentity["handledRefusal"] = (data) => {
    if (
      data.code !== DEPENDANT_IDENTITY_UNRESOLVED_CODE &&
      data.code !== DEPENDANT_IDENTITY_DECLARATION_INVALID_CODE
    ) {
      return false;
    }
    handleRefusal(
      data.code === DEPENDANT_IDENTITY_DECLARATION_INVALID_CODE,
      typeof data.error === "string" && data.error
        ? data.error
        : DEPENDANT_IDENTITY_UNRESOLVED_ON_BEHALF_MESSAGE,
    );
    return true;
  };

  return {
    collisions: answers.collisions,
    declaredDependantMemberIds: answers.declaredDependantMemberIds,
    unresolvedCollisions: answers.unresolvedCollisions,
    declarationsPayload: answers.declarationsPayload,
    declareDifferentPerson: answers.declareDifferentPerson,
    withdrawDeclaration: answers.withdrawDeclaration,
    relinkToMember,
    handledRefusal,
  };
}
