/**
 * The site banner routes' request schemas (`/api/admin/site-banners/**`),
 * shared with the AI app actions that call them (ALP-723, `INV-SSOT`).
 * Dates are New Zealand date-only strings; the window is inclusive.
 */
import { z } from "zod";

import { dateOnlyStringSchema } from "@/lib/date-only-schema";
import { SITE_BANNER_MESSAGE_MAX_LENGTH, SITE_BANNER_PRIORITIES } from "@/lib/site-banner-shared";

const message = z.string().trim().min(1).max(SITE_BANNER_MESSAGE_MAX_LENGTH);

/** `POST /api/admin/site-banners`. */
export const siteBannerCreateSchema = z
  .object({
    message,
    priority: z.enum(SITE_BANNER_PRIORITIES),
    startDate: dateOnlyStringSchema,
    endDate: dateOnlyStringSchema,
    active: z.boolean().optional().default(true),
  })
  .strict();

/** `PATCH /api/admin/site-banners/[id]`: a field left out keeps its value. */
export const siteBannerUpdateSchema = z
  .object({
    message: message.optional(),
    priority: z.enum(SITE_BANNER_PRIORITIES).optional(),
    startDate: dateOnlyStringSchema.optional(),
    endDate: dateOnlyStringSchema.optional(),
    active: z.boolean().optional(),
  })
  .strict();
