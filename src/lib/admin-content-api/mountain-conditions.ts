/**
 * The mountain conditions route's request schemas
 * (`/api/admin/mountain-conditions`), shared with the AI app actions that call
 * it (ALP-723, `INV-SSOT`). The report itself is checked by
 * `coerceWhakapapaCurlData`, and a source URL and selectors by the scraper's
 * own rules (`validateWhakapapaSourceUrl`, `findInvalidSelectorOverrides`), in
 * the route.
 */
import { z } from "zod";

import { WHAKAPAPA_SELECTOR_KEYS } from "@/lib/whakapapa-report";

/** `PUT`: the whole report as JSON text; auto refresh then pauses for 12 hours. */
export const mountainConditionsReportSchema = z.object({
  rawJson: z.string(),
});

/**
 * `PATCH`: which sections the public widget shows (a section left out is
 * shown), or where the report is read from. With both, only `config` is saved.
 */
export const mountainConditionsUpdateSchema = z.object({
  visibility: z
    .object({
      roadStatus: z.boolean().optional(),
      lifts: z.boolean().optional(),
      facilities: z.boolean().optional(),
      foodAndDrink: z.boolean().optional(),
      conditions: z.boolean().optional(),
      trails: z.boolean().optional(),
    })
    .optional(),
  config: z
    .object({
      sourceUrl: z.string(),
      // Only the selectors that differ from the built-in ones. A key outside
      // the selector list is ignored, as an imported selectors file may carry one.
      selectorOverrides: z
        .record(z.string(), z.string())
        .optional()
        .describe(
          `CSS selectors by key (${WHAKAPAPA_SELECTOR_KEYS.join(", ")}); a blank one uses the built-in selector.`,
        ),
    })
    .optional(),
});
