import { NextResponse } from "next/server";

import { OFFICER_SIGN_IN_ENFORCED } from "@/lib/officer-sign-in-switch";
import {
  isWithinRecentAuthWindow,
  recentAuthRefusalBody,
} from "@/lib/recent-auth";

/**
 * The one recent-authentication check (#4616, INV-AUTH-008, INV-AUTH-010).
 *
 * Listed admin routes call it after authorisation and before the body.
 * While officer sign-in is off (#4620 has not flipped the switch) it returns
 * immediately and does not read the session. A caller that is not signed in
 * gets 401. A signed-in caller whose `lastAuthenticatedAt` is missing or
 * older than five minutes gets the typed 403 the confirm dialog recognises.
 * Callers keep using the session from their own authorisation guard.
 * The session reader is loaded only when the switch is on, so a route that
 * calls this check does not pull the sign-in stack while the check is off.
 */
export async function requireRecentAuth() {
  if (!OFFICER_SIGN_IN_ENFORCED) {
    return { ok: true as const };
  }

  const { auth } = await import("@/lib/auth");
  const session = await auth();
  if (!session?.user?.id) {
    return {
      ok: false as const,
      response: NextResponse.json({ error: "Unauthorised" }, { status: 401 }),
    };
  }

  if (!isWithinRecentAuthWindow(session.user.lastAuthenticatedAt, Date.now())) {
    return {
      ok: false as const,
      response: NextResponse.json(recentAuthRefusalBody(), { status: 403 }),
    };
  }

  return { ok: true as const, session };
}
