import { timingSafeEqual } from "crypto";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getRuntimeStatus } from "@/lib/health-check";

export const dynamic = "force-dynamic";

function safeSecretCompare(provided: string | null, expected: string | undefined) {
  if (!provided || !expected) {
    return false;
  }

  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);

  return (
    providedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(providedBuffer, expectedBuffer)
  );
}

export async function GET(request: NextRequest) {
  const providedSecret = request.headers.get("x-cron-secret");

  if (!safeSecretCompare(providedSecret, process.env.CRON_SECRET)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return NextResponse.json(getRuntimeStatus());
}
