"use client";

import { useEffect, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { GuestData } from "@/components/guest-form";
import type { PromoResult } from "@/components/promo-code-input";
import { promoCodeListEntries, validatePromoCodeList } from "@/components/promo-code-list-client";
import type { PriceQuote } from "../_components/types";

/**
 * The booking wizard's working-bee discount preview, split out of
 * `use-booking-wizard.ts` (#3492) and called from the position its effect
 * always held, so the wizard's effect order is unchanged.
 *
 * - **Alone** (the club's `multiPromoCodes` switch off or unanswered): a
 *   selected working bee is priced on its own and replaces the applied list,
 *   exactly as it always has; the review step keeps it exclusive of codes.
 * - **Combined** (switch on, D-3813-3): with codes already applied, the working
 *   bee claims its in-window nights first and the codes are re-priced after it
 *   in one several-code preview — and re-priced without it once it is unticked
 *   or cleared. A refusal keeps the booker's codes and says why.
 */
export function useWorkingBeeDiscount({
  scopedLodgeId,
  selectedWorkPartyEventId,
  checkIn,
  checkOut,
  priceQuote,
  reviewGuestPayload,
  combineWorkPartyWithCodes,
  appliedPromosRef,
  setAppliedPromos,
  setWorkPartyError,
}: {
  scopedLodgeId: string | null;
  selectedWorkPartyEventId: string | null;
  checkIn: string | null;
  checkOut: string | null;
  priceQuote: PriceQuote | null;
  reviewGuestPayload: GuestData[];
  combineWorkPartyWithCodes: boolean;
  /** The applied list as of the last render, read without re-running on it. */
  appliedPromosRef: RefObject<PromoResult[]>;
  setAppliedPromos: Dispatch<SetStateAction<PromoResult[]>>;
  setWorkPartyError: (value: string) => void;
}): void {
  useEffect(() => {
    if (!scopedLodgeId || !checkIn || !checkOut || !priceQuote) {
      return;
    }

    // #3492 / D-3813-3: with the club's `multiPromoCodes` switch on, a working
    // bee COMBINES with codes the booker already applied — it claims its
    // in-window nights first and the codes are re-priced after it (or without
    // it, once it is unticked or cleared), in one several-code preview.
    const codes = appliedPromosRef.current.filter((promo) => promo.code && !promo.workPartyEvent);
    if (combineWorkPartyWithCodes && codes.length > 0) {
      const hadWorkParty = appliedPromosRef.current.some((promo) => promo.workPartyEvent);
      if (!selectedWorkPartyEventId && !hadWorkParty) return;
      let cancelled = false;
      setWorkPartyError("");
      void validatePromoCodeList({
        entries: promoCodeListEntries(codes),
        appliesTo: new Map(codes.flatMap((promo) => (promo.appliesTo ? [[promo.code!, promo.appliesTo]] : []))),
        checkIn,
        checkOut,
        guests: reviewGuestPayload,
        lodgeId: scopedLodgeId,
        ...(selectedWorkPartyEventId ? { workPartyEventId: selectedWorkPartyEventId } : {}),
      }).then((outcome) => {
        if (cancelled) return;
        if (outcome.ok) {
          setAppliedPromos(outcome.applied);
          return;
        }
        // Keep the booker's codes; say why the working bee did not join them.
        setAppliedPromos(codes);
        setWorkPartyError(outcome.error);
      });
      return () => {
        cancelled = true;
      };
    }
    if (!selectedWorkPartyEventId) return;

    let cancelled = false;
    const requestedLodgeId = scopedLodgeId;
    setWorkPartyError("");

    fetch("/api/promo-codes/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lodgeId: requestedLodgeId,
        workPartyEventId: selectedWorkPartyEventId,
        checkIn,
        checkOut,
        guests: reviewGuestPayload.map((g) => ({
          ageTier: g.ageTier,
          isMember: g.isMember,
          ...(g.memberId ? { memberId: g.memberId } : {}),
          ...(g.stayStart ? { stayStart: g.stayStart } : {}),
          ...(g.stayEnd ? { stayEnd: g.stayEnd } : {}),
        })),
      }),
    })
      .then(async (res) => {
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok || data.valid === false) {
          setAppliedPromos([]);
          setWorkPartyError(data.error || "This working bee event could not be applied");
          return;
        }
        setAppliedPromos([{
          code: data.code,
          description: data.description,
          type: data.type,
          discountCents: data.discountCents,
          promoAdjustmentCents: data.promoAdjustmentCents,
          totalPriceCents: data.totalPriceCents,
          finalPriceCents: data.finalPriceCents,
          workPartyEvent: data.workPartyEvent,
        }]);
      })
      .catch(() => {
        if (!cancelled) {
          setAppliedPromos([]);
          setWorkPartyError("Failed to apply the working bee discount");
        }
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopedLodgeId, selectedWorkPartyEventId, checkIn, checkOut, priceQuote, JSON.stringify(reviewGuestPayload), combineWorkPartyWithCodes]);
}
