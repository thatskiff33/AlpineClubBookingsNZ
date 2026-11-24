/**
 * Request bodies of the member family-group routes under
 * `src/app/api/members/family/` (ALP-795).
 *
 * Each route parses with the schema here, and the AI app action catalogue
 * (`src/lib/mcp/catalogue.ts`) describes the same action with it, so an app is
 * never told one shape while the route enforces another (`INV-SSOT`).
 *
 * Pure zod: no server imports, so the catalogue can import it.
 */
import { z } from "zod";

import { dateOfBirthStringSchema } from "@/lib/date-only-schema";
import { nameField } from "@/lib/zod-helpers";

/** A date of birth that must be sent: "required" is said before the format is checked. */
const requiredDateOfBirth = z
  .string({ error: "Date of birth is required" })
  .min(1, "Date of birth is required")
  .pipe(dateOfBirthStringSchema);

/** `PUT /api/members/family/[memberId]/details`. */
export const familyMemberIdParamsSchema = z.object({
  memberId: z.string().min(1),
});

/**
 * `PUT /api/members/family/[memberId]/details`: a no-login family member's
 * name and date of birth. Their contact details and address are always copied
 * from the adult confirming, which `inheritContactFromSelf` acknowledges.
 */
export const delegatedFamilyDetailsSchema = z.object({
  firstName: nameField({ required: "First name required" }),
  lastName: nameField({ required: "Last name required" }),
  dateOfBirth: dateOfBirthStringSchema,
  inheritContactFromSelf: z.literal(true),
});

/** `POST /api/members/family/create-group`. */
export const familyGroupCreateSchema = z.object({
  groupName: z
    .string()
    .min(1, "Group name cannot be empty")
    .max(100, "Group name must be 100 characters or fewer")
    .optional(),
  partnerEmail: z.string().email("Invalid email address").optional(),
  // #1742: the named partner is the requester's Partner/Husband/Wife. For an
  // unregistered partner this marks the minted invite token so claiming it
  // also forms the CONFIRMED MemberPartnerLink; a registered partner instead
  // receives a PENDING partner-link request to confirm from their profile.
  declarePartnerLink: z.boolean().default(false),
  children: z
    .array(
      z.object({
        firstName: nameField({ required: "First name required" }),
        lastName: nameField({ required: "Last name required" }),
        dateOfBirth: requiredDateOfBirth,
      }),
    )
    .max(6, "A group creation request can include at most 6 infant/child/youth members")
    .default([]),
});

/** `POST /api/members/family/invite`. */
export const familyGroupInviteSchema = z.object({
  email: z.string().email("Invalid email address"),
  familyGroupId: z.string().min(1, "Family group ID required"),
});

/** `POST /api/members/family/request-adult`. */
export const familyAdultRequestSchema = z.object({
  familyGroupId: z.string().min(1, "Family group ID required"),
  firstName: nameField({ required: "First name required" }),
  lastName: nameField({ required: "Last name required" }),
  dateOfBirth: dateOfBirthStringSchema,
  notes: z.string().max(500).optional(),
});

/** `POST /api/members/family/request-child`. */
export const familyChildRequestSchema = z.object({
  familyGroupId: z.string().min(1, "Family group ID required"),
  firstName: nameField({ required: "First name required" }),
  lastName: nameField({ required: "Last name required" }),
  dateOfBirth: requiredDateOfBirth,
});

/** `POST /api/members/family/request-join`. */
export const familyJoinRequestSchema = z.object({
  targetEmail: z.string().email("Invalid email address"),
});

/** `POST /api/members/family/request-removal`. */
export const familyRemovalRequestSchema = z.object({
  familyGroupId: z.string().min(1, "Family group ID required"),
  memberId: z.string().min(1, "Member ID required"),
  notes: z.string().max(500).optional(),
});
