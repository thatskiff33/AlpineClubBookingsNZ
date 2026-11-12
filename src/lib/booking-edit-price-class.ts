import {
  requestCarriesOtherLodgeElection,
  type OtherLodgeRateInput,
} from "@/lib/booking-other-lodge-rate";
import {
  requestChangesPromoCodes,
  type PromoCodeRequestFields,
} from "@/lib/booking-modify-promo-request";

/**
 * The request fields that decide whether a booking edit moves money, in one
 * shape both the preview (`modify-quote`) and the save (`modifyBookingBatch`)
 * hand over. Loosely typed on purpose: the route's zod body and the batch input
 * spell the guest arrays differently, and only their presence matters here.
 */
export interface ModificationPriceClassRequest
  extends OtherLodgeRateInput,
    PromoCodeRequestFields {
  checkIn?: unknown;
  checkOut?: unknown;
  addGuests?: { length: number } | null;
  removeGuestIds?: { length: number } | null;
  guestStayRanges?: { length: number } | null;
  linkGuestToMember?: { length: number } | null;
  guestUpdates?: { length: number } | null;
  applyCreditCents?: number;
}

export interface ModificationPriceClass {
  /**
   * Guest name updates and nothing structural (#1099). Read from the REQUEST,
   * not from which names actually differ: a rename that resends the stored
   * names is still a rename, and it changes nothing at all. Gates the
   * quote-priced exemption and the paid-booking typo allowance.
   */
  identityOnly: boolean;
  /** A credit election and nothing else (#2266). */
  creditElectionOnly: boolean;
  /**
   * The edit takes the price-preserving echo: stored totals, stored final
   * price, no pricing engine, no promotion, no money moved. An other-lodge
   * election is never price-preserving whatever else rides with it (#2978) —
   * a re-rate has to reach the rate resolver.
   */
  pricePreserving: boolean;
}

/**
 * Whether a booking edit is price-preserving, answered ONCE for the preview and
 * the save (`INV-SSOT`, ALP-573).
 *
 * Each side used to spell this out for itself, and they disagreed on a rename
 * whose names equal the stored ones: the preview read the request (identity-
 * only, echo the stored money) while the save read the resolved name changes
 * (none, so reprice at today's rates). Whenever rates had moved, the save then
 * settled a difference the preview never showed. One function cannot disagree
 * with itself.
 *
 * The other-lodge fields are deliberately NOT structural for `identityOnly`, so
 * the quote-priced exemptions keep their meaning (an officer's election-only
 * edit is exempted by `requestIsOtherLodgeRateElectionOnly`); they are folded
 * in only at `pricePreserving`.
 */
export function classifyModificationRequest(
  request: ModificationPriceClassRequest,
): ModificationPriceClass {
  const structural = Boolean(
    request.checkIn ||
      request.checkOut ||
      request.addGuests?.length ||
      request.removeGuestIds?.length ||
      request.guestStayRanges?.length ||
      // #2337: a link re-rates a guest, so it is structural — it must never
      // take the price-preserving echo (that would skip the re-rate).
      request.linkGuestToMember?.length ||
      requestChangesPromoCodes(request),
  );
  const identityOnly = !structural && Boolean(request.guestUpdates?.length);
  const creditElectionOnly =
    !structural &&
    !request.guestUpdates?.length &&
    request.applyCreditCents !== undefined;
  return {
    identityOnly,
    creditElectionOnly,
    pricePreserving:
      (identityOnly || creditElectionOnly) &&
      !requestCarriesOtherLodgeElection(request),
  };
}
