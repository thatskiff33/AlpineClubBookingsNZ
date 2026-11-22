import { z } from "zod";

/**
 * The `[id]` of `GET /api/inductions/[id]`, shared with the AI app action
 * `get_induction` (ALP-796, `INV-SSOT`).
 */
export const inductionIdParamsSchema = z.object({
  id: z.string().min(1),
});
