import { auth } from "./auth";
import { getKioskAccessTier, type KioskTier } from "./kiosk-access";
import { getTodayDateOnly, isDateOnlyString, parseDateOnly } from "./date-only";
import { getActiveLodgePinSessionForRequest } from "./lodge-pin-session";
import { requireActiveSessionUser } from "./session-guards";

interface CheckLodgeAuthOptions {
  allowPublicReadOnly?: boolean;
  request?: Request;
}

/**
 * Shared auth check for lodge API endpoints.
 * Allows ADMIN, LODGE, MEMBER with kiosk access, or a valid hut leader PIN session.
 * When allowPublicReadOnly is true, unauthenticated requests can still read the
 * kiosk in tier "none" mode.
 */
export async function checkLodgeAuth(
  dateStr?: string,
  options: CheckLodgeAuthOptions = {}
) {
  const session = await auth();

  if (dateStr && !isDateOnlyString(dateStr)) {
    return {
      session,
      tier: "none" as KioskTier,
      error: "Invalid date format" as const,
      status: 400 as const,
    };
  }

  const date = dateStr ? parseDateOnly(dateStr) : getTodayDateOnly();

  if (session?.user) {
    const inactiveResponse = await requireActiveSessionUser(session.user.id);
    if (inactiveResponse) {
      return {
        session: null,
        tier: "none" as KioskTier,
        error: "Account is deactivated" as const,
        status: 403 as const,
      };
    }

    const tier = await getKioskAccessTier(
      session.user.id,
      session.user.role,
      date
    );

    if (tier !== "none") {
      return { session, tier, error: null, status: null };
    }
  }

  if (options.request) {
    const pinSession = await getActiveLodgePinSessionForRequest(
      options.request,
      date
    );

    if (pinSession) {
      return {
        session: null,
        tier: "hut-leader" as KioskTier,
        error: null,
        status: null,
        pinSession,
      };
    }
  }

  if (options.allowPublicReadOnly) {
    return {
      session: null,
      tier: "none" as KioskTier,
      error: null,
      status: null,
    };
  }

  if (!session?.user) {
    return {
      session: null,
      tier: "none" as KioskTier,
      error: "Unauthorised" as const,
      status: 401 as const,
    };
  }

  return {
    session: null,
    tier: "none" as KioskTier,
    error: "Forbidden" as const,
    status: 403 as const,
  };
}
