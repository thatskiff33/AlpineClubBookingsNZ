import { z } from "zod";

/**
 * The query of `GET /api/availability`: one calendar month for one lodge.
 * `month` counts from 0 (January) to 11 (December), as the booking calendar
 * sends it.
 *
 * In a lib module because the AI app action catalogue
 * (`src/lib/mcp/catalogue.ts`) offers the same three fields (ALP-653,
 * `INV-SSOT`).
 */
export const availabilityQuerySchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100),
  month: z.coerce.number().int().min(0).max(11),
  lodgeId: z.string().min(1).optional(),
});
