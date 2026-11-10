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
      // The consolidated fee console (#1933, E7): `bookings` in the route map,
      // admitted on bookings OR finance. Each section still gates its own edits
      // by its historical area (hut fees bookings, joining and annual finance).
      id: "fees",
      label: "Fees",
      oldPath: "/admin/fees",
      area: "bookings",
      admission: "fees-or",
      keywords: ["hut fees", "joining fees", "annual fees", "rates", "pricing"],
      moved: true,
    },
    {
      // Redirect stub into the fee console (#1933).
      id: "fee-configuration",
      label: "Fee Configuration",
      oldPath: "/admin/fee-configuration",
      area: "finance",
      kind: "stub",
      moved: true,
    },
    {
      id: "seasons",
      label: "Seasons",
      oldPath: "/admin/seasons",
      area: "bookings",
      moved: true,
    },
    {
      id: "age-tier-settings",
      label: "Age Groups",
      oldPath: "/admin/age-tier-settings",
      area: "bookings",
      keywords: ["age tiers", "child pricing", "youth", "senior"],
      moved: true,
    },
    {
      id: "promo-codes",
      label: "Promo Codes",
      oldPath: "/admin/promo-codes",
      area: "bookings",
      flags: ["promoCodes"],
      keywords: ["discount", "coupon", "voucher"],
      moved: true,
    },
    {
      id: "booking-policies",
      label: "Booking Policies",
      oldPath: "/admin/booking-policies",
      area: "bookings",
      moved: true,
    },
    {
      id: "booking-policies-adult-member-hosting",
      label: "Adult Member Hosting",
      oldPath: "/admin/booking-policies/adult-member-hosting",
      area: "bookings",
      moved: true,
    },
    {
      id: "booking-policies-cancellation",
      label: "Cancellation Policy",
      oldPath: "/admin/booking-policies/cancellation",
      area: "bookings",
      moved: true,
    },
    {
      id: "booking-policies-group-discount",
      label: "Group Discount",
      oldPath: "/admin/booking-policies/group-discount",
      area: "bookings",
      moved: true,
    },
    {
      id: "booking-policies-minimum-stay",
      label: "Minimum Stay",
      oldPath: "/admin/booking-policies/minimum-stay",
      area: "bookings",
      moved: true,
    },
    {
      id: "booking-policies-periods",
      label: "Booking Periods",
      oldPath: "/admin/booking-policies/periods",
      area: "bookings",
      moved: true,
    },
    {
      id: "booking-policies-public-requests",
      label: "Public Booking Requests",
      oldPath: "/admin/booking-policies/public-requests",
      area: "bookings",
      moved: true,
    },
    {
      // S1 (#4796): also holds what was `/admin/setup/booking-rules`, which
      // was `bookings` too (#4581).
      id: "bookings-setup",
      label: "Bookings Setup",
      oldPath: "/admin/bookings-setup",
      area: "bookings",
      moved: true,
    },
  ],
});
