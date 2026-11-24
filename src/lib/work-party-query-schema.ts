/**
 * The request shapes of the member work-party routes (#5148), shared with the
 * AI app actions `get_work_party` and `find_work_parties_for_stay` (ALP-796,
 * `INV-SSOT`).
 */
import { z } from "zod";

import { parsedDateOnlySchema } from "@/lib/date-only-schema";

/**
 * How many upcoming work parties `GET /api/work-parties` lists. A club runs a
 * handful a season; the cap only bounds a pathological table.
 */
export const MEMBER_WORK_PARTY_LIST_LIMIT = 50;

/** The `[id]` of `GET /api/work-parties/[id]`. */
export { routeIdParamsSchema as workPartyIdParamsSchema } from "@/lib/route-id-params";

/** The query of `GET /api/work-parties/active`: the stay being booked. */
export const workPartiesForStayQuerySchema = z.object({
  checkIn: parsedDateOnlySchema,
  checkOut: parsedDateOnlySchema,
  // Lodge being booked (multi-lodge): events bound to another lodge are
  // filtered out; lodge-less events are club-wide and always listed.
  lodgeId: z.string().min(1).optional(),
});
