/**
 * The `[id]` path segment of a route that names one record: a non-empty
 * string. The one definition each route family's params schema aliases
 * (`bookingIdParamsSchema`, `noticeIdParamsSchema`,
 * `adminRecordIdParamsSchema`), so the AI app catalogue and the routes agree
 * on what an id is (`INV-SSOT-001`).
 */
import { z } from "zod";

export const idParamsSchema = z.object({
  id: z.string().min(1),
});
