/**
 * Committee roles and who holds them, and inductions (Membership admin area, ALP-720).
 *
 * Overriding an induction to complete is never offered: it vouches for the
 * member's safety induction in place of the sign-offs, which an officer does
 * on the website. Its `VOID` and `REASSIGN_SIGNERS` siblings on the same
 * route are pinned with `fixedBody`. Induction templates are read here and
 * written in `membership-config-structure.ts`.
 */
import {
  committeeAssignmentCreateSchema,
  committeeAssignmentListQuerySchema,
  committeeAssignmentPatchSchema,
} from "@/lib/admin-membership-api/committee";
import {
  createInductionSchema,
  INDUCTION_REGISTER_LIMIT,
  inductionListQuerySchema,
  MAX_ASSIGNED_INDUCTION_SIGNERS,
  reassignInductionSignersSchema,
  voidInductionSchema,
} from "@/lib/admin-membership-api/inductions";
import {
  COMMITTEE_ASSIGNMENT_CONNECTION_SHAPE,
  COMMITTEE_ASSIGNMENT_LIST_CONNECTION_SHAPE,
  COMMITTEE_ROLE_CONNECTION_SHAPE,
  COMMITTEE_ROLE_DELETED_CONNECTION_SHAPE,
  COMMITTEE_ROLE_LIST_CONNECTION_SHAPE,
  INDUCTION_CREATED_CONNECTION_SHAPE,
  INDUCTION_DETAIL_CONNECTION_SHAPE,
  INDUCTION_LIST_CONNECTION_SHAPE,
  INDUCTION_TEMPLATE_DETAIL_CONNECTION_SHAPE,
  INDUCTION_TEMPLATE_LIST_CONNECTION_SHAPE,
  INDUCTION_UPDATED_CONNECTION_SHAPE,
} from "@/lib/connection-shapes/membership-committee";
import { committeeRoleCreateSchema, committeeRolePatchSchema } from "@/lib/forms/committee-role-schema";
import { routeIdParamsSchema } from "@/lib/route-id-params";

import type { McpAction } from "../catalogue";

const PUBLIC_LISTING_HELP =
  "`published` lists the holder on the club's public committee page, `showPhone` adds their phone number there and `contactable` lets visitors message them; `contactEmailMode` picks which address those messages reach: the role's (ROLE), the member's own (MEMBER) or `contactEmailOverride` (CUSTOM).";

export const MEMBERSHIP_COMMITTEE_MCP_ACTIONS: readonly McpAction[] = [
  {
    id: "list_committee_roles",
    title: "List committee roles",
    summary:
      "The club's committee roles, archived ones included (`isActive` false), in display order, with how many assignments each has.",
    method: "GET",
    path: "/api/admin/committee/roles",
    kind: "read",
    returns: COMMITTEE_ROLE_LIST_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "create_committee_role",
    title: "Add a committee role",
    summary:
      "Adds a committee role such as Treasurer, active unless `isActive` is false, placed last unless `sortOrder` is given. `contactEmail` is the role's own address.",
    method: "POST",
    path: "/api/admin/committee/roles",
    body: committeeRoleCreateSchema,
    kind: "write",
    returns: COMMITTEE_ROLE_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "update_committee_role",
    title: "Edit or archive a committee role",
    summary:
      "Changes a committee role's fields; a field left out keeps its value. `contactEmail` is where the public contact form sends messages for the role, and `isActive` false archives the role, which stops those messages; true restores it.",
    method: "PATCH",
    path: "/api/admin/committee/roles/[id]",
    params: routeIdParamsSchema,
    body: committeeRolePatchSchema,
    // Destructive: it can redirect or stop other people's messages to the role.
    kind: "destructive",
    returns: COMMITTEE_ROLE_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "delete_committee_role",
    title: "Delete a committee role",
    summary:
      "Deletes a committee role that has never had an assignment; one that has is refused and can be archived with `update_committee_role` instead. This cannot be undone.",
    method: "DELETE",
    path: "/api/admin/committee/roles/[id]",
    params: routeIdParamsSchema,
    kind: "destructive",
    returns: COMMITTEE_ROLE_DELETED_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "list_committee_assignments",
    title: "List who holds committee roles",
    summary:
      'Who holds each committee role, with their email and phone and how they are listed publicly. Narrow by `memberId` or `committeeRoleId`; `includeInactive` "1" adds deactivated assignments.',
    method: "GET",
    path: "/api/admin/committee/assignments",
    query: committeeAssignmentListQuerySchema,
    kind: "read",
    returns: COMMITTEE_ASSIGNMENT_LIST_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "assign_committee_role",
    title: "Give a member a committee role",
    summary: `Makes member \`memberId\` a holder of committee role \`committeeRoleId\` (from \`list_committee_roles\`). If they already hold it, every field is replaced, and a field left out goes back to its default: not published, phone hidden, not contactable, the role's email, active. ${PUBLIC_LISTING_HELP} An archived role cannot take an active holder.`,
    method: "POST",
    path: "/api/admin/committee/assignments",
    body: committeeAssignmentCreateSchema,
    kind: "destructive",
    returns: COMMITTEE_ASSIGNMENT_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "update_committee_assignment",
    title: "Change a committee assignment",
    summary: `Changes one committee assignment (from \`list_committee_assignments\`); a field left out keeps its value. ${PUBLIC_LISTING_HELP} \`isActive\` true restores a deactivated assignment.`,
    method: "PATCH",
    path: "/api/admin/committee/assignments/[id]",
    params: routeIdParamsSchema,
    body: committeeAssignmentPatchSchema,
    kind: "destructive",
    returns: COMMITTEE_ASSIGNMENT_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "deactivate_committee_assignment",
    title: "Take a member off a committee role",
    summary:
      "Deactivates one committee assignment and removes it from the public committee page, turning off its published, phone and contactable settings. `update_committee_assignment` can restore it, but those settings have to be set again.",
    method: "DELETE",
    path: "/api/admin/committee/assignments/[id]",
    params: routeIdParamsSchema,
    kind: "destructive",
    returns: COMMITTEE_ASSIGNMENT_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "list_inductions",
    title: "List member inductions",
    summary:
      `The induction register, newest first and at most ${INDUCTION_REGISTER_LIMIT}: each induction's member, kind, status, sign-off count and assigned signers. Narrow by \`status\`, \`kind\`, or \`search\` on the member's name or email.`,
    method: "GET",
    path: "/api/admin/inductions",
    query: inductionListQuerySchema,
    kind: "read",
    returns: INDUCTION_LIST_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "get_admin_induction",
    title: "Show a member induction",
    summary:
      "One induction: its checklist, the sign-offs recorded so far with any comments, its assigned signers, and the declaration each signer accepts.",
    method: "GET",
    path: "/api/admin/inductions/[id]",
    params: routeIdParamsSchema,
    kind: "read",
    returns: INDUCTION_DETAIL_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "create_induction",
    title: "Start a member induction",
    summary: `Starts an induction for member \`memberId\` against the active checklist for its \`kind\` (a re-induction when left out); refused when no active checklist of that kind exists. \`signerMemberIds\` (at most ${MAX_ASSIGNED_INDUCTION_SIGNERS}, never the member) may sign it off, and each is emailed asking them to.`,
    method: "POST",
    path: "/api/admin/inductions",
    body: createInductionSchema,
    kind: "destructive",
    returns: INDUCTION_CREATED_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "reassign_induction_signers",
    title: "Change an induction's signers",
    summary: `Replaces the members assigned to sign off an induction that is not voided with \`signerMemberIds\` (at most ${MAX_ASSIGNED_INDUCTION_SIGNERS}); an empty list removes them all. Nobody is emailed.`,
    method: "PATCH",
    path: "/api/admin/inductions/[id]",
    params: routeIdParamsSchema,
    body: reassignInductionSignersSchema.omit({ action: true }),
    fixedBody: { action: "REASSIGN_SIGNERS" },
    kind: "destructive",
    returns: INDUCTION_UPDATED_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "void_induction",
    title: "Void a member induction",
    summary:
      "Voids an induction, completed or not, recording `reason`. A voided induction cannot be signed, reassigned or reopened; start a new one instead.",
    method: "PATCH",
    path: "/api/admin/inductions/[id]",
    params: routeIdParamsSchema,
    body: voidInductionSchema.omit({ action: true }),
    fixedBody: { action: "VOID" },
    kind: "destructive",
    returns: INDUCTION_UPDATED_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "list_induction_templates",
    title: "List induction checklists",
    summary:
      "The club's induction checklist templates, newest first: kind, version, whether each is the active one for its kind, and how many inductions used it.",
    method: "GET",
    path: "/api/admin/induction-templates",
    kind: "read",
    returns: INDUCTION_TEMPLATE_LIST_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "get_induction_template",
    title: "Show an induction checklist",
    summary: "One induction checklist template with its sections and items, and whether any induction has used it.",
    method: "GET",
    path: "/api/admin/induction-templates/[id]",
    params: routeIdParamsSchema,
    kind: "read",
    returns: INDUCTION_TEMPLATE_DETAIL_CONNECTION_SHAPE,
    core: false,
  },
];
