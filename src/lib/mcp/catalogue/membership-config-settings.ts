/**
 * Membership settings (Membership admin area, ALP-720): the message board,
 * optional member fields, cancellation, nomination and subscription lockout
 * settings an officer changes on the Membership setup screens.
 *
 * Every change is `destructive` (owner decision, #5305 comment 7111359405):
 * each one changes how the club treats every member, so the app asks the
 * officer first. The lockout settings' subscription-liability rule pair also
 * needs Finance edit; the route refuses it otherwise, for the app as for the
 * browser, so the entry carries the route's own guard and adds none.
 */
import {
  CLUB_POST_RETENTION_DAYS,
  clubPostRetentionUpdateSchema,
  liabilityImpactQuerySchema,
  memberFieldsUpdateSchema,
  membershipCancellationSettingsSchema,
  membershipLockoutSettingsSchema,
  membershipNominationSettingsSchema,
} from "@/lib/admin-membership-api/config-settings";
import {
  CLUB_POST_SETTINGS_CONNECTION_SHAPE,
  LIABILITY_IMPACT_CONNECTION_SHAPE,
  MEMBER_FIELDS_SETTINGS_CONNECTION_SHAPE,
  MEMBERSHIP_CANCELLATION_SETTINGS_CONNECTION_SHAPE,
  MEMBERSHIP_LOCKOUT_SETTINGS_CONNECTION_SHAPE,
  MEMBERSHIP_LOCKOUT_SETTINGS_SAVE_CONNECTION_SHAPE,
  MEMBERSHIP_NOMINATION_SETTINGS_CONNECTION_SHAPE,
} from "@/lib/connection-shapes/membership-config";

import type { McpAction } from "../catalogue";

import { MESSAGE_BOARD_OFF } from "./membership-notices";

const LIABILITY_RULE_NEEDS_FINANCE =
  "Changing `requiredTypeAgeRule` or `liabilityAgeSource` (the subscription-liability rule, sent together) also needs Finance edit access; without it the save is refused (403) and nothing changes. Run `preview_subscription_liability_rule` first to see who it changes; the answer's `clearedStaleRecords` says how many \"Not required\" records the save reset (null when the club has no rule chosen, so no clear-up ran).";

export const MEMBERSHIP_CONFIG_SETTINGS_MCP_ACTIONS: readonly McpAction[] = [
  {
    id: "get_message_board_settings",
    title: "Show the message board settings",
    summary: `How long the club message board keeps posts (\`retentionDays\`, 0 keeps everything), when the last clean-up ran and how many it deleted, and \`beyondRetention\`: how many posts the current period would delete. ${MESSAGE_BOARD_OFF}`,
    method: "GET",
    path: "/api/admin/club-posts/settings",
    kind: "read",
    returns: CLUB_POST_SETTINGS_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "update_message_board_settings",
    title: "Change how long message board posts are kept",
    summary: `Sets \`retentionDays\` to one of ${CLUB_POST_RETENTION_DAYS.join(", ")} (0 keeps everything). The scheduled clean-up then permanently deletes members' posts older than that, so check \`beyondRetention\` from \`get_message_board_settings\` with the officer first. ${MESSAGE_BOARD_OFF}`,
    method: "PUT",
    path: "/api/admin/club-posts/settings",
    body: clubPostRetentionUpdateSchema,
    kind: "destructive",
    returns: CLUB_POST_SETTINGS_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "get_member_field_settings",
    title: "Show which optional member fields are collected",
    summary:
      "Whether the club asks members for a title, gender, occupation and dietary requirements on the member record and at onboarding.",
    method: "GET",
    path: "/api/admin/member-fields",
    kind: "read",
    returns: MEMBER_FIELDS_SETTINGS_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "update_member_field_settings",
    title: "Change which optional member fields are collected",
    summary:
      "Turns each optional member field on or off. Send every field in `settings`, as `get_member_field_settings` returns them: one left out is refused. Dietary requirements are health information; turning them on means the club collects it from every member.",
    method: "PUT",
    path: "/api/admin/member-fields",
    body: memberFieldsUpdateSchema,
    kind: "destructive",
    returns: MEMBER_FIELDS_SETTINGS_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "get_membership_cancellation_settings",
    title: "Show the membership cancellation settings",
    summary:
      "The warning members see before asking to cancel a membership, how they rejoin, and whether a cancelled member's Xero contact is archived, and the Xero contact groups a cancelled member is added to.",
    method: "GET",
    path: "/api/admin/membership-cancellation-settings",
    kind: "read",
    returns: MEMBERSHIP_CANCELLATION_SETTINGS_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "update_membership_cancellation_settings",
    title: "Change the membership cancellation settings",
    summary:
      "Saves the whole setting. A field left out is saved empty or off, not kept: read `get_membership_cancellation_settings` first and send every field, changing only what the officer asked. `xeroContactGroups` lists at most 20 groups by `groupId`.",
    method: "PUT",
    path: "/api/admin/membership-cancellation-settings",
    body: membershipCancellationSettingsSchema,
    kind: "destructive",
    returns: MEMBERSHIP_CANCELLATION_SETTINGS_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "get_membership_nomination_settings",
    title: "Show the nomination settings",
    summary:
      "Whether applicants need nominators and how many sign-offs, the membership months and lodge nights a nominator needs, and the date the rule took effect (members who joined before it are not held to it).",
    method: "GET",
    path: "/api/admin/membership-nomination-settings",
    kind: "read",
    returns: MEMBERSHIP_NOMINATION_SETTINGS_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "update_membership_nomination_settings",
    title: "Change the nomination settings",
    summary:
      "Changes the fields sent; one left out keeps its value. Turning `gateEnabled` on with no `gateEffectiveFrom` sets it to now, so existing members are not held to the rule.",
    method: "PUT",
    path: "/api/admin/membership-nomination-settings",
    body: membershipNominationSettingsSchema,
    kind: "destructive",
    returns: MEMBERSHIP_NOMINATION_SETTINGS_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "get_membership_lockout_settings",
    title: "Show the subscription lockout settings",
    summary:
      "How the club treats a member whose subscription is unpaid when they book (`mode`), the membership financial year and how it is set, how paid subscriptions are detected, and the club's subscription-liability rule.",
    method: "GET",
    path: "/api/admin/membership-lockout-settings",
    kind: "read",
    returns: MEMBERSHIP_LOCKOUT_SETTINGS_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "update_membership_lockout_settings",
    title: "Change the subscription lockout settings",
    summary: `Changes the fields sent; one left out keeps its value. \`mode\` decides whether a member with an unpaid subscription can book, at what price. ${LIABILITY_RULE_NEEDS_FINANCE}`,
    method: "PUT",
    path: "/api/admin/membership-lockout-settings",
    body: membershipLockoutSettingsSchema,
    kind: "destructive",
    returns: MEMBERSHIP_LOCKOUT_SETTINGS_SAVE_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "preview_subscription_liability_rule",
    title: "Preview a subscription-liability rule",
    summary:
      "Who a proposed subscription-liability rule would change this season, by name: who would newly owe a subscription, who would no longer owe one, and members whose season subscription record says \"Not required\" but who would owe, whose record saving the rule resets (`inBillingPopulation` false: inactive or archived, so reset but not invoiced unless made active again). Send both `requiredTypeAgeRule` and `liabilityAgeSource`. Changes nothing.",
    method: "GET",
    path: "/api/admin/membership-lockout-settings/liability-impact",
    query: liabilityImpactQuerySchema,
    kind: "read",
    returns: LIABILITY_IMPACT_CONNECTION_SHAPE,
    core: false,
  },
];
