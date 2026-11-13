/**
 * The guest lines of a booking invoice (#713, #1163, #1930, #3170).
 *
 * Its own module so the member-money primary-invoice planner can call the
 * builder the sender calls, without importing the sender (`INV-SSOT`).
 * `xero-booking-invoices.ts` re-exports it for its existing importers.
 */

import type { LineItem } from "xero-node";
import {
  describeGuestRateMembershipLabel,
  type HutFeeItemCodeResolver,
} from "./xero-mappings";
import {
  applyHutFeeLineCodes,
  resolveHutFeeLineItemCode,
} from "@/lib/xero-hut-fee-line-codes";
import { calendarDateOfDateOnlyInstant } from "@/lib/club-time";
import {
  evenlySplitCents,
  ONE_DAY_MS,
  splitNightsIntoPriceRuns,
  type NightPriceRun,
} from "@/lib/night-price-runs";

/**
 * Build Xero invoice line items from a booking's guests and stay nights.
 * Exported for testing.
 *
 * @param itemCodeResolver - Per-guest hut-fee item code resolver keyed by
 *   membership type (#1930, E4). When provided with a seasonType, each guest
 *   gets its own item code from its rateMembershipType snapshot (NULL falls
 *   back isMember -> FULL/NON_MEMBER).
 * @param itemCode - Single hutFeesIncome item code applied to all guests, used
 *   only when the resolver is absent/unconfigured or no seasonType is known —
 *   never as a fallback for a per-guest miss once keyed rows exist.
 */
export function buildInvoiceLineItems(
  guests: Array<{
    firstName: string;
    lastName: string;
    ageTier: string;
    isMember: boolean;
    // Rate-membership-type snapshot (#1930, E4) — drives the hut-fee item code.
    rateMembershipTypeId?: string | null;
    priceCents: number;
    // Per-night rows (issue #713). When present, line items are emitted per
    // contiguous run; otherwise the guest is billed as one line over the whole
    // booking range, the pre-#713 behaviour.
    // #3170: a night whose stored price is `null` is a night whose sold price is
    // NOT KNOWN — written by a parked edit that committed a structural change
    // without valuing it. See the guest branch below for what this builder does
    // with one, and why it does not simply drop it.
    nights?: Array<{ stayDate: Date; priceCents: number | null }> | null;
  }>,
  checkIn: Date,
  checkOut: Date,
  nights: number,
  accountCode: string = "200",
  itemCode?: string | null,
  accountCodeExplicitlyConfigured: boolean = false,
  itemCodeResolver?: HutFeeItemCodeResolver,
  seasonType?: string | null,
): LineItem[] {
  // The precedence itself (#1930, E4) lives in `xero-hut-fee-line-codes.ts`,
  // shared with the itemised modification documents (#3530) so a night's money
  // is coded the same way whichever document carries it.
  const applyCodes = (
    lineItem: LineItem,
    guest: { ageTier: string; isMember: boolean; rateMembershipTypeId?: string | null },
  ) =>
    applyHutFeeLineCodes(lineItem, {
      itemCode: resolveHutFeeLineItemCode(guest, { itemCodeResolver, seasonType, itemCode }),
      accountCode,
      accountCodeExplicitlyConfigured,
    });

  const runToLineItem = (
    run: NightPriceRun,
    guest: {
      firstName: string;
      lastName: string;
      ageTier: string;
      isMember: boolean;
      rateMembershipTypeId?: string | null;
    }
  ): LineItem => {
    const description = [
      `${guest.firstName} ${guest.lastName}`,
      // #2543: the label follows the RATE snapshot, so it agrees with the item
      // code `applyCodes` resolves from the same field. See
      // `describeGuestRateMembershipLabel`.
      `(${guest.ageTier}, ${describeGuestRateMembershipLabel(itemCodeResolver, guest)})`,
      `${run.nightCount} night${run.nightCount !== 1 ? "s" : ""}`,
      `${calendarDateOfDateOnlyInstant(run.startDate)} - ${calendarDateOfDateOnlyInstant(run.endExclusive)}`,
    ].join(" - ");
    // perNightCents * nightCount === totalCents by construction, so the line
    // reconciles to the exact cent total (#1163).
    return applyCodes({
      description,
      quantity: run.nightCount,
      unitAmount: run.perNightCents / 100, // Xero uses dollars, not cents
      taxType: "OUTPUT2", // GST on Income (NZ)
    }, guest);
  };

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
    const guestNights = loadedNights.every(
      (night): night is { stayDate: Date; priceCents: number } =>
        typeof night.priceCents === "number",
    )
      ? loadedNights
      : [];

    // No per-night detail: bill the whole booking range (legacy path). Split
    // the flat total into an exact per-night cent vector and run it through the
    // same price-run splitter, so the emitted lines reconcile to guest.priceCents
    // by construction (#1163). With no remainder this collapses to one line,
    // byte-identical to the pre-#1163 behaviour.
    if (guestNights.length === 0) {
      if (nights <= 0) {
        // Degenerate range: keep the single legacy line (quantity 0) rather
        // than dividing by zero in the even split.
        const description = [
          `${guest.firstName} ${guest.lastName}`,
          // #2543 — same rate-driven label as `runToLineItem`.
          `(${guest.ageTier}, ${describeGuestRateMembershipLabel(itemCodeResolver, guest)})`,
          `${nights} night${nights !== 1 ? "s" : ""}`,
          `${calendarDateOfDateOnlyInstant(checkIn)} - ${calendarDateOfDateOnlyInstant(checkOut)}`,
        ].join(" - ");
        return [applyCodes({
          description,
          quantity: nights,
          unitAmount: guest.priceCents / 100, // Xero uses dollars, not cents
          taxType: "OUTPUT2", // GST on Income (NZ)
        }, guest)];
      }
      const syntheticNights = evenlySplitCents(guest.priceCents, nights).map(
        (priceCents, i) => ({
          stayDate: new Date(checkIn.getTime() + i * ONE_DAY_MS),
          priceCents,
        })
      );
      return splitNightsIntoPriceRuns(syntheticNights).map((run) =>
        runToLineItem(run, guest)
      );
    }

    // One line item per price-homogeneous contiguous run of nights.
    return splitNightsIntoPriceRuns(guestNights).map((run) =>
      runToLineItem(run, guest)
    );
  });
}
