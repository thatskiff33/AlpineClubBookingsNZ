/**
 * The club's membership structure (Membership admin area, ALP-720):
 * membership types, subscription categories and induction checklist
 * templates. Their reads of types and templates live with the members and
 * inductions actions (`list_membership_types`, `list_induction_templates`,
 * `get_induction_template`).
 *
 * Every change is `destructive` (owner decision, #5305 comment 7111359405):
 * a type's rules decide what its members pay and how they book, and a
 * template is what every new induction is signed against, so the app asks
 * the officer first.
 */
import {
  inductionTemplateActivateSchema,
  inductionTemplateCreateSchema,
  inductionTemplateUpdateSchema,
  membershipTypeCreateSchema,
  membershipTypeMergeSchema,
  membershipTypePatchSchema,
  membershipTypeReorderSchema,
  subscriptionCategoryCreateSchema,
  subscriptionCategoryPatchSchema,
} from "@/lib/admin-membership-api/config-structure";
import { INDUCTION_TEMPLATE_CONNECTION_SHAPE } from "@/lib/connection-shapes/membership-committee";
import {
  CONFIG_OK_CONNECTION_SHAPE,
  MEMBERSHIP_TYPE_CONNECTION_SHAPE,
  MEMBERSHIP_TYPE_MERGED_CONNECTION_SHAPE,
  MEMBERSHIP_TYPES_REORDERED_CONNECTION_SHAPE,
  SUBSCRIPTION_CATEGORY_CONNECTION_SHAPE,
  SUBSCRIPTION_CATEGORY_LIST_CONNECTION_SHAPE,
} from "@/lib/connection-shapes/membership-config";
import { routeIdParamsSchema } from "@/lib/route-id-params";

import type { McpAction } from "../catalogue";

const TYPE_RULES =
  "`bookingBehavior` sets the rate its members book at (or blocks booking); `subscriptionBehavior` whether they owe a subscription; `allowedAgeTiers` the age tiers it may be given to.";

export const MEMBERSHIP_CONFIG_STRUCTURE_MCP_ACTIONS: readonly McpAction[] = [
  // --- Membership types ---
  {
    id: "create_membership_type",
    title: "Add a membership type",
    summary: `Adds a membership type. ${TYPE_RULES} Names are unique, ignoring case.`,
    method: "POST",
    path: "/api/admin/membership-types",
    body: membershipTypeCreateSchema,
    kind: "destructive",
    returns: MEMBERSHIP_TYPE_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "update_membership_type",
    title: "Change a membership type",
    summary: `Changes the fields sent of the membership type \`id\` (from \`list_membership_types\`); one left out keeps its value. ${TYPE_RULES} A change applies to every member who holds the type. \`isActive\` false archives it. Refused when it would leave a member with an age tier the type no longer allows, and the built-in Full and Non-member types cannot be archived or given another booking rate.`,
    method: "PATCH",
    path: "/api/admin/membership-types/[id]",
    params: routeIdParamsSchema,
    body: membershipTypePatchSchema,
    kind: "destructive",
    returns: MEMBERSHIP_TYPE_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "delete_membership_type",
    title: "Delete a membership type",
    summary:
      "Deletes the membership type `id`. Refused for a built-in type, one any member holds in any season (merge it instead) and one with fee history (archive it with `update_membership_type` instead). Cannot be undone.",
    method: "DELETE",
    path: "/api/admin/membership-types/[id]",
    params: routeIdParamsSchema,
    kind: "destructive",
    returns: CONFIG_OK_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "merge_membership_type",
    title: "Merge a membership type into another",
    summary:
      "Moves every member holding the membership type `id`, in every season, to the active type `targetId`, then deletes `id`. Refused for a built-in type, one with fee history, and when `targetId` does not allow an age tier those members hold. Cannot be undone.",
    method: "POST",
    path: "/api/admin/membership-types/[id]/merge",
    params: routeIdParamsSchema,
    body: membershipTypeMergeSchema,
    kind: "destructive",
    returns: MEMBERSHIP_TYPE_MERGED_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "reorder_membership_types",
    title: "Reorder the membership types",
    summary:
      "Puts the membership types in the order of `orderedIds` (each id once, from `list_membership_types`), the order the club's screens list them in. Answers with every type in its new order.",
    method: "POST",
    path: "/api/admin/membership-types/reorder",
    body: membershipTypeReorderSchema,
    kind: "destructive",
    returns: MEMBERSHIP_TYPES_REORDERED_CONNECTION_SHAPE,
    core: false,
  },
  // --- Subscription categories ---
  {
    id: "list_subscription_categories",
    title: "List subscription categories",
    summary:
      "The club's subscription categories in order, with how many members are assigned each and how many fees name it. No prices.",
    method: "GET",
    path: "/api/admin/subscription-categories",
    kind: "read",
    returns: SUBSCRIPTION_CATEGORY_LIST_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "create_subscription_category",
    title: "Add a subscription category",
    summary: "Adds a subscription category. Names are unique, ignoring case. Its fees are set on the website.",
    method: "POST",
    path: "/api/admin/subscription-categories",
    body: subscriptionCategoryCreateSchema,
    kind: "destructive",
    returns: SUBSCRIPTION_CATEGORY_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "update_subscription_category",
    title: "Change a subscription category",
    summary:
      "Changes the fields sent of the subscription category `id`; one left out keeps its value. `isActive` false archives it. The built-in Individual category cannot be archived.",
    method: "PATCH",
    path: "/api/admin/subscription-categories/[id]",
    params: routeIdParamsSchema,
    body: subscriptionCategoryPatchSchema,
    kind: "destructive",
    returns: SUBSCRIPTION_CATEGORY_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "delete_subscription_category",
    title: "Delete a subscription category",
    summary:
      "Deletes the subscription category `id`. Refused for the built-in Individual category, one any member is assigned and one with fee history (archive it instead). Cannot be undone.",
    method: "DELETE",
    path: "/api/admin/subscription-categories/[id]",
    params: routeIdParamsSchema,
    kind: "destructive",
    returns: CONFIG_OK_CONNECTION_SHAPE,
    core: false,
  },
  // --- Induction checklist templates ---
  {
    id: "create_induction_template",
    title: "Add an induction checklist",
    summary:
      "Adds an inactive induction checklist template, empty or copied from the template `cloneFromId` (its `kind` too, unless `kind` is sent). Fill it with `update_induction_template`, then make it the one in use with `activate_induction_template`.",
    method: "POST",
    path: "/api/admin/induction-templates",
    body: inductionTemplateCreateSchema,
    kind: "destructive",
    returns: INDUCTION_TEMPLATE_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "update_induction_template",
    title: "Rewrite an induction checklist",
    summary:
      "Replaces every section and item of the template `id` with `sections`, in the order sent; read it with `get_induction_template` first and send it whole. `name`, `version` and `kind` change only when sent. Refused once any induction has used the template: copy it as a new version instead.",
    method: "PUT",
    path: "/api/admin/induction-templates/[id]",
    params: routeIdParamsSchema,
    body: inductionTemplateUpdateSchema,
    kind: "destructive",
    returns: INDUCTION_TEMPLATE_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "activate_induction_template",
    title: "Put an induction checklist in use",
    summary:
      "Makes the template `id` the active one for its kind, so new inductions of that kind are signed against it; the kind's previous active template stops being used.",
    method: "PATCH",
    path: "/api/admin/induction-templates/[id]",
    params: routeIdParamsSchema,
    body: inductionTemplateActivateSchema.omit({ isActive: true }),
    fixedBody: { isActive: true },
    kind: "destructive",
    returns: CONFIG_OK_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "delete_induction_template",
    title: "Delete an induction checklist",
    summary:
      "Deletes the template `id`. Refused for the active template and for one any induction has used. Cannot be undone.",
    method: "DELETE",
    path: "/api/admin/induction-templates/[id]",
    params: routeIdParamsSchema,
    kind: "destructive",
    returns: CONFIG_OK_CONNECTION_SHAPE,
    core: false,
  },
];
