/**
 * The body of `PUT /api/profile`, a member saving their own details. Shared
 * with the AI app action catalogue (ALP-718), which offers `update_my_profile`
 * a subset of these fields, so the two cannot describe a field differently
 * (`INV-SSOT`).
 */
import { z } from "zod";

import { dateOfBirthStringSchema } from "@/lib/date-only-schema";
import { dietaryRequirementsInputSchema } from "@/lib/member-dietary-field";
import { nameField } from "@/lib/zod-helpers";

const maxStr = (len: number) => z.string().max(len).optional().nullable();

export const memberProfileUpdateSchema = z.object({
  firstName: nameField({ required: "First name is required" }),
  lastName: nameField({ required: "Last name is required" }),
  phoneCountryCode: z.string().max(5).optional().nullable(),
  phoneAreaCode: z.string().max(5).optional().nullable(),
  phoneNumber: z.string().max(15).optional().nullable(),
  dateOfBirth: dateOfBirthStringSchema
    .optional()
    .nullable()
    .or(z.literal("")),
  // Physical address
  streetAddressLine1: maxStr(200),
  streetAddressLine2: maxStr(200),
  streetCity: maxStr(200),
  streetRegion: maxStr(200),
  streetPostalCode: maxStr(20),
  streetCountry: maxStr(100),
  // Postal address
  postalAddressLine1: maxStr(200),
  postalAddressLine2: maxStr(200),
  postalCity: maxStr(200),
  postalRegion: maxStr(200),
  postalPostalCode: maxStr(20),
  postalCountry: maxStr(100),
  occupation: z.string().max(100).optional().nullable().or(z.literal("")),
  // #2941: any age tier, only while the club has the field ON; blank clears.
  dietaryRequirements: dietaryRequirementsInputSchema,
  // #126 / #37: member opt-in to show their phone on the PUBLIC lobby display
  // (the serialiser also requires lodge config on + adult). The kiosk staff
  // check-in view is exempt from this toggle.
  lodgeScreenPhoneOptIn: z.boolean().optional(),
  postalSameAsPhysical: z.boolean().optional(),
});
