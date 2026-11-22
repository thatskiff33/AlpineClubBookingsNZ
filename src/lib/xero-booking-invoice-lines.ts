/**
 * The guest lines of a booking invoice (#713, #1163, #1930, #3170).
 *
 * Its own module so the member-money primary-invoice planner can call the
 * builder the sender calls, without importing the sender (`INV-SSOT`).
 * `xero-booking-invoices.ts` re-exports it for its existing importers.
 *
 * Which runs of nights each guest is billed for — including what a night whose
 * price is not known (#3170) does to them — is decided once, by the
 * provider-neutral `buildGuestInvoiceLines` (#5066), which the app's own
 * generated booking invoice reads too. This module only words and codes each
 * run as a Xero `LineItem`. Its output is byte-identical to the builder's
 * before the runs moved out (pinned by `xero-booking-invoice-lines.test.ts`).
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
import { formatDateOnly } from "@/lib/date-only";
import { buildGuestInvoiceLines, type GuestInvoiceLineGuest } from "@/lib/booking-guest-invoice-lines";
import { BASELINE_XERO_TAX_RENDERING, xeroLineTax, type XeroTaxRendering } from "@/lib/xero-tax-rendering";

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
 * @param taxRendering - The treatment the lines carry (#4632), resolved from
 *   the booking's tax anchor by every caller that sends the document; the
 *   baseline only for a caller that totals lines without sending them.
 */
export function buildInvoiceLineItems(
  guests: Array<
    GuestInvoiceLineGuest & {
      firstName: string;
      lastName: string;
      ageTier: string;
      isMember: boolean;
      // Rate-membership-type snapshot (#1930, E4) — drives the hut-fee item code.
      rateMembershipTypeId?: string | null;
    }
  >,
  checkIn: Date,
  checkOut: Date,
  nights: number,
  accountCode: string = "200",
  itemCode?: string | null,
  accountCodeExplicitlyConfigured: boolean = false,
  itemCodeResolver?: HutFeeItemCodeResolver,
  seasonType?: string | null,
  taxRendering: XeroTaxRendering = BASELINE_XERO_TAX_RENDERING,
): LineItem[] {
  // One line item per run. The degenerate zero-night run carries
  // `nightCount: nights` over the booking's own range with the flat price as
  // its rate, so it words and prices exactly as the legacy single line did.
  return buildGuestInvoiceLines(guests, checkIn, checkOut, nights).map(({ guest, run }) => {
    const description = [
      `${guest.firstName} ${guest.lastName}`,
      // #2543: the label follows the RATE snapshot, so it agrees with the item
      // code resolved from the same field. See `describeGuestRateMembershipLabel`.
      `(${guest.ageTier}, ${describeGuestRateMembershipLabel(itemCodeResolver, guest)})`,
      `${run.nightCount} night${run.nightCount !== 1 ? "s" : ""}`,
      `${formatDateOnly(run.startDate)} - ${formatDateOnly(run.endExclusive)}`,
    ].join(" - ");
    // The precedence (#1930, E4) lives in `xero-hut-fee-line-codes.ts`, shared
    // with the itemised modification documents (#3530), so a night's money is
    // coded the same way whichever document carries it.
    // perNightCents * nightCount === totalCents by construction, so the line
    // reconciles to the exact cent total (#1163).
    return applyHutFeeLineCodes(
      {
        description,
        quantity: run.nightCount,
        unitAmount: run.perNightCents / 100, // Xero uses dollars, not cents
        ...xeroLineTax(taxRendering), // the booking's tax treatment (#4632)
      },
      {
        itemCode: resolveHutFeeLineItemCode(guest, { itemCodeResolver, seasonType, itemCode }),
        accountCode,
        accountCodeExplicitlyConfigured,
      },
    );
  });
}
