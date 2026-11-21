// Moved out of src/lib/booking-batch-modification-service.ts verbatim (#5149:
// that file is past its hard size ceiling, and this is a cohesive pure part of
// it). Its one caller is `modifyBookingBatch`'s identity-only branch.
import type { LoadedBookingForModify, PricingResult } from "@/lib/booking-modify";

/**
 * Pricing echo for identity-only modifications (#1099): stored totals,
 * per-guest prices, and night rows exactly as persisted, in booking-guest
 * order (matching proposedRemainingGuests when nothing is added or removed).
 * Guests without night rows (quoted or pre-#713 bookings) echo empty night
 * arrays, which the guest-sync step treats as "leave the rows alone".
 */
export function buildIdentityOnlyPricing(booking: LoadedBookingForModify): PricingResult {
  // #3031: NO `?? 0`, ANYWHERE IN THIS ECHO. These amounts are written straight
  // back onto `BookingGuestNight.priceCents` by `syncGuestNights`, so a default
  // would replace a night's real sold price with a magic zero on an edit whose
  // entire promise is that it preserves it (INV-MOD-028). A night loaded without
  // its price is a SELECT that did not ask for it — the census in
  // `in-progress-edit-sold-price-census.test.ts` exists to stop exactly that —
  // and the honest response is to refuse rather than to invent. A stored value
  // that is negative IS echoed, unchanged: the promise is byte-for-byte
  // preservation, and repairing damaged rows is #2745's audited decision, not
  // this echo's.
  //
  // ONE READ OF THE ROWS, feeding both the breakdown and the per-night rates
  // (`INV-SSOT`). They were read twice, and the second read defaulted — dead
  // only because object-literal properties evaluate in source order and the
  // refusal happened to precede it. A prohibited construct on a money value must
  // not depend on evaluation order for its harmlessness.
  //
  // #3170: AND A ROW THAT SAYS "NOT KNOWN" IS ECHOED AS THAT. Byte-for-byte
  // preservation is the promise, and a `NULL` is a value this column holds: a
  // parked edit wrote one before #4317, and the old deploy may still write one
  // during a blue/green overlap. A spelling correction moves no money, so it
  // writes the row back as it found it; the next priced edit values it
  // (`INV-MOD-028`).
  //
  // The two absences stay apart, exactly as they do at the write. `null` is the
  // row's own statement and is preserved; `undefined` is still a SELECT that
  // did not ask for the price — a caller wiring defect — and still throws.
  //
  // Each guest carries its own echoed nights rather than a second array read
  // back by position, so the rate vector and its dates cannot drift apart from
  // the guest they describe (#2800).
  const echoedGuests = booking.guests.map((guest) => ({
    guest,
    nights: (guest.nights ?? []).map((night) => {
      if (night.priceCents === undefined) {
        throw new Error(
          `Booking guest ${guest.id} night ${night.stayDate.toISOString()} was loaded without its stored sold price (#3031)`,
        );
      }
      if (night.priceSource === undefined) {
        throw new Error(
          `Booking guest ${guest.id} night ${night.stayDate.toISOString()} was loaded without price provenance (#3275)`,
        );
      }
      return {
        stayDate: night.stayDate,
        priceCents: night.priceCents,
        priceSource: night.priceSource,
      };
    }),
  }));
  return {
    kind: "priced",
    inProgressPlan: null,
    capacityOverridden: false,
    newTotalPriceCents: booking.totalPriceCents,
    priceBreakdown: {
      totalPriceCents: booking.totalPriceCents,
      guests: echoedGuests.map(({ guest, nights }) => ({
        priceCents: guest.priceCents,
        perNightCents: nights.map((night) => night.priceCents),
        nightDates: nights.map((night) => night.stayDate),
        perNightPriceSources: nights.map((night) => night.priceSource),
      })),
    },
    // #3170: RATES ONLY, and the pair stays aligned. A night whose stored price
    // is not known has no rate to state, so it is dropped from BOTH lists
    // together rather than carried as a null one list would read as zero. This
    // echo's rates are unused in practice — a price-preserving modification
    // re-runs no promotion cap, which is the only reader — so dropping is safe
    // as well as honest; what would not be safe is a rate vector whose
    // positions no longer matched its dates.
    guestNightRates: echoedGuests.map(({ guest, nights }) => {
      const rated = nights.filter(
        (night): night is typeof night & { priceCents: number } =>
          night.priceCents !== null,
      );
      return {
        bookingGuestId: guest.id,
        memberId: guest.memberId ?? null,
        isMember: guest.isMember,
        perNightRates: rated.map((night) => night.priceCents),
        nightDates: rated.map((night) => night.stayDate),
        consentStatus: guest.consentStatus ?? null,
      };
    }),
    // Nothing was rated here — this echo does not run the rate resolver at all.
    // A request carrying an other-lodge election is therefore kept OFF this path
    // (see `pricePreservingModification` in `modifyBookingBatch`): storing the flag from an echo
    // would stamp a re-rate the money never made.
    otherLodgeRatedGuestIds: new Set<string>(),
  };
}
