/**
 * The request body `POST /api/admin/members/import` accepts: one member CSV row
 * per element, already mapped to field keys by the import dialog, plus the
 * date formats and the invite and Xero-link switches.
 *
 * Moved out of the route unchanged (#4988) so the route stays inside its
 * file-size ceiling (#4926). The route is still the only caller, and it alone
 * decides what each field means: in particular the dietary column is accepted
 * here in its shared JSON shape and applied there only while the club has the
 * field on and the importing admin holds membership edit access (#2941).
 */
import { z } from "zod";
import {
  deriveMemberImportNameFields,
  MEMBER_IMPORT_ADDRESS_MAX_LENGTHS,
  MEMBER_IMPORT_COMMENTS_MAX_LENGTH,
  MEMBER_IMPORT_DATE_FORMAT_VALUES,
  MEMBER_IMPORT_OCCUPATION_MAX_LENGTH,
} from "@/lib/member-csv-import";
import {
  MEMBER_IMPORT_FAMILY_KEY_MAX_LENGTH,
  MEMBER_IMPORT_MEMBERSHIP_TYPE_MAX_LENGTH,
} from "@/lib/member-csv-import-type-family";
import { MEMBER_IMPORT_ROLE_VALUES } from "@/lib/member-roles";
import { dietaryRequirementsValueSchema } from "@/lib/member-dietary-field";

const nullableImportString = (max: number) =>
  z.string().max(max).optional().nullable();
const dateFormatSchema = z.enum(MEMBER_IMPORT_DATE_FORMAT_VALUES);

const importRowSchema = z
  .object({
    fullName: nullableImportString(200),
    title: nullableImportString(40),
    firstName: nullableImportString(100),
    lastName: nullableImportString(100),
    gender: nullableImportString(40),
    occupation: nullableImportString(MEMBER_IMPORT_OCCUPATION_MAX_LENGTH),
    // #2941: the one shape every JSON writer shares. The 500-character rule
    // is applied below, only when this import actually takes the column.
    dietaryRequirements: dietaryRequirementsValueSchema,
    email: z.string().email("Invalid email address"),
    phone: z.string().max(20).optional().nullable(), // Legacy: single phone string (will be put in phoneNumber)
    phoneCountryCode: z.string().max(5).optional().nullable(),
    phoneAreaCode: z.string().max(5).optional().nullable(),
    phoneNumber: z.string().max(15).optional().nullable(),
    dateOfBirth: z.string().max(32).optional().nullable(),
    joinedDate: z.string().max(32).optional().nullable(),
    cancelledDate: z.string().max(32).optional().nullable(),
    streetAddressLine1: nullableImportString(
      MEMBER_IMPORT_ADDRESS_MAX_LENGTHS.streetAddressLine1,
    ),
    streetAddressLine2: nullableImportString(
      MEMBER_IMPORT_ADDRESS_MAX_LENGTHS.streetAddressLine2,
    ),
    streetCity: nullableImportString(
      MEMBER_IMPORT_ADDRESS_MAX_LENGTHS.streetCity,
    ),
    streetRegion: nullableImportString(
      MEMBER_IMPORT_ADDRESS_MAX_LENGTHS.streetRegion,
    ),
    streetCountry: nullableImportString(
      MEMBER_IMPORT_ADDRESS_MAX_LENGTHS.streetCountry,
    ),
    streetPostalCode: nullableImportString(
      MEMBER_IMPORT_ADDRESS_MAX_LENGTHS.streetPostalCode,
    ),
    lifeMemberDate: z.string().max(32).optional().nullable(),
    comments: nullableImportString(MEMBER_IMPORT_COMMENTS_MAX_LENGTH),
    role: z.enum(MEMBER_IMPORT_ROLE_VALUES).optional().default("USER"),
    membershipType: nullableImportString(MEMBER_IMPORT_MEMBERSHIP_TYPE_MAX_LENGTH),
    familyKey: nullableImportString(MEMBER_IMPORT_FAMILY_KEY_MAX_LENGTH),
    sourceLineNumber: z.number().int().positive().optional(),
    sourceColumnLabels: z.record(z.string(), z.string().max(128)).optional(),
  })
  .superRefine((row, ctx) => {
    const names = deriveMemberImportNameFields(row);
    if (!names.firstName) {
      ctx.addIssue({
        code: "custom",
        path: ["firstName"],
        message: "First name is required",
      });
    }
    if (!names.lastName) {
      ctx.addIssue({
        code: "custom",
        path: ["lastName"],
        message: "Last name is required",
      });
    }
    if (names.firstName.length > 100) {
      ctx.addIssue({
        code: "custom",
        path: ["firstName"],
        message: "First name must be 100 characters or fewer",
      });
    }
    if (names.lastName.length > 100) {
      ctx.addIssue({
        code: "custom",
        path: ["lastName"],
        message: "Last name must be 100 characters or fewer",
      });
    }
  });

export const memberImportBodySchema = z.object({
  rows: z
    .array(importRowSchema)
    .min(1, "At least one row is required")
    .max(500, "Maximum 500 rows per import"),
  dateFormats: z
    .object({
      dateOfBirth: dateFormatSchema.optional(),
      joinedDate: dateFormatSchema.optional(),
      lifeMemberDate: dateFormatSchema.optional(),
      cancelledDate: dateFormatSchema.optional(),
    })
    .optional(),
  sendInvites: z.boolean().default(false),
  autoLinkXero: z.boolean().default(false),
});

export type MemberImportRow = z.infer<typeof importRowSchema>;
