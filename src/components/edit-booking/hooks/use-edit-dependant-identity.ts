"use client";

import { useCallback, type Dispatch, type SetStateAction } from "react";
import {
  DEPENDANT_IDENTITY_DECLARATION_INVALID_CODE,
  type BookerDependant,
  type DependantIdentityPartyMember,
} from "@/lib/booking-dependant-identity";
import { normalizePersonFullName } from "@/lib/person-name-normalization";
import {
  relinkCollidingGuestToMember,
  useDependantIdentityAnswers,
  type DependantIdentityAnswers,
} from "@/lib/use-dependant-identity-answers";
import type { FamilyMember, NewGuest } from "@/components/edit-booking/types";

/**
 * The edit panel's half of "this added guest has the same name as a recorded
 * dependant" (#3451, `INV-GUEST-019`; owner decision 1 Oct 2026, option C — ask
 * in place on add-guest).
 *
 * THE CREATE WIZARD'S MACHINERY, NOT A SECOND COPY. The answer state is
 * `useDependantIdentityAnswers`, the relink is `relinkCollidingGuestToMember`,
 * and the question is drawn by the wizard's own components; this hook only
 * wires them to the panel's state. The party it asks about is the ADDED guests
 * plus any existing free-text guest RENAMED onto a new name (the same split by
 * another route, `renamedGuestsForDependantCheck`); untouched rows were admitted
 * under their own door's question and are not re-litigated. The dependants are the
 * booking OWNER's, from the family route the panel already reads (the owner's
 * own on a member's panel, the booking's `eligible-family` on an officer's).
 *
 * Nothing here is a guarantee: `modify-quote` and the save both re-derive every
 * collision from authenticated data and refuse what this would have let through.
 */
export function useEditDependantIdentity({
  addedGuests,
  setAddedGuests,
  renamedGuests,
  replaceRenamedGuest,
  ownDependants,
  reloadFamilyOptions,
}: {
  addedGuests: NewGuest[];
  setAddedGuests: Dispatch<SetStateAction<NewGuest[]>>;
  /** Existing free-text rows this edit renames onto a new name. */
  renamedGuests: ReadonlyArray<DependantIdentityPartyMember & { guestId: string }>;
  /**
   * "This is my dependant" about a RENAMED row: take that row off and add the
   * dependant as a member instead. An existing row cannot be relinked in place —
   * a rename never touches member identity (`resolveGuestNameUpdates`).
   */
  replaceRenamedGuest: (guestId: string, familyMember: FamilyMember) => void;
  ownDependants: BookerDependant[];
  reloadFamilyOptions: () => void;
}): DependantIdentityAnswers & {
  /** "This is my dependant": move the colliding added row onto the member path. */
  bookAsDependant: (normalizedName: string, familyMember: FamilyMember) => void;
  /**
   * The server refused the edit over a collision. STABLE, because the quote hook
   * names it in the dependency list of a debounced fetch.
   */
  handleRefusal: (code: string) => void;
} {
  const answers = useDependantIdentityAnswers({
    party: [...addedGuests, ...renamedGuests],
    ownDependants,
  });
  const { clearDeclarations } = answers;

  const bookAsDependant = useCallback(
    (normalizedName: string, familyMember: FamilyMember) => {
      // Matched by NORMALISED NAME, never by row position — the shared relink is
      // the whole defence against answering for whoever now occupies a slot.
      if (relinkCollidingGuestToMember(addedGuests, normalizedName, familyMember)) {
        setAddedGuests(
          (current) =>
            relinkCollidingGuestToMember(current, normalizedName, familyMember) ??
            current,
        );
        return;
      }
      const renamed = renamedGuests.find(
        (guest) =>
          normalizePersonFullName(guest.firstName, guest.lastName) ===
          normalizedName,
      );
      if (renamed) replaceRenamedGuest(renamed.guestId, familyMember);
    },
    [addedGuests, renamedGuests, replaceRenamedGuest, setAddedGuests],
  );

  const handleRefusal = useCallback(
    (code: string) => {
      // The server refuses the whole edit when ANY declaration fails and does
      // not say which, so keeping them rebuilds the same refused payload.
      // Clearing re-asks the question, which is the only answer that ends.
      if (code === DEPENDANT_IDENTITY_DECLARATION_INVALID_CODE) {
        clearDeclarations();
      }
      // A refusal the panel did not predict means its dependant list is stale,
      // and it needs the fresh one to draw the question at all. Re-read on every
      // refusal rather than only the unpredicted ones: telling the two apart
      // here would make this callback change identity on every render, and the
      // debounced quote fetch would re-arm on it.
      reloadFamilyOptions();
    },
    [clearDeclarations, reloadFamilyOptions],
  );

  return { ...answers, bookAsDependant, handleRefusal };
}
