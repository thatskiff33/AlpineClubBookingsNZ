import { NextRequest, NextResponse } from "next/server";
import { requireActiveSession } from "@/lib/session-guards";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";
import { clubTodayDateOnlyInstant } from "@/lib/club-time/server";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { canViewWorkParties } from "@/lib/work-party-access";
import { findMemberWorkParty } from "@/lib/work-party-member";

/**
 * One work party as a member sees it (fork #118): what the `/work-parties/[id]`
 * page shows, and what the booking page reads for `?workParty=<id>` to fill in
 * the Join stay. Never the internal promo code.
 *
 * Members only (`canViewWorkParties`, owner decision 7). Everyone else — an
 * organisation account, a non-member login — gets 404, as do an inactive or
 * unknown work party and a club with the Work Parties module off: for them the
 * work party does not exist, and the states stay indistinguishable.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const rateLimited = await applyRateLimit(rateLimiters.bookingQuery, req);
  if (rateLimited) return rateLimited;

  const guard = await requireActiveSession();
  if (!guard.ok) return guard.response;

  const modules = await loadEffectiveModuleFlags();
  if (!modules.workParties || !canViewWorkParties(guard.session.user)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const { id } = await params;
  const workParty = await findMemberWorkParty(
    id,
    await clubTodayDateOnlyInstant()
  );
  if (!workParty) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({ workParty });
}
