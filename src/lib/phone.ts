import type { AgeTier } from "@prisma/client";

/**
 * Single source of truth (fork hoppers99/AlpineClubBookingsNZ#125 / hoppers99/AlpineClubBookingsNZ#37) for whether a member's phone number
 * may be served to a lodge kiosk or lobby-display surface. Two-sided consent
 * with an adults-only floor:
 *   - the lodge must enable phone display (config side), AND
 *   - the member must have opted in on their profile (permission side), AND
 *   - the member must be an adult, regardless of the two settings.
 *
 * Enforced in the SERVING serialisers ONLY (the kiosk `guests/[date]` route and
 * the lobby display-state builder); never in a template or client component
 * (#37 AC4 — no surface may display a number the API did not serve). Defaults on
 * both flags are `false`, so the pre-feature behaviour is "no phone" until a
 * lodge opts its screens in AND the member opts their number in.
 */
export function canServeMemberPhoneOnLodgeSurface(input: {
  lodgeShowGuestPhonesOnScreens: boolean;
  memberOptedIn: boolean;
  ageTier: AgeTier;
}): boolean {
  return (
    input.lodgeShowGuestPhonesOnScreens &&
    input.memberOptedIn &&
    input.ageTier === "ADULT"
  );
}

export function formatXeroPhone(phone: {
  phoneCountryCode?: string | null;
  phoneAreaCode?: string | null;
  phoneNumber?: string | null;
}): string | null {
  if (!phone.phoneNumber) return null;

  const parts: string[] = [];
  if (phone.phoneCountryCode) {
    parts.push(`+${phone.phoneCountryCode.replace(/^\+/, "")}`);
  }
  if (phone.phoneAreaCode) {
    parts.push(phone.phoneAreaCode);
  }
  parts.push(phone.phoneNumber);

  return parts.join(" ");
}
