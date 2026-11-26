/**
 * Family groups, their requests and partner invites, and suggested groups (Membership admin area, ALP-720).
 */
import { ADMIN_FAMILY_GROUP_MAX_MEMBERS } from "@/lib/admin-family-group-create";
import {
  createFamilyGroupFromSuggestionSchema,
  createFamilyGroupSchema,
  FAMILY_GROUP_MEMBER_SEARCH_LIMIT,
  FAMILY_SUGGESTION_GROUP_NAME_MAX_LENGTH,
  familyGroupMemberSearchQuerySchema,
  hideFamilySuggestionSchema,
  reviewFamilyGroupRequestSchema,
  revokePartnerInviteQuerySchema,
  updateFamilyGroupSchema,
} from "@/lib/admin-membership-api/family-groups";
import {
  FAMILY_GROUP_CREATED_CONNECTION_SHAPE,
  FAMILY_GROUP_DETAIL_CONNECTION_SHAPE,
  FAMILY_GROUP_LIST_CONNECTION_SHAPE,
  FAMILY_GROUP_MEMBER_SEARCH_CONNECTION_SHAPE,
  FAMILY_GROUP_REQUEST_LIST_CONNECTION_SHAPE,
  FAMILY_GROUP_REQUEST_REVIEWED_CONNECTION_SHAPE,
  FAMILY_GROUP_SUCCESS_CONNECTION_SHAPE,
  FAMILY_GROUP_UPDATED_CONNECTION_SHAPE,
  FAMILY_SUGGESTION_GROUP_CREATED_CONNECTION_SHAPE,
  FAMILY_SUGGESTION_HIDDEN_CONNECTION_SHAPE,
  FAMILY_SUGGESTION_LIST_CONNECTION_SHAPE,
  FAMILY_SUGGESTIONS_RESET_CONNECTION_SHAPE,
  PARTNER_INVITE_LIST_CONNECTION_SHAPE,
} from "@/lib/connection-shapes/membership-family-groups";
import { routeIdParamsSchema } from "@/lib/route-id-params";

import type { McpAction } from "../catalogue";

export const MEMBERSHIP_FAMILY_GROUP_MCP_ACTIONS: readonly McpAction[] = [
  {
    id: "list_family_groups",
    title: "List family groups",
    summary:
      "Every family group, by name, with its members (archived members left out), each as an id, a name, an age tier and whether they are active, plus how many members are inactive and how many requests await review. No email addresses or ages. It answers every group at once, so a large club's answer can be cut short: to find one person's group, search with `list_members` (`q`; each member comes with their family groups) and read it with `get_family_group`, and `list_members` with `familyGroup` lists one group's members a page at a time.",
    method: "GET",
    path: "/api/admin/family-groups",
    kind: "read",
    returns: FAMILY_GROUP_LIST_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "get_family_group",
    title: "Read a family group",
    summary:
      "One family group by `id` (from `list_family_groups`), with its members (archived members left out), each as an id, a name, an age tier and whether they are active.",
    method: "GET",
    path: "/api/admin/family-groups/[id]",
    params: routeIdParamsSchema,
    kind: "read",
    returns: FAMILY_GROUP_DETAIL_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "create_family_group",
    title: "Create a family group",
    summary: `Creates a family group called \`name\` with the members in \`memberIds\` (1 to ${ADMIN_FAMILY_GROUP_MAX_MEMBERS}; a repeated id counts once). Refused if any member does not exist or is archived. It does not check whether a member already belongs to another group. Nobody is emailed.`,
    method: "POST",
    path: "/api/admin/family-groups",
    body: createFamilyGroupSchema,
    kind: "destructive",
    returns: FAMILY_GROUP_CREATED_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "update_family_group",
    title: "Rename a family group or change its members",
    summary: `Renames a family group (\`name\`), replaces its member list (\`memberIds\`, 1 to ${ADMIN_FAMILY_GROUP_MAX_MEMBERS}), or both; a field left out is unchanged. \`memberIds\` is the whole new list, not additions: every member left out is removed, including archived members, which \`get_family_group\` does not list, and a removed member who chose this group as their billing family loses that choice. Refused if any listed member does not exist or is archived. Nobody is emailed.`,
    method: "PUT",
    path: "/api/admin/family-groups/[id]",
    params: routeIdParamsSchema,
    body: updateFamilyGroupSchema,
    kind: "destructive",
    returns: FAMILY_GROUP_UPDATED_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "delete_family_group",
    title: "Delete a family group",
    summary:
      "Deletes a family group with its memberships, its requests and its outstanding partner invitations, and clears it as any member's billing family. The members themselves are kept. Nobody is emailed. This cannot be undone.",
    method: "DELETE",
    path: "/api/admin/family-groups/[id]",
    params: routeIdParamsSchema,
    kind: "destructive",
    returns: FAMILY_GROUP_SUCCESS_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "search_family_group_members",
    title: "Find members for a family group",
    summary:
      `Up to ${FAMILY_GROUP_MEMBER_SEARCH_LIMIT} active, non-archived members whose first name, last name or email address contains \`q\` (at least 2 characters), with \`total\` the full number of matches. \`ageTierIn\` limits the search to a comma-separated list of age tiers, such as "INFANT,CHILD,YOUTH" when choosing a child. Give \`prospectiveParentMemberId\` (a child request's requester) to have \`ineligibleReason\` set on any member who is that person's partner and so cannot be linked as their child. Each member carries their email address, to tell similar records apart, and their recorded parents (\`parentLinks\`), whose ids are the choices for \`inheritEmailFromId\` when approving a child request. No ages.`,
    method: "GET",
    path: "/api/admin/family-groups/member-search",
    query: familyGroupMemberSearchQuerySchema,
    kind: "read",
    returns: FAMILY_GROUP_MEMBER_SEARCH_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "list_partner_invites",
    title: "List partner invitations",
    summary:
      "Outstanding partner invitations (not yet accepted and not expired), newest first: the email address each was sent to, the family group, who sent it, and when it expires. Never the invitation link.",
    method: "GET",
    path: "/api/admin/family-groups/partner-invites",
    kind: "read",
    returns: PARTNER_INVITE_LIST_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "revoke_partner_invite",
    title: "Revoke a partner invitation",
    summary:
      "Revokes one outstanding partner invitation by `id` (from `list_partner_invites`), so its link stops working; a new invitation would have to be sent. Refused if it has already been accepted or revoked. Nobody is emailed.",
    method: "DELETE",
    path: "/api/admin/family-groups/partner-invites",
    query: revokePartnerInviteQuerySchema,
    kind: "destructive",
    returns: FAMILY_GROUP_SUCCESS_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "list_family_group_requests",
    title: "List family group requests",
    summary:
      "Family group requests awaiting review, oldest first, by `type`: JOIN_REQUEST (join a group), CHILD_REQUEST (add an infant, child or youth), ADULT_REQUEST (add an adult who shares the requester's email address), REMOVAL_REQUEST (remove a member) and GROUP_CREATE (create a new group). Each carries the requester, the group and its current members, the names the requester gave (and an adult's email address), their notes, the age tier their child would have (`requestedAgeTier`), whether a new member may be created from it (`canCreateMemberFromRequest`), and for child and adult requests the existing members who may be the same person (`matchingMembers`, with their recorded parents). No dates of birth or ages.",
    method: "GET",
    path: "/api/admin/family-groups/requests",
    kind: "read",
    returns: FAMILY_GROUP_REQUEST_LIST_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "review_family_group_request",
    title: "Approve or reject a family group request",
    summary:
      'Approves or rejects one pending request from `list_family_group_requests` (`requestId`; `action` "approve" or "reject"). A reviewed request cannot be reviewed again. Approving a JOIN_REQUEST adds the requester to the group; a REMOVAL_REQUEST removes the member and clears the group as their billing family. A CHILD_REQUEST needs `linkedMemberId` (an existing active infant, child or youth, for example from `matchingMembers`) or `createNewMember: true` (only where `canCreateMemberFromRequest` is true; the new child gets the requester\'s email address, phone and addresses and cannot sign in), never both; the child joins the group with the requester recorded as a parent. `inheritEmailFromId` says whose mailbox the child\'s club email goes to: leave it out for the requester, give one of the child\'s parents\' ids, or "" for the child\'s own address. An ADULT_REQUEST needs `linkedMemberId` (an active adult who cannot sign in) or `createNewMember: true` (creates a non-login adult from the request). Approving a GROUP_CREATE makes the requester its first member and, where a partner was named and can join, files an invitation and emails the partner; rejecting one also rejects the requester\'s pending child requests for that group and revokes its outstanding partner invitations. Child and group creation decisions email the requester unless `notifyMember` is false, with `rejectionReason` in a rejection email; other decisions email nobody. ADULT_INVITE requests are refused.',
    method: "PUT",
    path: "/api/admin/family-groups/requests",
    body: reviewFamilyGroupRequestSchema,
    kind: "destructive",
    returns: FAMILY_GROUP_REQUEST_REVIEWED_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "list_family_suggestions",
    title: "List suggested family groups",
    summary:
      "Suggested family groups among active members who are in no family group: members who share an email address first (`score` 10), then members who share a last name (`score` 3). Suggestions an officer hid are left out; `hiddenCount` says how many. Each member carries their email address, which is how the strongest suggestions are found, and `reason` can name the shared address. No ages.",
    method: "GET",
    path: "/api/admin/family-suggestions",
    kind: "read",
    returns: FAMILY_SUGGESTION_LIST_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "create_family_group_from_suggestion",
    title: "Create a family group from a suggestion",
    summary:
      `Creates a family group called \`name\` (up to ${FAMILY_SUGGESTION_GROUP_NAME_MAX_LENGTH} characters) with the members in \`memberIds\` (at least 2, each once), usually a suggestion's \`suggestedName\` and members. Refused if any member does not exist or is inactive. Nobody is emailed.`,
    method: "POST",
    path: "/api/admin/family-suggestions",
    body: createFamilyGroupFromSuggestionSchema,
    kind: "destructive",
    returns: FAMILY_SUGGESTION_GROUP_CREATED_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "hide_family_suggestion",
    title: "Hide a suggested family group",
    summary:
      "Hides the suggestion made of exactly the members in `memberIds` (a suggestion's members), for every officer, until `reset_hidden_family_suggestions`. Refused if any member does not exist or is inactive.",
    method: "POST",
    path: "/api/admin/family-suggestions/hide",
    body: hideFamilySuggestionSchema,
    kind: "write",
    returns: FAMILY_SUGGESTION_HIDDEN_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "reset_hidden_family_suggestions",
    title: "Show hidden family suggestions again",
    summary:
      "Unhides every hidden family suggestion, for every officer, and answers with how many were unhidden.",
    method: "POST",
    path: "/api/admin/family-suggestions/reset",
    kind: "destructive",
    returns: FAMILY_SUGGESTIONS_RESET_CONNECTION_SHAPE,
    core: false,
  },
];
