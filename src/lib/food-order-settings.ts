import { z } from "zod";

import {
  DEFAULT_FOOD_OFFICER_LABEL,
  FOOD_OFFICER_EMAIL_MAX_LENGTH,
  FOOD_OFFICER_LABEL_MAX_LENGTH,
} from "@/lib/food-order-rules";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";

/**
 * The food-order settings singleton (fork #121): the food officer's email
 * address and what the club calls them.
 *
 * Follows `maintenance-report-settings.ts`: the row is created LAZILY on first
 * save, the migration seeds nothing, and a club that never opened the card reads
 * the defaults — no officer email, so ordering is not set up.
 *
 * EVERY FAILURE PATH IS CLOSED. A missing row, a table that does not exist yet
 * during a blue/green window, or a database error all read as "no officer
 * email", which refuses new orders. An outage can stop orders being taken; it
 * can never accept an order that nobody is told about.
 *
 * THE ADDRESS IS CHECKED ONLY AS AN EMAIL ADDRESS (fork #121 owner decision 10). It is
 * never matched against members or committee roles: keeping it current is the
 * committee's job.
 */

export const FOOD_ORDER_SETTINGS_ID = "default";

export type FoodOrderSettingsValues = {
  /** The configured address, or null when ordering is not set up. */
  officerEmail: string | null;
  officerLabel: string;
};

/** The one format check for the officer address, shared by read and write. */
export const foodOfficerEmailSchema = z
  .string()
  .trim()
  .max(FOOD_OFFICER_EMAIL_MAX_LENGTH)
  .email();

export const foodOfficerLabelSchema = z
  .string()
  .trim()
  .min(1)
  .max(FOOD_OFFICER_LABEL_MAX_LENGTH);

/** A stored address that is not a valid email reads as unset, never as a recipient. */
export function normaliseFoodOfficerEmail(
  value: string | null | undefined,
): string | null {
  if (typeof value !== "string") return null;
  const parsed = foodOfficerEmailSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function normaliseFoodOfficerLabel(
  value: string | null | undefined,
): string {
  const parsed = foodOfficerLabelSchema.safeParse(value ?? "");
  return parsed.success ? parsed.data : DEFAULT_FOOD_OFFICER_LABEL;
}

export function normaliseFoodOrderSettings(
  record?: { officerEmail?: string | null; officerLabel?: string | null } | null,
): FoodOrderSettingsValues {
  return {
    officerEmail: normaliseFoodOfficerEmail(record?.officerEmail),
    officerLabel: normaliseFoodOfficerLabel(record?.officerLabel),
  };
}

export async function loadFoodOrderSettings(): Promise<FoodOrderSettingsValues> {
  try {
    const record = await prisma.foodOrderSettings.findUnique({
      where: { id: FOOD_ORDER_SETTINGS_ID },
      select: { officerEmail: true, officerLabel: true },
    });
    return normaliseFoodOrderSettings(record);
  } catch (err) {
    logger.error({ err }, "Failed to load food order settings; using defaults");
    return normaliseFoodOrderSettings(null);
  }
}

/** The configured food officer address, or null when it is empty or unreadable. */
export async function foodOfficerEmail(): Promise<string | null> {
  return (await loadFoodOrderSettings()).officerEmail;
}
