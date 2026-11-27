/**
 * The season years an officer may ask for: billing, subscriptions and the
 * Xero membership refresh all accept the same window (`INV-SSOT`). A season
 * is named by its starting year.
 */
import { z } from "zod";

export const SEASON_YEAR_MIN = 2020;
export const SEASON_YEAR_MAX = 2040;

/** A season year in a JSON body. */
export const seasonYearSchema = z.number().int().min(SEASON_YEAR_MIN).max(SEASON_YEAR_MAX);

/** A season year in a query string, read from its text. */
export const seasonYearQuerySchema = z.coerce.number().int().min(SEASON_YEAR_MIN).max(SEASON_YEAR_MAX);
