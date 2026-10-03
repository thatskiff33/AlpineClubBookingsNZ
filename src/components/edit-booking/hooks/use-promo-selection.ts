"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PromoResult } from "@/components/promo-code-input";
import type { Guest, NewGuest } from "@/components/edit-booking/types";

/** What this edit will do to the booking's promo code. */
export type PromoAction =
  | { type: "keep" }
  | { type: "remove" }
  // #2266: guestIndexes carries a guest-targeted code's beneficiary
  // selection (from the shared PromoCodeInput), positional over
  // [remaining guests..., added guests...] — the order the server prices.
  | { type: "new"; code: string; guestIndexes?: number[] }
  // #3492: the COMPLETE list of codes the booking should carry after the edit,
  // in the booker's order (D-3813-2), sent as `promoCodes` — while the club's
  // `multiPromoCodes` switch is on. A code without guest indexes that the
  // booking already carries is kept and re-priced; positional indexes as above.
  | { type: "list"; codes: Array<{ code: string; guestIndexes?: number[] }> };

type PromoGuestTargetFields = { promoGuestIds?: string[]; promoAddedGuestIndexes?: number[] };

/**
 * #2266 (MED-4): a guest-targeted code's beneficiaries, positional over
 * [remaining guests..., added guests...], bound the way the server binds them:
 * EXISTING guests by bookingGuestId, so a concurrent edit refuses loudly instead
 * of redeeming the discount for the wrong guest; only TO-BE-ADDED guests (no id
 * yet) stay positional, relative to this request's addGuests array.
 */
function promoGuestTargets(
  guestIndexes: readonly number[] | undefined,
  remainingGuests: readonly Pick<Guest, "id">[],
): PromoGuestTargetFields {
  if (!guestIndexes?.length) return {};
  const promoGuestIds: string[] = [];
  const promoAddedGuestIndexes: number[] = [];
  for (const index of guestIndexes) {
    if (index < remainingGuests.length) {
      const guest = remainingGuests[index];
      if (guest) promoGuestIds.push(guest.id);
    } else {
      promoAddedGuestIndexes.push(index - remainingGuests.length);
    }
  }
  return {
    ...(promoGuestIds.length ? { promoGuestIds } : {}),
    ...(promoAddedGuestIndexes.length ? { promoAddedGuestIndexes } : {}),
  };
}

/** The modify request's promo fields for this edit's promo choice. */
export function promoActionPayload(
  promoAction: PromoAction,
  remainingGuests: readonly Pick<Guest, "id">[],
): Record<string, unknown> {
  if (promoAction.type === "remove") return { removePromoCode: true };
  if (promoAction.type === "new") {
    return {
      promoCode: promoAction.code,
      ...promoGuestTargets(promoAction.guestIndexes, remainingGuests),
    };
  }
  if (promoAction.type === "list") {
    return {
      promoCodes: promoAction.codes.map((entry) => ({
        code: entry.code,
        ...promoGuestTargets(entry.guestIndexes, remainingGuests),
      })),
    };
  }
  return {};
}

/**
 * The promo choice this edit is making.
 *
 * SPLIT FROM ITS OWN EFFECT, for the reason `useModificationQuoteState` is split
 * from `useDebouncedModificationQuote` and by the same technique (#2690 review).
 * `buildModificationPayload` reads `promoAction`, and the debounced quote is
 * keyed on that payload, so this state has to be declared BEFORE the quote hook.
 * The reset effect below, however, sat AFTER the quote effect in the original
 * component body. Keeping them in one hook would have moved the reset two
 * positions earlier in the panel's effect order; declaring the state here and
 * running the effect at its original position keeps all eight effects exactly
 * where they were, so no argument about whether a reorder is inert has to be
 * made or believed.
 */
export function usePromoSelectionState() {
  const [promoAction, setPromoAction] = useState<PromoAction>({ type: "keep" });
  // #2266: the old blind promo text field is gone — the shared PromoCodeInput
  // owns entry + validation of a NEW code (guest selection included).
  const [appliedNewPromo, setAppliedNewPromo] = useState<PromoResult | null>(
    null,
  );
  const [prefillPromoCode, setPrefillPromoCode] = useState<string | undefined>(
    undefined,
  );
  // #3492: the codes shown while a `list` edit is in progress (null = the
  // booking's stored codes, untouched).
  const [appliedPromoList, setAppliedPromoList] = useState<PromoResult[] | null>(null);

  /**
   * Drop the applied code and fall back to the stored promo.
   *
   * Handed to `usePromoBeneficiaryReset` as ONE stable callback rather than as
   * two setters, so that hook's dependency array gains a single entry that
   * `useCallback(..., [])` pins for the component's whole lifetime. Both setters
   * it closes over are declared right here, which is what lets the array be
   * empty and the identity be constant.
   */
  const retirePromoSelection = useCallback(() => {
    setAppliedNewPromo(null);
    setAppliedPromoList(null);
    setPromoAction({ type: "keep" });
  }, []);

  return {
    promoAction,
    setPromoAction,
    appliedNewPromo,
    setAppliedNewPromo,
    prefillPromoCode,
    setPrefillPromoCode,
    appliedPromoList,
    setAppliedPromoList,
    retirePromoSelection,
  };
}

/**
 * Drop a guest-targeted promo when the party it was aimed at changes.
 *
 * Extracted from `edit-booking-panel.tsx` (#2690) with the memo's dependency
 * array, the three-branch guard order and the ref latch unchanged, and called
 * from the panel at the position the effect always occupied.
 *
 * #2266: a guest-targeted promo's beneficiary indexes are positional over
 * [remaining guests..., added guests...]; changing that list silently re-points
 * them at different people. Reset the applied code instead and let the member
 * re-apply it against the new guest list.
 *
 * The effect's array gains exactly one entry over the original
 * `[promoAction, promoGuestSetSignature]`: `retirePromoSelection`, which is
 * `useCallback(..., [])` in the state hook above and therefore never changes.
 */
export function usePromoBeneficiaryReset({
  promoAction,
  guests,
  removedGuestIds,
  addedGuests,
  retirePromoSelection,
}: {
  promoAction: PromoAction;
  guests: Guest[];
  removedGuestIds: Set<string>;
  addedGuests: NewGuest[];
  retirePromoSelection: () => void;
}): void {
  const promoGuestSetSignature = useMemo(
    () =>
      JSON.stringify([
        guests
          .filter((guest) => !removedGuestIds.has(guest.id))
          .map((guest) => guest.id),
        addedGuests.map((guest) => guest.key),
      ]),
    [guests, removedGuestIds, addedGuests],
  );
  const appliedPromoGuestSignatureRef = useRef<string | null>(null);
  useEffect(() => {
    const targetsGuests =
      promoAction.type === "new"
        ? Boolean(promoAction.guestIndexes?.length)
        : promoAction.type === "list" &&
          promoAction.codes.some((entry) => entry.guestIndexes?.length);
    if (!targetsGuests) {
      appliedPromoGuestSignatureRef.current = null;
      return;
    }
    if (appliedPromoGuestSignatureRef.current === null) {
      appliedPromoGuestSignatureRef.current = promoGuestSetSignature;
      return;
    }
    if (appliedPromoGuestSignatureRef.current !== promoGuestSetSignature) {
      appliedPromoGuestSignatureRef.current = null;
      retirePromoSelection();
    }
  }, [promoAction, promoGuestSetSignature, retirePromoSelection]);
}
