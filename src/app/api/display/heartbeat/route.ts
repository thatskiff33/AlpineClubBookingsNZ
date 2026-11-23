import { NextRequest, NextResponse } from "next/server";
import { checkDisplayAuth, markDisplaySeen } from "@/lib/lodge-display-auth";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";

// Lobby display heartbeat (fork issue hoppers99/AlpineClubBookingsNZ#27): the only write the display
// surface performs — its own lastSeenAt bookkeeping, so admins can see a
// dead screen. A revoked or invalid token is rejected WITHOUT updating
// lastSeenAt (AC6).

export async function POST(req: NextRequest) {
  const rateLimited = await applyRateLimit(rateLimiters.api, req);
  if (rateLimited) return rateLimited;

  const auth = await checkDisplayAuth(req);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  await markDisplaySeen(auth.device.id);
  return NextResponse.json({ ok: true });
}
