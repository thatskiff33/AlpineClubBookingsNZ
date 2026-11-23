import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";
import { formatDateOnly } from "@/lib/date-only";
import { workPartiesForStayQuerySchema } from "@/lib/work-party-query-schema";
import { WORK_PARTIES_FOR_STAY_CONNECTION_SHAPE } from "@/lib/connection-shapes-lodge-life";
import { connectionJson } from "@/lib/mcp-connection-request";
import { findActiveWorkPartyEventsForRange } from "@/lib/work-party";

/**
 * Active work party (working bee) events overlapping the requested stay.
 * Drives the "I am attending a working bee" picker on the booking form, and
 * is the AI app action `find_work_parties_for_stay` (ALP-796).
 */
export async function GET(req: NextRequest) {
  const rateLimited = await applyRateLimit(rateLimiters.bookingQuery, req);
  if (rateLimited) return rateLimited;

  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const { searchParams } = new URL(req.url);
  const parsed = workPartiesForStayQuerySchema.safeParse({
    checkIn: searchParams.get("checkIn"),
    checkOut: searchParams.get("checkOut"),
    lodgeId: searchParams.get("lodgeId") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { checkIn, checkOut } = parsed.data;
  if (formatDateOnly(checkOut) <= formatDateOnly(checkIn)) {
    return NextResponse.json(
      { error: "Check-out must be after check-in" },
      { status: 400 }
    );
  }

  const events = await findActiveWorkPartyEventsForRange(
    checkIn,
    checkOut,
    undefined,
    parsed.data.lodgeId,
  );

  return connectionJson(req, {
    events: events.map((event) => ({
      id: event.id,
      name: event.name,
      description: event.description,
      startDate: formatDateOnly(event.startDate),
      endDate: formatDateOnly(event.endDate),
      discountPercent: event.discountPercent,
      lodgeName: event.lodge?.name ?? null,
    })),
  }, WORK_PARTIES_FOR_STAY_CONNECTION_SHAPE);
}
