import { auth } from "./auth";
import { isHutLeader } from "./hut-leader";

/**
 * Shared auth check for lodge API endpoints.
 * Allows LODGE, ADMIN, or MEMBER with active hut leader assignment.
 * Returns the session if authorized, or null if not.
 */
export async function checkLodgeAuth() {
  const session = await auth();
  if (!session?.user) {
    return { session: null, error: "Unauthorised" as const, status: 401 as const };
  }

  if (session.user.role === "LODGE" || session.user.role === "ADMIN") {
    return { session, error: null, status: null };
  }

  if (session.user.role === "MEMBER") {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const hasAccess = await isHutLeader(session.user.id, today);
    if (hasAccess) {
      return { session, error: null, status: null };
    }
  }

  return { session: null, error: "Forbidden" as const, status: 403 as const };
}
