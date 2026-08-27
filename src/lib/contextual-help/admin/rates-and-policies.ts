/**
 * Help for the "Rates & Policies" admin section: what a stay costs, who may
 * book it, and the promotions that change either.
 *
 * Section per the sidebar's `buildAdminNavSections`. Seasons sit here too — they are
 * reached from Fees rather than from a menu entry of their own, and what they
 * configure is the rate calendar.
 */
import { entry, help, type HelpEntry } from "../types";

export const adminRatesAndPoliciesHelpEntries: HelpEntry[] = [
  entry(
    "/admin/seasons",
    help(
      "Seasons",
      "This page defines the seasonal date windows (name, type, dates, active) used by booking quotes. Nightly hut-fee rates live on the Fees page.",
      [
        "Create or edit season windows before the booking period opens.",
        "Set overlapping dates carefully; a season window drives which nightly rates apply.",
        "Manage the nightly rates for each season on the Fees page (Hut Fees section).",
      ],
      [
        {
          name: "Season dates",
          description:
            "The date-only range where this season applies.",
        },
        {
          name: "Season type",
          description:
            "Whether the window is a Winter or Summer season.",
        },
        {
          name: "Active",
          description:
            "Whether the season window is currently in effect.",
        },
      ],
    ),
  ),
  entry(
    "/admin/age-tier-settings",
    help(
      "Age Groups",
      "Age groups define how member and guest ages map to infant, child, youth, and adult pricing or policy behavior.",
      [
        "Review the current tier boundaries before changing fees or membership type rules.",
        "Update age ranges only when the club policy changes.",
        "Save and then recheck booking quote behavior in a non-production environment for high-impact changes.",
      ],
      [
        {
          name: "Minimum age",
          description:
            "The first age included in a tier.",
        },
        {
          name: "Maximum age",
          description:
            "The last age included in a tier, if the tier has an upper bound.",
        },
        {
          name: "Tier code",
          description:
            "The system label used by pricing, membership types, and Xero group rules.",
        },
      ],
    ),
  ),
  entry(
    "/admin/promo-codes",
    help(
      "Promo Codes",
      "Promo codes apply controlled discounts to eligible bookings.",
      [
        "Create codes with clear validity dates, usage limits, and discount rules.",
        "Deactivate or expire a code instead of deleting historical context.",
        "Test the code against a quote before publishing it to members.",
      ],
      [
        {
          name: "Code",
          description:
            "The member-entered value used during booking.",
        },
        {
          name: "Discount",
          description:
            "The configured price reduction, stored and applied in cents or percent according to the code type.",
        },
        {
          name: "Usage limit",
          description:
            "Controls how many times the code can be redeemed.",
        },
      ],
    ),
  ),
  entry(
    "/admin/booking-policies",
    help(
      "Booking Policies",
      "Booking policies control cancellation rules, group discounts, minimum stays, and public request settings.",
      [
        "Open the policy area you need and edit only the rule that is changing.",
        "Check effective dates, booking status, and member/non-member behavior before saving.",
        "Review the wording members or requesters will see after the policy change.",
      ],
      [
        {
          name: "Effective window",
          description:
            "The dates or conditions where a policy applies.",
        },
        {
          name: "Penalty or discount",
          description:
            "The configured cents or percent value used by quotes, cancellations, or public requests.",
        },
        {
          name: "Public request setting",
          description:
            "Controls how non-member request workflows behave.",
        },
      ],
    ),
  ),
];
