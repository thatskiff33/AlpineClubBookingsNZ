"use client";

import { useCallback, type Dispatch, type SetStateAction } from "react";
import {
  DEPENDANT_IDENTITY_DECLARATION_INVALID_CODE,
  type BookerDependant,
} from "@/lib/booking-dependant-identity";
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
 * and nothing else — rows already on the booking were admitted under the create
 * door's own question and are not re-litigated — and the dependants are the
 * booking OWNER's, from the family route the panel already reads (the owner's
 * own on a member's panel, the booking's `eligible-family` on an officer's).
 *
 * Nothing here is a guarantee: `modify-quote` and the save both re-derive every
 * collision from authenticated data and refuse what this would have let through.
 */
export function useEditDependantIdentity({
  addedGuests,
  setAddedGuests,
  ownDependants,
  reloadFamilyOptions,
}: {
  addedGuests: NewGuest[];
  setAddedGuests: Dispatch<SetStateAction<NewGuest[]>>;
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
    party: addedGuests,
    ownDependants,
  });
  const { clearDeclarations } = answers;

  const bookAsDependant = useCallback(
    (normalizedName: string, familyMember: FamilyMember) => {
      // Matched by NORMALISED NAME, never by row position — the shared relink is
      // the whole defence against answering for whoever now occupies a slot.
      setAddedGuests(
        (current) =>
          relinkCollidingGuestToMember(current, normalizedName, familyMember) ??
          current,
      );
    },
    [setAddedGuests],
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
