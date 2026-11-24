/**
 * The actions an AI app connection may run (ALP-653, `INV-MCP-006`).
 *
 * An action is one method of one existing API route, named so an AI app can
 * find it. The catalogue adds no behaviour and no permission: the dispatcher
 * (`dispatch.ts`) sends the call back through the site's own front door, so
 * the route's guards decide, exactly as they do for a browser.
 *
 * The request schemas here are the routes' own, imported from the lib modules
 * the routes import them from (`INV-SSOT`). A field described twice would let
 * the app be told one shape while the route enforces another. So is each
 * action's answer (`returns`): the shape the route projects a connection's
 * answer onto, from `connection-shapes.ts` (or an area's own shapes module).
 *
 * `mcp-route-census.test.ts` holds every route method in `src/app/api` to
 * either an entry here or a reasoned exclusion (`exclusions.ts`).
 */
import { z } from "zod";

import { availabilityQuerySchema } from "@/lib/availability-query-schema";
import { bookingIdParamsSchema, cancelBookingMutationSchema } from "@/lib/booking-cancel-schema";
import { bookingCreateCoreShape } from "@/lib/booking-create-fields";
import { getAdminRouteRequirement, type AdminAccessRequirement } from "@/lib/admin-permissions";
import type { ConnectionShape } from "@/lib/connection-projection";
import {
  AGE_GROUPS_CONNECTION_SHAPE,
  AVAILABILITY_CONNECTION_SHAPE,
  BOOKING_MESSAGES_CONNECTION_SHAPE,
  CANCEL_BOOKING_CONNECTION_SHAPE,
  CANCEL_PREVIEW_CONNECTION_SHAPE,
  COMMITTEE_CONNECTION_SHAPE,
  CREDIT_BALANCE_CONNECTION_SHAPE,
  FAMILY_GROUP_CREATE_CONNECTION_SHAPE,
  FAMILY_INVITATIONS_CONNECTION_SHAPE,
  FAMILY_INVITE_CONNECTION_SHAPE,
  FAMILY_MEMBER_DETAILS_CONNECTION_SHAPE,
  FAMILY_REQUEST_SUBMITTED_CONNECTION_SHAPE,
  LODGE_LIST_CONNECTION_SHAPE,
  LODGE_ROSTER_CONNECTION_SHAPE,
  MEMBER_ACCOUNT_ACTIVITY_CONNECTION_SHAPE,
  MEMBER_BOOKING_CONNECTION_SHAPE,
  MEMBER_BOOKING_LIST_CONNECTION_SHAPE,
  MEMBER_DRAFT_LIST_CONNECTION_SHAPE,
  MEMBER_DRAFT_SUMMARY_CONNECTION_SHAPE,
  MEMBER_FAMILY_CONNECTION_SHAPE,
  MEMBER_GUEST_CANDIDATES_CONNECTION_SHAPE,
  MEMBER_GUEST_OPTIONS_CONNECTION_SHAPE,
  MEMBER_NOTICE_CONNECTION_SHAPE,
  MEMBER_NOTICE_LIST_CONNECTION_SHAPE,
  MEMBER_NOTIFICATION_PREFERENCES_CONNECTION_SHAPE,
  MEMBER_PROFILE_CONNECTION_SHAPE,
  MEMBER_PROFILE_UPDATE_CONNECTION_SHAPE,
  MEMBERSHIP_CANCELLATION_OPTIONS_CONNECTION_SHAPE,
  NOTICE_READ_CONNECTION_SHAPE,
  PARTNER_LINK_MESSAGE_CONNECTION_SHAPE,
  PARTNER_LINK_REQUEST_CONNECTION_SHAPE,
  PARTNER_LINK_STATE_CONNECTION_SHAPE,
  SKIFIELD_REPORT_CONNECTION_SHAPE,
  SUBSCRIPTION_STATUS_CONNECTION_SHAPE,
} from "@/lib/connection-shapes";
import { MEMBER_AUDIT_TIMELINE_CATEGORY_OPTIONS } from "@/lib/audit-query";
import { MCP_BOOKING_ACTIONS, MCP_BOOKING_WEBSITE_ONLY_ACTIONS } from "@/lib/mcp/catalogue-bookings";
import {
  delegatedFamilyDetailsSchema,
  familyAdultRequestSchema,
  familyChildRequestSchema,
  familyGroupCreateSchema,
  familyGroupInviteSchema,
  familyJoinRequestSchema,
  familyMemberIdParamsSchema,
  familyRemovalRequestSchema,
} from "@/lib/family-group-request-schemas";
import { ROSTER_WINDOW_DAYS } from "@/lib/lodge-roster-window";
import { MCP_GROUP_ACTIONS } from "@/lib/mcp/catalogue-groups";
import { MCP_LODGE_LIFE_ACTIONS } from "@/lib/mcp/catalogue-lodge-life";
import { memberAuditLogQuerySchema } from "@/lib/member-audit-log-query";
import {
  MEMBER_GUEST_SEARCH_MIN_CHARS,
  MEMBER_GUEST_SEARCH_RESULT_CAP,
  memberGuestResolveBodySchema,
  memberGuestSearchQuerySchema,
} from "@/lib/member-guest-find";
import { memberNotificationPreferencesConnectionUpdateSchema } from "@/lib/member-notification-preferences";
import { memberProfileConnectionUpdateSchema } from "@/lib/member-profile-update-schema";
import { noticeIdParamsSchema } from "@/lib/notices-shared";
import { partnerLinkDeleteQuerySchema, partnerLinkRequestSchema } from "@/lib/partner-link-request-schemas";
import type { StepUpHttpMethod } from "@/lib/step-up-routes";

// An action's flat arguments, kept beside the catalogue that defines them.
export { mcpActionInputJsonSchema, mcpActionInputSchema, splitMcpActionArguments } from "./action-input";

import { BOOKINGS_BEDS_MCP_ACTIONS } from "./catalogue/bookings-beds";
import { BOOKINGS_BOOKING_MCP_ACTIONS } from "./catalogue/bookings-bookings";
import { BOOKINGS_REQUEST_MCP_ACTIONS } from "./catalogue/bookings-requests";
import { BOOKINGS_REVIEW_QUEUE_MCP_ACTIONS } from "./catalogue/bookings-review-queues";
import { BOOKINGS_SETUP_MCP_ACTIONS } from "./catalogue/bookings-setup";

/**
 * `read` changes none of the member's own data. A read may still touch shared
 * housekeeping: the rate-limit counter its route applies, a public cache
 * (`get_skifield_report` refreshes the ski field report's), or its route's own
 * audit row (a lookup of other members records every query, blocked ones
 * included). `write` changes something the member can undo.
 * `destructive` cannot be undone from the app, notifies other people, or
 * overwrites another person's record (owner decision, #5305): for an officer,
 * any email or notice, any change to a member's booking, request, waitlist
 * place, bed or promo code, and every change to club-wide configuration
 * (#5305 comment 7093303964). The app confirms first, and it is audited as
 * important. View-only runs `read` actions only.
 */
export type McpActionKind = "read" | "write" | "destructive";

export type ObjectSchema = z.ZodObject<z.ZodRawShape>;

export interface McpAction {
  /** The tool name the AI app calls. Lower snake case, never reused. */
  readonly id: string;
  readonly title: string;
  /** What the action does, written for the AI app choosing between actions. */
  readonly summary: string;
  readonly method: StepUpHttpMethod;
  /** App Router path, dynamic segments in brackets: `/api/bookings/[id]`. */
  readonly path: string;
  /** One key per bracketed segment in `path`. */
  readonly params?: ObjectSchema;
  readonly query?: ObjectSchema;
  readonly body?: ObjectSchema;
  /** Body fields the catalogue sets and the app cannot. */
  readonly fixedBody?: Readonly<Record<string, unknown>>;
  readonly kind: McpActionKind;
  /**
   * A `POST` that changes no member's data, such as a quote, run as a `read`;
   * like any read it may touch housekeeping (see `McpActionKind`). The census
   * pins every route allowed to be one.
   */
  readonly preview?: true;
  /**
   * The fields the action answers with: the shape the route projects a
   * connection's answer onto (`connectionJson`), or, for a stage 1 route whose
   * whole answer was chosen for the member, a complete description of it.
   */
  readonly returns: ConnectionShape;
  /** Listed as its own tool. The rest are reached through `find_actions`. */
  readonly core: boolean;
  /**
   * An officer route's explicit `requireAdmin({ permission })`, when it names
   * one instead of the path's rule. The census reads the handler and fails
   * unless this matches it, so it is never a free-standing copy.
   */
  readonly requires?: AdminAccessRequirement;
  /**
   * A sentence appended to a successful result that points the member at the
   * website for the step an app cannot take. `{origin}` is the club's site and
   * `{id}` the `id` of the returned record.
   */
  readonly nextStep?: string;
}

/**
 * An action a member may ask for that only the website can do. The app is
 * answered with the page to open and nothing runs.
 */
export interface McpWebsiteOnlyAction {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  /** Site path the member opens. `{id}` is filled from the `id` argument. */
  readonly page: string;
  readonly needsId: boolean;
}

const bookingIdParams = bookingIdParamsSchema;

/** The member's own actions (ALP-653, ALP-718, ALP-796). */
const MEMBER_ACTIONS: readonly McpAction[] = [
  {
    id: "get_availability",
    title: "Check lodge availability",
    summary:
      "Free beds at a lodge for each night of one calendar month. `month` counts from 0 (January) to 11 (December).",
    method: "GET",
    path: "/api/availability",
    query: availabilityQuerySchema,
    kind: "read",
    returns: AVAILABILITY_CONNECTION_SHAPE,
    core: true,
  },
  {
    id: "list_lodges",
    title: "List lodges",
    summary: "The club's lodges that can be booked, with the id each booking action takes as `lodgeId`.",
    method: "GET",
    path: "/api/lodges",
    kind: "read",
    returns: LODGE_LIST_CONNECTION_SHAPE,
    core: true,
  },
  {
    id: "list_my_bookings",
    title: "List my bookings",
    summary:
      "The signed-in member's bookings, newest stay first: the ones they made and the ones they are a guest on. `truncated` is true when there are older ones than the 200 listed. `finalPriceCents` is null on a booking someone else made, and `priceBeingChecked` means the club has not yet confirmed the figure.",
    method: "GET",
    path: "/api/bookings/mine",
    kind: "read",
    returns: MEMBER_BOOKING_LIST_CONNECTION_SHAPE,
    core: true,
  },
  {
    id: "get_my_booking",
    title: "Read one of my bookings",
    summary:
      "A summary of one booking the signed-in member made or is a guest on: dates, lodge, status, party and, for a booking they made, the price and their note. `priceBeingChecked` means the club has not yet confirmed the figure.",
    method: "GET",
    path: "/api/bookings/[id]",
    params: bookingIdParams,
    kind: "read",
    returns: MEMBER_BOOKING_CONNECTION_SHAPE,
    core: true,
  },
  {
    id: "get_my_family_group",
    title: "Read my family group",
    summary:
      "The signed-in member and the active members of their family groups, with the member ids a booking's guest list takes, the `familyGroupIds` the family actions take, each person's groups, whether they have their own login, and whether the member may confirm their details (`confirm_family_member_details`).",
    method: "GET",
    path: "/api/members/family",
    kind: "read",
    returns: MEMBER_FAMILY_CONNECTION_SHAPE,
    core: true,
  },
  {
    id: "get_my_profile",
    title: "Read my profile",
    summary: "The signed-in member's own name, contact details, address and age group, and whether two-step sign-in is on.",
    method: "GET",
    path: "/api/profile/summary",
    kind: "read",
    returns: MEMBER_PROFILE_CONNECTION_SHAPE,
    core: true,
  },
  {
    id: "list_notices",
    title: "List club notices",
    summary: "Club notices the signed-in member can see, pinned first and then newest.",
    method: "GET",
    path: "/api/notices",
    kind: "read",
    returns: MEMBER_NOTICE_LIST_CONNECTION_SHAPE,
    core: true,
  },
  {
    id: "create_draft_booking",
    title: "Start a draft booking",
    summary:
      "Saves a draft booking for the signed-in member. A draft holds no beds and takes no payment: the member finishes and pays on the website.",
    method: "POST",
    path: "/api/bookings",
    body: z.object(bookingCreateCoreShape),
    fixedBody: { draft: true },
    kind: "write",
    returns: MEMBER_DRAFT_SUMMARY_CONNECTION_SHAPE,
    core: true,
    nextStep:
      "This is a draft. It holds no beds until the member confirms and pays at {origin}/bookings/{id}.",
  },
  {
    id: "preview_cancel_booking",
    title: "Preview cancelling a booking",
    summary:
      "What cancelling one of the signed-in member's own bookings would refund, and by which method, without cancelling it. Run this before `cancel_my_booking`.",
    method: "GET",
    path: "/api/bookings/[id]/cancel-preview",
    params: bookingIdParams,
    kind: "read",
    returns: CANCEL_PREVIEW_CONNECTION_SHAPE,
    core: true,
  },
  {
    id: "cancel_my_booking",
    title: "Cancel a booking",
    summary:
      "Cancels one of the signed-in member's own bookings and refunds it under the club's cancellation policy. This cannot be undone. `refundMethod` is `card` or `credit`. Only a booking the member made can be cancelled here, whatever the member's role on the website.",
    method: "POST",
    path: "/api/bookings/[id]/cancel",
    params: bookingIdParams,
    body: cancelBookingMutationSchema.pick({ refundMethod: true }),
    kind: "destructive",
    returns: CANCEL_BOOKING_CONNECTION_SHAPE,
    core: true,
  },
  {
    id: "list_my_draft_bookings",
    title: "List my draft bookings",
    summary: "Draft bookings the signed-in member saved and has not yet confirmed.",
    method: "GET",
    path: "/api/bookings/drafts",
    kind: "read",
    returns: MEMBER_DRAFT_LIST_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "get_my_credit_balance",
    title: "Read my account credit",
    summary: "The signed-in member's account credit balance, in cents.",
    method: "GET",
    path: "/api/member/credit-balance",
    kind: "read",
    returns: CREDIT_BALANCE_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "get_my_subscription_status",
    title: "Read my subscription status",
    summary: "Whether the signed-in member's club subscription is paid for the current season.",
    method: "GET",
    path: "/api/member/subscription-status",
    kind: "read",
    returns: SUBSCRIPTION_STATUS_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "get_my_notification_preferences",
    title: "Read my email preferences",
    summary:
      "Which emails the signed-in member has chosen to receive from the club: booking confirmations, reminders, bumps and cancellations, being added to a family member's booking, the chore roster, club notices and marketing. `true` means the email is sent.",
    method: "GET",
    path: "/api/notifications/preferences",
    kind: "read",
    returns: MEMBER_NOTIFICATION_PREFERENCES_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "update_my_notification_preferences",
    title: "Change my email preferences",
    summary:
      "Turns emails from the club on (`true`) or off (`false`) for the signed-in member. Only the preferences sent change. Answers with all of them. Marketing email can only be turned off here: the member turns it on themselves on the website.",
    method: "PUT",
    path: "/api/notifications/preferences",
    body: memberNotificationPreferencesConnectionUpdateSchema,
    kind: "write",
    returns: MEMBER_NOTIFICATION_PREFERENCES_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "update_my_profile",
    title: "Change my profile",
    summary:
      "Saves the signed-in member's own name, phone number, date of birth, addresses and occupation. `firstName`, `lastName` and the three phone fields are always saved, so send their current values from `get_my_profile` to keep them; any other field not sent keeps its stored value. Dates are `YYYY-MM-DD`. Refused if the result would leave the profile incomplete. Email address, password and two-step sign-in change only on the website.",
    method: "PUT",
    path: "/api/profile",
    // Dietary needs are never read by an app, so it is not offered a blind
    // write; the lobby-screen phone opt-in is a consent the member gives on
    // the website.
    body: memberProfileConnectionUpdateSchema,
    kind: "write",
    returns: MEMBER_PROFILE_UPDATE_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "get_notice",
    title: "Read a club notice",
    summary:
      "One club notice the signed-in member can see, with its text, by the `id` from `list_notices`. Reading it here does not mark it read: run `mark_notice_read` for that. A notice that asks to be acknowledged is acknowledged on the website.",
    method: "GET",
    path: "/api/notices/[id]",
    params: noticeIdParamsSchema,
    kind: "read",
    returns: MEMBER_NOTICE_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "mark_notice_read",
    title: "Mark a notice as read",
    summary:
      "Records that the signed-in member has read one club notice. Marking it again keeps the first time. This does not acknowledge a notice that asks for it.",
    method: "POST",
    path: "/api/notices/[id]/read",
    params: noticeIdParamsSchema,
    kind: "write",
    returns: NOTICE_READ_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "list_my_account_activity",
    title: "List my account activity",
    summary: `The signed-in member's own account history, newest first: bookings, payments, profile and family changes, sign-in and AI app events. \`category\` is one of ${MEMBER_AUDIT_TIMELINE_CATEGORY_OPTIONS.map(({ value }) => `\`${value}\``).join(", ")}. \`page\` counts from 1; \`pageSize\` is at most 50.`,
    method: "GET",
    path: "/api/member/audit-log",
    query: memberAuditLogQuerySchema,
    kind: "read",
    returns: MEMBER_ACCOUNT_ACTIVITY_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "get_lodge_roster",
    title: "See who is at the lodge",
    summary:
      `Who is staying over the next ${ROSTER_WINDOW_DAYS} nights at the lodges the signed-in member can book, as the club's roster page shows it: names, or a group label and head count, and their nights. \`to\` is the morning after the last night shown. Only when the club has the roster switched on.`,
    method: "GET",
    path: "/api/lodge-roster",
    kind: "read",
    returns: LODGE_ROSTER_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "get_age_groups",
    title: "Read the club's age groups",
    summary:
      "The club's age groups (`tier`), their labels and age ranges, and whether each needs a paid subscription to book. Ages are as at the start of the season.",
    method: "GET",
    path: "/api/age-tier-settings",
    kind: "read",
    returns: AGE_GROUPS_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "get_booking_messages",
    title: "Read the club's booking messages",
    summary:
      "The club's standard booking messages, such as payment instructions, by key. `{{TOKEN}}` placeholders take their values from `tokens`; others are filled in for a particular booking.",
    method: "GET",
    path: "/api/booking-messages",
    kind: "read",
    returns: BOOKING_MESSAGES_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "list_committee",
    title: "List the club committee",
    summary: "The club's published committee: each person's name, role and description.",
    method: "GET",
    path: "/api/committee",
    kind: "read",
    returns: COMMITTEE_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "get_skifield_report",
    title: "Read the ski field report",
    summary:
      "The ski field's latest road, lift, facility, weather and trail status, as the club's website shows it. `visibility` says which sections the club shows. `stale` means the report could not be refreshed and is the last one fetched.",
    method: "GET",
    path: "/api/skifield-whakapapa",
    kind: "read",
    returns: SKIFIELD_REPORT_CONNECTION_SHAPE,
    core: false,
  },
  // --- Bookings (ALP-794), in `catalogue-bookings.ts` ---
  ...MCP_BOOKING_ACTIONS,
  // --- Family and membership (ALP-795) ---
  {
    id: "list_my_family_invitations",
    title: "List my family group invitations",
    summary:
      "Invitations to join another member's family group that are waiting for the signed-in member: who sent each, the group and when. The member accepts or declines on their profile page on the website.",
    method: "GET",
    path: "/api/members/family/invitations",
    kind: "read",
    returns: FAMILY_INVITATIONS_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "invite_to_family_group",
    title: "Invite a member to my family group",
    summary:
      "Invites an adult who is already a member, by their email address, to one of the signed-in member's family groups (`familyGroupId` from `get_my_family_group`). The person accepts or declines from their own profile. Only an adult in the group can invite.",
    method: "POST",
    path: "/api/members/family/invite",
    body: familyGroupInviteSchema,
    kind: "write",
    returns: FAMILY_INVITE_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "request_family_group",
    title: "Ask for a new family group",
    summary:
      "Asks the club to create a family group for a signed-in adult who is not in one: an optional group name, an optional partner by email (`declarePartnerLink` also asks them to confirm the partnership), and up to six children with their dates of birth (`YYYY-MM-DD`). An officer reviews the request; the answer is the same whether or not the partner's email belongs to a member.",
    method: "POST",
    path: "/api/members/family/create-group",
    body: familyGroupCreateSchema,
    kind: "write",
    returns: FAMILY_GROUP_CREATE_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "request_to_join_family_group",
    title: "Ask to join a family group",
    summary:
      "Asks to join the family group of another member, by that member's email address. An officer reviews the request. A member with a request already waiting cannot send another.",
    method: "POST",
    path: "/api/members/family/request-join",
    body: familyJoinRequestSchema,
    kind: "write",
    returns: FAMILY_REQUEST_SUBMITTED_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "request_family_child",
    title: "Ask to add a child to my family group",
    summary:
      "Asks the club to add an infant, child or youth (anyone not in the club's adult age group, see `get_age_groups`) to one of the signed-in member's family groups. `dateOfBirth` is `YYYY-MM-DD`. An officer reviews the request. Only an adult in the group can ask.",
    method: "POST",
    path: "/api/members/family/request-child",
    body: familyChildRequestSchema,
    kind: "write",
    returns: FAMILY_REQUEST_SUBMITTED_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "request_family_adult",
    title: "Ask to add an adult without their own login",
    summary:
      "Asks the club to add an adult who shares the signed-in member's email address and has no login of their own to one of the member's family groups. `dateOfBirth` is `YYYY-MM-DD`. An officer reviews the request. To add an adult who has their own login, use `invite_to_family_group`.",
    method: "POST",
    path: "/api/members/family/request-adult",
    body: familyAdultRequestSchema,
    kind: "write",
    returns: FAMILY_REQUEST_SUBMITTED_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "request_family_member_removal",
    title: "Ask to remove someone from my family group",
    summary:
      "Asks the club to remove a person who should not be in one of the signed-in member's family groups (`memberId` and `familyGroupId` from `get_my_family_group`). An officer reviews the request; nobody is removed until then.",
    method: "POST",
    path: "/api/members/family/request-removal",
    body: familyRemovalRequestSchema,
    kind: "write",
    returns: FAMILY_REQUEST_SUBMITTED_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "confirm_family_member_details",
    title: "Confirm a family member's details",
    summary:
      "Saves and confirms the name and date of birth (`YYYY-MM-DD`) of a family member who has no login of their own (`memberId` from `get_my_family_group`, where `canCurrentUserConfirmDetails` is true). Their phone number and addresses are copied from the signed-in member's own profile, which must be complete. The date of birth sets their age group, and so what they pay.",
    method: "PUT",
    path: "/api/members/family/[memberId]/details",
    params: familyMemberIdParamsSchema,
    body: delegatedFamilyDetailsSchema.omit({ inheritContactFromSelf: true }),
    fixedBody: { inheritContactFromSelf: true },
    kind: "destructive",
    returns: FAMILY_MEMBER_DETAILS_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "get_member_guest_options",
    title: "Read how members are found as guests",
    summary:
      "Whether the club lets members add other members as guests on a booking and, if so, whether members can be found by name (`openSearchEnabled`, for `search_members_for_guest`) or only by exact email address (`find_member_by_email`), and whether the guest must approve first.",
    method: "GET",
    path: "/api/members/guest-candidates",
    kind: "read",
    returns: MEMBER_GUEST_OPTIONS_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "search_members_for_guest",
    title: "Search members by name to add as a guest",
    summary: `Members whose first or last name starts with \`q\` (at least ${MEMBER_GUEST_SEARCH_MIN_CHARS} characters), to add as a guest on a booking: each one's \`memberId\`, name and age group, never contact details or dates of birth. At most ${MEMBER_GUEST_SEARCH_RESULT_CAP}; \`truncated\` means there are more, so narrow the search. Only where the club has name search switched on; each search is recorded.`,
    method: "GET",
    path: "/api/members/guest-candidates/search",
    query: memberGuestSearchQuerySchema,
    kind: "read",
    returns: MEMBER_GUEST_CANDIDATES_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "find_member_by_email",
    title: "Find a member by email to add as a guest",
    summary:
      "The member with exactly this email address, or each member of a household who share it, to add as a guest on a booking: each one's `memberId`, name and age group. An empty list says nothing about why. Changes no member's data; each lookup is recorded and rate limited.",
    method: "POST",
    path: "/api/members/guest-candidates/resolve",
    body: memberGuestResolveBodySchema,
    kind: "read",
    preview: true,
    returns: MEMBER_GUEST_CANDIDATES_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "get_my_partner_link",
    title: "Read my partner link",
    summary:
      "The signed-in member's confirmed partner, the partner requests they sent and received, the family members without a login they may declare as their partner in one step (on the website, not through `request_partner_link`), and any emailed partner invitation nobody has claimed (its id and expiry). A request addressed to the member is confirmed on the website.",
    method: "GET",
    path: "/api/members/partner-link",
    kind: "read",
    returns: PARTNER_LINK_STATE_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "request_partner_link",
    title: "Declare my partner",
    summary:
      "Asks another member to confirm they are the signed-in member's partner: by `email` (a registered adult with a login) or by `memberId` (an adult with a login in the signed-in member's own family group). Send exactly one. They confirm from their own profile. Once a request by email is accepted, the reply is the same whether or not a request was created. A family member without a login of their own is declared on the website, because that confirms the partnership at once.",
    method: "POST",
    path: "/api/members/partner-link",
    body: partnerLinkRequestSchema,
    kind: "write",
    returns: PARTNER_LINK_REQUEST_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "end_partner_link",
    title: "End or withdraw a partner link",
    summary:
      "With `id` (from `get_my_partner_link`), withdraws the signed-in member's own pending partner request or ends their confirmed partnership; the other person is told. With `inviteTokenId`, cancels an emailed partner invitation nobody has claimed. Send exactly one. Cannot be undone from the app.",
    method: "DELETE",
    path: "/api/members/partner-link",
    query: partnerLinkDeleteQuerySchema,
    kind: "destructive",
    returns: PARTNER_LINK_MESSAGE_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "get_membership_cancellation_options",
    title: "Read my membership cancellation options",
    summary:
      "Whose memberships the signed-in member may ask the club to cancel (themselves and family members), and why any cannot be; the club's warning and how to rejoin; and their cancellation requests so far. No email addresses. The request itself is made on the member's profile page on the website.",
    method: "GET",
    path: "/api/member/membership-cancellation-requests",
    kind: "read",
    returns: MEMBERSHIP_CANCELLATION_OPTIONS_CONNECTION_SHAPE,
    core: false,
  },
  // --- Lodge life (ALP-796) and groups and whole-lodge (ALP-797), in their own modules ---
  ...MCP_LODGE_LIFE_ACTIONS,
  ...MCP_GROUP_ACTIONS,
];

/**
 * Every action. An officer action is one whose route `getAdminRouteRequirement`
 * resolves to an admin area: it is offered only to someone holding that area
 * at that level (`mcpActionAdminRequirement`), and its route decides with the
 * officer's own permissions, exactly as on the admin screens. Each officer
 * area's actions live in a module of their own under `catalogue/`.
 */
export const MCP_ACTIONS: readonly McpAction[] = [
  ...MEMBER_ACTIONS,
  // Bookings & Beds (ALP-719), every route the `bookings` area guards bar the
  // fresh-proof ones.
  ...BOOKINGS_BOOKING_MCP_ACTIONS,
  ...BOOKINGS_REQUEST_MCP_ACTIONS,
  ...BOOKINGS_REVIEW_QUEUE_MCP_ACTIONS,
  ...BOOKINGS_BEDS_MCP_ACTIONS,
  ...BOOKINGS_SETUP_MCP_ACTIONS,
];

export const MCP_WEBSITE_ONLY_ACTIONS: readonly McpWebsiteOnlyAction[] = [
  ...MCP_BOOKING_WEBSITE_ONLY_ACTIONS,
  {
    id: "change_sign_in_details",
    title: "Change password or two-step sign-in",
    summary: "Passwords and two-step sign-in are changed on the club website, after signing in again.",
    page: "/profile",
    needsId: false,
  },
  {
    id: "manage_connected_apps",
    title: "Disconnect an AI app",
    summary: "Connected AI apps are listed and disconnected on the member's profile page.",
    page: "/profile",
    needsId: false,
  },
];

/** `/api/bookings/[id]` → `src/app/api/bookings/[id]/route.ts`. */
export function mcpActionRouteFile(action: Pick<McpAction, "path">): string {
  return `src/app${action.path}/route.ts`;
}

/**
 * The admin area and level an officer action needs, or null for a member
 * action: what the route itself demands. That is the route's explicit
 * `requireAdmin` permission where it names one (`requires`, pinned to the
 * handler by the census), else the path's rule in `admin-permissions.ts`
 * (`INV-MCP-009`).
 */
export function mcpActionAdminRequirement(
  action: Pick<McpAction, "path" | "method" | "requires">,
): AdminAccessRequirement | null {
  return action.requires ?? getAdminRouteRequirement(action.path, action.method);
}

export function findMcpAction(id: string): McpAction | undefined {
  return MCP_ACTIONS.find((action) => action.id === id);
}

export function findMcpWebsiteOnlyAction(id: string): McpWebsiteOnlyAction | undefined {
  return MCP_WEBSITE_ONLY_ACTIONS.find((action) => action.id === id);
}
