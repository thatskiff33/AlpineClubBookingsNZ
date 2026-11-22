/**
 * The member routes' request schemas (`/api/admin/members/[id]/**`), shared
 * with the AI app actions that call them (ALP-720, `INV-SSOT`): the app is
 * described exactly the fields the route enforces. The member list's query
 * stays in `admin-members-service.ts` (`adminMembersQuerySchema`), beside the
 * listing it drives.
 */
import { z } from "zod";

import { memberAuditLogQuerySchema } from "@/lib/member-audit-log-query";
import { recordIdParamsSchema } from "@/lib/route-id-params";

/**
 * `GET /api/admin/members/[id]/audit-log`: the same query as a member's own
 * timeline (`GET /api/member/audit-log`); the route also refuses a category
 * that is not an audit timeline category.
 */
export const adminMemberAuditLogQuerySchema = memberAuditLogQuerySchema;

/** `PUT /api/admin/members/[id]/lodge-access`: both lists are always replaced. */
export const memberLodgeAccessUpdateSchema = z
  .object({
    bookingRestrictionLodgeIds: z.array(z.string().min(1)).max(50),
    staffLodgeIds: z.array(z.string().min(1)).max(50),
  })
  .strict();

/** `POST /api/admin/members/[id]/partner-link`: absent `notifyMember` emails both members. */
export const assignPartnerLinkSchema = z.object({
  partnerMemberId: z.string().min(1, "Partner member is required"),
  // #1769a: absent/undefined = notify (default), false = suppress the emails.
  notifyMember: z.boolean().optional(),
});

/**
 * `DELETE /api/admin/members/[id]/partner-link`: the link to remove. The
 * screen sends it as `?id=`, which an AI app cannot (the member's `id` is the
 * address segment), so the route also reads `?linkId=`.
 */
export const removePartnerLinkQuerySchema = z.object({
  linkId: z.string().trim().min(1),
});

/** `DELETE /api/admin/members/[id]/partner-link`: the optional body. */
export const removePartnerLinkBodySchema = z.object({
  notifyMember: z.boolean().optional(),
});

/** `POST /api/admin/members/[id]/dependents/link`. */
export const linkDependentSchema = z.object({
  memberId: z.string().min(1, "Member is required"),
  inheritEmail: z.boolean(),
  disableLogin: z.boolean(),
  inheritEmailFromId: z.string().optional().nullable().or(z.literal("")),
  addToFamilyGroupIds: z.array(z.string()).default([]),
});

/** `DELETE /api/admin/members/[id]/dependents/[dependentId]`: the parent, then the dependant. */
export const dependentRouteParamsSchema = recordIdParamsSchema.extend({
  dependentId: z.string().min(1),
});
