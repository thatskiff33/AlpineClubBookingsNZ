/**
 * The site settings routes' request schemas, shared with the AI app actions
 * that call them (ALP-723, `INV-SSOT`): which fee and policy sections the
 * public pages show and where Book Now goes (`/api/admin/public-content-settings`),
 * whose details the Contact page shows (`/api/admin/club-contact`), and the
 * club's name and details in the site chrome (`/api/admin/club-identity`).
 * Each save replaces every field it names.
 */
import { BookNowTarget, CommitteePhotoDisplay } from "@prisma/client";
import { z } from "zod";

import { clubLegalNameSchema, clubPostalAddressSchema } from "@/lib/club-invoice-supplier-fields";
import type { PersistedClubIdentity } from "@/lib/club-identity-settings";
import { isHttpUrl } from "@/lib/http-url";

/** `PUT /api/admin/public-content-settings`. */
export const publicContentSettingsSchema = z
  .object({
    membershipTypes: z.boolean(),
    entranceFees: z.boolean(),
    hutFees: z.boolean(),
    bookingPolicySummary: z.boolean(),
    cancellationPolicy: z.boolean(),
    // Dedicated {{annual-fees}} double-opt-in gate (#1933, E7).
    annualFees: z.boolean(),
    // Configurable public Book Now button (E3 #1929).
    showBookNow: z.boolean(),
    bookNowTarget: z.enum(BookNowTarget),
    bookNowPageId: z.string().min(1).nullable(),
    // Committee-roster photo display + shape (MP5, #171).
    committeePhotoDisplay: z.enum(CommitteePhotoDisplay),
  })
  .strict();

export type PublicContentSettingsValues = z.infer<typeof publicContentSettingsSchema>;

/** `PUT /api/admin/club-contact`: null restores the default booking-officer fallback. */
export const clubContactSchema = z
  .object({
    contactCommitteeRoleKey: z.string().min(1).nullable(),
  })
  .strict();

/**
 * `PUT /api/admin/club-identity`. Blank clears a field back to its fallback.
 * `legalName` and `postalAddress` (#5066) are optional so a page loaded before
 * they existed still saves its four fields without clearing them.
 */
export const clubIdentitySchema = z
  .object({
    name: z.string().trim().max(200).nullable(),
    shortName: z.string().trim().max(200).nullable(),
    hutLeaderLabel: z.string().trim().max(200).nullable(),
    facebookUrl: z
      .string()
      .trim()
      .max(500)
      // Blank clears (restores the fallback); a value must be a valid http(s) URL.
      .refine((v) => v === "" || isHttpUrl(v), {
        message: "facebookUrl must be a valid http(s) URL",
      })
      .nullable(),
    // One line, and the lengths config transfer also enforces (`club-invoice-supplier-fields.ts`).
    legalName: clubLegalNameSchema.nullable().optional(),
    postalAddress: clubPostalAddressSchema.nullable().optional(),
  })
  .strict();

/** The club identity as stored and as the route answers with it: null uses the fallback. */
export interface ClubIdentityValues extends PersistedClubIdentity {
  legalName: string | null;
  postalAddress: string | null;
}
