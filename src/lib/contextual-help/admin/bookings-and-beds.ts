/**
 * Help for the "Bookings & Beds" admin section.
 *
 * The section IS the sidebar's (`buildAdminNavSections` in `admin-sidebar.tsx`): this
 * split groups help by the areas the product already shows operators, so the
 * module a page's help lives in is the menu heading they found it under.
 */
import { entry, help, type HelpEntry } from "../types";
import { BOOKING_STATUS_GLOSSARY } from "../booking-status-glossary";

export const adminBookingsAndBedsHelpEntries: HelpEntry[] = [
  entry(
    "/admin/booking-requests",
    help(
      "Booking Requests",
      "This page manages public or internal booking requests before they become normal bookings.",
      [
        "Open each request, check the requested dates and guest counts, then price, quote, approve, decline, or ask for changes. Sending a quote auto-holds the beds, so a manual Hold slots step only shows for school requests.",
        "Use status tabs to separate new requests from quoted, queried, and completed requests.",
        "Check capacity and payment expectations before sending a quote or approval.",
      ],
      [
        {
          name: "Status",
          description:
            "Shows where the request sits: submitted, verified, priced, quoted, waiting on the requester, approved, declined, or cancelled.",
        },
        {
          name: "Price or quote",
          description:
            "Controls the offer sent to the requester and should reflect the latest dates, guest mix, and policy rules.",
        },
        {
          name: "Hold",
          description:
            "Manually reserves capacity for a school request before it is approved or quoted. Sending a quote auto-holds the beds on other requests, so the manual Hold slots button only appears for school requests.",
        },
      ],
      [
        "Approving or quoting can affect lodge capacity and customer expectations. Recheck date-only lodge nights before sending.",
      ],
    ),
  ),
  entry(
    "/admin/bookings",
    help(
      "Bookings",
      "This page searches and manages normal booking records after they have been created.",
      [
        "Use member, date, status, and payment filters to find the target booking.",
        "Use Reset to restore search, filters, sort, and page without changing the selected lodge.",
        "Open a booking to inspect guests, payments, capacity status, notes, and available actions.",
        "Use cancel, copy, force-confirm, or review actions only when the booking state allows it.",
      ],
      [
        {
          name: "Booking status",
          description:
            "Shows whether the booking is draft, pending, confirmed, paid, waitlisted, cancelled, or completed.",
        },
        {
          name: "Check-in / check-out",
          description:
            "Date-only lodge nights used for pricing, capacity, and guest stay ranges.",
        },
        {
          name: "Payment status",
          description:
            "The associated payment lifecycle, separate from the booking lifecycle.",
        },
      ],
      [
        "Booking actions can affect capacity and money. Confirm the date range and payment source before changing state.",
      ],
      [
        {
          title: "Booking status glossary",
          details: BOOKING_STATUS_GLOSSARY,
        },
      ],
    ),
  ),
  entry(
    "/admin/book",
    help(
      "Book on Behalf",
      "This page lets an admin create a booking for a member or approved requester.",
      [
        "Choose the member or requester first, then set lodge nights and guests.",
        "Review the calculated quote, policies, capacity warnings, and payment options before confirming.",
        "Use this flow for assisted booking only; members should self-serve when possible.",
      ],
      [
        {
          name: "Member",
          description:
            "The account that owns the booking and receives booking communications. Selecting the member loads their family group (from your bookings:edit permission) so you can add family guests at the correct member price.",
        },
        {
          name: "Guests",
          description:
            "The staying people who consume beds and may have individual stay ranges.",
        },
        {
          name: "Quote",
          description:
            "The calculated price in integer cents after rates, policies, and discounts.",
        },
      ],
    ),
  ),
  entry(
    "/admin/bed-allocation",
    help(
      "Bed Allocation",
      "Bed allocation assigns paid or confirmed guests to rooms and beds for specific lodge nights.",
      [
        "Select the date or booking window, then review unallocated guests and room availability.",
        "Use auto-allocation for ordinary cases and manual moves for operational exceptions.",
        "When a booking is paid or confirmed, automatic allocation gives Held bookings first claim: it may move a blocking Provisional allocation to a free bed, or return it to the awaiting queue, so a Held booking gets a bed. The manual 'Run auto-allocation' button does not displace; a Held or admin-approved allocation is never displaced.",
        "Approve allocations only after checking room rules, capacity, and any hut-leader notes.",
      ],
      [
        {
          name: "Room and bed",
          description:
            "The physical sleeping place assigned to a guest for a lodge night.",
        },
        {
          name: "Allocation source",
          description:
            "Shows whether the placement came from auto-allocation or a manual operator change.",
        },
        {
          name: "Approval",
          description:
            "Locks or confirms allocation output for lodge operations.",
        },
      ],
      [
        "Bed allocation must not create more occupants than available beds for a lodge night.",
      ],
    ),
  ),
  entry(
    "/admin/waitlist",
    help(
      "Waitlist",
      "The waitlist page manages members waiting for capacity and offers places when beds become available.",
      [
        "Review requested nights, capacity changes, and active offers.",
        "Send an offer only when the booking can be fulfilled and the expiry window is appropriate.",
        "Force-confirm only when you understand any overbooked nights shown in the confirmation prompt.",
      ],
      [
        {
          name: "Offer expiry",
          description:
            "The deadline for the member to accept a waitlist offer before it lapses.",
        },
        {
          name: "Requested nights",
          description:
            "The date-only lodge nights the member wants to book.",
        },
        {
          name: "Capacity",
          description:
            "The available bed count after existing capacity-holding bookings are considered.",
        },
      ],
    ),
  ),
];
