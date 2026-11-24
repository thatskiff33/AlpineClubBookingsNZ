/**
 * The AI app's booking actions (ALP-794, `INV-MCP-006`), part of
 * `MCP_ACTIONS` in `catalogue.ts`, which says what an action is.
 *
 * Each acts on the connected member's own bookings only: the routes decide
 * officer reach on `memberOnlySessionUser`. Booking edits that can take, move
 * or refund money are not here; they are `moves-money` exclusions
 * (`exclusions.ts`) and the website-only `change_my_booking`.
 *
 * An action that notifies anyone but the member, or changes another person's
 * record, is `destructive` (owner decision on #5305, item 2), so the app
 * confirms with the member first and the call is logged as important: the
 * change, exception and refund-review requests email the club's officers, and
 * accepting a waitlist offer runs the hosting check that can email other
 * members on a group trip.
 */
import { bookingIdParamsSchema } from "@/lib/booking-cancel-schema";
import { changeRequestConnectionCreateSchema, changeRequestEstimateSchema } from "@/lib/booking-change-request-input";
import {
  arrivalTimeUpdateSchema,
  bookingNotesUpdateSchema,
  requestedRoomUpdateSchema,
} from "@/lib/booking-detail-edit-schemas";
import {
  bookingExceptionRequestParamsSchema,
  exceptionRequestIdParamsSchema,
  modificationExceptionRequestConnectionSchema,
  newBookingExceptionRequestConnectionSchema,
} from "@/lib/booking-exception-request-schemas";
import { modifyQuoteConnectionSchema } from "@/lib/booking-modify-quote-request";
import { bookingQuoteConnectionRequestSchema } from "@/lib/booking-quote-request";
import {
  availabilityCheckQuerySchema,
  bookingPolicyCheckQuerySchema,
  bookingRoomsConnectionQuerySchema,
} from "@/lib/booking-stay-check-query";
import {
  ARRIVAL_TIME_CONNECTION_SHAPE,
  BOOKING_CHANGE_QUOTE_CONNECTION_SHAPE,
  BOOKING_CHANGE_REQUEST_CONNECTION_SHAPE,
  BOOKING_CHANGE_REQUEST_LIST_CONNECTION_SHAPE,
  BOOKING_NOTE_CONNECTION_SHAPE,
  BOOKING_QUOTE_CONNECTION_SHAPE,
  BOOKING_RULES_CONNECTION_SHAPE,
  CHANGE_REQUEST_ESTIMATE_CONNECTION_SHAPE,
  CREATED_EXCEPTION_REQUEST_CONNECTION_SHAPE,
  DRAFT_DELETED_CONNECTION_SHAPE,
  LODGE_ROOMS_CONNECTION_SHAPE,
  MEMBER_EXCEPTION_REQUEST_LIST_CONNECTION_SHAPE,
  MEMBER_PROMO_CODES_CONNECTION_SHAPE,
  PROMO_CHECK_CONNECTION_SHAPE,
  REFUND_APPEAL_CONNECTION_SHAPE,
  REFUND_APPEAL_LIST_CONNECTION_SHAPE,
  REQUESTED_ROOM_CONNECTION_SHAPE,
  STAY_AVAILABILITY_CONNECTION_SHAPE,
  WAITLIST_OFFER_ACCEPTED_CONNECTION_SHAPE,
  WITHDRAWN_EXCEPTION_REQUEST_CONNECTION_SHAPE,
} from "@/lib/connection-shapes-bookings";
import { promoValidateConnectionRequestSchema } from "@/lib/promo-validate-request";
import { refundAppealRequestSchema } from "@/lib/refund-appeal-request";
import type { McpAction, McpWebsiteOnlyAction } from "@/lib/mcp/catalogue";

export const MCP_BOOKING_ACTIONS: readonly McpAction[] = [
  {
    id: "check_stay_availability",
    title: "Check beds for a stay",
    summary:
      "Free beds at a lodge for each night of one stay, and the lowest number free on any night. Dates are `YYYY-MM-DD`; `checkOut` is the morning the stay ends. `lodgeId` is from `list_lodges`; omitted, the club's main lodge. A full night and a night the lodge is held both show 0 free.",
    method: "GET",
    path: "/api/availability/check",
    query: availabilityCheckQuerySchema,
    kind: "read",
    returns: STAY_AVAILABILITY_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "check_booking_rules",
    title: "Check a stay against the booking rules",
    summary:
      "Whether a stay meets the club's minimum-stay rules, each rule it breaks in words, and the cancellation schedule that would apply. Dates are `YYYY-MM-DD`. A stay that breaks a rule can still be asked for with `request_booking_exception`.",
    method: "GET",
    path: "/api/booking-policies/check",
    query: bookingPolicyCheckQuerySchema,
    kind: "read",
    returns: BOOKING_RULES_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "list_lodge_rooms",
    title: "List lodge rooms",
    summary:
      "The rooms a member can ask to stay in, with their bed counts, at one lodge (`lodgeId`, from `list_lodges`). `enabled` is false when the club does not take room requests.",
    method: "GET",
    path: "/api/bookings/rooms",
    query: bookingRoomsConnectionQuerySchema,
    kind: "read",
    returns: LODGE_ROOMS_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "list_requestable_rooms",
    title: "List rooms I can request for a booking",
    summary:
      "The rooms at the booking's lodge that the signed-in member can request for one of their own bookings, for `set_my_requested_room`.",
    method: "GET",
    path: "/api/bookings/[id]/requested-room/options",
    params: bookingIdParamsSchema,
    kind: "read",
    returns: LODGE_ROOMS_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "list_my_promo_codes",
    title: "List my promo codes",
    summary: "The promo codes the club has given the signed-in member, with what each takes off.",
    method: "GET",
    path: "/api/promo-codes/available",
    kind: "read",
    returns: MEMBER_PROMO_CODES_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "quote_booking",
    title: "Price a stay",
    summary:
      "What a stay would cost the signed-in member, guest by guest, before anything is booked. Changes none of the member's bookings. Dates are `YYYY-MM-DD`. Each guest gives `ageTier` and `isMember`, a member guest their `memberId` from `get_my_family_group`, and optionally their own `stayStart` and `stayEnd` or `nights`. `availableCreditCents` is the member's account credit.",
    method: "POST",
    path: "/api/bookings/quote",
    body: bookingQuoteConnectionRequestSchema,
    kind: "read",
    preview: true,
    returns: BOOKING_QUOTE_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "check_promo_code",
    title: "Check a promo code",
    summary:
      "What a promo code (`code`), several codes (`codes`) or a working bee (`workPartyEventId`, with `lodgeId`) would take off a stay, without applying it. Changes none of the member's bookings. Send the stay and party as for `quote_booking`; for a change to an existing booking, also its `bookingId`.",
    method: "POST",
    path: "/api/promo-codes/validate",
    body: promoValidateConnectionRequestSchema,
    kind: "read",
    preview: true,
    returns: PROMO_CHECK_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "quote_booking_change",
    title: "Price a change to a booking",
    summary:
      "What changing one of the signed-in member's own bookings would cost or give back, and whether it can be made, without changing it. Send only what changes: new `checkIn` or `checkOut`, guests to add or remove (by the guest `id`), a guest's own nights, name corrections, the full list of `promoCodes`, or credit to apply. The change itself is made on the website (`change_my_booking`).",
    method: "POST",
    path: "/api/bookings/[id]/modify-quote",
    params: bookingIdParamsSchema,
    body: modifyQuoteConnectionSchema,
    kind: "read",
    preview: true,
    returns: BOOKING_CHANGE_QUOTE_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "quote_booking_change_request",
    title: "Price guests for a change request",
    summary:
      "An estimate for the guests a change request on a stay already under way would add, before the request is sent. Changes none of the member's bookings. Member guests are counted but not priced. `editorChanges` is the rest of the request, as `request_booking_change` takes it.",
    method: "POST",
    path: "/api/bookings/[id]/change-requests/quote",
    params: bookingIdParamsSchema,
    body: changeRequestEstimateSchema,
    kind: "read",
    preview: true,
    returns: CHANGE_REQUEST_ESTIMATE_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "set_my_booking_note",
    title: "Change a booking's note",
    summary:
      "Saves the note on one of the signed-in member's own active bookings, up to 500 characters. An empty note clears it.",
    method: "PUT",
    path: "/api/bookings/[id]/notes",
    params: bookingIdParamsSchema,
    body: bookingNotesUpdateSchema,
    kind: "write",
    returns: BOOKING_NOTE_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "set_my_arrival_time",
    title: "Set an expected arrival time",
    summary:
      "Records when the member expects to arrive at the lodge for one of their own bookings, on the hour or half hour (`HH:00` or `HH:30`, 24-hour). Only before the check-in date has passed.",
    method: "PUT",
    path: "/api/bookings/[id]/arrival-time",
    params: bookingIdParamsSchema,
    body: arrivalTimeUpdateSchema,
    kind: "write",
    returns: ARRIVAL_TIME_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "clear_my_arrival_time",
    title: "Clear an expected arrival time",
    summary: "Removes the expected arrival time from one of the signed-in member's own bookings.",
    method: "DELETE",
    path: "/api/bookings/[id]/arrival-time",
    params: bookingIdParamsSchema,
    kind: "write",
    returns: ARRIVAL_TIME_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "set_my_requested_room",
    title: "Request a room",
    summary:
      "Asks for a room, from `list_requestable_rooms`, on one of the signed-in member's own bookings. A request, not a guarantee; refused once the club has allocated beds.",
    method: "PUT",
    path: "/api/bookings/[id]/requested-room",
    params: bookingIdParamsSchema,
    body: requestedRoomUpdateSchema,
    kind: "write",
    returns: REQUESTED_ROOM_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "clear_my_requested_room",
    title: "Withdraw a room request",
    summary: "Withdraws the room request on one of the signed-in member's own bookings.",
    method: "DELETE",
    path: "/api/bookings/[id]/requested-room",
    params: bookingIdParamsSchema,
    kind: "write",
    returns: REQUESTED_ROOM_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "list_booking_change_requests",
    title: "List a booking's change requests",
    summary:
      "The change requests and exception requests on one of the signed-in member's own bookings, newest first, with each one's status and the club's reply.",
    method: "GET",
    path: "/api/bookings/[id]/change-requests",
    params: bookingIdParamsSchema,
    kind: "read",
    returns: BOOKING_CHANGE_REQUEST_LIST_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "request_booking_change",
    title: "Ask the club to change a stay",
    summary:
      "Asks a booking officer to change one of the signed-in member's own bookings in a way the member can no longer make themselves: a stay under way, or a night today or earlier. Name the change (new dates, guests added or removed, or a guest's nights) and add a `reason`. The officer decides, and any price difference is settled then. One open request per booking. The club's officers are emailed, so confirm with the member first.",
    method: "POST",
    path: "/api/bookings/[id]/change-requests",
    params: bookingIdParamsSchema,
    body: changeRequestConnectionCreateSchema,
    kind: "destructive",
    returns: BOOKING_CHANGE_REQUEST_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "list_my_exception_requests",
    title: "List my exception requests",
    summary:
      "The signed-in member's requests to book or change a booking outside the club's rules, with the proposal as frozen for the officer, the rules involved, and the decision.",
    method: "GET",
    path: "/api/bookings/exception-requests",
    kind: "read",
    returns: MEMBER_EXCEPTION_REQUEST_LIST_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "request_booking_exception",
    title: "Ask to book outside the rules",
    summary:
      "Asks a booking officer to allow a new stay the club's rules refuse, such as one shorter than the minimum stay. `memberMessage` explains why. Nothing is booked until an officer approves; the member then confirms and pays on the website. `supersedeRequestId` replaces an open request. The club's officers are emailed, so confirm with the member first.",
    method: "POST",
    path: "/api/bookings/exception-requests",
    body: newBookingExceptionRequestConnectionSchema,
    kind: "destructive",
    returns: CREATED_EXCEPTION_REQUEST_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "withdraw_booking_exception_request",
    title: "Withdraw a booking exception request",
    summary:
      "Withdraws one of the signed-in member's open requests to book outside the rules, by the `id` from `list_my_exception_requests`. This cannot be undone: ask again to reopen it.",
    method: "PATCH",
    path: "/api/bookings/exception-requests/[id]",
    params: exceptionRequestIdParamsSchema,
    fixedBody: { action: "cancel" },
    kind: "destructive",
    returns: WITHDRAWN_EXCEPTION_REQUEST_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "request_booking_change_exception",
    title: "Ask to change a booking outside the rules",
    summary:
      "Asks a booking officer to allow a change to one of the signed-in member's own bookings that the club's rules refuse. Send only what changes, as for `quote_booking_change`, with `memberMessage` explaining why. Nothing changes until an officer approves. The club's officers are emailed, so confirm with the member first.",
    method: "POST",
    path: "/api/bookings/[id]/exception-requests",
    params: bookingIdParamsSchema,
    body: modificationExceptionRequestConnectionSchema,
    kind: "destructive",
    returns: CREATED_EXCEPTION_REQUEST_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "withdraw_booking_change_exception_request",
    title: "Withdraw a change exception request",
    summary:
      "Withdraws one of the signed-in member's open requests to change a booking outside the rules: the booking `id` and the request's `requestId`. This cannot be undone: ask again to reopen it.",
    method: "PATCH",
    path: "/api/bookings/[id]/exception-requests/[requestId]",
    params: bookingExceptionRequestParamsSchema,
    fixedBody: { action: "cancel" },
    kind: "destructive",
    returns: WITHDRAWN_EXCEPTION_REQUEST_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "list_my_refund_reviews",
    title: "List refund reviews on a booking",
    summary: "The refund reviews asked for on one of the signed-in member's own cancelled bookings, and the club's decisions.",
    method: "GET",
    path: "/api/bookings/[id]/refund-request",
    params: bookingIdParamsSchema,
    kind: "read",
    returns: REFUND_APPEAL_LIST_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "request_refund_review",
    title: "Ask for a refund review",
    summary:
      "Asks the club to review the refund on one of the signed-in member's own cancelled bookings. `reason` is 10 to 2000 characters; `requestedAmountCents` is optional. No money moves: an officer decides. One open review per booking. The club's officers are emailed, so confirm with the member first.",
    method: "POST",
    path: "/api/bookings/[id]/refund-request",
    params: bookingIdParamsSchema,
    body: refundAppealRequestSchema,
    kind: "destructive",
    returns: REFUND_APPEAL_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "accept_waitlist_offer",
    title: "Accept a waitlist offer",
    summary:
      "Accepts the place the club has offered on one of the signed-in member's waitlisted bookings. If `requiresPayment` is true the member must pay on the website to keep it; if `requiresSetup` is true the booking is held as pending and the member saves a card on the website, charged only once the booking is confirmed. An offer at another lodge is refused (409): the member accepts it on the website, which shows the lodge and price. Confirms the booking and can lead to emails to other members on a group trip, so confirm with the member first.",
    method: "POST",
    path: "/api/bookings/[id]/waitlist-confirm",
    params: bookingIdParamsSchema,
    kind: "destructive",
    returns: WAITLIST_OFFER_ACCEPTED_CONNECTION_SHAPE,
    core: false,
    nextStep: "If payment or a saved card is needed, the member finishes at {origin}/bookings/{id}.",
  },
  {
    id: "delete_my_draft_booking",
    title: "Delete a draft booking",
    summary:
      "Deletes one of the signed-in member's own draft bookings, from `list_my_draft_bookings`. This cannot be undone. Only a draft: a confirmed booking is cancelled with `cancel_my_booking`.",
    method: "DELETE",
    path: "/api/bookings/[id]",
    params: bookingIdParamsSchema,
    kind: "destructive",
    returns: DRAFT_DELETED_CONNECTION_SHAPE,
    core: false,
  },
];

/** Booking actions the member takes on the website; the app sends them there. */
export const MCP_BOOKING_WEBSITE_ONLY_ACTIONS: readonly McpWebsiteOnlyAction[] = [
  {
    id: "pay_for_booking",
    title: "Pay for a booking",
    summary: "Card details are entered on the club website, never in an AI app.",
    page: "/bookings/{id}",
    needsId: true,
  },
  {
    // ALP-794: changing dates or guests can take or refund money (`moves-money`).
    id: "change_my_booking",
    title: "Change a booking's dates or guests",
    summary:
      "Changing a booking's dates or guests, confirming a draft, or sending a guest a payment link can take or refund money, so the member does it on the club website. `quote_booking_change` shows what it would cost first.",
    page: "/bookings/{id}",
    needsId: true,
  },
];
