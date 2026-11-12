import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";
import { formatDateOnly } from "@/lib/date-only";
import { parsedDateOnlySchema } from "@/lib/date-only-schema";
import { findActiveWorkPartyEventsForRange } from "@/lib/work-party";

const querySchema = z.object({
  checkIn: parsedDateOnlySchema,
  checkOut: parsedDateOnlySchema,
  // Lodge being booked (multi-lodge): events bound to another lodge are
  // filtered out; lodge-less events are club-wide and always listed.
  lodgeId: z.string().min(1).optional(),
});

/**
 * Active work party (working bee) events overlapping the requested stay.
 * Drives the "I am attending a working bee" picker on the booking form.
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
  const parsed = querySchema.safeParse({
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

  return NextResponse.json({
    events: events.map((event) => ({
      id: event.id,
      name: event.name,
      description: event.description,
      startDate: formatDateOnly(event.startDate),
      endDate: formatDateOnly(event.endDate),
      discountPercent: event.discountPercent,
      lodgeName: event.lodge?.name ?? null,
    })),
  });
}
