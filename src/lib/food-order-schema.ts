/**
 * The request shapes of the member food-order routes (fork
 * triyder/AlpineClubBookingsNZ#121), shared with the AI app actions
 * `place_food_order` and `list_my_food_orders` (ALP-796, `INV-SSOT`).
 *
 * Client-safe, like `food-order-rules.ts` whose limits it reads.
 */
import { z } from "zod";

import { dateOnlyStringSchema } from "@/lib/date-only-schema";
import {
  FOOD_ORDER_ITEM_DESCRIPTION_MAX_LENGTH,
  FOOD_ORDER_MAX_ITEMS,
  FOOD_ORDER_NOTES_MAX_LENGTH,
  FOOD_ORDER_STATUSES,
} from "@/lib/food-order-rules";

/**
 * The body of `POST /api/food-orders`. Bounded here so an oversized payload is
 * refused before it is walked; the item rules themselves are
 * `foodOrderItemsProblem`, shared with the form.
 */
export const foodOrderPlaceSchema = z
  .object({
    lodgeId: z.string().trim().min(1).max(64),
    /** The club calendar day the food is needed by, `YYYY-MM-DD`. */
    neededBy: z.string().trim().max(10),
    notes: z.string().max(FOOD_ORDER_NOTES_MAX_LENGTH).optional().nullable(),
    items: z
      .array(
        z
          .object({
            description: z
              .string()
              .max(FOOD_ORDER_ITEM_DESCRIPTION_MAX_LENGTH * 2),
            // A decimal STRING ("0.5"), parsed strictly by
            // `parseFoodOrderQuantity` in `foodOrderItemsProblem`; a JSON
            // number is refused so no float ever carries a quantity.
            quantity: z.string().max(16),
            // Required: the form sends its default, Items.
            unit: z.string().max(20),
          })
          .strict(),
      )
      .max(FOOD_ORDER_MAX_ITEMS * 2),
  })
  .strict();

/**
 * The filters of `GET /api/food-orders/history`. The route drops empty values
 * first, so `?status=` means no filter. A malformed value is refused rather
 * than ignored, so a typo never silently widens the totals a club forecasts
 * from; `FOOD_ORDER_HISTORY_FILTER_ERRORS` says which. The dates are real
 * calendar days (`dateOnlyStringSchema`), so `2026-02-30` is refused too.
 */
export const foodOrderHistoryQuerySchema = z.object({
  lodgeId: z.string().trim().max(64).optional(),
  status: z.enum(FOOD_ORDER_STATUSES).optional(),
  /** First needed-by day, `YYYY-MM-DD`, inclusive. */
  from: dateOnlyStringSchema.optional(),
  /** Last needed-by day, `YYYY-MM-DD`, inclusive. */
  to: dateOnlyStringSchema.optional(),
  page: z.coerce.number().int().min(1).max(100_000).optional(),
});

/** The member-facing refusal for each filter `foodOrderHistoryQuerySchema` refuses. */
export const FOOD_ORDER_HISTORY_FILTER_ERRORS: Readonly<
  Record<keyof z.infer<typeof foodOrderHistoryQuerySchema>, string>
> = {
  lodgeId: "Unknown lodge filter.",
  status: "Unknown status filter.",
  from: "Dates must be in YYYY-MM-DD form.",
  to: "Dates must be in YYYY-MM-DD form.",
  page: "Unknown page.",
};
