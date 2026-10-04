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
import { useClubFormat } from "@/components/club-format-provider";
import { PromoCodeList, type GuestPromoChipGroup } from "@/components/promo-code-list";
import { useGuestPromoCodes, validatePromoCodeList } from "@/components/promo-code-list-client";

type StoredPromoLine = PromoInfo & { amountCents: number };

/** The booking's own codes as list entries, in its stored order (working bee aside). */
function storedPromoList(
  promo: PromoInfo | null,
  promoLines: StoredPromoLine[] | undefined,
  promoAdjustmentCents: number,
): PromoResult[] {
  const lines = promoLines ?? (promo ? [{ ...promo, amountCents: promoAdjustmentCents }] : []);
  return lines
    .filter((line) => !line.workPartyEventName)
    .map((line) => ({
      code: line.code,
      description: line.description,
      type: line.type,
      discountCents: 0,
      promoAdjustmentCents: line.amountCents,
      totalPriceCents: 0,
      finalPriceCents: 0,
    }));
}

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
  bookingId,
  promo,
  promoLines,
  appliedPromoList,
  onPromoListChange,
  onKeepPromoList,
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
  bookingId: string;
  promo: PromoInfo | null;
  /** #3828: one row per code on a booking carrying several. */
  promoLines?: StoredPromoLine[];
  /** #3492: the list being edited, or null for the booking's stored codes. */
  appliedPromoList: PromoResult[] | null;
  onPromoListChange: (next: PromoResult[]) => void;
  onKeepPromoList: () => void;
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
  const format = useClubFormat();
  // #3492: the booking's staying guest members' codes (the server reads the
  // guests itself and offers only family or accepted guests), and the club's
  // `multiPromoCodes` switch, which decides which editor this card shows.
  const guestCodes = useGuestPromoCodes({ bookingId });
  const guestNameById = new Map(
    remainingGuests.map((guest) => [guest.id, [guest.firstName, guest.lastName].filter(Boolean).join(" ")]),
  );
  const guestGroups: GuestPromoChipGroup[] = guestCodes.groups.flatMap((group) => {
    const guestName = guestNameById.get(group.guestRef);
    return guestName
      ? [{ guestName, codes: group.codes.map((chip) => ({ code: chip.code, detail: chip.benefit })) }]
      : [];
  });
  const partyGuests = [
    ...remainingGuests.map((g) => ({
      firstName: g.firstName,
      lastName: g.lastName,
      ageTier: g.ageTier,
      isMember: g.isMember,
      memberId: g.memberId ?? undefined,
      ...(perGuestDatesEnabled && !isInProgressEdit ? getExistingGuestRange(g) : {}),
    })),
    ...addedGuests.map((g) => ({
      firstName: g.firstName,
      lastName: g.lastName,
      ageTier: g.ageTier as string,
      isMember: g.isMember,
      memberId: g.memberId,
      ...(perGuestDatesEnabled && !isInProgressEdit && g.stayStart && g.stayEnd
        ? { stayStart: g.stayStart, stayEnd: g.stayEnd }
        : {}),
    })),
  ];
  const stored = storedPromoList(promo, promoLines, promoAdjustmentCents);
  const shownList = appliedPromoList ?? stored;
  const workPartyName =
    promo?.workPartyEventName ?? promoLines?.find((line) => line.workPartyEventName)?.workPartyEventName;
  const quoteRefusal =
    (promoAction.type === "new" || promoAction.type === "list") &&
    quote?.promoValidation &&
    !quote.promoValidation.valid
      ? quote.promoValidation.error
      : null;

  if (guestCodes.multiPromoCodes === true) {
    const storedByCode = new Map(stored.map((entry) => [entry.code, entry]));
    const shownByCode = new Map(shownList.map((entry) => [entry.code, entry]));
    return (
      <Card>
        <CardHeader>
          <CardTitle>Promo Codes</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {workPartyName && (
            <p className="text-sm text-success-11">Working bee: {workPartyName} (stays on the booking)</p>
          )}
          <PromoCodeList
            applied={shownList}
            onChange={onPromoListChange}
            multiPromoCodes
            ownCodes={availablePromoCodes.map((pc) => ({ code: pc.code, detail: pc.description }))}
            guestGroups={guestGroups}
            guestLabel={(index) => {
              const guest = partyGuests[index];
              const name = [guest?.firstName, guest?.lastName].filter(Boolean).join(" ").trim();
              return `${name || `Guest ${index + 1}`}${guest?.isMember ? " (member)" : ""}`;
            }}
            // The edit's own quote (modify-quote) prices the whole list in
            // order; the amount shown is the summary's, never a per-code guess.
            showAmounts={false}
            validate={async (entries, appliesTo) => {
              // A code the booking already carries is kept and re-priced by the
              // save; only a code being added is checked here.
              const fresh = entries.filter(
                (entry) => !storedByCode.has(entry.code) || entry.promoGuestIndexes?.length,
              );
              const checked = fresh.length
                ? await validatePromoCodeList({
                    entries: fresh,
                    appliesTo,
                    checkIn,
                    checkOut,
                    guests: partyGuests,
                    lodgeId,
                    forMemberId,
                    forBookingEdit: true,
                  })
                : { ok: true as const, applied: [] };
              if (!checked.ok) return checked;
              return {
                ok: true,
                applied: entries.map(
                  (entry) =>
                    checked.applied.find((result) => result.code === entry.code) ??
                    shownByCode.get(entry.code) ??
                    storedByCode.get(entry.code)!,
                ),
              };
            }}
          />
          {promoAction.type === "list" && (
            <Button variant="outline" size="sm" onClick={onKeepPromoList}>
              Undo promo code changes
            </Button>
          )}
          {quoteRefusal && <p className="text-sm text-danger-11">{quoteRefusal}</p>}
        </CardContent>
      </Card>
    );
  }

  // #3828: with the switch off (or not yet answered), a several-code booking's
  // codes are shown read-only — the one-code controls below would release
  // every other code.
  if (hasSeveralPromoCodes({ promoLines })) return <SeveralPromoCodesCard promoLines={promoLines} />;

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
                ({formatSignedCents(promoAdjustmentCents, format)})
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
            {guestGroups.length > 0 && !appliedNewPromo && (
              <div className="app-callout-brand space-y-2 p-4">
                <p className="text-sm font-medium text-foreground">
                  Your guests have promo codes. Each one covers only that guest&apos;s nights:
                </p>
                {guestGroups.map((group) =>
                  group.codes.map((chip) => (
                    <button
                      key={`${group.guestName}:${chip.code}`}
                      type="button"
                      onClick={() => onPrefillCode(chip.code)}
                      className="app-chip-brand mr-2 font-mono"
                    >
                      {chip.code}
                      <span className="font-sans font-normal text-brand-charcoal">
                        {chip.detail ? ` — ${chip.detail}` : ""} (applies to {group.guestName} only)
                      </span>
                    </button>
                  )),
                )}
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
              guests={partyGuests}
              onPromoApplied={onPromoApplied}
              appliedPromo={appliedNewPromo}
              forMemberId={forMemberId}
              lodgeId={lodgeId}
              prefillCode={prefillPromoCode}
            />
            {/* The booking-aware re-validation (modify-quote) can refuse a
                code the standalone validator accepted (e.g. already redeemed
                against this booking's dates); surface that honestly. */}
            {quoteRefusal && <p className="text-sm text-danger-11">{quoteRefusal}</p>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * #3828: does the booking carry several promo codes? Then the one-code
 * controls never show: `PromoCodeCard` renders #3492's list editor (which sends
 * the whole `promoCodes` list) where the club's `multiPromoCodes` switch is on,
 * and the read-only `SeveralPromoCodesCard` otherwise. Deliberately stricter
 * than the server's refusal, which ignores a working-bee discount: with one
 * booker code beside a working-bee discount the server would accept a one-code
 * swap, but the one-code card cannot show which code is current on such a
 * booking, so it is withheld there too (the list editor names the working-bee
 * discount separately and keeps it).
 */
export function hasSeveralPromoCodes(booking: { promoLines?: ReadonlyArray<unknown> }): boolean {
  return (booking.promoLines?.length ?? 0) > 1;
}

/**
 * #3828: a booking carrying several promo codes where #3492's list editor is
 * not offered (the club's `multiPromoCodes` switch is off, or has not yet
 * answered). The one-code controls would send the legacy one-code request,
 * which replaces or releases EVERY code (and the server refuses it), so the
 * codes are shown read-only. Renders nothing for one code or none.
 */
export function SeveralPromoCodesCard({
  promoLines,
}: {
  promoLines: ReadonlyArray<PromoInfo & { amountCents: number }> | undefined;
}) {
  const format = useClubFormat();
  if (!promoLines || !hasSeveralPromoCodes({ promoLines })) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Promo Codes</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <ul className="space-y-1">
          {promoLines.map((line) => (
            <li key={line.code}>
              <span className="font-medium">
                {line.workPartyEventName ? `Working bee: ${line.workPartyEventName}` : line.code}
              </span>
              <span className="text-sm text-muted-foreground ml-2">
                ({formatSignedCents(line.amountCents, format)})
              </span>
            </li>
          ))}
        </ul>
        <p className="text-sm text-muted-foreground">
          This booking has more than one promo code, and codes on a booking like this
          can&apos;t be added, removed or swapped here. Any other change you make
          re-prices them.
        </p>
      </CardContent>
    </Card>
  );
}
