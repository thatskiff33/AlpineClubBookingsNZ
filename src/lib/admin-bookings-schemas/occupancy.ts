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

export const adminOccupancyQuerySchema = z.object({
  month: z.string().regex(OCCUPANCY_MONTH_PATTERN, "month is required as YYYY-MM").describe("The calendar month, `YYYY-MM`."),
  lodgeId: z.string().min(1, "A valid lodgeId is required.").describe("The lodge, from `list_lodges`."),
});
