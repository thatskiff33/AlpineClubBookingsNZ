import { NextResponse } from "next/server";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";
import { getSentryReplayEnabled } from "@/lib/privacy-retention-settings";

export const dynamic = "force-dynamic";

/** Public, non-personal runtime policy; unavailable configuration means off. */
export async function GET(request: Request) {
  const rateLimited = await applyRateLimit(rateLimiters.api, request);
  if (rateLimited) return rateLimited;
  return NextResponse.json({ enabled: await getSentryReplayEnabled() }, {
    headers: { "Cache-Control": "no-store" },
  });
}
