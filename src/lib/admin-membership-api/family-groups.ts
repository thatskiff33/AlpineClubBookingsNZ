/**
 * The family group and family suggestion routes' request schemas
 * (`/api/admin/family-groups/**`, `/api/admin/family-suggestions/**`), shared
 * with the AI app actions that call them (ALP-720, `INV-SSOT`): the app is
 * described exactly the fields the route enforces.
 * The member search query and the request review body live here rather than
 * beside their services, so the catalogue can describe them without loading
 * the database client.
 */
import { z } from "zod";

import { ageTierEnum } from "@/lib/age-tier-schema";

import {
  ADMIN_FAMILY_GROUP_MAX_MEMBERS,
  ADMIN_FAMILY_GROUP_NAME_MAX_LENGTH,
} from "@/lib/admin-family-group-create";

/** `POST /api/admin/family-groups`. */
export const createFamilyGroupSchema = z.object({
  name: z.string().min(1, "Name is required").max(ADMIN_FAMILY_GROUP_NAME_MAX_LENGTH),
  memberIds: z
    .array(z.string())
    .min(1, "At least one member is required")
    .max(ADMIN_FAMILY_GROUP_MAX_MEMBERS),
});

/** `PUT /api/admin/family-groups/[id]`: `memberIds`, when sent, is the whole new member list. */
export const updateFamilyGroupSchema = z.object({
  name: z.string().min(1).max(ADMIN_FAMILY_GROUP_NAME_MAX_LENGTH).optional(),
  memberIds: z.array(z.string()).min(1).max(ADMIN_FAMILY_GROUP_MAX_MEMBERS).optional(),
});

/** `DELETE /api/admin/family-groups/partner-invites?id=…`: the invitation's id, never its token. */
export const revokePartnerInviteQuerySchema = z.object({
  id: z.string().trim().min(1),
});

/** `POST /api/admin/family-suggestions`. */
export const createFamilyGroupFromSuggestionSchema = z.object({
  name: z.string().min(1, "Group name required").max(100),
  memberIds: z.array(z.string().min(1)).min(2, "At least 2 members required"),
});

/** `POST /api/admin/family-suggestions/hide`. */
export const hideFamilySuggestionSchema = z.object({
  memberIds: z.array(z.string().min(1)).min(2, "At least 2 members required"),
});

/** `GET /api/admin/family-groups/member-search`. */
export const familyGroupMemberSearchQuerySchema = z.object({
  q: z.string().trim().min(2, "Enter at least 2 characters").max(100),
  // CSV, e.g. "INFANT,CHILD,YOUTH". An empty or absent value means no tier
  // restriction; an unrecognised tier is a 400 rather than a silent widening.
  ageTierIn: z
    .string()
    .trim()
    .optional()
    .transform((value) => (value ? value.split(",").map((part) => part.trim()) : undefined))
    .pipe(z.array(ageTierEnum).min(1).optional()),
  prospectiveParentMemberId: z.string().trim().min(1).optional(),
});

/** `POST /api/admin/family-groups/requests`. */
export const reviewFamilyGroupRequestSchema = z.object({
  requestId: z.string().min(1),
  action: z.enum(["approve", "reject"]),
  linkedMemberId: z.string().min(1).optional(),
  // Empty string is intentionally allowed: the admin request-review UI's
  // "Use child's own email" option sends inheritEmailFromId: "" (its
  // <option value="">), which the approve path coerces to null (no inheritance,
  // child keeps its own email) via `data.inheritEmailFromId?.trim() || null` and
  // resolveParentNotificationSourceId. Do not tighten to reject "" without
  // updating that client — a rolling deploy would 422 the old client's requests.
  inheritEmailFromId: z.string().optional().nullable().or(z.literal("")),
  createNewMember: z.boolean().optional(),
  rejectionReason: z.string().max(500).optional(),
  // #1789: admin per-decision member-email choice. Absent/undefined = notify
  // (default), false = suppress the requester's decision email. Only gates the
  // requester-facing CHILD_REQUEST and GROUP_CREATE decision emails; the
  // token-bearing partner invite on GROUP_CREATE approval is always sent (the
  // invited partner cannot join without it).
  notifyMember: z.boolean().optional(),
});
