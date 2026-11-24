/**
 * The query of `GET /api/admin/occupancy` (ALP-719, `INV-MCP-006`).
 *
 * In a pure lib module because the route parses with it and the AI app
 * action catalogue offers the same fields (`INV-SSOT`). No database or
 * server imports, so the catalogue can load it.
 */
import { z } from "zod";

/** A calendar month as the occupancy page asks for it. */
export const OCCUPANCY_MONTH_PATTERN = /^\d{4}-\d{2}$/;

const MONTH_REQUIRED = "month is required as YYYY-MM";
const LODGE_REQUIRED = "A valid lodgeId is required.";

// A missing field answers the same sentence as a malformed one, as the page
// has always been told.
export const adminOccupancyQuerySchema = z.object({
  month: z
    .string({ error: MONTH_REQUIRED })
    .regex(OCCUPANCY_MONTH_PATTERN, MONTH_REQUIRED)
    .describe("The calendar month, `YYYY-MM`."),
  lodgeId: z.string({ error: LODGE_REQUIRED }).min(1, LODGE_REQUIRED).describe("The lodge, from `list_lodges`."),
});
