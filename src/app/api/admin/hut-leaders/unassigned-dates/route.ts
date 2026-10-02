import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { getUnassignedHutLeaderDates } from "@/lib/hut-leader-coverage";
import { parseOccupancyMonth } from "@/lib/admin-occupancy";
import { addDaysDateOnly, isDateOnlyString, parseDateOnly } from "@/lib/date-only";
import { prisma } from "@/lib/prisma";
import { resolveOptionalActiveLodgeId } from "@/lib/lodges";
import {
  listHutLeaderNightLeaders,
  loadHutLeaderNightCover,
} from "@/lib/hut-leader-night-cover";

/**
 * GET /api/admin/hut-leaders/unassigned-dates
 *
 * lodgeId is required. With no other query params, returns dates in the
 * configured hut-leader lookahead window at that lodge with paid or operational
 * bookings but no HutLeaderAssignment (the amber upcoming-dates card).
 *
 * Every row names its lodge (`lodgeId`, `lodgeName`) since #2917, because the
 * underlying result is one row per uncovered LODGE-night. Here that lodge is
 * always the requested one — this route is single-lodge by construction — so the
 * fields are for the client's identity/keying, not for display: the workspace's
 * lodge selector already names the lodge above the card, and repeating it on
 * every row would breach the multi-lodge Presentation Rule (ADR-002).
 *
 * Optional windowing (used to paint one calendar month red on the redesigned
 * assignment page):
 *   ?month=YYYY-MM                — first→last day of that calendar month
 *   ?from=YYYY-MM-DD&to=YYYY-MM-DD — an explicit inclusive date-only window
 * Bad input returns 400.
 *
 * A windowed request also returns `coveredNights` (#3818): every night from the
 * day BEFORE the window to its end that a leader validly covers — assigned and
 * staying, read through the one coverage helper — with who covers it. The
 * calendar derives its "AM · … until midday" / "PM · … from midday" changeover
 * labels from consecutive nights, and the morning of the window's first day
 * belongs to the night before it, hence the extra night.
 */
export async function GET(req: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const searchParams = new URL(req.url).searchParams;
  const month = searchParams.get("month");
  const from = searchParams.get("from");
  const to = searchParams.get("to");
  const requestedLodgeId = searchParams.get("lodgeId");
  const lodgeId = requestedLodgeId
    ? await resolveOptionalActiveLodgeId(prisma, requestedLodgeId)
    : null;
  if (!lodgeId) {
    return NextResponse.json({ error: "A valid lodgeId is required." }, { status: 400 });
  }

  let window: { from: Date; to: Date } | undefined;

  if (month !== null) {
    const parsed = parseOccupancyMonth(month);
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    // parseOccupancyMonth's endDate is the first of the NEXT month (exclusive);
    // step back one day for an inclusive last-of-month window.
    window = { from: parsed.startDate, to: addDaysDateOnly(parsed.endDate, -1) };
  } else if (from !== null || to !== null) {
    if (!from || !to || !isDateOnlyString(from) || !isDateOnlyString(to)) {
      return NextResponse.json(
        { error: "from and to are required as YYYY-MM-DD" },
        { status: 400 },
      );
    }
    if (from > to) {
      return NextResponse.json(
        { error: "from must be before or equal to to" },
        { status: 400 },
      );
    }
    window = { from: parseDateOnly(from), to: parseDateOnly(to) };
  }

  const scope = { kind: "lodge", lodgeId } as const;
  if (!window) {
    return NextResponse.json({
      unassignedDates: await getUnassignedHutLeaderDates({ scope }),
    });
  }

  const coverFrom = addDaysDateOnly(window.from, -1);
  const [unassignedDates, cover] = await Promise.all([
    getUnassignedHutLeaderDates({ ...window, scope }),
    loadHutLeaderNightCover(prisma, { scope, from: coverFrom, to: window.to }),
  ]);
  return NextResponse.json({
    unassignedDates,
    coveredNights: listHutLeaderNightLeaders(cover, {
      from: coverFrom,
      to: window.to,
    }).map(({ date, leaders }) => ({ date, leaders })),
  });
}
