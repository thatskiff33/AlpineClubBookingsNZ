import { z } from "zod";

/**
 * #5248: the request shape shared by the bulk subscription-category preview and
 * save. `subscriptionCategoryId` is REQUIRED and nullable — `null` clears the
 * category to Individual. It is never optional: in the single-member save an
 * omitted category means "keep the current one", and a bulk category action
 * that silently kept everyone's category would be a no-op nobody asked for.
 */
export const bulkSubscriptionCategoryBaseSchema = z.object({
  ids: z
    .array(z.string().min(1))
    .min(1, "At least one member ID is required")
    .max(100),
  seasonYear: z.number().int().min(2020).max(2040),
  subscriptionCategoryId: z.string().min(1).nullable(),
});

export const bulkSubscriptionCategoryPreviewSchema =
  bulkSubscriptionCategoryBaseSchema.strict();

export const bulkSubscriptionCategorySaveSchema = bulkSubscriptionCategoryBaseSchema
  .extend({
    reason: z.string().trim().min(1).max(1000),
    previewTokens: z.record(z.string().min(1), z.string().min(1)),
  })
  .strict();
