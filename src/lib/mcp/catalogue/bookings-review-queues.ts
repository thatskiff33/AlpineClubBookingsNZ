/**
 * Review queues and booking reads: change and exception requests, booking
 * reviews, the waitlist, occupancy and promo codes. Part of the Bookings &
 * Beds officer actions (ALP-719), spread into `MCP_ACTIONS`.
 *
 * Deciding a change or exception request, or a booking review, needs a fresh
 * sign-in proof, so it stays website-only (`STEP_UP_ROUTES`); the queues here
 * are read so an officer can see what waits. A waitlisted booking's own steps
 * are booking actions (`bookings-bookings.ts`).
 *
 * Kinds: every promo code change is `destructive`: a code can be assigned to
 * members, so a change can overwrite what a member was given (owner decision,
 * #5305 item 2). Deleting also cannot be taken back: a code never applied is
 * deleted outright, and one that was is archived.
 */
import { adminOccupancyQuerySchema } from "@/lib/admin-bookings-schemas/occupancy";
import {
  adminPromoCodeListQuerySchema,
  adminPromoRedemptionsQuerySchema,
  promoCodeCreateBodySchema,
  promoCodeUpdateBodySchema,
} from "@/lib/admin-bookings-schemas/promo-codes";
import { adminRecordIdParamsSchema } from "@/lib/admin-bookings-schemas/record-id";
import {
  adminBookingChangeRequestQueueQuerySchema,
  adminBookingExceptionRequestQueueQuerySchema,
  adminBookingReviewQueueQuerySchema,
  adminWaitlistQuerySchema,
} from "@/lib/admin-bookings-schemas/review-queues";
import {
  ADMIN_BOOKING_REVIEW_QUEUE_CONNECTION_SHAPE,
  ADMIN_CHANGE_REQUEST_CONNECTION_SHAPE,
  ADMIN_CHANGE_REQUEST_QUEUE_CONNECTION_SHAPE,
  ADMIN_EXCEPTION_REQUEST_DETAIL_CONNECTION_SHAPE,
  ADMIN_EXCEPTION_REQUEST_QUEUE_CONNECTION_SHAPE,
  ADMIN_OCCUPANCY_CONNECTION_SHAPE,
  ADMIN_PROMO_CODE_CONNECTION_SHAPE,
  ADMIN_PROMO_CODE_DELETED_CONNECTION_SHAPE,
  ADMIN_PROMO_CODE_LIST_CONNECTION_SHAPE,
  ADMIN_PROMO_CODE_RESTORED_CONNECTION_SHAPE,
  ADMIN_PROMO_REDEMPTIONS_CONNECTION_SHAPE,
  ADMIN_WAITLIST_CONNECTION_SHAPE,
} from "@/lib/connection-shapes/bookings-review-queues";

import type { McpAction } from "../catalogue";

export const BOOKINGS_REVIEW_QUEUE_MCP_ACTIONS: readonly McpAction[] = [
  {
    id: "get_lodge_occupancy",
    title: "Read a lodge's occupancy for a month",
    summary:
      "Officer: how many guests stay at one lodge on each night of one calendar month, and the bookings behind them (reference, owner, dates, guest count, status).",
    method: "GET",
    path: "/api/admin/occupancy",
    query: adminOccupancyQuerySchema,
    kind: "read",
    returns: ADMIN_OCCUPANCY_CONNECTION_SHAPE,
    core: false,
  },

  // --- Locked-period change requests -----------------------------------------
  {
    id: "list_booking_change_request_queue",
    title: "List booking change requests",
    summary:
      "Officer: members' requests to change a booking inside its locked period (today or past nights), by default those waiting for a decision, oldest first, a page at a time (`page`, `pageSize`, `total`, `totalPages`). Each answers with its id, status, what was asked (summary, dates, guests to add, and each guest's requested nights as runs of `YYYY-MM-DD` nights), the member's reason, the member-visible and private officer notes, who asked and who decided (names), the booking (dates as ISO timestamps whose date part is the lodge night, status, total and payment in integer cents, owner), whether approving would apply the change (a finished stay) and any promo correction it carries. Deciding a request is website-only.",
    method: "GET",
    path: "/api/admin/booking-change-requests",
    query: adminBookingChangeRequestQueueQuerySchema,
    kind: "read",
    returns: ADMIN_CHANGE_REQUEST_QUEUE_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "get_booking_change_request",
    title: "Read a booking change request",
    summary:
      "Officer: one booking change request by `id` (from `list_booking_change_request_queue`): its kind, status, what was asked, the member's reason, the member-visible and private officer notes, who asked and who decided (names), any linked booking modification (price difference and change fee in integer cents) and the booking (dates as ISO timestamps, status, total and payment in integer cents, owner). Deciding it is website-only.",
    method: "GET",
    path: "/api/admin/booking-change-requests/[id]",
    params: adminRecordIdParamsSchema,
    kind: "read",
    returns: ADMIN_CHANGE_REQUEST_CONNECTION_SHAPE,
    core: false,
  },

  // --- Booking-policy exception requests -------------------------------------
  {
    id: "list_booking_exception_requests",
    title: "List booking-policy exception requests",
    summary:
      "Officer: members' requests to be let past a booking rule (minimum stay, adult-member hosting, a paid-up adult member), new bookings and changes together, by default those waiting for a decision, oldest first, a page at a time (`page`, `pageSize`, `total`, `totalPages`). Each answers with its id, `source` (`NEW_BOOKING` or `MODIFICATION`), status, the rules broken and the nights affected (`YYYY-MM-DD`), the proposed dates and party size, whether it holds beds, the member's message, who asked and who decided (names), the member-visible and private officer notes, capacity-conflict history and the booking it is about or created. Deciding a request is website-only.",
    method: "GET",
    path: "/api/admin/booking-exception-requests",
    query: adminBookingExceptionRequestQueueQuerySchema,
    kind: "read",
    returns: ADMIN_EXCEPTION_REQUEST_QUEUE_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "get_booking_exception_request",
    title: "Read a booking-policy exception request",
    summary:
      "Officer: one booking-policy exception request by `id` (from `list_booking_exception_requests`), either kind: status, the member's message, who asked and who decided (names), the member-visible and private officer notes, the proposed dates (`YYYY-MM-DD`) and the exact party an approval would book (each guest's age group, member or not, nights, and whether a member guest is outside the requester's family), each rule broken with its plain-language message, and the booking it changes (`booking`, for a change) or the lodge (`lodge`, for a new booking). Deciding it is website-only.",
    method: "GET",
    path: "/api/admin/booking-exception-requests/[id]",
    params: adminRecordIdParamsSchema,
    kind: "read",
    returns: ADMIN_EXCEPTION_REQUEST_DETAIL_CONNECTION_SHAPE,
    core: false,
  },

  // --- Booking reviews and the waitlist --------------------------------------
  {
    id: "list_booking_reviews",
    title: "List bookings awaiting review",
    summary:
      "Officer: bookings held for an officer's review (a party needing adult supervision, or adult-member hosting), by default those pending, oldest first, a page at a time (`page`, `pageSize`, `total`, `totalPages`). Each booking answers with its id, lodge, dates (ISO timestamps whose date part is the lodge night), status, total in integer cents, the review status, reason codes and sentences, notes and decision time, who decided (name), the owner's name and member id, and the guests (names, age group, member or not). Deciding a review is website-only.",
    method: "GET",
    path: "/api/admin/booking-reviews",
    query: adminBookingReviewQueueQuerySchema,
    kind: "read",
    returns: ADMIN_BOOKING_REVIEW_QUEUE_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "list_waitlist",
    title: "List the waitlist",
    summary:
      "Officer: waitlisted and offered bookings in queue order, a page at a time (`page`, `pageSize`, `total`), optionally within `from`/`to` (`YYYY-MM-DD`; too long a window is refused with its limit). Each entry answers with its booking id, the owner's name and member id (null for an organisation), dates (`YYYY-MM-DD`), guests, status, its place in its lodge's queue (null once offered), the offer and its expiry (ISO timestamps), review flags, whether emails are switched off, the price in integer cents and whether the offer email was delivered.",
    method: "GET",
    path: "/api/admin/waitlist",
    // The route also limits the window and refuses a day that does not
    // exist; it remains the authority for those.
    query: adminWaitlistQuerySchema,
    kind: "read",
    returns: ADMIN_WAITLIST_CONNECTION_SHAPE,
    core: false,
  },

  // --- Promo codes -----------------------------------------------------------
  {
    id: "list_promo_codes",
    title: "List promo codes",
    summary:
      "Officer: the club's promo codes, newest first, under `promoCodes` (`archived: \"true\"` for archived ones; work-party codes are not listed). Each answers with its id, code, type and value (amounts in integer cents, `percentOff` a whole percentage), caps, validity and check-in windows (ISO timestamps whose date part is the day), who it is limited to, assigned members (member id and name), lodge restriction, Xero codes, whether active, when archived, and its use counts.",
    method: "GET",
    path: "/api/admin/promo-codes",
    query: adminPromoCodeListQuerySchema,
    kind: "read",
    returns: ADMIN_PROMO_CODE_LIST_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "get_promo_code",
    title: "Read a promo code",
    summary:
      "Officer: one promo code by `id` (from `list_promo_codes`): code, type and value (amounts in integer cents), caps, validity and check-in windows (ISO timestamps), limits, assigned members (member id and name), lodge restriction, Xero codes, whether active and when archived. Its uses are `get_promo_code_redemptions`.",
    method: "GET",
    path: "/api/admin/promo-codes/[id]",
    params: adminRecordIdParamsSchema,
    kind: "read",
    returns: ADMIN_PROMO_CODE_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "create_promo_code",
    title: "Create a promo code",
    summary:
      "Officer: adds a promo code. `type` decides which value it needs: `percentOff` (whole percentage), `valueCents` or `fixedNightlyPriceCents` (integer cents) or `freeNightsPerIndividual`; values for other types are cleared. Dates are `YYYY-MM-DD`; the code must be unique and lodges real. Answers the saved code.",
    method: "POST",
    path: "/api/admin/promo-codes",
    body: promoCodeCreateBodySchema,
    // Owner decision #5305 item 2: a promo code can be assigned to members.
    kind: "destructive",
    returns: ADMIN_PROMO_CODE_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "update_promo_code",
    title: "Change a promo code",
    summary:
      "Officer: changes a promo code (`id` from `list_promo_codes`); a field left out keeps its value, and `assignedMemberIds` or `lodgeIds`, when given, replace the list. Amounts are integer cents, dates `YYYY-MM-DD`; the type's value must stay above 0. Changes apply to future uses only. Answers the saved code.",
    method: "PUT",
    path: "/api/admin/promo-codes/[id]",
    params: adminRecordIdParamsSchema,
    body: promoCodeUpdateBodySchema,
    // Owner decision #5305 item 2: a promo code can be assigned to members.
    kind: "destructive",
    returns: ADMIN_PROMO_CODE_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "restore_promo_code",
    title: "Restore an archived promo code",
    summary:
      "Officer: brings an archived promo code (`id` from `list_promo_codes` with `archived`) back to the list. It stays inactive until `update_promo_code` sets `active`. Refused if the code is not archived. Answers `success`.",
    method: "PATCH",
    path: "/api/admin/promo-codes/[id]",
    params: adminRecordIdParamsSchema,
    // Owner decision #5305 item 2: a promo code can be assigned to members.
    kind: "destructive",
    returns: ADMIN_PROMO_CODE_RESTORED_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "delete_promo_code",
    title: "Delete a promo code",
    summary:
      "Officer: removes a promo code (`id` from `list_promo_codes`). A code that was ever applied to a booking is archived and deactivated instead (`archived: true`; `restore_promo_code` brings it back); one never applied is deleted. A deletion cannot be undone.",
    method: "DELETE",
    path: "/api/admin/promo-codes/[id]",
    params: adminRecordIdParamsSchema,
    kind: "destructive",
    returns: ADMIN_PROMO_CODE_DELETED_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "get_promo_code_redemptions",
    title: "Read a promo code's uses",
    summary:
      "Officer: one promo code's uses (`id` from `list_promo_codes`; archived and work-party codes included), newest first, a page at a time, optionally redeemed between `from` and `to` (`YYYY-MM-DD`, club days) or at one lodge. Answers the code with its caps and how much of them is used, all-time and filtered totals (uses, distinct members, discount in integer cents, free nights), and each use: when, the booking owner (name and member id), the booking (reference, lodge, `YYYY-MM-DD` dates, nights), discount and price adjustment in integer cents, whether it gave a benefit, which use it was for that member, and the per-member split when shared.",
    method: "GET",
    path: "/api/admin/promo-codes/[id]/redemptions",
    params: adminRecordIdParamsSchema,
    query: adminPromoRedemptionsQuerySchema,
    kind: "read",
    returns: ADMIN_PROMO_REDEMPTIONS_CONNECTION_SHAPE,
    core: false,
  },
];
