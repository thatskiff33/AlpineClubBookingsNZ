"use client";

import { useMemo } from "react";
import type { PromoResult } from "@/components/promo-code-input";
import { PromoCodeList, type PromoChipOption } from "@/components/promo-code-list";
import { useGuestPromoCodes, validatePromoCodeList } from "@/components/promo-code-list-client";

type PartyGuest = {
  firstName?: string;
  lastName?: string;
  ageTier: string;
  isMember: boolean;
  memberId?: string;
  stayStart?: string;
  stayEnd?: string;
};

function guestName(guest: PartyGuest | undefined, index: number) {
  const name = [guest?.firstName, guest?.lastName].filter(Boolean).join(" ").trim();
  return name || `Guest ${index + 1}`;
}

/**
 * The promo codes of a booking that does not exist yet (#3492): the member
 * wizard's review step and the admin Book-on-Behalf review. Asks the guest-code
 * lookup about the party's member guests (the server keeps only the booker's
 * family — a cross-family guest's codes appear once the booking exists and they
 * have accepted), and prices the list through the several-code preview.
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
  const guestGroups = guestCodes.groups.flatMap((group) => {
    const memberId = guestMemberIds[Number(group.guestRef)];
    const index = guests.findIndex((guest) => guest.memberId === memberId);
    if (!memberId || index < 0) return [];
    return [
      {
        guestName: guestName(guests[index], index),
        codes: group.codes.map((chip): PromoChipOption => ({ code: chip.code, detail: chip.benefit })),
      },
    ];
  });

  return (
    <PromoCodeList
      applied={applied}
      onChange={onChange}
      multiPromoCodes={guestCodes.multiPromoCodes === true}
      ownCodes={ownCodes.map((chip) => ({ code: chip.code, detail: chip.description }))}
      guestGroups={guestGroups}
      guestLabel={(index) => `${guestName(guests[index], index)}${guests[index]?.isMember ? " (member)" : ""}`}
      validate={(entries, appliesTo) =>
        validatePromoCodeList({
          entries,
          appliesTo,
          checkIn,
          checkOut,
          guests,
          lodgeId,
          forMemberId,
        })
      }
      disabled={disabled}
      disabledReason={disabledReason}
    />
  );
}
