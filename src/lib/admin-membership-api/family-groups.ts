/**
 * The family group and family suggestion routes' request schemas
 * (`/api/admin/family-groups/**`, `/api/admin/family-suggestions/**`), shared
 * with the AI app actions that call them (ALP-720, `INV-SSOT`): the app is
 * described exactly the fields the route enforces.
 *
 * The member search query and the request review body already live beside the
 * services that read them (`admin-family-group-member-search.ts`,
 * `admin-family-group-requests-service.ts`), and the catalogue imports them
 * from there.
 */
import { z } from "zod";

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
