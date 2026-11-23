/**
 * Group, school and whole-lodge booking requests in the officer queue (`/api/admin/booking-requests/**`).
 * Part of the Bookings & Beds officer actions (ALP-719): spread into `MCP_ACTIONS`.
 *
 * The fresh-proof methods in these route files (correcting, declining and
 * releasing a request's held beds) are not here: they stay website-only
 * (`STEP_UP_ROUTES`). The settings route is in `bookings-setup.ts`.
 *
 * Kinds: every change here is `destructive`: each changes a requester's
 * booking request or emails them (owner decision, #5305 item 2). Saving a
 * quote also withdraws a quote already sent to the requester and replaces the
 * request's member links, and releasing held beds is website-only. Checking member links
 * changes nothing and runs as a read (`preview`).
 */
import { adminRecordIdParamsSchema } from "@/lib/admin-bookings-schemas/record-id";
import {
  adminBookingRequestApproveBodySchema,
  adminBookingRequestContactsQuerySchema,
  adminBookingRequestHoldBodySchema,
  adminBookingRequestLinkConflictsBodySchema,
  adminBookingRequestPriceBodySchema,
  adminBookingRequestQueueQuerySchema,
  adminBookingRequestResolvePendingAdultsBodySchema,
  adminBookingRequestSchoolRecordQuerySchema,
  adminBookingRequestSendQuoteBodySchema,
  bookingRequestQuoteInputSchema,
} from "@/lib/admin-bookings-schemas/requests";
import {
  ADMIN_BOOKING_REQUEST_APPROVAL_CONNECTION_SHAPE,
  ADMIN_BOOKING_REQUEST_ATTENDEE_CONFIRMATION_CONNECTION_SHAPE,
  ADMIN_BOOKING_REQUEST_CONNECTION_SHAPE,
  ADMIN_BOOKING_REQUEST_CONTACTS_CONNECTION_SHAPE,
  ADMIN_BOOKING_REQUEST_HOLD_CONFLICTS_CONNECTION_SHAPE,
  ADMIN_BOOKING_REQUEST_HOLD_CONNECTION_SHAPE,
  ADMIN_BOOKING_REQUEST_LINK_CONFLICTS_CONNECTION_SHAPE,
  ADMIN_BOOKING_REQUEST_PENDING_ADULTS_CONNECTION_SHAPE,
  ADMIN_BOOKING_REQUEST_PENDING_COUNTS_CONNECTION_SHAPE,
  ADMIN_BOOKING_REQUEST_QUEUE_CONNECTION_SHAPE,
  ADMIN_BOOKING_REQUEST_QUOTE_SAVED_CONNECTION_SHAPE,
  ADMIN_BOOKING_REQUEST_QUOTE_SENT_CONNECTION_SHAPE,
  ADMIN_BOOKING_REQUEST_SCHOOL_RECORD_CONNECTION_SHAPE,
} from "@/lib/connection-shapes/bookings-requests";

import type { McpAction } from "../catalogue";

// ── The queue ───────────────────────────────────────────────────────────────

const QUEUE: readonly McpAction[] = [
  {
    id: "list_booking_requests",
    title: "List booking requests",
    summary:
      "Officer: group, school and member whole-lodge booking requests, by default the queue waiting for the officer, oldest first, a page at a time (`page`, `pageSize`, `total`, `totalPages`). Each request answers with its id, kind, status, `version`, lodge, contact (names, email, phone), dates (ISO timestamps; the date part is the lodge night), guests, named teachers and pending adults (school), member links, the requester's message, the indicative, officer and accepted prices and the flat whole-lodge total in integer cents, the latest quote with its options, the held booking and its status, who priced or reviewed it, the suggested nightly rates per age group in integer cents, and a flag where a stored part of the request cannot be read. The id is what every other booking-request action takes.",
    method: "GET",
    path: "/api/admin/booking-requests",
    query: adminBookingRequestQueueQuerySchema,
    kind: "read",
    returns: ADMIN_BOOKING_REQUEST_QUEUE_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "get_booking_request_counts",
    title: "Count the booking request queues",
    summary:
      "Officer: how many items wait in each Booking Requests queue: bookings held for review, locked-period change requests, policy exception requests and public booking requests.",
    method: "GET",
    path: "/api/admin/booking-requests/pending-counts",
    kind: "read",
    returns: ADMIN_BOOKING_REQUEST_PENDING_COUNTS_CONNECTION_SHAPE,
    core: false,
  },
];

// ── Reads on one request ────────────────────────────────────────────────────

const ONE_REQUEST_READS: readonly McpAction[] = [
  {
    id: "list_booking_request_contacts",
    title: "Find existing contacts for a booking request",
    summary:
      "Officer: existing non-member and school contacts (people who cannot sign in) that a request (`id` from `list_booking_requests`) could be booked under instead of creating a new contact: each one's id, names, email, phone, role and number of bookings, at most 8. Without `q`, contacts matching the request's own email, names and school name are suggested. The id is what `ownerContactMemberId` takes on hold, send quote and approve.",
    method: "GET",
    path: "/api/admin/booking-requests/[id]/contacts",
    params: adminRecordIdParamsSchema,
    query: adminBookingRequestContactsQuerySchema,
    kind: "read",
    returns: ADMIN_BOOKING_REQUEST_CONTACTS_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "get_booking_request_hold_conflicts",
    title: "Check a whole-lodge request's nights",
    summary:
      "Officer: for a request's nights (`id` from `list_booking_requests`), the lodge and its beds, each night's free and occupied beds and whether it is already held as a whole lodge (`date` as `YYYY-MM-DD`), and the overlapping bookings (id, booker name, dates `YYYY-MM-DD`, guest count, status, and `overridden` for a booking over capacity that will take its beds when it settles). Advice only: approving a whole-lodge request is never refused for these.",
    method: "GET",
    path: "/api/admin/booking-requests/[id]/hold-conflicts",
    params: adminRecordIdParamsSchema,
    kind: "read",
    returns: ADMIN_BOOKING_REQUEST_HOLD_CONFLICTS_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "check_booking_request_member_links",
    title: "Check member links on a booking request for clashes",
    summary:
      "Officer: for guest-to-member links on a request (`id` from `list_booking_requests`), the members who already stay at the lodge on any of its nights: member id and name, the clashing nights (`YYYY-MM-DD`) and the other booking (id, status, owner name, dates `YYYY-MM-DD`). Changes nothing; holding beds and approving refuse a real clash.",
    method: "POST",
    path: "/api/admin/booking-requests/[id]/link-conflicts",
    params: adminRecordIdParamsSchema,
    body: adminBookingRequestLinkConflictsBodySchema,
    kind: "read",
    preview: true,
    returns: ADMIN_BOOKING_REQUEST_LINK_CONFLICTS_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "preview_booking_request_school_record",
    title: "Check which school record a name matches",
    summary:
      "Officer: for a school request (`id` from `list_booking_requests`), which of the club's school records a school name (`name`, or the request's own) would join on approval: the name as stored, whether a record is known, its own spelling, whether it is archived or already has a Xero customer, and the contact names approval would replace. Changes nothing; refused for a request that is not a school's.",
    method: "GET",
    path: "/api/admin/booking-requests/[id]/school-record",
    params: adminRecordIdParamsSchema,
    query: adminBookingRequestSchoolRecordQuerySchema,
    kind: "read",
    returns: ADMIN_BOOKING_REQUEST_SCHOOL_RECORD_CONNECTION_SHAPE,
    core: false,
  },
];

// ── Pricing, quoting and approving ──────────────────────────────────────────

const OFFICER_STEPS: readonly McpAction[] = [
  {
    id: "price_booking_request",
    title: "Price a booking request",
    summary:
      "Officer: set or change the price, in integer cents, on a verified or priced request (`id` from `list_booking_requests`); the request moves to priced. Refused for a member's whole-lodge request (priced at approval) and where the stored guests cannot be read. Answers with the request, as `list_booking_requests` shows it without the queue's extra fields. Needs Bookings & Beds edit access.",
    method: "POST",
    path: "/api/admin/booking-requests/[id]/price",
    params: adminRecordIdParamsSchema,
    body: adminBookingRequestPriceBodySchema,
    // Owner decision #5305 item 2: changes a requester's booking request.
    kind: "destructive",
    returns: ADMIN_BOOKING_REQUEST_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "save_booking_request_quote",
    title: "Save a quote for a booking request",
    summary:
      "Officer: save one or two priced options as the request's quote (`id` from `list_booking_requests`), as an overall total or per guest-night rates in integer cents. Nothing is emailed or held. For a school, `childCounts` changes the group's numbers on the request; refused while its beds are held. Send the request's current `linkedGuestMembers` or its member links are removed. Answers with the quote's version, status, pricing mode and options with each guest's breakdown in cents. Refused for a member's whole-lodge request. Needs Bookings & Beds edit access. Cannot be undone from the app: a quote already sent to the requester stops working.",
    method: "POST",
    path: "/api/admin/booking-requests/[id]/quote",
    params: adminRecordIdParamsSchema,
    body: bookingRequestQuoteInputSchema,
    kind: "destructive",
    returns: ADMIN_BOOKING_REQUEST_QUOTE_SAVED_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "send_booking_request_quote",
    title: "Send a booking request's quote",
    summary:
      "Officer: hold the request's beds (`id` from `list_booking_requests`) and email the requester its latest saved quote with a link to accept it. Refused when the lodge is full, a linked member already stays those nights, or a school's `childCounts` differ from the saved numbers. Answers with the quote's version, status, when the link expires, whether the email was delivered, and the options in integer cents. Needs Bookings & Beds edit access. Cannot be undone: the email is sent, and releasing the beds is done on the website.",
    method: "POST",
    path: "/api/admin/booking-requests/[id]/send-quote",
    params: adminRecordIdParamsSchema,
    body: adminBookingRequestSendQuoteBodySchema,
    kind: "destructive",
    returns: ADMIN_BOOKING_REQUEST_QUOTE_SENT_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "hold_booking_request_beds",
    title: "Hold a booking request's beds",
    summary:
      "Officer: reserve the lodge beds for a request (`id` from `list_booking_requests`) as a booking awaiting review, mainly for school groups; approving a school request uses the held booking. Refused when the lodge is full or a linked member already stays those nights. Answers with the held booking's id and whether an existing hold was reused. Needs Bookings & Beds edit access. Cannot be undone from the app: releasing the beds is done on the website.",
    method: "POST",
    path: "/api/admin/booking-requests/[id]/hold",
    params: adminRecordIdParamsSchema,
    body: adminBookingRequestHoldBodySchema,
    kind: "destructive",
    returns: ADMIN_BOOKING_REQUEST_HOLD_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "approve_booking_request",
    title: "Approve a booking request",
    summary:
      "Officer: turn a request (`id` from `list_booking_requests`) into a booking. A public request becomes a booking with a payment link emailed to the requester; a school request is confirmed and invoiced; a member's whole-lodge request is booked for the member, priced from `pricedHeadcount`, `priceAsWholeLodge` or `priceOverrideCents` (integer cents). Refused when the lodge is full, a linked member already stays those nights, or the lodge's adult-member hosting rule is not met. Answers with the kind, the booking id, the owner's member id, the price in integer cents and, by kind, the payment link's expiry, how it was invoiced, the guest or teacher count and the overlapping bookings a whole-lodge hold leaves for the officer to resolve. Needs Bookings & Beds edit access. Cannot be undone.",
    method: "POST",
    path: "/api/admin/booking-requests/[id]/approve",
    params: adminRecordIdParamsSchema,
    body: adminBookingRequestApproveBodySchema,
    kind: "destructive",
    returns: ADMIN_BOOKING_REQUEST_APPROVAL_CONNECTION_SHAPE,
    core: false,
  },
];

// ── After a school accepts ──────────────────────────────────────────────────

const SCHOOL_FOLLOW_UP: readonly McpAction[] = [
  {
    id: "name_school_pending_adults",
    title: "Name a school request's pending adults",
    summary:
      "Officer: on an accepted school request with beds held (`id` from `list_booking_requests`), replace pending adults with real names on the held booking without changing the accepted price. Send the request's `version` as `expectedVersion`. Refused when a name matches a club member (that needs new terms) or the request changed. Answers with the request, its remaining pending adult count and new version. Needs Bookings & Beds edit access. Cannot be undone from the app.",
    method: "POST",
    path: "/api/admin/booking-requests/[id]/resolve-pending-adults",
    params: adminRecordIdParamsSchema,
    body: adminBookingRequestResolvePendingAdultsBodySchema,
    kind: "destructive",
    returns: ADMIN_BOOKING_REQUEST_PENDING_ADULTS_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "resend_school_attendee_confirmation",
    title: "Resend a school's attendee confirmation email",
    summary:
      "Officer: email the school contact on an approved school request (`id` from `list_booking_requests`) a new link to confirm who is attending, now rather than on the usual schedule. Refused once the attendees are confirmed or the booking is cancelled. The previous link stops working. Answers `success`. Needs Bookings & Beds edit access. Cannot be undone.",
    method: "POST",
    path: "/api/admin/booking-requests/[id]/resend-attendee-confirmation",
    params: adminRecordIdParamsSchema,
    kind: "destructive",
    returns: ADMIN_BOOKING_REQUEST_ATTENDEE_CONFIRMATION_CONNECTION_SHAPE,
    core: false,
  },
];

export const BOOKINGS_REQUEST_MCP_ACTIONS: readonly McpAction[] = [
  ...QUEUE,
  ...ONE_REQUEST_READS,
  ...OFFICER_STEPS,
  ...SCHOOL_FOLLOW_UP,
];
