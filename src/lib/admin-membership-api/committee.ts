/**
 * The committee assignment routes' request schemas
 * (`/api/admin/committee/assignments/**`), shared with the AI app actions
 * that call them (ALP-720, `INV-SSOT`): the app is described exactly the
 * fields the route enforces. A committee role's own fields are the admin
 * form's (`forms/committee-role-schema.ts`).
 */
import { z } from "zod";

const COMMITTEE_CONTACT_EMAIL_MODES = ["ROLE", "MEMBER", "CUSTOM"] as const;

/** The assignment fields both writes accept, without defaults. */
const assignmentFields = {
  blurb: z.string().trim().max(1000).nullable().optional(),
  sortOrder: z.number().int().min(0).max(100000).optional(),
  published: z.boolean().optional(),
  showPhone: z.boolean().optional(),
  contactable: z.boolean().optional(),
  contactEmailMode: z.enum(COMMITTEE_CONTACT_EMAIL_MODES).optional(),
  contactEmailOverride: z
    .string()
    .trim()
    .max(320)
    .email("Invalid committee email")
    .nullable()
    .optional(),
  isActive: z.boolean().optional(),
};

/** `GET /api/admin/committee/assignments`: `includeInactive=1` adds deactivated ones. */
export const committeeAssignmentListQuerySchema = z.object({
  memberId: z.string().min(1).optional(),
  committeeRoleId: z.string().min(1).optional(),
  includeInactive: z.enum(["0", "1"]).optional(),
});

/**
 * `POST /api/admin/committee/assignments`: creates the member's assignment to
 * the role, or replaces every field of the one they already hold.
 */
export const committeeAssignmentCreateSchema = z
  .object({
    memberId: z.string().min(1),
    committeeRoleId: z.string().min(1),
    ...assignmentFields,
    sortOrder: assignmentFields.sortOrder.default(0),
    published: assignmentFields.published.default(false),
    showPhone: assignmentFields.showPhone.default(false),
    contactable: assignmentFields.contactable.default(false),
    contactEmailMode: assignmentFields.contactEmailMode.default("ROLE"),
    isActive: assignmentFields.isActive.default(true),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.contactEmailMode === "CUSTOM" && !value.contactEmailOverride) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["contactEmailOverride"],
        message:
          "A custom committee email is required when contact email mode is CUSTOM",
      });
    }
  });

/** `PATCH /api/admin/committee/assignments/[id]`: a field left out keeps its value. */
export const committeeAssignmentPatchSchema = z.object(assignmentFields).strict();
