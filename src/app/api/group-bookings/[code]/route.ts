import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";
import { parseJsonRequestBody } from "@/lib/api-json";
import {
  closeGroupBooking,
  GroupBookingError,
  reopenGroupBooking,
  resolveGroupBookingByCode,
} from "@/lib/group-booking";
import { toGroupBookingSummaryResponse } from "@/lib/group-booking-summary-response";
import logger from "@/lib/logger";

/**
 * Public lookup of a group booking by its join code. Returns only safe summary
 * fields (no contact details, no roster, no internal ids) so the public join
 * page can show the event. Unknown codes return 404 uniformly.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ code: string }> }
) {
  const rateLimited = await applyRateLimit(rateLimiters.groupBookingLookup, request);
  if (rateLimited) return rateLimited;

  const { code } = await params;
  const summary = await resolveGroupBookingByCode(code);
  if (!summary) {
    return NextResponse.json({ error: "Group booking not found" }, { status: 404 });
  }

  // One serialiser, typed from the summary, so no field can be dropped here.
  return NextResponse.json(toGroupBookingSummaryResponse(summary));
}

const patchSchema = z
  .object({ action: z.enum(["close", "reopen"]) })
  .strict();

/**
 * Organiser management: close or reopen the group to new joins. Ownership is
 * enforced in the service. Existing child bookings are never touched here.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ code: string }> }
) {
  const rateLimited = await applyRateLimit(rateLimiters.groupBookingCreate, request);
  if (rateLimited) return rateLimited;

  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const json = await parseJsonRequestBody(request);
  if (!json.ok) return json.response;
  const parsed = patchSchema.safeParse(json.body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten().fieldErrors },
      { status: 422 }
    );
  }

  const { code } = await params;
  try {
    const group =
      parsed.data.action === "close"
        ? await closeGroupBooking(code, session.user.id)
        : await reopenGroupBooking(code, session.user.id);
    return NextResponse.json({ status: group.status });
  } catch (err) {
    if (err instanceof GroupBookingError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    logger.error({ err }, "Unexpected error updating group booking");
    return NextResponse.json(
      { error: "Unable to update the group booking right now" },
      { status: 500 }
    );
  }
}
