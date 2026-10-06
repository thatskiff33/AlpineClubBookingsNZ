"use client";

import { useEffect, useMemo } from "react";
import {
  promoGuestCheckboxLabel,
  promoGuestName,
  type PromoResult,
} from "@/components/promo-code-input";
import { PromoCodeList } from "@/components/promo-code-list";
import {
  guestPromoChipGroups,
  guestPromoCodesProblem,
  useGuestPromoCodes,
  validatePromoCodeList,
} from "@/components/promo-code-list-client";
import { useClubFormat } from "@/components/club-format-provider";
import { formatSignedCents } from "@/lib/utils";

type PartyGuest = {
  firstName?: string;
  lastName?: string;
  ageTier: string;
  isMember: boolean;
  memberId?: string;
  stayStart?: string;
  stayEnd?: string;
};

/**
 * The promo codes of a booking that does not exist yet (#3492): the member
 * wizard's review step and the admin Book-on-Behalf review. Asks the guest-code
 * lookup about the party's member guests (the server keeps only the booker's
 * family — a cross-family guest can only be confirmed once the booking exists,
 * so their codes appear on its edit panel then), and prices the list through
 * the several-code preview.
 *
 * `workPartyEventId` (the wizard, with the club's `multiPromoCodes` switch on):
 * the working bee the booking also takes, which claims its in-window nights
 * before any code (D-3813-3), so each code is priced after it.
 */
export function BookingPromoCodes({
  applied,
  onChange,
  checkIn,
  checkOut,
  guests,
  lodgeId,
  forMemberId,
  ownCodes,
  disabled,
  disabledReason,
  workPartyEventId,
  onMultiPromoCodesChange,
}: {
  applied: PromoResult[];
  onChange: (next: PromoResult[]) => void;
  checkIn: string;
  checkOut: string;
  guests: PartyGuest[];
  lodgeId: string | null | undefined;
  /** An officer booking on a member's behalf. */
  forMemberId?: string;
  ownCodes: Array<{ code: string; description: string | null }>;
  disabled?: boolean;
  disabledReason?: string;
  workPartyEventId?: string;
  /** Told the club's `multiPromoCodes` switch once the lookup answers (null until then). */
  onMultiPromoCodesChange?: (value: boolean | null) => void;
}) {
  const guestMemberIds = useMemo(
    () => [...new Set(guests.flatMap((guest) => (guest.memberId ? [guest.memberId] : [])))],
    [guests],
  );
  const guestCodes = useGuestPromoCodes(
    lodgeId
      ? { lodgeId, guestMemberIds, ...(forMemberId ? { forMemberId } : {}) }
      : null,
  );
  useEffect(() => {
    onMultiPromoCodesChange?.(guestCodes.multiPromoCodes);
  }, [guestCodes.multiPromoCodes, onMultiPromoCodesChange]);
  const guestGroups = guestPromoChipGroups({
    groups: guestCodes.groups,
    nameFor: (guestRef) => {
      const memberId = guestMemberIds[Number(guestRef)];
      const index = memberId ? guests.findIndex((guest) => guest.memberId === memberId) : -1;
      return index < 0 ? null : promoGuestName(guests[index], index);
    },
    ownCodes: ownCodes.map((chip) => chip.code),
  });
  const problem = guestPromoCodesProblem(guestCodes.status);

  return (
    <>
      <PromoCodeList
        applied={applied}
        onChange={onChange}
        multiPromoCodes={guestCodes.multiPromoCodes === true}
        ownCodes={ownCodes.map((chip) => ({ code: chip.code, detail: chip.description }))}
        guestGroups={guestGroups}
        guestLabel={(index) => promoGuestCheckboxLabel(guests[index], index)}
        validate={(entries, appliesTo) =>
          validatePromoCodeList({
            entries,
            appliesTo,
            checkIn,
            checkOut,
            guests,
            lodgeId,
            forMemberId,
            ...(workPartyEventId ? { workPartyEventId } : {}),
          })
        }
        disabled={disabled}
        disabledReason={disabledReason}
      />
      {problem && <p className="text-sm text-muted-foreground">{problem}</p>}
    </>
  );
}

/**
 * The price summary's promo rows (#3492): one per applied code — or the working
 * bee — in the booker's order, each with its own signed adjustment. Shared by
 * the member wizard and Book on Behalf, which differ only in their colour tokens.
 */
export function PromoAdjustmentRows({
  applied,
  palette,
}: {
  applied: PromoResult[];
  palette: "member" | "admin";
}) {
  const format = useClubFormat();
  const tone = (cents: number) =>
    palette === "member"
      ? cents > 0 ? "text-warning" : "text-success"
      : cents > 0 ? "text-warning-11" : "text-success-11";
  return applied
    .filter((promo) => promo.promoAdjustmentCents !== 0)
    .map((promo) => (
      <div
        key={promo.code ?? promo.workPartyEvent?.id}
        className={`flex justify-between gap-3 text-sm ${tone(promo.promoAdjustmentCents)}`}
      >
        <span>
          {promo.workPartyEvent
            ? `Working bee discount (${promo.workPartyEvent.name})`
            : `Promo adjustment (${promo.code})`}
        </span>
        <span>{formatSignedCents(promo.promoAdjustmentCents, format)}</span>
      </div>
    ));
}
