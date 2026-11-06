import type { ClubFormat } from "../../club-format";
import { clubChargeCurrencyCode } from "../../stripe-charge-currency";
import type { MemberMoneyPostingContext } from "./plan";

/**
 * WHETHER THE JOURNAL IS ACTIVE FOR THIS CLUB (#4627, Ledger M3b). A pure,
 * pre-transaction decision, never a refused posting caught after the fact.
 *
 * The journal posts in the currency card charges use (`resolveMemberMoneyPostingContext`).
 * A club whose stored currency no card can be charged in is a state the product
 * tolerates on purpose (#3567 D3: pages render, only card charges refuse). For
 * such a club the journal is inactive: every booking door goes ahead and posts
 * nothing, exactly as a booking confirmed before M3b posts nothing, and the
 * census reports the club as `JOURNAL_INACTIVE` until the currency is fixed.
 */
export interface BookingJournalInactive {
  readonly inactive: "unusable-currency";
  readonly detail: string;
}

/** What a door carries into its transaction: a posting context, or the reason the journal is inactive. */
export type BookingJournalContext = MemberMoneyPostingContext | BookingJournalInactive;

/** Why the journal posts nothing for this club, or null when it is active. */
export function bookingJournalInactiveReason(format: ClubFormat): string | null {
  if (clubChargeCurrencyCode(format) !== null) return null;
  return `the club's stored currency (${format.unusableStoredCurrency ?? format.currencyCode}) cannot be charged by card, so the member-money journal posts nothing until it is fixed`;
}

export const isBookingJournalInactive = (context: BookingJournalContext): context is BookingJournalInactive =>
  "inactive" in context;
