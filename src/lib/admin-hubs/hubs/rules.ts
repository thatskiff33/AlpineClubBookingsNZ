import { defineHub } from "../define";

/**
 * Fees & booking rules. The prefix is not `fees`: `/admin/fees` carries the fee
 * console's bookings-OR-finance admission, which every page under it would
 * inherit.
 */
export const RULES_HUB = defineHub({
  key: "rules",
  label: "Fees & booking rules",
  prefix: "rules",
  pages: [
    {
      id: "fees",
      label: "Fees",
      oldPath: "/admin/fees",
      area: "bookings",
      admission: "fees-or",
      moved: false,
    },
    {
      // Redirect stub into the fee console (#1933).
      id: "fee-configuration",
      label: "Fee Configuration",
      oldPath: "/admin/fee-configuration",
      area: "finance",
      kind: "stub",
      moved: false,
    },
    {
      id: "seasons",
      label: "Seasons",
      oldPath: "/admin/seasons",
      area: "bookings",
      moved: false,
    },
    {
      id: "age-tier-settings",
      label: "Age Groups",
      oldPath: "/admin/age-tier-settings",
      area: "bookings",
      moved: false,
    },
    {
      id: "promo-codes",
      label: "Promo Codes",
      oldPath: "/admin/promo-codes",
      area: "bookings",
      flags: ["promoCodes"],
      moved: false,
    },
    {
      id: "booking-policies",
      label: "Booking Policies",
      oldPath: "/admin/booking-policies",
      area: "bookings",
      moved: false,
    },
    {
      id: "booking-policies-adult-member-hosting",
      label: "Adult Member Hosting",
      oldPath: "/admin/booking-policies/adult-member-hosting",
      area: "bookings",
      moved: false,
    },
    {
      id: "booking-policies-cancellation",
      label: "Cancellation Policy",
      oldPath: "/admin/booking-policies/cancellation",
      area: "bookings",
      moved: false,
    },
    {
      id: "booking-policies-group-discount",
      label: "Group Discount",
      oldPath: "/admin/booking-policies/group-discount",
      area: "bookings",
      moved: false,
    },
    {
      id: "booking-policies-minimum-stay",
      label: "Minimum Stay",
      oldPath: "/admin/booking-policies/minimum-stay",
      area: "bookings",
      moved: false,
    },
    {
      id: "booking-policies-periods",
      label: "Booking Periods",
      oldPath: "/admin/booking-policies/periods",
      area: "bookings",
      moved: false,
    },
    {
      id: "booking-policies-public-requests",
      label: "Public Booking Requests",
      oldPath: "/admin/booking-policies/public-requests",
      area: "bookings",
      moved: false,
    },
    {
      // S1 (#4796) merges this with setup/booking-rules.
      id: "bookings-setup",
      label: "Bookings Setup",
      oldPath: "/admin/bookings-setup",
      area: "bookings",
      moved: false,
    },
    {
      // S1 (#4796) merges this with bookings-setup.
      id: "setup-booking-rules",
      label: "Booking Rules",
      oldPath: "/admin/setup/booking-rules",
      area: "bookings",
      moved: false,
    },
  ],
});
