import { z } from "zod";

/**
 * A committee role's fields, validated ONCE for the two API routes that write
 * one and the admin form that edits one (#4467). Before this, the create and
 * update routes each declared the five rules and the form checked none of
 * them, so a blank or badly-formed value came back as a bare "Invalid input".
 *
 * Shared form schemas live in `src/lib/forms/` and import nothing but `zod`,
 * so a `"use client"` form can import them: the client/server boundary census
 * walks this module from the form, and `shared-form-schema-census.test.ts`
 * fails one that a route or a form stops importing.
 *
 * Each message names the fix, because the error summary lists them as links
 * with no field label in front ("Enter a role name").
 */
const roleName = z
  .string()
  .trim()
  .min(1, "Enter a role name")
  .max(120, "Use a role name of 120 characters or fewer");

const roleDescription = z
  .string()
  .trim()
  .max(1000, "Use a description of 1,000 characters or fewer")
  .nullable();

const roleContactEmail = z
  .string()
  .trim()
  .email("Enter the role email as an address, like president@example.org")
  .max(320, "Use a role email of 320 characters or fewer")
  .nullable();

const roleSortOrder = z
  .number()
  .int("Enter the sort order as a whole number")
  .min(0, "Enter a sort order of 0 or more")
  .max(100000, "Enter a sort order of 100,000 or less");

const roleIsActive = z.boolean();

/** `POST /api/admin/committee/roles`. */
export const committeeRoleCreateSchema = z
  .object({
    name: roleName,
    description: roleDescription.optional(),
    contactEmail: roleContactEmail.optional(),
    isActive: roleIsActive.optional().default(true),
    sortOrder: roleSortOrder.optional(),
  })
  .strict();

/**
 * `PATCH /api/admin/committee/roles/[id]`: every field optional, and no
 * default. A default `isActive` here would re-activate an archived role on
 * any update that left it out.
 */
export const committeeRolePatchSchema = z
  .object({
    name: roleName.optional(),
    description: roleDescription.optional(),
    contactEmail: roleContactEmail.optional(),
    isActive: roleIsActive.optional(),
    sortOrder: roleSortOrder.optional(),
  })
  .strict();

/** A text box's empty value is "none": the routes store `null`, never `""`. */
function emptyAsNull<T extends z.ZodType<unknown, string | null>>(schema: T) {
  return z
    .string()
    .transform((value) => (value === "" ? null : value))
    .pipe(schema);
}

/**
 * The admin form's values in, the payload both routes accept out: the same
 * field rules, with an empty description or email sent as `null`, as the form
 * always did.
 */
export const committeeRoleFormSchema = z.object({
  name: roleName,
  description: emptyAsNull(roleDescription),
  contactEmail: emptyAsNull(roleContactEmail),
  sortOrder: roleSortOrder,
  isActive: roleIsActive,
});

export type CommitteeRoleFormValues = z.input<typeof committeeRoleFormSchema>;
export type CommitteeRolePayload = z.output<typeof committeeRoleFormSchema>;
