import { NextResponse } from "next/server";

import { listMemberBookingSummaries } from "@/lib/member-self-read";
import { requireActiveSession } from "@/lib/session-guards";

/**
 * GET /api/bookings/mine
 *
 * The signed-in member's bookings, newest stay first: the ones they made and
 * the ones they are a guest on. The same set the bookings page lists.
 */
export async function GET() {
  const guard = await requireActiveSession();
  if (!guard.ok) {
    return guard.response;
  }

  const bookings = await listMemberBookingSummaries(guard.session.user.id);
  return NextResponse.json({ bookings });
}
