/**
 * THE ONE per-guest invoice line builder (fork #115, lifted out of
 * `buildInvoiceLineItems` in `xero-booking-invoices.ts`).
 *
 * Pure and provider-neutral: a booking's guests and stay range in, one line per
 * price-homogeneous run of each guest's nights out, all in integer cents. The
 * Xero invoice maps these lines to its own `LineItem` shape; the generated
 * booking invoice PDF prints them. Both therefore cut a guest's stay into the
 * same runs and bill the same cents (`INV-SSOT`). Output for the Xero path is
 * byte-identical to the builder's own before the move.
 */
import {
  evenlySplitCents,
  ONE_DAY_MS,
  splitNightsIntoPriceRuns,
  type NightPriceRun,
} from "@/lib/night-price-runs";

export interface GuestInvoiceLineGuest {
  priceCents: number;
  // Per-night rows (issue #713). When present, lines are emitted per
  // contiguous run; otherwise the guest is billed as one line over the whole
  // booking range, the pre-#713 behaviour.
  // #3170: a night whose stored price is `null` is a night whose sold price is
  // NOT KNOWN — written by a parked edit that committed a structural change
  // without valuing it. See the guest branch below for what this builder does
  // with one, and why it does not simply drop it.
  nights?: Array<{ stayDate: Date; priceCents: number | null }> | null;
}

/** The stretch of nights one line bills. `perNightCents * nightCount` is the line amount, except on the degenerate zero-night range. */
export type GuestInvoiceRun = Pick<
  NightPriceRun,
  "startDate" | "endExclusive" | "nightCount" | "perNightCents"
>;

export interface GuestInvoiceLine<G extends GuestInvoiceLineGuest> {
  guest: G;
  run: GuestInvoiceRun;
  /**
   * True when the guest holds a night whose price is not known (#3170), so
   * the line is the guest's stored total spread evenly over the booking range
   * rather than its real nights. The Xero invoice accepts that presentation;
   * the generated PDF refuses it rather than print an invented split.
   */
  hasUnpricedNight: boolean;
}

export function buildGuestInvoiceLines<G extends GuestInvoiceLineGuest>(
  guests: readonly G[],
  checkIn: Date,
  checkOut: Date,
  nights: number,
): Array<GuestInvoiceLine<G>> {
  return guests.flatMap((guest) => {
    const loadedNights = guest.nights ?? [];
    /**
     * #3170: the nights this guest's rows can actually price.
     *
     * A `null` night is one a PARKED edit committed without valuing (epic
     * #2797): the structural change landed and the money is held as an OPEN
     * `EDIT_FINANCIAL_REVIEW` task for a person to price.
     *
     * DROPPING SUCH A NIGHT FROM THE RUNS WOULD LOSE MONEY, silently. The runs
     * reconcile to `guest.priceCents` only because they partition every night
     * the guest holds; omitting one emits an invoice SHORT by that night's
     * share, which is a real under-charge on a live Xero document
     * (INV-MONEY-003). So an unknown night disqualifies the per-night detail
     * for this guest ENTIRELY, and the guest falls to the whole-range legacy
     * branch below — which bills `guest.priceCents`, a real stored number, over
     * the booking's own range. That is the same treatment a pre-#713 or
     * quoted guest with no night rows already gets, and it invents nothing:
     * the even split below is a LINE-SPLITTING presentation that sums to the
     * stored total exactly and is never written back to any row.
     */
    const hasUnpricedNight = loadedNights.some(
      (night) => typeof night.priceCents !== "number",
    );
    const guestNights = hasUnpricedNight
      ? []
      : (loadedNights as Array<{ stayDate: Date; priceCents: number }>);

    const line = (run: GuestInvoiceRun): GuestInvoiceLine<G> => ({
      guest,
      run,
      hasUnpricedNight,
    });

    // No per-night detail: bill the whole booking range (legacy path). Split
    // the flat total into an exact per-night cent vector and run it through the
    // same price-run splitter, so the emitted lines reconcile to guest.priceCents
    // by construction (#1163). With no remainder this collapses to one line,
    // byte-identical to the pre-#1163 behaviour.
    if (guestNights.length === 0) {
      if (nights <= 0) {
        // Degenerate range: keep the single legacy line (nightCount 0, the
        // flat price as its rate) rather than dividing by zero in the split.
        return [
          line({
            startDate: checkIn,
            endExclusive: checkOut,
            nightCount: nights,
            perNightCents: guest.priceCents,
          }),
        ];
      }
      const syntheticNights = evenlySplitCents(guest.priceCents, nights).map(
        (priceCents, i) => ({
          stayDate: new Date(checkIn.getTime() + i * ONE_DAY_MS),
          priceCents,
        }),
      );
      return splitNightsIntoPriceRuns(syntheticNights).map(line);
    }

    // One line per price-homogeneous contiguous run of nights.
    return splitNightsIntoPriceRuns(guestNights).map(line);
  });
}

/** A line's amount in cents: the run's nights at its nightly rate (0 on the degenerate zero-night line, as Xero bills it). */
export function guestInvoiceLineAmountCents(line: { run: GuestInvoiceRun }): number {
  return line.run.perNightCents * line.run.nightCount;
}
