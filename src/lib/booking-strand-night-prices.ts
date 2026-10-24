import type { MemberGuestConsentStatus } from "@prisma/client";

// The shape a promotion is re-decided over: each guest's nights as rates, in
// stay order (#3827). Since #4317 (review H1) every producer values the nights
// through `valuedStrandNightPrices` (`INV-MOD-028`); the exact-only reader that
// lived here, `readStrandNightPrices`, is gone with the last caller that
// declined on it.

export type StrandNightPrices = {
  bookingGuestId: string;
  memberId: string | null;
  isMember: boolean;
  consentStatus: MemberGuestConsentStatus | null;
  perNightRates: number[];
  nightDates: Date[];
};
