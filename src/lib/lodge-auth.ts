import { auth } from "./auth";
import { getKioskAccessTier, type KioskTier } from "./kiosk-access";

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

  const date = dateStr ? new Date(dateStr + "T00:00:00") : new Date();
  if (!dateStr) date.setHours(0, 0, 0, 0);

  const tier = await getKioskAccessTier(session.user.id, session.user.role, date);

  if (tier === "none") {
    return { session: null, tier, error: "Forbidden" as const, status: 403 as const };
  }

  return { session, tier, error: null, status: null };
}
