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
      oldPath: "/admin/book",
      area: "bookings",
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
