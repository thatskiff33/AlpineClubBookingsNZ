/**
 * Booking setup: seasons, booking policies, age groups, member-guest and booking-request settings.
 * Part of the Bookings & Beds officer actions (ALP-719): spread into `MCP_ACTIONS`.
 *
 * Kinds: every change here is `destructive`. Seasons and hut rates, booking
 * periods, minimum stays, the cancellation and group discount policies, age
 * groups and booking-request settings are club-wide configuration, which an
 * officer's app may change only after asking the officer first (owner
 * decision, #5305 comment 7093303964, item 2). A delete, the minimum-stay
 * "delete" that deactivates, and the adult-member hosting save (it can email
 * booking owners whose bookings lose cover) were already. The member-guest
 * save is website-only (`privacy-posture` in `exclusions.ts`).
 */
import { adminRecordIdParamsSchema } from "@/lib/admin-bookings-schemas/record-id";
import {
  adminPolicyLodgeQuerySchema,
  adminSeasonsQuerySchema,
  adultMemberHostingBodySchema,
  ageTierSettingsBodySchema,
  bookingPeriodCreateBodySchema,
  bookingPeriodUpdateBodySchema,
  bookingRequestSettingsBodySchema,
  groupDiscountBodySchema,
  minimumStayCreateBodySchema,
  minimumStayDeleteBodySchema,
  minimumStayUpdateBodySchema,
  seasonCreateBodySchema,
  seasonUpdateBodySchema,
} from "@/lib/admin-bookings-schemas/setup";
import { policySchema as cancellationPolicyBodySchema } from "@/lib/booking-policy-cancellation-schema";
import {
  ADMIN_ADULT_MEMBER_HOSTING_CONNECTION_SHAPE,
  ADMIN_AGE_TIER_SETTINGS_CONNECTION_SHAPE,
  ADMIN_BOOKING_PERIOD_CONNECTION_SHAPE,
  ADMIN_BOOKING_PERIOD_LIST_CONNECTION_SHAPE,
  ADMIN_BOOKING_REQUEST_SETTINGS_CONNECTION_SHAPE,
  ADMIN_CANCELLATION_POLICY_CONNECTION_SHAPE,
  ADMIN_CANCELLATION_POLICY_SAVED_CONNECTION_SHAPE,
  ADMIN_GROUP_DISCOUNT_CONNECTION_SHAPE,
  ADMIN_GROUP_DISCOUNT_SAVED_CONNECTION_SHAPE,
  ADMIN_MEMBER_GUEST_SETTINGS_CONNECTION_SHAPE,
  ADMIN_MINIMUM_STAY_POLICY_CONNECTION_SHAPE,
  ADMIN_MINIMUM_STAY_POLICY_DEACTIVATED_CONNECTION_SHAPE,
  ADMIN_MINIMUM_STAY_POLICY_LIST_CONNECTION_SHAPE,
  ADMIN_SEASON_CONNECTION_SHAPE,
  ADMIN_SEASON_LIST_CONNECTION_SHAPE,
  ADMIN_SETUP_DELETED_CONNECTION_SHAPE,
} from "@/lib/connection-shapes/bookings-setup";

import type { McpAction } from "../catalogue";

export const BOOKINGS_SETUP_MCP_ACTIONS: readonly McpAction[] = [
  // --- Seasons and hut rates -------------------------------------------------
  {
    id: "list_seasons",
    title: "List seasons and hut rates",
    summary:
      "Officer: the club's seasons, newest first, under `seasons`: name, WINTER or SUMMER, dates (`YYYY-MM-DD`), whether active, lodge, the flat whole-lodge night rate and each membership type's nightly rates, all in integer cents. Give `lodgeId` (from `list_lodges`) for one lodge.",
    method: "GET",
    path: "/api/admin/seasons",
    query: adminSeasonsQuerySchema,
    kind: "read",
    returns: ADMIN_SEASON_LIST_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "get_season",
    title: "Read a season",
    summary:
      "Officer: one season by `id` (from `list_seasons`): dates, whether active, lodge, the flat whole-lodge night rate and each membership type's nightly rates, in integer cents.",
    method: "GET",
    path: "/api/admin/seasons/[id]",
    params: adminRecordIdParamsSchema,
    kind: "read",
    returns: ADMIN_SEASON_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "create_season",
    title: "Create a season",
    summary:
      "Officer: adds a season at a lodge (`lodgeId` from `list_lodges`, default lodge if omitted) with its nightly hut rates in integer cents, one per membership type (`membershipTypeId` as in an existing season's rates from `list_seasons`). Dates are `YYYY-MM-DD` and must not overlap another season at the lodge. Answers the saved season.",
    method: "POST",
    path: "/api/admin/seasons",
    body: seasonCreateBodySchema,
    kind: "destructive",
    returns: ADMIN_SEASON_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "update_season",
    title: "Change a season or its hut rates",
    summary:
      "Officer: changes a season (`id` from `list_seasons`): name, type, dates (`YYYY-MM-DD`), whether active, the flat whole-lodge night rate, or its nightly rates in integer cents, which replace every rate when given. Answers the saved season.",
    method: "PUT",
    path: "/api/admin/seasons/[id]",
    params: adminRecordIdParamsSchema,
    body: seasonUpdateBodySchema,
    kind: "destructive",
    returns: ADMIN_SEASON_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "delete_season",
    title: "Delete a season",
    summary:
      "Officer: deletes a season (`id` from `list_seasons`) and all its hut rates. It cannot be undone; the season would have to be entered again. Answers `success`.",
    method: "DELETE",
    path: "/api/admin/seasons/[id]",
    params: adminRecordIdParamsSchema,
    kind: "destructive",
    returns: ADMIN_SETUP_DELETED_CONNECTION_SHAPE,
    core: false,
  },

  // --- Cancellation policy ---------------------------------------------------
  {
    id: "get_cancellation_policy",
    title: "Read the cancellation policy",
    summary:
      "Officer: the cancellation refund tiers (from `daysBeforeStay` days before arrival: card and credit refund percentages and fixed fees in integer cents) for the club, or for one lodge's override when `lodgeId` is given, plus the club-wide booking defaults: non-member hold, waitlist order, linked-move change fees, late-capture refund approval and the reminder and hold timings in days.",
    method: "GET",
    path: "/api/admin/booking-policies/cancellation",
    query: adminPolicyLodgeQuerySchema,
    kind: "read",
    returns: ADMIN_CANCELLATION_POLICY_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "update_cancellation_policy",
    title: "Change the cancellation policy",
    summary:
      "Officer: replaces the cancellation refund tiers of the club or, with `lodgeId`, of one lodge (an empty list for a lodge removes its override), and sets any club-wide default given. Percentages are whole numbers, fees integer cents, day thresholds unique. Changing late-capture refund approval also needs finance edit access; send the value last read as `lateCaptureRefundNeedsApprovalLoaded`. Answers the saved tiers and defaults.",
    method: "PUT",
    path: "/api/admin/booking-policies/cancellation",
    // The route's schema also refuses club-wide fields with a lodge and an
    // empty club-wide list; the route remains the authority for those.
    body: cancellationPolicyBodySchema,
    kind: "destructive",
    returns: ADMIN_CANCELLATION_POLICY_SAVED_CONNECTION_SHAPE,
    core: false,
  },

  // --- Booking periods -------------------------------------------------------
  {
    id: "list_booking_periods",
    title: "List booking periods",
    summary:
      "Officer: the booking periods (date ranges with their own non-member hold and cancellation tiers), earliest first, under `periods`, for the club or, with `lodgeId`, one lodge's override set. Fees are integer cents.",
    method: "GET",
    path: "/api/admin/booking-policies/periods",
    query: adminPolicyLodgeQuerySchema,
    kind: "read",
    returns: ADMIN_BOOKING_PERIOD_LIST_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "get_booking_period",
    title: "Read a booking period",
    summary:
      "Officer: one booking period by `id` (from `list_booking_periods`): dates (`YYYY-MM-DD`), non-member hold, cancellation tiers (fees in integer cents), whether active and its lodge.",
    method: "GET",
    path: "/api/admin/booking-policies/periods/[id]",
    params: adminRecordIdParamsSchema,
    kind: "read",
    returns: ADMIN_BOOKING_PERIOD_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "create_booking_period",
    title: "Create a booking period",
    summary:
      "Officer: adds a booking period, club-wide or for one lodge (`lodgeId`), with dates (`YYYY-MM-DD`), non-member hold days and its own cancellation tiers (fees in integer cents). Answers the saved period.",
    method: "POST",
    path: "/api/admin/booking-policies/periods",
    body: bookingPeriodCreateBodySchema,
    kind: "destructive",
    returns: ADMIN_BOOKING_PERIOD_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "update_booking_period",
    title: "Change a booking period",
    summary:
      "Officer: changes a booking period (`id` from `list_booking_periods`): name, dates (`YYYY-MM-DD`), non-member hold, cancellation tiers (fees in integer cents; given tiers replace them all) or whether active. Answers the saved period.",
    method: "PUT",
    path: "/api/admin/booking-policies/periods/[id]",
    params: adminRecordIdParamsSchema,
    body: bookingPeriodUpdateBodySchema,
    kind: "destructive",
    returns: ADMIN_BOOKING_PERIOD_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "delete_booking_period",
    title: "Delete a booking period",
    summary:
      "Officer: deletes a booking period (`id` from `list_booking_periods`). It cannot be undone; the period would have to be entered again. Answers `success`.",
    method: "DELETE",
    path: "/api/admin/booking-policies/periods/[id]",
    params: adminRecordIdParamsSchema,
    kind: "destructive",
    returns: ADMIN_SETUP_DELETED_CONNECTION_SHAPE,
    core: false,
  },

  // --- Minimum stay ----------------------------------------------------------
  {
    id: "list_minimum_stay_policies",
    title: "List minimum-stay policies",
    summary:
      "Officer: the minimum-stay policies, newest first, under `policies`, for the club or, with `lodgeId`, one lodge's override set: dates (`YYYY-MM-DD`), trigger weekdays (0 Sunday to 6 Saturday), minimum nights, capacity mode, whether active and the `version` a change must send.",
    method: "GET",
    path: "/api/admin/booking-policies/minimum-stay",
    query: adminPolicyLodgeQuerySchema,
    kind: "read",
    returns: ADMIN_MINIMUM_STAY_POLICY_LIST_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "create_minimum_stay_policy",
    title: "Create a minimum-stay policy",
    summary:
      "Officer: adds a minimum-stay policy, club-wide or for one lodge (`lodgeId`): an arrival on a trigger weekday between the dates (`YYYY-MM-DD`) must stay at least `minimumNights`. An active policy's name must be unique in its scope. Answers the saved policy.",
    method: "POST",
    path: "/api/admin/booking-policies/minimum-stay",
    body: minimumStayCreateBodySchema,
    kind: "destructive",
    returns: ADMIN_MINIMUM_STAY_POLICY_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "update_minimum_stay_policy",
    title: "Change a minimum-stay policy",
    summary:
      "Officer: changes a minimum-stay policy (`id` from `list_minimum_stay_policies`), including making it active again. Send its current `version`; a policy changed since is refused with 409. Answers the saved policy.",
    method: "PUT",
    path: "/api/admin/booking-policies/minimum-stay/[id]",
    params: adminRecordIdParamsSchema,
    body: minimumStayUpdateBodySchema,
    kind: "destructive",
    returns: ADMIN_MINIMUM_STAY_POLICY_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "deactivate_minimum_stay_policy",
    title: "Delete (deactivate) a minimum-stay policy",
    summary:
      "Officer: deactivates a minimum-stay policy (`id` from `list_minimum_stay_policies`) so bookings are no longer held to it; send its current `version`. The row is kept: `update_minimum_stay_policy` with `active: true` turns it back on. Answers `success` and the deactivated policy (`policy` is absent if it was already inactive).",
    method: "DELETE",
    path: "/api/admin/booking-policies/minimum-stay/[id]",
    params: adminRecordIdParamsSchema,
    body: minimumStayDeleteBodySchema,
    kind: "destructive",
    returns: ADMIN_MINIMUM_STAY_POLICY_DEACTIVATED_CONNECTION_SHAPE,
    core: false,
  },

  // --- Group discount ----------------------------------------------------------
  {
    id: "get_group_discount_policy",
    title: "Read the group discount policy",
    summary:
      "Officer: the group discount: whether it is on, the minimum group size, whether it applies in summer only, whether later edits earn it, the membership type whose rates qualifying non-members pay (`rateMembershipTypeId`), and `configured` (false while the club has never saved it).",
    method: "GET",
    path: "/api/admin/booking-policies/group-discount",
    kind: "read",
    returns: ADMIN_GROUP_DISCOUNT_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "update_group_discount_policy",
    title: "Change the group discount policy",
    summary:
      "Officer: sets the group discount: on or off, the minimum group size (2 up to the lodge's capacity), summer only, and whether later edits earn it (omit to leave unchanged). Answers the saved policy.",
    method: "PUT",
    path: "/api/admin/booking-policies/group-discount",
    body: groupDiscountBodySchema,
    kind: "destructive",
    returns: ADMIN_GROUP_DISCOUNT_SAVED_CONNECTION_SHAPE,
    core: false,
  },

  // --- Adult-member hosting ----------------------------------------------------
  {
    id: "get_adult_member_hosting_policy",
    title: "Read the adult-member hosting policy",
    summary:
      "Officer: whether non-member guests must be covered by an adult member, for the club or, with `lodgeId`, one lodge: this scope's own mode, capacity mode, host scopes and `version`, `configured`, and under `effective` the rule actually in force, where it comes from and a plain-English description.",
    method: "GET",
    path: "/api/admin/booking-policies/adult-member-hosting",
    query: adminPolicyLodgeQuerySchema,
    kind: "read",
    returns: ADMIN_ADULT_MEMBER_HOSTING_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "update_adult_member_hosting_policy",
    title: "Change the adult-member hosting policy",
    summary:
      "Officer: sets the adult-member hosting rule for the club or, with `lodgeId`, one lodge. Send the `version` read by `get_adult_member_hosting_policy`; a changed policy is refused with 409. Affected upcoming bookings are re-checked against it, and this can email the booking owner of any that loses adult-member cover; those emails cannot be undone. Answers the saved policy and what is now in force.",
    method: "PUT",
    path: "/api/admin/booking-policies/adult-member-hosting",
    body: adultMemberHostingBodySchema,
    kind: "destructive",
    returns: ADMIN_ADULT_MEMBER_HOSTING_CONNECTION_SHAPE,
    core: false,
  },

  // --- Age groups ------------------------------------------------------------
  {
    id: "get_age_tier_settings",
    title: "Read the age group settings",
    summary:
      "Officer: the club's age groups in age order: tier, label, age range (`maxAge` null for the open-ended adult group), whether a subscription is needed to book, and whether a family-group request may create a member in it.",
    method: "GET",
    path: "/api/admin/age-tier-settings",
    kind: "read",
    returns: ADMIN_AGE_TIER_SETTINGS_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "update_age_tier_settings",
    title: "Change the age group settings",
    summary:
      "Officer: saves the whole set of age groups, which must cover every age from 0 with ADULT the only open-ended group. A group left out is removed, which is refused (409, with counts) while any member or current or upcoming guest is still in it. Answers the saved groups.",
    method: "PUT",
    path: "/api/admin/age-tier-settings",
    body: ageTierSettingsBodySchema,
    kind: "destructive",
    returns: ADMIN_AGE_TIER_SETTINGS_CONNECTION_SHAPE,
    core: false,
  },

  // --- Booking-request and member-guest settings -----------------------------
  {
    id: "get_booking_request_settings",
    title: "Read the booking request settings",
    summary:
      "Officer: the booking request settings: whether non-members are shown indicative prices, how many days a quote stays open and how many days before it lapses a reminder goes, and the attendee confirmation lead and reminder days.",
    method: "GET",
    path: "/api/admin/booking-requests/settings",
    kind: "read",
    returns: ADMIN_BOOKING_REQUEST_SETTINGS_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "update_booking_request_settings",
    title: "Change the booking request settings",
    summary:
      "Officer: saves all five booking request settings; the quote reminder lead must be shorter than the quote response window (days). Answers the saved settings.",
    method: "PUT",
    path: "/api/admin/booking-requests/settings",
    // The route also refuses a reminder lead not shorter than the window.
    body: bookingRequestSettingsBodySchema,
    kind: "destructive",
    returns: ADMIN_BOOKING_REQUEST_SETTINGS_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "get_member_guest_settings",
    title: "Read the member-guest settings",
    summary:
      "Officer: the member-guest policy: whether a member brought as a guest must approve first, how many days a pending hold lasts (with its allowed range), whether anyone booking can browse the member name list and whether children appear in it, when it was last saved, and whether this officer may change it (`access`).",
    method: "GET",
    path: "/api/admin/member-guest-settings",
    kind: "read",
    returns: ADMIN_MEMBER_GUEST_SETTINGS_CONNECTION_SHAPE,
    core: false,
  },
];
