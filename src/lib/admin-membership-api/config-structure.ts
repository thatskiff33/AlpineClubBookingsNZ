/**
 * The request schemas of the routes that shape the club's membership
 * structure (membership types, subscription categories and induction
 * checklist templates), shared with the AI app actions that call them
 * (ALP-720, `INV-SSOT`). Free of the database client, so the catalogue can
 * load it.
 */
import { z } from "zod";

import {
  MEMBERSHIP_TYPE_AGE_TIERS,
  MEMBERSHIP_TYPE_BOOKING_BEHAVIORS,
  MEMBERSHIP_TYPE_SUBSCRIPTION_BEHAVIORS,
} from "@/lib/membership-types";

// --- Membership types: `/api/admin/membership-types/**` ---------------------

/** `POST /api/admin/membership-types`. */
export const membershipTypeCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(1000).nullable().optional(),
    publicDescription: z.string().trim().max(4000).nullable().optional(),
    publiclyListed: z.boolean().optional().default(false),
    bookingBehavior: z.enum(MEMBERSHIP_TYPE_BOOKING_BEHAVIORS),
    subscriptionBehavior: z.enum(MEMBERSHIP_TYPE_SUBSCRIPTION_BEHAVIORS),
    isActive: z.boolean().optional().default(true),
    sortOrder: z.number().int().min(0).max(100000).optional(),
    allowedAgeTiers: z.array(z.enum(MEMBERSHIP_TYPE_AGE_TIERS)).optional(),
  })
  .strict();

/** `PATCH /api/admin/membership-types/[id]`: a field left out keeps its value. */
export const membershipTypePatchSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(1000).nullable().optional(),
    publicDescription: z.string().trim().max(4000).nullable().optional(),
    publiclyListed: z.boolean().optional(),
    bookingBehavior: z.enum(MEMBERSHIP_TYPE_BOOKING_BEHAVIORS).optional(),
    subscriptionBehavior: z.enum(MEMBERSHIP_TYPE_SUBSCRIPTION_BEHAVIORS).optional(),
    isActive: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(100000).optional(),
    allowedAgeTiers: z.array(z.enum(MEMBERSHIP_TYPE_AGE_TIERS)).optional(),
  })
  .strict();

/** `POST /api/admin/membership-types/[id]/merge`: the type whose members are moved, by `id`, into `targetId`. */
export const membershipTypeMergeSchema = z
  .object({
    targetId: z.string().trim().min(1),
  })
  .strict();

/** `POST /api/admin/membership-types/reorder`: every type's id, in the new order. */
export const membershipTypeReorderSchema = z
  .object({
    orderedIds: z.array(z.string().min(1)).min(1),
  })
  .strict();

// --- Subscription categories: `/api/admin/subscription-categories/**` -------

/** `POST /api/admin/subscription-categories`. */
export const subscriptionCategoryCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(1000).nullable().optional(),
    isActive: z.boolean().optional().default(true),
    sortOrder: z.number().int().min(0).max(100000).optional(),
  })
  .strict();

/** `PATCH /api/admin/subscription-categories/[id]`: a field left out keeps its value. */
export const subscriptionCategoryPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(1000).nullable().optional(),
    isActive: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(100000).optional(),
  })
  .strict();

// --- Induction checklist templates: `/api/admin/induction-templates/**` -----

const INDUCTION_TEMPLATE_KINDS = ["NEW_MEMBER", "HUT_LEADER", "YOUTH_TO_FULL", "RE_INDUCTION"] as const;

const INDUCTION_SECTION_PRIORITIES = ["EMERGENCY", "SECURITY", "STARTUP", "SHUTDOWN", "GENERAL"] as const;

/** `POST /api/admin/induction-templates`: a new, inactive template, empty or copied from `cloneFromId`. */
export const inductionTemplateCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  version: z.string().trim().min(1).max(50),
  kind: z.enum(INDUCTION_TEMPLATE_KINDS).optional(),
  cloneFromId: z.string().min(1).optional(),
});

/**
 * `PUT /api/admin/induction-templates/[id]`: the template's whole checklist.
 * `sections` replaces every section and item, in the order given.
 */
export const inductionTemplateUpdateSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  version: z.string().trim().min(1).max(50).optional(),
  kind: z.enum(INDUCTION_TEMPLATE_KINDS).optional(),
  sections: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(200),
        description: z.string().trim().max(1000).nullable().optional(),
        priority: z.enum(INDUCTION_SECTION_PRIORITIES),
        items: z
          .array(
            z.object({
              label: z.string().trim().min(1).max(500),
              competencyPrompt: z.string().trim().max(1000).nullable().optional(),
              notesPrompt: z.string().trim().max(1000).nullable().optional(),
              isMandatory: z.boolean().optional(),
              requiresDemonstration: z.boolean().optional(),
            }),
          )
          .max(100),
      }),
    )
    .max(30),
});

/** `PATCH /api/admin/induction-templates/[id]`: make it the active template of its kind. */
export const inductionTemplateActivateSchema = z.object({ isActive: z.literal(true) });
