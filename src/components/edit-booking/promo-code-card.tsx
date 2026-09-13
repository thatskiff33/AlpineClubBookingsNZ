"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PromoCodeInput, type PromoResult } from "@/components/promo-code-input";
import { formatSignedCents } from "@/lib/utils";
import type { PromoAction } from "@/components/edit-booking/hooks/use-promo-selection";
import type {
  AvailablePromoCode,
  Guest,
  NewGuest,
  PromoInfo,
  QuoteResult,
} from "@/components/edit-booking/types";

/**
 * The booking's promo code: keep it, drop it, or apply a different one.
 *
 * Moved out of `edit-booking-panel.tsx` (#2690) as pure presentation. The card
 * is not rendered at all while the promo controls are locked (an in-progress
 * edit or an active admin override) — that gate stays in the panel, with the
 * other things those two modes turn off.
 *
 * The guest list handed to `PromoCodeInput` is built here, in the order the
 * server prices — [remaining guests..., added guests...] — because a
 * guest-targeted code's beneficiary indexes are positional over exactly that
 * list, and the panel converts them back to booking-guest ids when it builds the
 * payload.
 */
export function PromoCodeCard({
  promo,
  promoAdjustmentCents,
  promoAction,
  availablePromoCodes,
  appliedNewPromo,
  prefillPromoCode,
  checkIn,
  checkOut,
  remainingGuests,
  addedGuests,
  perGuestDatesEnabled,
  isInProgressEdit,
  getExistingGuestRange,
  quote,
  forMemberId,
  lodgeId,
  onRemovePromo,
  onKeepPromo,
  onPrefillCode,
  onPromoApplied,
}: {
  promo: PromoInfo | null;
  promoAdjustmentCents: number;
  promoAction: PromoAction;
  availablePromoCodes: AvailablePromoCode[];
  appliedNewPromo: PromoResult | null;
  prefillPromoCode: string | undefined;
  checkIn: string;
  checkOut: string;
  remainingGuests: Guest[];
  addedGuests: NewGuest[];
  perGuestDatesEnabled: boolean;
  isInProgressEdit: boolean;
  getExistingGuestRange: (guest: Guest) => { stayStart: string; stayEnd: string };
  quote: QuoteResult | null;
  forMemberId: string | undefined;
  lodgeId: string | null | undefined;
  onRemovePromo: () => void;
  onKeepPromo: () => void;
  onPrefillCode: (code: string) => void;
  onPromoApplied: (result: PromoResult | null) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Promo Code</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {promo && promoAction.type === "keep" && (
          <div className="flex items-center justify-between">
            <div>
              <span className="font-medium text-success-11">
                {promo.workPartyEventName
                  ? `Working bee: ${promo.workPartyEventName}`
                  : promo.code}
              </span>
              {promo.description && !promo.workPartyEventName && (
                <span className="text-sm text-muted-foreground ml-2">{promo.description}</span>
              )}
              <span className={`text-sm ml-2 ${promoAdjustmentCents > 0 ? "text-warning-11" : "text-success-11"}`}>
                ({formatSignedCents(promoAdjustmentCents)})
              </span>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="text-danger-11 hover:text-danger-11"
              onClick={onRemovePromo}
            >
              Remove
            </Button>
          </div>
        )}

        {promoAction.type === "remove" && promo && (
          <div className="flex items-center justify-between text-muted-foreground">
            <div>
              <span className="line-through">
                {promo.workPartyEventName
                  ? `Working bee: ${promo.workPartyEventName}`
                  : promo.code}
              </span>
              <span className="text-sm ml-2">(will be removed - available for reuse)</span>
            </div>
            <Button variant="outline" size="sm" onClick={onKeepPromo}>
              Undo
            </Button>
          </div>
        )}

        {/* #2266: entry area — eligible-code chips plus the shared
            PromoCodeInput (validation, guest selection, applied display),
            replacing the old blind text field. Shown whenever a new code may
            be entered, and while one is applied (the input renders the
            applied chip itself). */}
        {(promoAction.type === "remove" ||
          promoAction.type === "new" ||
          (!promo && promoAction.type === "keep")) && (
          <div className="space-y-3">
            {availablePromoCodes.length > 0 && !appliedNewPromo && (
              <div className="app-callout-brand p-4">
                <p className="mb-2 text-sm font-medium text-foreground">
                  You have promo codes available:
                </p>
                <div className="flex flex-wrap gap-2">
                  {availablePromoCodes.map((pc) => (
                    <button
                      key={pc.code}
                      type="button"
                      onClick={() => onPrefillCode(pc.code)}
                      className="app-chip-brand font-mono"
                    >
                      {pc.code}
                      {pc.description && (
                        <span className="font-sans font-normal text-brand-charcoal">
                          — {pc.description}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <PromoCodeInput
              // #2770 (INV-MOD-026): this widget is on an EDIT, so the
              // validator must consult the club's `applyToEdits` switch. Left
              // off, the promo adjustment shown here would be sized on
              // group-discounted per-night rates that the quote above and the
              // save below refuse to give at a switch-off club.
              forBookingEdit
              checkIn={checkIn}
              checkOut={checkOut}
              guests={[
                ...remainingGuests.map((g) => ({
                  firstName: g.firstName,
                  lastName: g.lastName,
                  ageTier: g.ageTier,
                  isMember: g.isMember,
                  memberId: g.memberId ?? undefined,
                  ...(perGuestDatesEnabled && !isInProgressEdit
                    ? getExistingGuestRange(g)
                    : {}),
                })),
                ...addedGuests.map((g) => ({
                  firstName: g.firstName,
                  lastName: g.lastName,
                  ageTier: g.ageTier as string,
                  isMember: g.isMember,
                  memberId: g.memberId,
                  ...(perGuestDatesEnabled &&
                  !isInProgressEdit &&
                  g.stayStart &&
                  g.stayEnd
                    ? { stayStart: g.stayStart, stayEnd: g.stayEnd }
                    : {}),
                })),
              ]}
              onPromoApplied={onPromoApplied}
              appliedPromo={appliedNewPromo}
              forMemberId={forMemberId}
              lodgeId={lodgeId}
              prefillCode={prefillPromoCode}
            />
            {/* The booking-aware re-validation (modify-quote) can refuse a
                code the standalone validator accepted (e.g. already redeemed
                against this booking's dates); surface that honestly. */}
            {promoAction.type === "new" &&
              quote?.promoValidation &&
              !quote.promoValidation.valid && (
                <p className="text-sm text-danger-11">
                  {quote.promoValidation.error}
                </p>
              )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
