import { auth } from "./auth";
import { getKioskAccessTier, type KioskTier } from "./kiosk-access";
import { getTodayDateOnly, isDateOnlyString, parseDateOnly } from "./date-only";

/**
 * Shared auth check for lodge API endpoints.
 * Allows LODGE, ADMIN, MEMBER with hut leader assignment, or staying guest.
 * Returns the session and tier if authorized.
 */
export async function checkLodgeAuth(dateStr?: string) {
  const session = await auth();
  if (!session?.user) {
    return { session: null, tier: "none" as KioskTier, error: "Unauthorised" as const, status: 401 as const };
  }

  if (dateStr && !isDateOnlyString(dateStr)) {
    return { session, tier: "none" as KioskTier, error: "Invalid date format" as const, status: 400 as const };
  }

  const date = dateStr ? parseDateOnly(dateStr) : getTodayDateOnly();

  const tier = await getKioskAccessTier(session.user.id, session.user.role, date);

  if (tier === "none") {
    return { session: null, tier, error: "Forbidden" as const, status: 403 as const };
  }

  return { session, tier, error: null, status: null };
}
