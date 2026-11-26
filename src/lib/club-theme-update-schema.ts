import { z } from "zod";

import {
  CLUB_THEME_FONT_KEYS,
  isValidLogoDataUrl,
  isValidLogoUrl,
  isValidThemeColour,
  logoDataUrlByteLength,
  sanitiseRawCss,
} from "@/lib/club-theme-schema";

/**
 * Zod validators for the club-theme update payload. These live apart from
 * `club-theme-schema.ts` so that the base module (colour/font constants,
 * contrast helpers, CSS builders, sanitisers) stays free of any `zod` value
 * import and is therefore safe to bundle into the `'use client'` site-style
 * wizard without dragging zod into the `admin/site-style` client bundle. The
 * wizard lazy-loads this module via a dynamic `import()` purely for live
 * client-side field validation; server request validation
 * (`api/admin/site-style/route.ts`) imports it statically. The helpers pulled
 * from the base module are plain functions/constant tuples, so importing them
 * here does not pull zod back into that base module (#1278, follow-up from
 * #1197).
 */
const colourSchema = z
  .string()
  .trim()
  .refine(isValidThemeColour, "Use a 6-digit hex colour (e.g. #1a2b3c).");

/**
 * WRITE-path budget for a NEWLY SET inlined logo data URI (#2322), decoded bytes.
 *
 * Deliberately far below the 900_000 READ-path bound in `club-theme-schema.ts`.
 * New logos go through `POST /api/admin/site-style/logo`, which resizes
 * server-side and stores a served image, so this small budget is only a
 * deliberate escape hatch for a hand-crafted tiny logo supplied through the API
 * or a config bundle.
 *
 * NOT enforced in this schema, on purpose. The zod layer is stateless and cannot
 * see the stored value, so a refine here would reject a deployment's EXISTING
 * ~860KB logo on every save — locking such a club out of changing its colours.
 * The budget applies only to a CHANGED value, which needs the current row, so it
 * lives in the site-style PUT route (`isLogoDataUrlWithinWriteBudget` below is
 * the shared predicate). The 900K read bound still gates this field here.
 */
export const MAX_LOGO_DATA_URL_WRITE_BYTES = 64_000;

/**
 * True when a data URI is small enough to be newly stored inline. Callers must
 * apply this ONLY to a value that differs from what is already stored.
 */
export function isLogoDataUrlWithinWriteBudget(value: string): boolean {
  const byteLength = logoDataUrlByteLength(value);
  return byteLength !== null && byteLength <= MAX_LOGO_DATA_URL_WRITE_BYTES;
}

export const LOGO_DATA_URL_WRITE_BUDGET_MESSAGE =
  "Logo must be a PNG, JPEG, WebP, or GIF data URL no larger than 64KB. Upload a larger logo as a file instead — it is resized and stored as an image.";

const logoDataUrlSchema = z
  .string()
  .trim()
  .max(2_000_000)
  .refine(
    isValidLogoDataUrl,
    "Logo must be a PNG, JPEG, WebP, or GIF data URL no larger than 900KB.",
  );

const logoUrlSchema = z
  .string()
  .trim()
  .refine(isValidLogoUrl, "Logo URL must be an uploaded image path.");

export const clubThemeUpdateSchema = z
  .object({
    brandGold: colourSchema,
    brandDeep: colourSchema,
    brandSafety: colourSchema,
    headingFontKey: z.enum(CLUB_THEME_FONT_KEYS),
    bodyFontKey: z.enum(CLUB_THEME_FONT_KEYS),
    logoUrl: z
      .union([logoUrlSchema, z.literal(""), z.null()])
      .transform((value) => value || null),
    logoDataUrl: z
      .union([logoDataUrlSchema, z.literal(""), z.null()])
      .transform((value) => value || null),
    rawCss: z.string().max(50_000).default("").transform(sanitiseRawCss),
    completeSetup: z.boolean().optional(),
  })
  .strict();

export type ClubThemeUpdateInput = z.infer<typeof clubThemeUpdateSchema>;

/**
 * What an AI app connection may send to the site style save (ALP-723): the
 * colours, fonts and custom CSS. The logo is a file the officer uploads on the
 * website, and completing setup is the setup wizard's last step, so neither is
 * offered; the route keeps the stored logo for a connection's save.
 */
export const clubThemeConnectionUpdateSchema = clubThemeUpdateSchema.omit({
  logoUrl: true,
  logoDataUrl: true,
  completeSetup: true,
});
