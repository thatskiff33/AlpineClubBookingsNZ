import { NextResponse } from "next/server";
import { getBrowserSentryDsn } from "@/lib/observability/browser-sentry-config";

export const dynamic = "force-dynamic";

/** Public configuration, read per request so generic images serve any club. */
export async function GET() {
  return NextResponse.json({ dsn: getBrowserSentryDsn() }, {
    headers: { "Cache-Control": "no-store" },
  });
}
