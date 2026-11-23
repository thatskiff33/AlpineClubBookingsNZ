/**
 * Bookings: the booking list and search, and the officer tools on one booking (`/api/admin/bookings/**`).
 * Part of the Bookings & Beds officer actions (ALP-719): spread into `MCP_ACTIONS`.
 *
 * The fresh-proof methods in these route files (marking a booking reviewed,
 * confirming pending guests, the work-party correction) are not here: they
 * stay website-only (`STEP_UP_ROUTES`).
 */
import {
  adminBookingCopyBodySchema,
  adminBookingSearchQuerySchema,
  adminBookingsCalendarQuerySchema,
  adminCapacityHoldBodySchema,
  adminEligibleFamilyQuerySchema,
  adminExclusiveHoldBodySchema,
  adminForceConfirmBodySchema,
  adminFreshEmailCopyBodySchema,
  adminMemberGuestEmailBodySchema,
  adminMemberGuestNameQuerySchema,
  adminNoEmailsBodySchema,
  adminNonMemberContactQuerySchema,
  adminRequestedRoomBodySchema,
  nonMemberContactCreateSchema,
} from "@/lib/admin-bookings-schemas/bookings";
import { bookingIdParamsSchema } from "@/lib/booking-cancel-schema";
import {
  ADMIN_ADDITIONAL_PAYMENT_REMINDER_CONNECTION_SHAPE,
  ADMIN_BOOKING_COPY_CONNECTION_SHAPE,
  ADMIN_BOOKING_ELIGIBLE_FAMILY_CONNECTION_SHAPE,
  ADMIN_BOOKING_SEARCH_CONNECTION_SHAPE,
  ADMIN_BOOKING_WORK_PARTY_OPTIONS_CONNECTION_SHAPE,
  ADMIN_BOOKINGS_CALENDAR_CONNECTION_SHAPE,
  ADMIN_CAPACITY_HOLD_CONNECTION_SHAPE,
  ADMIN_CAPACITY_HOLD_RELEASE_CONNECTION_SHAPE,
  ADMIN_EXCLUSIVE_HOLD_CONNECTION_SHAPE,
  ADMIN_FORCE_CONFIRM_CONNECTION_SHAPE,
  ADMIN_FRESH_EMAIL_COPY_CONNECTION_SHAPE,
  ADMIN_MEMBER_FAMILY_CONNECTION_SHAPE,
  ADMIN_MEMBER_GUEST_EMAIL_CANDIDATES_CONNECTION_SHAPE,
  ADMIN_MEMBER_GUEST_NAME_CANDIDATES_CONNECTION_SHAPE,
  ADMIN_NO_EMAILS_CONNECTION_SHAPE,
  ADMIN_NON_MEMBER_CONTACT_CONNECTION_SHAPE,
  ADMIN_NON_MEMBER_CONTACT_SUGGESTIONS_CONNECTION_SHAPE,
  ADMIN_REQUESTED_ROOM_CLEARED_CONNECTION_SHAPE,
  ADMIN_REQUESTED_ROOM_CONNECTION_SHAPE,
  ADMIN_RETURN_TO_WAITLIST_CONNECTION_SHAPE,
} from "@/lib/connection-shapes/bookings-bookings";

import { ADDITIONAL_PAYMENT_RESEND_COOLDOWN_MINUTES } from "@/lib/additional-payment-chase";
import { MEMBER_GUEST_SEARCH_MIN_CHARS, MEMBER_GUEST_SEARCH_RESULT_CAP } from "@/lib/member-guest-find";
import type { McpAction } from "../catalogue";

// The routes below that name their own `requireAdmin` permission, stricter
// than (or other than) their path's rule; the census pins each to its handler.
const BOOKINGS_EDIT = { area: "bookings", level: "edit" } as const;

// ── The booking list and search ─────────────────────────────────────────────

const LIST_AND_SEARCH: readonly McpAction[] = [
  {
    id: "search_bookings",
    title: "Search bookings",
    summary:
      "Officer: find bookings by the start of their id, or by the booker's name or email, or a school's name, most recently changed first; drafts are not searched. Answers with each booking's id, booker name, dates (`YYYY-MM-DD`), status, deleted time and guest count. The id is what every other booking action takes.",
    method: "GET",
    path: "/api/admin/bookings/search",
    query: adminBookingSearchQuerySchema,
    kind: "read",
    returns: ADMIN_BOOKING_SEARCH_CONNECTION_SHAPE,
    core: true,
  },
  {
    id: "list_bookings_for_month",
    title: "List bookings in a month",
    summary:
      "Officer: the bookings whose stay overlaps one calendar month (id, booker name, dates `YYYY-MM-DD`, status, deleted time, most guests on a night), and, for one lodge or a club's only lodge, the free beds on each night. Drafts are left out unless `status` names `DRAFT`.",
    method: "GET",
    path: "/api/admin/bookings",
    query: adminBookingsCalendarQuerySchema,
    kind: "read",
    returns: ADMIN_BOOKINGS_CALENDAR_CONNECTION_SHAPE,
    core: false,
  },
];

// ── On-behalf pickers ───────────────────────────────────────────────────────

const ON_BEHALF_PICKERS: readonly McpAction[] = [
  {
    id: "get_member_family_for_booking",
    title: "Read a member's family for a new booking",
    summary:
      "Officer: one member's family group, for booking on their behalf: the member and the active members of their family groups (id, names, age tier, relationship) and their own recorded dependants. The member ids are what a booking's guest list takes.",
    method: "GET",
    path: "/api/admin/bookings/eligible-family",
    query: adminEligibleFamilyQuerySchema,
    requires: BOOKINGS_EDIT,
    kind: "read",
    returns: ADMIN_MEMBER_FAMILY_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "get_booking_owner_family",
    title: "Read a booking owner's family",
    summary:
      "Officer: the family group of the member who owns a booking (`id` from `search_bookings`), for adding guests to it: the same fields as `get_member_family_for_booking`, plus the confirmed partners of the booking's member guests who could share a double bed.",
    method: "GET",
    path: "/api/admin/bookings/[id]/eligible-family",
    params: bookingIdParamsSchema,
    requires: BOOKINGS_EDIT,
    kind: "read",
    returns: ADMIN_BOOKING_ELIGIBLE_FAMILY_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "search_non_member_contacts",
    title: "Find existing non-member contacts",
    summary:
      "Officer: existing non-member booking contacts (people and schools who cannot sign in) whose email or name matches, so one can be reused instead of creating a duplicate. Answers with each contact's id, names, email, phone, role and number of bookings.",
    method: "GET",
    path: "/api/admin/bookings/non-member-contact",
    query: adminNonMemberContactQuerySchema,
    requires: BOOKINGS_EDIT,
    kind: "read",
    returns: ADMIN_NON_MEMBER_CONTACT_SUGGESTIONS_CONNECTION_SHAPE,
    core: false,
  },
  {
    // The route also takes `{ useExistingContactId }`, which only re-checks a
    // contact `search_non_member_contacts` already returned: the website's
    // picker step, not offered here. The route's full body schema is the
    // union; this is its create half.
    id: "create_non_member_contact",
    title: "Create a non-member booking contact",
    summary:
      "Officer: create a booking contact for someone who is not a member and cannot sign in, so a booking can be made in their name. Check `search_non_member_contacts` first: several contacts may share an email. Refused when a member who can sign in has that email. Answers with the new contact's id, names and email. Cannot be undone from the app.",
    method: "POST",
    path: "/api/admin/bookings/non-member-contact",
    body: nonMemberContactCreateSchema,
    kind: "destructive",
    returns: ADMIN_NON_MEMBER_CONTACT_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "search_member_guest_candidates",
    title: "Find members to add as guests by name",
    summary:
      `Officer: members whose first or last name starts with \`q\` (${MEMBER_GUEST_SEARCH_MIN_CHARS} characters or more, at most ${MEMBER_GUEST_SEARCH_RESULT_CAP} answered), to add to a booking (\`id\` from \`search_bookings\`) as member guests: each one's member id, names and age tier. \`truncated\` is true when more matched. Needs Membership view access as well; the search is recorded in the audit log.`,
    method: "GET",
    path: "/api/admin/bookings/[id]/member-guest-candidates",
    params: bookingIdParamsSchema,
    query: adminMemberGuestNameQuerySchema,
    kind: "read",
    returns: ADMIN_MEMBER_GUEST_NAME_CANDIDATES_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "find_member_guest_by_email",
    title: "Find a member to add as a guest by email",
    summary:
      "Officer: the active members with exactly this email address, to add to a booking (`id` from `search_bookings`) as member guests: each one's member id, names and age tier. An unknown or malformed address answers with no candidates. Changes no booking; the lookup is recorded in the audit log.",
    method: "POST",
    path: "/api/admin/bookings/[id]/member-guest-candidates",
    params: bookingIdParamsSchema,
    body: adminMemberGuestEmailBodySchema,
    kind: "write",
    returns: ADMIN_MEMBER_GUEST_EMAIL_CANDIDATES_CONNECTION_SHAPE,
    core: false,
  },
];

// ── Officer tools on one booking ────────────────────────────────────────────

const ONE_BOOKING_TOOLS: readonly McpAction[] = [
  {
    id: "get_booking_work_party_options",
    title: "Read the work parties a booking could join",
    summary:
      "Officer: the booking's current work party (if any) and whether it can be taken off, and every open work party whose dates overlap the stay, with its dates (`YYYY-MM-DD`), discount percent, lodge and whether this booking can be added (with the reason when not). Adding or removing a work party is done on the website.",
    method: "GET",
    path: "/api/admin/bookings/[id]/work-party",
    params: bookingIdParamsSchema,
    kind: "read",
    returns: ADMIN_BOOKING_WORK_PARTY_OPTIONS_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "copy_booking_to_draft",
    title: "Copy a booking to a new draft",
    summary:
      "Officer: copy a booking's party to a new draft booking starting on `checkIn` (`YYYY-MM-DD`), keeping the length of stay. Answers with the new draft's id, dates and status. Member guests from another family are emailed that they were added. Cannot be undone from the app.",
    method: "POST",
    path: "/api/admin/bookings/[id]/copy",
    params: bookingIdParamsSchema,
    body: adminBookingCopyBodySchema,
    kind: "destructive",
    returns: ADMIN_BOOKING_COPY_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "send_additional_payment_reminder",
    title: "Remind a member of an extra amount owing",
    summary:
      `Officer: emails the member again asking them to pay the extra amount still owing on a booking. Refused within ${ADDITIONAL_PAYMENT_RESEND_COOLDOWN_MINUTES} minutes of the last email and when nothing is owed. Answers with when it was sent and the amount in cents. Cannot be undone.`,
    method: "POST",
    path: "/api/admin/bookings/[id]/additional-payment-reminder",
    params: bookingIdParamsSchema,
    kind: "destructive",
    returns: ADMIN_ADDITIONAL_PAYMENT_REMINDER_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "place_admin_capacity_hold",
    title: "Hold beds for an unpaid booking",
    summary:
      "Officer: reserve lodge beds for a payment-pending booking while payment is arranged, without changing its status. Refused over capacity unless `allowOverbook` is true. Answers with whether it overbooked, the overbooked nights (`YYYY-MM-DD`) and when the hold was placed. `release_admin_capacity_hold` frees the beds again, but an overbooked hold also records a capacity override on the booking, which cannot be undone.",
    method: "POST",
    path: "/api/admin/bookings/[id]/capacity-hold",
    params: bookingIdParamsSchema,
    body: adminCapacityHoldBodySchema,
    kind: "destructive",
    returns: ADMIN_CAPACITY_HOLD_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "release_admin_capacity_hold",
    title: "Release the beds held for an unpaid booking",
    summary:
      "Officer: release an admin bed hold on a payment-pending booking, so the beds can be booked by others. Refused once the booking holds the beds through its own status (paid or confirmed). Answers `success`. Cannot be undone: the beds may be taken at once.",
    method: "DELETE",
    path: "/api/admin/bookings/[id]/capacity-hold",
    params: bookingIdParamsSchema,
    kind: "destructive",
    returns: ADMIN_CAPACITY_HOLD_RELEASE_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "set_exclusive_lodge_hold",
    title: "Set or clear a whole-lodge hold",
    summary:
      "Officer: with `hold` true, give a booking that holds beds the whole lodge for its nights, blocking new bookings; with `hold` false, clear it. Setting removes the booking's bed assignments and lists the overlapping bookings the officer must resolve (id, booker name, dates `YYYY-MM-DD`, guest count, status). Answers with the hold, those conflicts and what changed in bed assignments. Cannot be undone from the app: removed bed assignments are not restored.",
    method: "POST",
    path: "/api/admin/bookings/[id]/exclusive-hold",
    params: bookingIdParamsSchema,
    body: adminExclusiveHoldBodySchema,
    kind: "destructive",
    returns: ADMIN_EXCLUSIVE_HOLD_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "force_confirm_waitlisted_booking",
    title: "Confirm a waitlisted booking",
    summary:
      "Officer: take a waitlisted booking off the waitlist now. It moves to payment pending, to paid when free (and emails the member unless `notifyMember` is false), or to awaiting review when it has no adult. Refused over capacity unless `allowOverbook` is true. Answers with the new status, whether it overbooked and the overbooked nights (`YYYY-MM-DD`), and whether it created an unpaid finished stay. Cannot be undone.",
    method: "POST",
    path: "/api/admin/bookings/[id]/force-confirm",
    params: bookingIdParamsSchema,
    body: adminForceConfirmBodySchema,
    kind: "destructive",
    returns: ADMIN_FORCE_CONFIRM_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "send_fresh_booking_email_copy",
    title: "Send a fresh copy of a booking email",
    summary:
      "Officer: emails the member a newly written copy of one booking email: the confirmation, the pre-arrival reminder, or the split guests' payment link (a new link that replaces the old one). Refused when the booking cannot be sent it or a copy just went out. Answers with the template, how many earlier failures were archived, and any warning. Cannot be undone.",
    method: "POST",
    path: "/api/admin/bookings/[id]/fresh-email-copy",
    params: bookingIdParamsSchema,
    body: adminFreshEmailCopyBodySchema,
    kind: "destructive",
    returns: ADMIN_FRESH_EMAIL_COPY_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "set_booking_no_emails",
    title: "Turn a booking's No emails switch on or off",
    summary:
      "Officer: with `noEmails` true (and `acknowledged` true), withhold every member email about this booking, from confirmations to waitlist offers; with false, let them go again. Answers with the switch, when it was set, whether anything changed, and `hasLiveWaitlistOffer`: a live offer keeps running while the member is not told.",
    method: "POST",
    path: "/api/admin/bookings/[id]/no-emails",
    params: bookingIdParamsSchema,
    body: adminNoEmailsBodySchema,
    // Owner decision #5305 item 2: changes a member's booking.
    kind: "destructive",
    returns: ADMIN_NO_EMAILS_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "set_booking_requested_room",
    title: "Set the room a booking asks for",
    summary:
      "Officer: record the room a booking would like at its lodge, for bed allocation. Only with the Bed Allocation module on. Answers with the booking id and the room (id, name, whether active).",
    method: "PUT",
    path: "/api/admin/bookings/[id]/requested-room",
    params: bookingIdParamsSchema,
    body: adminRequestedRoomBodySchema,
    // Owner decision #5305 item 2: changes a member's booking.
    kind: "destructive",
    returns: ADMIN_REQUESTED_ROOM_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "clear_booking_requested_room",
    title: "Clear the room a booking asks for",
    summary:
      "Officer: remove a booking's room request. Only with the Bed Allocation module on. Answers with the booking id and a null `requestedRoomId`.",
    method: "DELETE",
    path: "/api/admin/bookings/[id]/requested-room",
    params: bookingIdParamsSchema,
    // Owner decision #5305 item 2: changes a member's booking.
    kind: "destructive",
    returns: ADMIN_REQUESTED_ROOM_CLEARED_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "return_booking_to_waitlist",
    title: "Return a stranded free booking to the waitlist",
    summary:
      "Officer: repair a free booking left payment pending by a failed waitlist confirmation, putting it back on the waitlist in its old place and releasing any holds on it. Refused for any other booking. Emails the member that their place is restored. Answers with the new status and the place shown (null while No emails is on). Cannot be undone.",
    method: "POST",
    path: "/api/admin/bookings/[id]/return-to-waitlist",
    params: bookingIdParamsSchema,
    kind: "destructive",
    returns: ADMIN_RETURN_TO_WAITLIST_CONNECTION_SHAPE,
    core: false,
  },
];

export const BOOKINGS_BOOKING_MCP_ACTIONS: readonly McpAction[] = [
  ...LIST_AND_SEARCH,
  ...ON_BEHALF_PICKERS,
  ...ONE_BOOKING_TOOLS,
];
