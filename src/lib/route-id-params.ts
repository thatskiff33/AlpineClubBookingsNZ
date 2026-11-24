import { z } from "zod";

/**
 * The `[id]` segment of a member route: the one schema every route and the AI
 * app action catalogue read it with (ALP-796, `INV-SSOT`). Each area
 * re-exports it under a readable name (`bookingIdParamsSchema`,
 * `noticeIdParamsSchema`, `inductionIdParamsSchema`, `workPartyIdParamsSchema`,
 * `adminRecordIdParamsSchema`) rather than declaring its own copy. Client-safe: zod only.
 */
export const routeIdParamsSchema = z.object({
  id: z.string().min(1),
});
