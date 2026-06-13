import { NextResponse } from "next/server";
import { requireActiveSession } from "@/lib/session-guards";
import {
  canReadLodgeInstructions,
  getSanitizedLodgeInstructions,
} from "@/lib/lodge-instructions";

/**
 * GET /api/lodge-instructions
 * Reader endpoint for the member-facing lodge instructions page.
 * Admins always qualify; members qualify only while they hold a current
 * or upcoming hut leader assignment. Everyone else gets a 403 the page
 * turns into the "you're not currently assigned" state.
 */
export async function GET() {
  const guard = await requireActiveSession();
  if (!guard.ok) {
    return guard.response;
  }

  const allowed = await canReadLodgeInstructions(
    guard.session.user.id,
    guard.session.user.role,
  );

  if (!allowed) {
    return NextResponse.json(
      { error: "You are not currently assigned as a hut leader" },
      { status: 403 },
    );
  }

  const documents = await getSanitizedLodgeInstructions();
  return NextResponse.json({ documents });
}
