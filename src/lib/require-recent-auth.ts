import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import {
  isWithinRecentAuthWindow,
  recentAuthRefusalBody,
} from "@/lib/recent-auth";

/**
 * The one recent-authentication check (#4616, INV-AUTH-008, INV-SSOT).
 *
 * No route calls it yet (#4619). A caller that is not signed in gets 401.
 * A signed-in caller whose `lastAuthenticatedAt` is missing or older than
 * five minutes gets the typed 403 the confirm dialog recognises.
 */
export async function requireRecentAuth() {
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
