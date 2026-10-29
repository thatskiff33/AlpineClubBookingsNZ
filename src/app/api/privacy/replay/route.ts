import { NextResponse } from "next/server";
import { getSentryReplayEnabled } from "@/lib/privacy-retention-settings";

export const dynamic = "force-dynamic";

/** Public, non-personal runtime policy; unavailable configuration means off. */
export async function GET() {
  return NextResponse.json({ enabled: await getSentryReplayEnabled() }, {
    headers: { "Cache-Control": "no-store" },
  });
}
