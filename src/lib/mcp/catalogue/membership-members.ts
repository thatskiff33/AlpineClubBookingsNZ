/**
 * Members: finding a member, their record, family links and lodge access (Membership admin area, ALP-720).
 */
import { z } from "zod";

import {
  ADMIN_MEMBER_CONTACTABILITY_FILTERS,
  ADMIN_MEMBER_LIFECYCLE_FILTERS,
  ADMIN_MEMBER_SORT_FIELDS,
  ADMIN_MEMBER_SUBSCRIPTION_FILTERS,
  adminMembersQuerySchema,
  assignPartnerLinkSchema,
  dependentRouteParamsSchema,
  linkDependentSchema,
  memberLodgeAccessUpdateSchema,
  removePartnerLinkQuerySchema,
} from "@/lib/admin-membership-api/members";
import { ADMIN_LIST_DEFAULT_PAGE_SIZE, ADMIN_LIST_MAX_PAGE_SIZE, adminListPageQueryFields } from "@/lib/admin-list-page";
import { AGE_TIER_VALUES } from "@/lib/age-tier-schema";
import { AUDIT_TIMELINE_CATEGORY_OPTIONS } from "@/lib/audit-query";
import {
  DEPENDENT_LINKED_CONNECTION_SHAPE,
  DEPENDENT_UNLINKED_CONNECTION_SHAPE,
  MEMBER_AUDIT_TIMELINE_CONNECTION_SHAPE,
  MEMBER_DETAIL_CONNECTION_SHAPE,
  MEMBER_LIST_CONNECTION_SHAPE,
  MEMBER_LODGE_ACCESS_CONNECTION_SHAPE,
  MEMBER_PARTNER_LINK_CONNECTION_SHAPE,
  MEMBERSHIP_TYPE_LIST_CONNECTION_SHAPE,
  PARTNER_LINK_ASSIGNED_CONNECTION_SHAPE,
  PARTNER_LINK_REMOVED_CONNECTION_SHAPE,
} from "@/lib/connection-shapes/membership-members";
import {
  MEMBER_AUDIT_LOG_DEFAULT_PAGE_SIZE,
  MEMBER_AUDIT_LOG_MAX_PAGE_SIZE,
  memberAuditLogQuerySchema,
} from "@/lib/member-audit-log-query";
import { UNASSIGNED_MEMBERSHIP_TYPE_VALUE } from "@/lib/membership-type-filter";
import { routeIdParamsSchema } from "@/lib/route-id-params";

import type { McpAction } from "../catalogue";

/**
 * The member-list filters an app is offered: the route's own fields, picked
 * so the screen's picker internals, legacy aliases, sign-in and access-role
 * filters and the live Xero group lookup stay screen-only. The fixed-value
 * filters are enums here, so the app is told the route's values; sorting by
 * access role is screen-only too, as access roles are never sent.
 */
const MEMBER_LIST_APP_SORT_FIELDS = ADMIN_MEMBER_SORT_FIELDS.filter((field) => field !== "access");

const memberListActionQuerySchema = adminMembersQuerySchema.in
  .pick({
    q: true,
    sortBy: true,
    sortDir: true,
    lifecycleStatus: true,
    ageTier: true,
    membershipType: true,
    subscription: true,
    familyGroup: true,
    contactability: true,
    dependentLinkEligibleFor: true,
    parentLinkEligibleFor: true,
    partnerLinkEligibleFor: true,
  })
  .extend({
    // Numbers, as every other list action takes them; the route clamps the string it is sent.
    ...adminListPageQueryFields,
    sortBy: z.enum(MEMBER_LIST_APP_SORT_FIELDS).optional(),
    sortDir: z.enum(["asc", "desc"]).optional(),
    lifecycleStatus: z.enum(ADMIN_MEMBER_LIFECYCLE_FILTERS).optional(),
    subscription: z.enum(ADMIN_MEMBER_SUBSCRIPTION_FILTERS).optional(),
    contactability: z.enum(ADMIN_MEMBER_CONTACTABILITY_FILTERS).optional(),
  });

const quoted = (values: readonly string[]) => values.map((value) => `\`${value}\``).join(", ");

export const MEMBERSHIP_MEMBER_MCP_ACTIONS: readonly McpAction[] = [
  {
    id: "list_members",
    title: "Find members",
    summary: `Finds members, ${ADMIN_LIST_DEFAULT_PAGE_SIZE} a page (\`pageSize\` up to ${ADMIN_LIST_MAX_PAGE_SIZE}, \`page\` from 1), by surname unless \`sortBy\` is one of ${quoted(MEMBER_LIST_APP_SORT_FIELDS)} (\`sortDir\` \`asc\` or \`desc\`). \`q\` matches a name, an email address or the start of a member id. Archived members are left out unless \`lifecycleStatus\` (one of ${quoted(ADMIN_MEMBER_LIFECYCLE_FILTERS)}) is \`archived\` or \`all\`; the others narrow the list. \`ageTier\` is one of ${quoted(AGE_TIER_VALUES)}. \`membershipType\` is a type id from \`list_membership_types\`, or \`${UNASSIGNED_MEMBERSHIP_TYPE_VALUE}\` for members with no type this season. \`subscription\` filters on this season's subscription: one of ${quoted(ADMIN_MEMBER_SUBSCRIPTION_FILTERS)}. \`familyGroup\` is a family group id, \`any\` or \`none\`. \`contactability\` is one of ${quoted(ADMIN_MEMBER_CONTACTABILITY_FILTERS)}, for members the club cannot email. \`dependentLinkEligibleFor\`, \`parentLinkEligibleFor\` and \`partnerLinkEligibleFor\` each take a member id and list only who could be linked to that member as their dependant, their parent or their partner. Each member comes with their email, age tier, status, membership type and this season's subscription status; \`deletedAccount\` marks an erased account. \`get_member\` has the rest.`,
    method: "GET",
    path: "/api/admin/members",
    query: memberListActionQuerySchema,
    kind: "read",
    returns: MEMBER_LIST_CONNECTION_SHAPE,
    core: true,
  },
  {
    id: "get_member",
    title: "Read a member's record",
    summary:
      "One member's record as the officer's member page shows it: name, email, phone, age tier, status and membership dates, each season's membership type and subscription, family groups, recorded parents and dependants, whose address their club email goes to (`inheritEmailFrom`), whose address a dependant added under them would use (`dependentEmailSource`), and any open membership cancellation request. `id` is the member id from `list_members`. Date of birth, addresses, dietary needs, bookings and the audit history are not sent.",
    method: "GET",
    path: "/api/admin/members/[id]",
    params: routeIdParamsSchema,
    kind: "read",
    returns: MEMBER_DETAIL_CONNECTION_SHAPE,
    core: true,
  },
  {
    id: "list_member_activity",
    title: "List a member's account history",
    summary: `A member's account history as officers see it, newest first: when, what kind, the outcome and a one-line summary of each entry. \`category\` is one of ${quoted(AUDIT_TIMELINE_CATEGORY_OPTIONS.map(({ value }) => value))} (\`all\` when left out). \`page\` counts from 1; \`pageSize\` is at most ${MEMBER_AUDIT_LOG_MAX_PAGE_SIZE} (${MEMBER_AUDIT_LOG_DEFAULT_PAGE_SIZE} when left out).`,
    method: "GET",
    path: "/api/admin/members/[id]/audit-log",
    params: routeIdParamsSchema,
    query: memberAuditLogQuerySchema,
    kind: "read",
    returns: MEMBER_AUDIT_TIMELINE_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "get_member_lodge_access",
    title: "Read a member's lodge access",
    summary:
      "The lodges a member is limited to booking (`bookingRestrictions`; none means they can book every lodge) and the lodges a lodge-operational (kiosk) account is bound to (`staffGrants`), by lodge id. `lodgeAccess` lists both kinds together.",
    method: "GET",
    path: "/api/admin/members/[id]/lodge-access",
    params: routeIdParamsSchema,
    kind: "read",
    returns: MEMBER_LODGE_ACCESS_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "set_member_lodge_access",
    title: "Set a member's lodge access",
    summary:
      "Replaces a member's lodge access with exactly the lodges given. `bookingRestrictionLodgeIds` limits which lodges they can book (an empty list lets them book every lodge); `staffLodgeIds` binds a lodge-operational (kiosk) account to lodges. Both lists are always saved, so send the current ids from `get_member_lodge_access` for the one you are not changing. Refused if any lodge id is unknown.",
    method: "PUT",
    path: "/api/admin/members/[id]/lodge-access",
    params: routeIdParamsSchema,
    body: memberLodgeAccessUpdateSchema,
    kind: "destructive",
    returns: MEMBER_LODGE_ACCESS_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "get_member_partner_links",
    title: "Read a member's partner links",
    summary:
      "A member's confirmed partner (`confirmed`, at most one) and the pending partner requests they received (`pendingIncoming`) or sent (`pendingOutgoing`), each with the link id `remove_member_partner_link` takes. `assignedByAdmin` marks a link an officer recorded.",
    method: "GET",
    path: "/api/admin/members/[id]/partner-link",
    params: routeIdParamsSchema,
    kind: "read",
    returns: MEMBER_PARTNER_LINK_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "link_member_partner",
    title: "Record two members as partners",
    summary:
      "Records `partnerMemberId` as the confirmed partner of member `id` straight away, with no request for either to accept; a pending request between the two is confirmed instead. Both must be active adults, neither may already have a confirmed partner, and neither may be the other's recorded parent or child. Every other pending partner request either of them has is removed. Both members are always emailed that they are now partners (one email if they share an address).",
    method: "POST",
    path: "/api/admin/members/[id]/partner-link",
    params: routeIdParamsSchema,
    body: assignPartnerLinkSchema.omit({ notifyMember: true }),
    fixedBody: { notifyMember: true },
    kind: "destructive",
    returns: PARTNER_LINK_ASSIGNED_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "remove_member_partner_link",
    title: "Remove a partner link",
    summary:
      "Deletes partner link `linkId` (from `get_member_partner_links`), pending or confirmed, when it involves member `id`. Removing a confirmed partnership always emails both members (removing a pending request emails no one), and any future nights the pair were sharing a double bed go back to the allocation queue, with an alert to the club's admins. This cannot be undone: the link has to be made again.",
    method: "DELETE",
    path: "/api/admin/members/[id]/partner-link",
    params: routeIdParamsSchema,
    query: removePartnerLinkQuerySchema,
    fixedBody: { notifyMember: true },
    kind: "destructive",
    returns: PARTNER_LINK_REMOVED_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "link_member_dependant",
    title: "Link a dependant to a parent",
    summary:
      "Records member `memberId` as a dependant of member `id`: as their first recorded parent, or their second when they already have one. `inheritEmail` true sends their club email to the parent's address (or the nearest ancestor who can receive mail); `inheritEmailFromId` instead names which of their parents receives it, or an empty string for their own address; with `inheritEmail` false and no `inheritEmailFromId` their email setting is left as it is. `addToFamilyGroupIds` also adds them to family groups the parent belongs to. Refused when the parent is inactive, archived or an organisation account, when the member is archived, already has two parents or is the parent's ancestor or partner, or when the family would span more than four generations. Their sign-in is never turned off from an AI app. No one is emailed.",
    method: "POST",
    path: "/api/admin/members/[id]/dependents/link",
    params: routeIdParamsSchema,
    body: linkDependentSchema.omit({ disableLogin: true }),
    fixedBody: { disableLogin: false },
    kind: "destructive",
    returns: DEPENDENT_LINKED_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "unlink_member_dependant",
    title: "Unlink a dependant from a parent",
    summary:
      "Removes the link between parent `id` and dependant `dependentId`. If it was their first recorded parent and they have a second, the second becomes the first. When their club email went to the parent being removed it moves to the remaining parent (or the nearest ancestor who can receive mail), or back to their own address when no parent is left; `clearedEmailInheritance` says whether that happened. Refused when the member is not that parent's dependant. No one is emailed. Linking again does not restore the parents' order or the email choice.",
    method: "DELETE",
    path: "/api/admin/members/[id]/dependents/[dependentId]",
    params: dependentRouteParamsSchema,
    kind: "destructive",
    returns: DEPENDENT_UNLINKED_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "list_membership_types",
    title: "List membership types",
    summary:
      "The club's membership types, with the id `list_members` filters by, and whether each is active. `currentSeasonYear` is the season the club is in now.",
    method: "GET",
    path: "/api/admin/membership-types",
    kind: "read",
    returns: MEMBERSHIP_TYPE_LIST_CONNECTION_SHAPE,
    core: false,
  },
];
