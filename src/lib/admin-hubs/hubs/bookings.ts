import { defineHub } from "../define";

/**
 * Bookings. The prefix is not `bookings`: `/admin/bookings` is already the
 * Bookings page and a `bookings`-area route prefix, so every hub path under it
 * would inherit that area by first match (see the prefix census).
 */
export const BOOKINGS_HUB = defineHub({
  key: "bookings",
  label: "Bookings",
  prefix: "booking-desk",
  pages: [
    {
      id: "bookings",
      label: "Bookings",
      keywords: ["all bookings"],
      oldPath: "/admin/bookings",
      area: "bookings",
      moved: true,
    },
    {
      id: "booking-requests",
      label: "Booking Requests",
      oldPath: "/admin/booking-requests",
      area: "bookings",
      moved: true,
    },
    {
      // Redirect stub into Booking Requests' approvals tab.
      id: "booking-approvals",
      label: "Booking Approvals",
      oldPath: "/admin/booking-approvals",
      area: "bookings",
      kind: "stub",
      moved: true,
    },
    {
      // Redirect stub into Booking Requests' changes tab.
      id: "booking-change-requests",
      label: "Booking Change Requests",
      oldPath: "/admin/booking-change-requests",
      area: "bookings",
      kind: "stub",
      moved: true,
    },
    {
      id: "book",
      label: "Book on Behalf",
      keywords: ["book on behalf of member"],
      oldPath: "/admin/book",
      area: "bookings",
      moved: true,
    },
    {
      // #5005: a moving-in club's paid future bookings, carried over at what
      // was paid. Opening it is a bookings read; its API also needs finance,
      // and importing or reversing needs edit on both (O4).
      id: "booking-import",
      label: "Import Paid Bookings",
      keywords: ["moving in", "carry over", "previous system", "csv"],
      oldPath: "/admin/booking-import",
      area: "bookings",
      moved: true,
    },
    {
      id: "booking-import-batch",
      label: "Import Batch",
      oldPath: "/admin/booking-import/[id]",
      area: "bookings",
      kind: "detail",
      moved: true,
    },
    {
      id: "bed-allocation",
      label: "Bed Allocation",
      oldPath: "/admin/bed-allocation",
      area: "bookings",
      flags: ["bedAllocation"],
      keywords: ["rooms", "beds", "assign", "bunks"],
      moved: true,
    },
    {
      id: "waitlist",
      label: "Waitlist",
      oldPath: "/admin/waitlist",
      area: "bookings",
      flags: ["waitlist"],
      moved: true,
    },
  ],
});
